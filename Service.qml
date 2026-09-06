import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model
import "Api.js" as Api

// One instance per shell. Owns config, polling, state and IPC. Widgets and panels
// (one per monitor) only render `snapshot` and `bar`.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var omarchyPath: null
  property var barWidgetRegistry: null
  property var pluginRegistry: null

  readonly property string configDirPath: Quickshell.env("HOME") + "/.config/omarify"
  readonly property string configPath: configDirPath + "/config.json"
  readonly property string me: Quickshell.env("USER")

  // Private. `_` is a naming convention, not access control: any plugin in this
  // shell can read these through shell.serviceFor(). The token is never placed in
  // argv, console output, snapshot, status or disk.
  property var _cfg: null              // Model.normaliseConfig result
  property var _instance: null         // instances[0] without the token
  property string _token: ""
  property string _tokenSource: ""     // "file" | "command"
  property string _tokenCmdKey: ""     // JSON of the tokenCommand that produced the cached token
  property int _tokenCmdSeq: 0         // a superseded token command's exit is ignored
  property string _configMode: ""
  property string _configOwner: ""
  property bool _statPending: false
  property bool _needToken: false
  property string _stamp: ""           // "inode mtime" of the config the store was built from
  property bool _acceptStamp: false    // the reload in flight owns the next stamp
  property var _error: null            // Model error object or null
  property var _warning: null
  property bool _ready: false
  property string _version: ""

  // Store (plain objects, rebuilt by Model.js; never QObjects).
  property var _servers: []
  property var _resourcesRaw: []       // normalised, unjoined
  property var _resources: []          // joined
  property var _deployments: []        // active, joined
  property var _recent: []             // terminal, newest first, cap 20
  property var _activeUuids: []
  property var _terminalQueue: []
  property var _projects: []
  property var _envsByProject: ({})
  property var _byServer: ({})
  property var _tree: []
  property var _failedUnacked: []
  property var _lastPollAt: ({ deployments: 0, resources: 0, servers: 0, topology: 0, version: 0 })
  property var _baseline: ({ deployments: false, resources: false, servers: false, version: false })
  property bool _baselineDone: false
  property bool _topologyFetched: false

  // Scheduler state.
  property var _perKind: ({})
  property var _requestLog: []
  property var _backoff: ({})          // kind -> { until, attempt }
  property bool _paused: false         // 429: every timer stops until pauseTimer fires
  property int _backoffSec: 0
  property bool _probeMode: false      // 401/403: timers stop; one deployments probe a minute
  property var _rateLimitRemaining: null
  property double _lastPrimeAt: 0
  property var _panels: ({})           // panelId -> last alive ms
  property int _openPanels: 0
  property bool _busy: false

  readonly property int _activeCount: root._deployments.filter(function(d) { return d.status === "queued" || d.status === "in_progress" }).length
  readonly property bool _deploying: root._activeCount > 0
  readonly property bool _panelOpen: root._openPanels > 0
  readonly property int _deploymentsSec: root._deploying ? 2 : (root._cfg ? root._cfg.poll.deploymentsSec : 4)
  readonly property int _resourcesSec: Math.min(root._cfg ? root._cfg.poll.resourcesSec : 60, root._deploying ? 15 : 100000, root._panelOpen ? 30 : 100000)
  readonly property int _serversSec: root._cfg ? root._cfg.poll.serversSec : 120
  property int _topologySec: 600
  readonly property bool _timersOn: root._ready && !root._paused && !root._probeMode

  readonly property var snapshot: ({
    instance: root._instance ? { id: root._instance.id, name: root._instance.name, url: root._instance.url, version: root._version, plaintext: root._instance.plaintext } : null,
    error: root._error, warning: root._warning,
    servers: root._servers, resources: root._resources, deployments: root._deployments, recent: root._recent,
    tree: root._tree, byServer: root._byServer,
    failedUnacked: root._failedUnacked, lastPollAt: root._lastPollAt,
    busy: root._busy, openPanels: root._openPanels, baselineDone: root._baselineDone,
    backoffSec: root._backoffSec
  })
  readonly property var bar: Model.barState(root.snapshot)

  // ---- public ---------------------------------------------------------------------

  function refresh() {
    root._selfHeal()
    root._prime("all")
  }

  function panelOpened(id) {
    var p = root._panels; p[String(id)] = Date.now(); root._panels = p
    root._syncOpenPanels()
    root.acknowledgeFailures()
    if (root._ready) {
      root._prime("stale")
      if (!root._topologyFetched) root._pollTopology()
    }
  }
  function panelClosed(id) {
    var p = root._panels; delete p[String(id)]; root._panels = p
    root._syncOpenPanels()
  }
  function panelAlive(id) {
    if (root._panels[String(id)] !== undefined) { var p = root._panels; p[String(id)] = Date.now(); root._panels = p }
  }
  function acknowledgeFailures() { if (root._failedUnacked.length) root._failedUnacked = [] }

  function _syncOpenPanels() { root._openPanels = Object.keys(root._panels).length }

  // ---- config ---------------------------------------------------------------------
  // FileView cannot watch a file that does not exist yet, so the directory is
  // watched too (plugins/bar/Bar.qml bar-off pattern). `text()` is stale inside the
  // change signal, so every change routes through reload() -> onLoaded.
  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root._configText(text())
    onLoadFailed: root._configText(null)
  }
  FileView {
    id: configDir
    path: root.configDirPath
    watchChanges: true
    printErrors: false
    // Any file created in the directory fires this (an editor's swap file, a backup),
    // so only re-stat; _applyStat reloads when the config's inode or mtime changed.
    onFileChanged: root._stat()
  }
  Process {
    id: mkdirProc
    running: false
    command: ["mkdir", "-m", "700", "-p", root.configDirPath]
    onExited: function(code) {
      configDir.path = ""
      configDir.path = root.configDirPath
      Qt.callLater(function() { if (!root._cfg) configFile.reload(); root._stat() })
    }
  }
  Process {
    id: statProc
    running: false
    command: ["stat", "-c", "%a %U %i %Y", root.configPath]
    stdout: StdioCollector { id: statOut; waitForEnd: true }
    onExited: function(code) {
      root._applyStat(code === 0 ? statOut.text : "")
      if (root._statPending) { root._statPending = false; statProc.running = true }
    }
  }
  Process {
    id: tokenCmd
    property int seq: 0
    property string key: ""
    running: false
    command: []
    stdout: StdioCollector { id: tokenOut; waitForEnd: true }
    stderr: StdioCollector { id: tokenErr; waitForEnd: true }   // collected so it never reaches the log; never read
    onExited: function(code) {
      if (tokenCmd.seq !== root._tokenCmdSeq) return
      var t = String(tokenOut.text || "").trim()
      if (code === 0 && t.length > 0) { root._tokenCmdKey = tokenCmd.key; root._tokenReady(t, "command") }
      else root._setError(Model.makeError("tokencmd", "", { curlExit: code }))
    }
  }

  // Re-arm the directory watch (a removed directory strands it) and re-stat; the
  // config text is only re-read when nothing is loaded, so a refresh never cascades.
  function _selfHeal() { mkdirProc.running = true }

  // Start rather than restart: a stat already in flight answers for the current file;
  // a change that lands meanwhile is replayed from onExited.
  function _stat() {
    if (statProc.running) root._statPending = true
    else statProc.running = true
  }

  function _configText(t) {
    root._acceptStamp = true
    if (t !== null && t !== undefined && root._cfg) {
      // Same config text (an attribute change, a touch): keep the store, just re-stat.
      var again = Model.normaliseConfig(String(t))
      if (again.ok && JSON.stringify(again) === JSON.stringify(root._cfg)) { root._stat(); return }
    }
    root._resetStore()
    root._ready = false
    if (t === null || t === undefined || String(t).trim() === "") {
      root._cfg = null
      root._warning = null
      root._setError(Model.makeError("noconfig"))
      return
    }
    var c = Model.normaliseConfig(String(t))
    if (!c.ok) {
      root._cfg = null
      root._warning = null
      root._setError(Model.makeError("configerror", c.error))
      return
    }
    root._cfg = c
    var i = c.instances[0]
    root._instance = { id: i.id, name: i.name, url: i.url, plaintext: i.plaintext }
    root._topologySec = c.poll.topologySec
    root._needToken = true
    root._error = null
    root._stat()                       // token resolution continues in _applyStat
  }

  function _resetStore() {
    root._version = ""
    root._servers = []; root._resourcesRaw = []; root._resources = []; root._deployments = []; root._recent = []
    root._activeUuids = []; root._terminalQueue = []; root._projects = []; root._envsByProject = {}; root._byServer = {}; root._tree = []
    root._failedUnacked = []
    root._lastPollAt = { deployments: 0, resources: 0, servers: 0, topology: 0, version: 0 }
    root._baseline = { deployments: false, resources: false, servers: false, version: false }
    root._baselineDone = false
    root._topologyFetched = false
    root._backoff = {}; root._paused = false; root._backoffSec = 0; root._probeMode = false
    startupRamp.ticks = 0
    for (var i = 0; i < root._reqs.length; i++) root._reqs[i].kill()
    root._syncBusy()
  }

  function _applyStat(text) {
    var parts = String(text || "").trim().split(/\s+/)
    root._configMode = parts[0] || ""
    root._configOwner = parts[1] || ""
    var stamp = (parts[2] || "") + " " + (parts[3] || "")
    if (root._configMode && stamp !== root._stamp) {
      root._stamp = stamp
      // A new inode or mtime that no reload announced (atomic editor save, file
      // appeared): read it. A reload in flight already owns this stamp.
      if (!root._acceptStamp) { configFile.reload(); return }
    }
    root._acceptStamp = false
    if (!root._cfg) { if (root._configMode) configFile.reload(); return }
    if (!root._configMode) return      // stat failed: the file watch owns the "not configured" state
    if (Model.configUnsafe(root._configMode, root._configOwner, root.me)) {
      root._ready = false
      root._needToken = true
      root._setError(Model.makeError("unsafe"))
      return
    }
    var i = root._cfg.instances[0]
    if (Model.configLoose(root._configMode) && !i.tokenCommand) root._warning = { kind: "permissions", title: "Config is readable by others", detail: "" }
    else if (i.plaintext) root._warning = { kind: "plaintext", title: "Plaintext instance", detail: "" }
    else root._warning = null
    if (root._error && root._error.kind === "unsafe") root._error = null
    if (root._needToken || !root._ready) { root._needToken = false; root._resolveToken() }
  }

  function _resolveToken() {
    var i = root._cfg.instances[0]
    if (i.tokenCommand) {
      var key = JSON.stringify(i.tokenCommand)
      if (key === root._tokenCmdKey && root._token.length > 0) { root._tokenReady(root._token, "command"); return }
      root._ready = false
      root._setError(Model.makeError("waitingtoken"))
      if (tokenCmd.running && tokenCmd.key === key) return       // already waiting on this command
      if (tokenCmd.running) { root._tokenCmdSeq += 1; tokenCmd.running = false }   // supersede
      root._tokenCmdSeq += 1
      tokenCmd.seq = root._tokenCmdSeq
      tokenCmd.key = key
      tokenCmd.command = ["timeout", "-k", "2", "30"].concat(i.tokenCommand)
      tokenCmd.running = true
      return
    }
    root._tokenCmdKey = ""
    root._tokenReady(i.token, "file")
  }

  function _tokenReady(token, source) {
    root._token = token
    root._tokenSource = source
    if (root._error && (root._error.kind === "waitingtoken" || root._error.kind === "tokencmd" || root._error.kind === "noconfig" || root._error.kind === "configerror")) root._error = null
    root._ready = true
    root._prime("all")
    topologyKick.restart()
  }

  function _setError(e) { root._error = e }

  // ---- HTTP client ----------------------------------------------------------------
  // One Process per request kind: kinds overlap but never stack. Every request is
  // a curl config on stdin (Api.config); the token is only ever inside that text.
  component Req: Process {
    id: req
    property string kind: ""
    property var arg: null
    property int seq: 0
    property int liveSeq: -1
    property string cfg: ""
    property double deadline: 0
    property bool stopping: false      // killed; refuse a relaunch until the exit arrives
    running: false
    command: Api.argv()
    stdout: StdioCollector { id: out; waitForEnd: true }
    stderr: StdioCollector { id: err; waitForEnd: true }
    // write() then stdinEnabled = false closes curl's stdin (EOF), which is what
    // makes `curl -K -` start the transfer.
    onStarted: { liveSeq = seq; write(cfg); cfg = ""; stdinEnabled = false }
    onExited: function(code) { req.stopping = false; root._finish(req, code, out.text, err.text) }
    function kill() { if (running) { seq += 1; stopping = true; running = false } }
  }

  Req { id: versionReq }
  Req { id: deploymentsReq }
  Req { id: deploymentReq }
  Req { id: resourcesReq }
  Req { id: serversReq }
  Req { id: topologyReq }

  readonly property var _reqs: [versionReq, deploymentsReq, deploymentReq, resourcesReq, serversReq, topologyReq]

  function _syncBusy() { root._busy = root._reqs.some(function(p) { return p.running }) }

  function _launch(p, reqs, maxTime) {
    if (p.running || p.stopping) return false
    var list = Array.isArray(reqs) ? reqs : [reqs]
    p.seq += 1
    p.kind = Array.isArray(reqs) ? "topology" : reqs.kind
    p.arg = list
    p.deadline = Date.now() + (list.length * maxTime + 3) * 1000
    p.stdinEnabled = true
    p.cfg = Api.config(root._instance, root._token, list, maxTime)   // the only call site
    p.running = true
    root._noteRequest(p.kind, list.length)
    root._syncBusy()
    return true
  }

  function _finish(p, code, stdoutText, stderrText) {
    root._syncBusy()
    if (p.liveSeq !== p.seq) return
    var results = Model.splitResponses(stdoutText)
    if (results.length === 0) {
      root._fail(p.kind, Model.errorFor({ curlExit: code || 1, errmsg: stderrText, request: p.kind }), null)
      if (p.kind === "deployment") root._drainTerminal()
      return
    }
    var anyOk = false
    for (var i = 0; i < results.length; i++) {
      var r = results[i]
      root._record(p.kind, r)
      var e = Model.errorFor({ curlExit: r.exit, httpCode: r.code, body: r.body, headers: r.headers, request: p.kind })
      if (e) {
        if (!(p.kind === "deployment" && r.code === 404)) root._fail(p.kind, e, r.headers)   // 404: vanished for good
      } else {
        anyOk = true
        root._dispatch(p.arg[i], r, p.kind)
      }
    }
    if (anyOk) root._succeeded(p.kind)
    if (p.kind === "resources" || p.kind === "servers" || p.kind === "topology" || p.kind === "deployments") root._rejoin()
    if (p.kind === "deployment") root._drainTerminal()
  }

  function _dispatch(req, r, kind) {
    var now = Date.now()
    var json = req.json === false ? null : Model.parseJson(r.body)
    if (req.json !== false && !json.ok) { root._fail(kind, Model.makeError("http", "Coolify returned something that is not JSON", { httpCode: r.code, request: kind }), r.headers); return }
    switch (req.kind) {
      case "version":
        root._version = Model.parseVersion(r.body)
        root._markPoll("version", now)
        break
      case "deployments": {
        var norm = Model.normaliseDeployments(json.value)
        var diff = Model.diffActive(root._activeUuids, norm)
        if (diff.vanished.length) {
          var q = root._terminalQueue.slice()
          diff.vanished.forEach(function(u) { if (q.indexOf(u) < 0 && q.length < 20) q.push(u) })
          root._terminalQueue = q
        }
        root._activeUuids = norm.map(function(d) { return d.uuid })
        root._deployments = norm
        root._markPoll("deployments", now)
        root._drainTerminal()
        break
      }
      case "deployment": {
        var d = Model.normaliseDeployment(json.value)
        if (d.uuid) {
          var rec = root._recent.filter(function(x) { return x.uuid !== d.uuid })
          rec.unshift(d)
          root._recent = rec.slice(0, 20)
          if (d.status === "failed" && root._baselineDone && root._openPanels === 0 && root._failedUnacked.indexOf(d.uuid) < 0)
            root._failedUnacked = root._failedUnacked.concat([d.uuid])
        }
        break
      }
      case "resources":
        root._resourcesRaw = Model.normaliseResources(json.value)
        root._markPoll("resources", now)
        break
      case "servers":
        root._servers = Model.normaliseServers(json.value)
        root._markPoll("servers", now)
        break
      case "projects":
        root._projects = Model.normaliseProjects(json.value)
        root._markPoll("topology", now)
        root._topologyStage2()
        break
      case "project": {
        var envs = root._envsByProject; envs[req.arg] = Model.environmentsOf(json.value); root._envsByProject = envs
        root._topologyFetched = true
        break
      }
      case "serverResources": {
        var bs = root._byServer; bs[req.arg] = Model.serverResourceUuids(json.value); root._byServer = bs
        root._topologyFetched = true
        break
      }
    }
    console.log("omarify " + req.kind + " " + r.code + " exit=" + r.exit + " " + r.timeMs + "ms " + r.bytes + "B")
  }

  function _markPoll(kind, now) {
    var lp = root._lastPollAt; lp[kind] = now; root._lastPollAt = lp
    if (root._baseline[kind] === false) {
      var b = root._baseline; b[kind] = true; root._baseline = b
      if (b.deployments && b.resources && b.servers && b.version) root._baselineDone = true
    }
  }

  function _rejoin() {
    root._tree = Model.buildTree(root._projects, root._envsByProject, root._resourcesRaw)
    root._resources = Model.applyJoins(root._resourcesRaw, root._tree, root._byServer, root._servers)
    var counts = Model.resourceCounts(root._byServer)
    root._servers = root._servers.map(function(x) { var o = {}; for (var k in x) o[k] = x[k]; o.resourceCount = counts[x.uuid] || 0; return o })
    root._deployments = Model.joinBranch(root._deployments, root._resources)
    root._recent = Model.joinBranch(root._recent, root._resources)
  }

  function _topologyStage2() {
    var list = root._projects.map(function(p) { return Api.reqProject(p.uuid) })
      .concat(root._servers.map(function(s) { return Api.reqServerResources(s.uuid) }))
    root._topologySec = Model.topologyIntervalSec(root._cfg ? root._cfg.poll.topologySec : 600, root._projects.length, root._servers.length)
    if (list.length) root._launch(topologyReq, list, 8)
    else root._topologyFetched = true
  }

  function _drainTerminal() {
    if (!root._ready || deploymentReq.running || !root._terminalQueue.length) return
    if (root._backoffUntil("deployment") > Date.now()) return
    var q = root._terminalQueue.slice()
    var uuid = q.shift()
    root._terminalQueue = q
    root._launch(deploymentReq, Api.reqDeployment(uuid), 6)
  }

  // ---- errors, backoff, pause, probe ---------------------------------------------------

  function _succeeded(kind) {
    var b = root._backoff; if (b[kind]) { delete b[kind]; root._backoff = b }
    if (root._error && root._error.request === kind) root._error = null
    if (root._probeMode) { root._probeMode = false; root._prime("all") }
  }

  function _record(kind, r) {
    var pk = root._perKindEntry(kind)
    pk.lastAt = Date.now(); pk.lastCode = r.code; pk.lastMs = r.timeMs; pk.lastBytes = r.bytes
    if (r.exit === 0 && r.code < 400) pk.consecutiveFailures = 0
    if (r.headers && r.headers.rateLimitRemaining !== null) root._rateLimitRemaining = r.headers.rateLimitRemaining
    root._perKind = root._perKind
  }

  function _fail(kind, e, headers) {
    var pk = root._perKindEntry(kind)
    pk.consecutiveFailures += 1
    root._perKind = root._perKind
    e.at = Date.now()
    e.staleSince = root._lastPollAt[kind === "deployment" ? "deployments" : kind] || 0
    if (!(root._error && root._error.kind === "ratelimited" && e.kind !== "ratelimited")) root._error = e
    if (e.kind === "auth" || e.kind === "apidisabled" || e.kind === "ipblocked") {
      root._probeMode = true
      probeTimer.restart()
    } else if (e.kind === "ratelimited") {
      var b = root._backoff; var attempt = ((b.ratelimited && b.ratelimited.attempt) || 0) + 1
      root._backoffSec = Model.retryAfterSec(headers, attempt)
      b.ratelimited = { until: Date.now() + root._backoffSec * 1000, attempt: attempt }; root._backoff = b
      root._paused = true
      pauseTimer.interval = root._backoffSec * 1000
      pauseTimer.restart()
    } else if (e.kind !== "ability") {
      var bo = root._backoff; var a = ((bo[kind] && bo[kind].attempt) || 0) + 1
      bo[kind] = { until: Date.now() + (a <= 1 ? 30 : 60) * 1000, attempt: a }; root._backoff = bo
    }
    console.warn("omarify " + kind + " failed: " + e.kind + " http=" + e.httpCode + " exit=" + e.curlExit + " " + e.detail)
  }

  function _backoffUntil(kind) { var b = root._backoff[kind]; return b ? b.until : 0 }
  function _maxBackoffUntil() { var m = 0; for (var k in root._backoff) m = Math.max(m, root._backoff[k].until); return m }

  function _perKindEntry(kind) {
    if (!root._perKind[kind]) root._perKind[kind] = { lastAt: 0, lastCode: 0, lastMs: 0, lastBytes: 0, interval: 0, consecutiveFailures: 0, reaps: 0, lastReapAt: 0 }
    return root._perKind[kind]
  }

  function _noteRequest(kind, n) {
    var now = Date.now()
    var log = root._requestLog.filter(function(t) { return now - t < 60000 })
    for (var i = 0; i < n; i++) log.push(now)
    root._requestLog = log
  }

  function _requestsLastMin() {
    var now = Date.now()
    return root._requestLog.filter(function(t) { return now - t < 60000 }).length
  }

  // ---- scheduler -----------------------------------------------------------------------

  function _pollVersion() { root._launch(versionReq, Api.reqVersion(), 6) }
  function _pollDeployments() { if (root._backoffUntil("deployments") <= Date.now()) root._launch(deploymentsReq, Api.reqDeployments(), 6) }
  function _pollResources() { if (root._backoffUntil("resources") <= Date.now()) root._launch(resourcesReq, Api.reqResources(), 10) }
  function _pollServers() { if (root._backoffUntil("servers") <= Date.now()) root._launch(serversReq, Api.reqServers(), 10) }
  function _pollTopology() { if (root._backoffUntil("topology") <= Date.now()) root._launch(topologyReq, [Api.reqProjects()], 8) }

  // which: "all" (refresh, token ready), "stale" (panel open), "missing" (startup ramp)
  function _prime(which) {
    if (!root._ready) return
    var now = Date.now()
    if (which === "all") { if (now - root._lastPrimeAt < 2000) return; root._lastPrimeAt = now }
    function want(kind, idleSec) {
      if (which === "all") return true
      if (which === "missing") return !root._baseline[kind]
      return now - (root._lastPollAt[kind] || 0) >= idleSec * 1000
    }
    if (want("deployments", root._deploymentsSec)) root._pollDeployments()
    if (want("version", 100000)) root._pollVersion()
    if (want("resources", root._resourcesSec)) root._pollResources()
    if (want("servers", root._serversSec)) root._pollServers()
  }

  // Changing a running Timer's interval restarts it, so after a cadence flip a kind
  // whose last poll is older than the new interval launches immediately.
  function _catchUp(kind, sec, fn) {
    if (!root._timersOn) return
    if (Date.now() - (root._lastPollAt[kind] || 0) >= sec * 1000) fn()
  }

  Timer { id: deploymentsTimer; interval: root._deploymentsSec * 1000; repeat: true; triggeredOnStart: false; running: root._timersOn
          onTriggered: root._pollDeployments(); onIntervalChanged: root._catchUp("deployments", root._deploymentsSec, root._pollDeployments) }
  Timer { id: resourcesTimer; interval: root._resourcesSec * 1000; repeat: true; triggeredOnStart: false; running: root._timersOn
          onTriggered: root._pollResources(); onIntervalChanged: root._catchUp("resources", root._resourcesSec, root._pollResources) }
  Timer { id: serversTimer; interval: root._serversSec * 1000; repeat: true; triggeredOnStart: false; running: root._timersOn
          onTriggered: { root._pollServers(); root._selfHeal() } }
  Timer { id: topologyTimer; interval: root._topologySec * 1000; repeat: true; triggeredOnStart: false; running: root._timersOn
          onTriggered: root._pollTopology() }
  Timer { id: topologyKick; interval: 2000; repeat: false; running: false; onTriggered: if (root._ready) root._pollTopology() }

  // First 30 s after the token is ready: retry kinds that have not answered yet every 2 s.
  Timer {
    id: startupRamp
    property int ticks: 0
    interval: 2000
    repeat: true
    running: root._ready && !root._baselineDone && !root._paused && !root._probeMode && ticks < 15
    onTriggered: { ticks += 1; root._prime("missing") }
  }
  // 401/403: everything stops; one deployments probe a minute until a 2xx or a config change.
  Timer { id: probeTimer; interval: 60000; repeat: true; running: root._ready && root._probeMode; onTriggered: root._launch(deploymentsReq, Api.reqDeployments(), 6) }
  // 429: everything pauses for Retry-After (clamped) or the ladder.
  Timer { id: pauseTimer; interval: 30000; repeat: false; running: false; onTriggered: { root._paused = false; root._prime("all") } }

  // Reaper: armed once, never restarted (tailscale lesson). A Req past its deadline is
  // killed; bumping seq first makes its onExited a no-op. Also expires dead panels.
  Timer {
    id: reaper
    interval: 5000
    repeat: true
    running: true
    onTriggered: {
      var now = Date.now()
      for (var i = 0; i < root._reqs.length; i++) {
        var p = root._reqs[i]
        if (p.running && p.deadline > 0 && now > p.deadline) {
          p.kill()
          var pk = root._perKindEntry(p.kind)
          pk.reaps += 1; pk.lastReapAt = now; pk.consecutiveFailures += 1
          root._perKind = root._perKind
          var bo = root._backoff; var a = ((bo[p.kind] && bo[p.kind].attempt) || 0) + 1
          bo[p.kind] = { until: now + (a <= 1 ? 30 : 60) * 1000, attempt: a }; root._backoff = bo
          console.warn("omarify reaped " + p.kind)
          if (p.kind === "deployment") root._drainTerminal()
        }
      }
      var changed = false
      for (var id in root._panels) if (now - root._panels[id] > 5000) { delete root._panels[id]; changed = true }
      if (changed) { root._panels = root._panels; root._syncOpenPanels() }
      root._syncBusy()
    }
  }

  Component.onCompleted: mkdirProc.running = true

  Component.onDestruction: {
    reaper.running = false
    deploymentsTimer.running = false; resourcesTimer.running = false; serversTimer.running = false; topologyTimer.running = false
    startupRamp.running = false; probeTimer.running = false; pauseTimer.running = false; topologyKick.running = false
    tokenCmd.running = false
    statProc.running = false
    mkdirProc.running = false
    for (var i = 0; i < root._reqs.length; i++) root._reqs[i].kill()
  }

  // ---- IPC ---------------------------------------------------------------------------
  function _status() {
    var intervals = { deployments: root._deploymentsSec, resources: root._resourcesSec, servers: root._serversSec, topology: root._topologySec, version: 0, deployment: 0 }
    var per = {}
    for (var k in root._perKind) { per[k] = {}; for (var f in root._perKind[k]) per[k][f] = root._perKind[k][f]; per[k].interval = intervals[k] || 0 }
    var configState = root._error && ["noconfig", "configerror", "unsafe", "tokencmd", "waitingtoken"].indexOf(root._error.kind) >= 0
      ? root._error.kind : (root._ready ? "ok" : "unconfigured")
    return {
      configState: configState,
      configMode: root._configMode || null,
      tokenSource: root._ready ? root._tokenSource : null,
      instance: root._instance ? { id: root._instance.id, version: root._version } : null,
      counts: { servers: root._servers.length, resources: root._resources.length, deployments: root._activeCount, recent: root._recent.length },
      perKind: per,
      requestsLastMin: root._requestsLastMin(),
      rateLimitRemaining: root._rateLimitRemaining,
      backoffUntil: root._maxBackoffUntil(),
      paused: root._paused,
      probeMode: root._probeMode,
      openPanels: root._openPanels,
      baselineDone: root._baselineDone,
      topologyFetched: root._topologyFetched,
      terminalQueue: root._terminalQueue.length,
      error: root._error ? { kind: root._error.kind, request: root._error.request, httpCode: root._error.httpCode, curlExit: root._error.curlExit } : null,
      warning: root._warning ? root._warning.kind : null,
      bar: { glyph: "U+" + root.bar.glyph.codePointAt(0).toString(16).toUpperCase(), dimmed: root.bar.dimmed, active: root.bar.active, tooltip: root.bar.tooltip }
    }
  }

  IpcHandler {
    target: "io.github.danjonesio.omarify"
    function refresh(): string { root.refresh(); return "ok" }
    function status(): string { return JSON.stringify(root._status()) }
  }
}
