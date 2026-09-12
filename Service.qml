import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons                    // Util.execArgv for the notification helper (Phase 3)
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

  readonly property string configDirPath: Quickshell.env("HOME") + "/.config/coolwatch"
  readonly property string configPath: configDirPath + "/config.json"
  readonly property string me: Quickshell.env("USER")
  // State (Phase 3): recent terminal deployments. The directory is the permission control
  // (FileView has no mode API and its atomic rename discards a chmod on the file).
  readonly property string stateDirPath: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/coolwatch"
  readonly property string recentPath: stateDirPath + "/recent.json"

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
  property bool _topologyFetched: false   // the current cycle's queue has drained
  property bool _topologyLoaded: false    // latched: the topology completed at least once since the last config change
  property double _lastTopologyStepAt: 0
  property var _topologyQueue: []      // stage-2 descriptors, launched one per topologyStep tick

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
  property var _panelCandidates: ({})  // panelId -> first alive ms seen while unregistered
  property int _openPanels: 0
  property bool _busy: false

  // Actions (Phase 2). Pending is a service-owned map applied at render time (a value
  // written into the store would be erased by the next poll). Set at launch, cleared on
  // any non-2xx (a 429 answers before the action runs); only a reap keeps it (the POST may
  // have landed). Resolved per verb by _expirePending on the reaper tick. Never routed through _fail: an action's outcome
  // is the status line and nothing else.
  property var _pending: ({})          // uuid -> { verb, targetType, kind, name, since, baseStatus, deploymentUuid, stale }
  property var _inflightAction: null   // the resolved action between launch and finish
  property double _lastActionLaunchAt: 0
  property var _actionLog: []          // bare timestamps, the _requestLog idiom; _requestLog itself is untouched
  property int _ipcAbilityStreak: 0    // consecutive ability 403s from IPC-originated actions
  property string _lastAbility: ""
  property string _actionStatus: ""
  property string _actionTone: "dim"
  property var _lastAction: null
  readonly property var pending: root._pending
  readonly property string actionStatus: root._actionStatus
  readonly property string actionTone: root._actionTone

  // Notifications (Phase 3). Events are produced inside _dispatch from the previous store
  // value and drained once per _finish; Model.notifyPlan decides everything (toggles,
  // suppression, ordering, caps, argv) so tests/run.js covers it. Nothing here enters
  // `snapshot` (the `pending` precedent). Every diff is gated on its kind's own _baseline
  // flag, never _baselineDone.
  readonly property string pluginId: "io.github.danjonesio.coolwatch"
  property var _notifyQueue: []
  property var _actionAt: ({})         // uuid -> last user action ms (resource uuid; deployment uuid for cancel); pruned > 300 s
  property var _lastNotified: ({})     // "<kind>:<uuid>:<event>" -> ms; the dedupe/flap ledger; pruned > 3600 s
  property var _notifyLog: []          // bare timestamps, the _actionLog idiom (filter-push-reassign)
  property var _suppressed: Model.suppressedZero()   // every rule present at 0; cumulative since the last config change
  property var _lastEvent: null
  // The terminal fetch is now the only source of the Deployed/Failed toast, so a vanished
  // uuid whose fetch fails (transport, 5xx, 429, reap) is re-queued at the back, twice at
  // most; a 404 is final. The existing `deployment` backoff and pause gate the next launch.
  property var _drainTries: ({})       // uuid -> attempts so far; deleted on success, 404 or give-up
  property int _drainRetries: 0        // cumulative, for status
  property bool _drainDispatched: false // the deployment arm ran with a uuid this _finish (HTTP 200 alone is not success)
  // recent.json: written from the deployment arm only (never from a property change, never
  // from _resetStore), armed only after the state dir exists and the file was read once.
  property bool _stateDirReady: false
  property bool _recentLoaded: false
  property string _recentKey: ""       // Model.origin(instance.url) the loaded file was checked against; "" never arms
  property string _lastRecentKey: ""   // stamp-free guard key of the last write
  property int _recentPersisted: 0
  property bool _recentRejected: false

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
    backoffSec: root._backoffSec, topologyFetched: root._topologyLoaded   // the latch: "loading" is a startup state, not a per-cycle one
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
      if (!root._topologyFetched && !root._topologyQueue.length && !topologyReq.running) root._pollTopology()
    }
  }
  function panelClosed(id) {
    var p = root._panels; delete p[String(id)]; root._panels = p
    root._syncOpenPanels()
  }
  // Also the re-registration path: a hot-reloaded service starts with an empty
  // registry and open panels ping every second. A single stray ping does not register;
  // two within 2.5 s (a panel that is really open) do.
  function panelAlive(id) {
    var key = String(id), now = Date.now()
    if (root._panels[key] !== undefined) { var p = root._panels; p[key] = now; root._panels = p; return }
    var first = root._panelCandidates[key]
    if (first !== undefined && now - first <= 2500) {
      var c = root._panelCandidates; delete c[key]; root._panelCandidates = c
      var q = root._panels; q[key] = now; root._panels = q
      root._syncOpenPanels()
    } else {
      var c2 = root._panelCandidates; c2[key] = now; root._panelCandidates = c2
    }
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
    // -m is create-only, so the chmod repairs a state dir that already existed at 0755;
    // both paths are positional parameters, never interpolated. A non-zero exit leaves
    // _stateDirReady false: recent.json is then neither read nor written..
    command: ["bash", "-c", 'mkdir -m 700 -p "$1" "$2" && chmod 700 "$2"', "bash", root.configDirPath, root.stateDirPath]
    onExited: function(code) {
      configDir.path = ""
      configDir.path = root.configDirPath
      root._stateDirReady = code === 0             // a failed mkdir/chmod means no read and no write: the 0700 dir is the control
      if (code !== 0) console.warn("coolwatch state dir unavailable (mkdir exit " + code + ")")
      root._armRecent()
      Qt.callLater(function() { if (!root._cfg) configFile.reload(); root._stat() })
    }
  }
  // Write-only shape (plugins/agents/Main.qml): no watch on a file this service writes.
  FileView {
    id: recentFile
    path: ""
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: root._loadRecent(text())
    onLoadFailed: function(err) { root._loadRecent(null) }
    onSaveFailed: function(err) { console.log("coolwatch recent save failed") }
  }

  // Called from _configText (after _instance is set) and from mkdirProc.onExited; needs both.
  // Do not hoist the path assignment to Component.onCompleted: the directory must exist first.
  function _armRecent() {
    if (!root._stateDirReady || !root._instance) return
    var key = Model.origin(root._instance.url)
    if (key === root._recentKey && recentFile.path === root.recentPath) return
    root._recentKey = key; root._recentLoaded = false
    if (recentFile.path === root.recentPath) recentFile.reload(); else recentFile.path = root.recentPath
  }
  function _loadRecent(text) {         // idempotent: onLoaded may fire more than once
    var r = Model.parseRecent(text, root._recentKey, Date.now())
    root._recent = Model.joinBranch(Model.mergeRecent(root._recent, r.recent), root._resources)
    root._recentPersisted = r.recent.length; root._recentRejected = r.rejected; root._recentLoaded = true
    console.log(r.rejected ? "coolwatch recent rejected" : "coolwatch recent loaded " + r.recent.length)
  }
  function _saveRecent() {             // the deployment arm is the only caller
    if (!root._recentLoaded || !root._stateDirReady || root._recentKey === "") return
    var out = Model.serialiseRecent(root._recent, root._recentKey, Date.now())
    if (out.key === root._lastRecentKey) return
    root._lastRecentKey = out.key
    recentFile.setText(out.text)
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
      // A notify-only edit applies live: no reset, no new baseline, no killed request, no
      // token re-resolution (_stat -> _applyStat keeps the stamp bookkeeping and recomputes
      // the warning; _needToken and _ready are untouched so _tokenReady does not re-fire).
      if (again.ok && JSON.stringify(Model.configSansNotify(again)) === JSON.stringify(Model.configSansNotify(root._cfg))) {
        root._cfg = again
        root._stat()
        return
      }
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
    root._armRecent()                  // the file is keyed on the instance, not the token: no wait on a vault
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
    root._topologyFetched = false; root._topologyLoaded = false; root._lastTopologyStepAt = 0; root._topologyQueue = []
    root._backoff = {}; root._paused = false; root._backoffSec = 0; root._probeMode = false
    startupRamp.ticks = 0
    var interrupted = root._inflightAction !== null
    root._pending = {}; root._inflightAction = null; root._ipcAbilityStreak = 0; root._lastAbility = ""
    root._actionStatus = ""; actionStatusTimer.stop()
    root._notifyQueue = []; root._actionAt = {}; root._lastNotified = {}; root._notifyLog = []; root._suppressed = Model.suppressedZero(); root._lastEvent = null
    root._drainTries = {}; deploymentReq.inflight = null
    root._recentLoaded = false; root._recentKey = ""; root._lastRecentKey = ""   // never writes; _configText re-arms the read
    for (var i = 0; i < root._reqs.length; i++) root._reqs[i].kill()
    root._syncBusy()
    if (interrupted) root._say("Action interrupted by a config change", "urgent")
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
    else if (root._cfg.warning) root._warning = { kind: "notify", title: "Notify setting ignored", detail: root._cfg.warning + "; using the default" }
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
    property double stopSince: 0
    running: false
    command: Api.argv()
    stdout: StdioCollector { id: out; waitForEnd: true }
    stderr: StdioCollector { id: err; waitForEnd: true }
    // write() then stdinEnabled = false closes curl's stdin (EOF), which is what
    // makes `curl -K -` start the transfer.
    onStarted: { liveSeq = seq; write(cfg); cfg = ""; stdinEnabled = false }
    onExited: function(code) { req.cfg = ""; req.stopping = false; root._finish(req, code, out.text, err.text) }
    function kill() { if (running) { seq += 1; stopping = true; stopSince = Date.now(); cfg = ""; running = false } }
    function escalate(now) {           // SIGTERM ignored: SIGKILL after 5 s, give up the flag after 10 s
      if (!stopping) return
      if (now - stopSince > 10000) { stopping = false; return }
      if (now - stopSince > 5000) { try { signal(9) } catch (e) {} }
    }
  }

  Req { id: versionReq }
  Req { id: deploymentsReq }
  Req { id: deploymentReq; property var inflight: null }   // { uuid } of the terminal fetch in flight; p.arg stays the descriptor list
  Req { id: resourcesReq }
  Req { id: serversReq }
  Req { id: topologyReq }
  Req { id: actionReq }                // single-flight; every action goes through _launch like a poll

  readonly property var _reqs: [versionReq, deploymentsReq, deploymentReq, resourcesReq, serversReq, topologyReq, actionReq]

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
    if (p === actionReq) { root._finishAction(p, code, stdoutText, stderrText); return }   // after the stale guard, never before
    var results = Model.splitResponses(stdoutText)
    if (results.length === 0) {
      root._fail(p.kind, Model.errorFor({ curlExit: code || 1, errmsg: stderrText, request: p.kind }), null)
      if (p.kind === "deployment") { root._drainDone(false, false); root._drainTerminal() }
      return
    }
    var anyOk = false, gone = false
    root._drainDispatched = false
    for (var i = 0; i < results.length; i++) {
      if (i >= p.arg.length) break               // more trailers than blocks: malformed stream
      var r = results[i]
      root._record(p.kind, r)
      var e = Model.errorFor({ curlExit: r.exit, httpCode: r.code, body: r.body, errmsg: r.errmsg, headers: r.headers, request: p.kind })
      if (e) {
        if (p.kind === "deployment" && r.code === 404) gone = true                     // vanished for good: no _fail, no retry
        else root._fail(p.kind, e, r.headers)
      } else {
        anyOk = true
        root._dispatch(p.arg[i], r, p.kind)
      }
    }
    if (anyOk) root._succeeded(p.kind)
    if (p.kind === "resources" || p.kind === "servers" || p.kind === "topology") root._rejoin()
    else if (p.kind === "deployments") root._joinDeployments()
    if (p.kind === "deployment") { root._drainDone(root._drainDispatched, gone); root._drainTerminal() }   // dispatch success, not HTTP success
    // Only a successful block can mark the cycle complete: a failed /projects leaves the
    // flag false so the 65 s kick, a panel open and the next cycle all retry it.
    // (A failed stage-2 block after a successful /projects still counts: the tree is usable.)
    if (p.kind === "topology" && (anyOk || root._projects.length)) { root._topologyFetched = root._topologyQueue.length === 0; if (root._topologyFetched) root._topologyLoaded = true }   // the next block waits for topologyStep
    root._flushNotify()                // last: after the joins, so every toast reads the joined snapshot
  }

  // ---- notifications (Phase 3) ---------------------------------------------------------

  function _queueNotify(evs) { root._notifyQueue = root._notifyQueue.concat((evs || []).filter(function(e) { return !!e })) }

  // true | false | null (the notifications service is unreachable: the toast keeps the
  // plugin id and is silenced under DND; status.notify.dnd reports null).
  function _dnd() {
    var n = root.shell && typeof root.shell.serviceFor === "function" ? root.shell.serviceFor("omarchy.notifications") : null
    if (!n || typeof n.doNotDisturb !== "boolean") return null
    return n.doNotDisturb
  }

  function _flushNotify() {
    var q = root._notifyQueue
    if (!q.length) return
    root._notifyQueue = []
    var now = Date.now()
    var log = root._notifyLog.filter(function(t) { return now - t < 60000 })
    var ctx = { notify: root._cfg ? root._cfg.notify : Model.notifyDefaults(),
                origin: root._instance ? Model.origin(root._instance.url) : "",
                dnd: root._dnd(), pending: root._pending, actionAt: root._actionAt,
                lastNotified: root._lastNotified, sentLastMin: log.length, now: now, pluginId: root.pluginId }
    var out = Model.notifyPlan(q, root.snapshot, ctx)
    out.notified.forEach(function(n) { root._lastNotified[n.key] = n.at }); root._lastNotified = root._lastNotified
    out.log.forEach(function(l) { console.log("coolwatch notify " + l) })          // event + uuid8 only, at intent
    for (var i = 0; i < out.argvs.length; i++) Util.execArgv(out.argvs[i])
    for (var j = 0; j < out.nonCritical; j++) log.push(now)         // critical toasts are exempt from the minute cap and never charge it
    root._notifyLog = log
    for (var k in out.suppressed) root._suppressed[k] = (root._suppressed[k] || 0) + out.suppressed[k]
    root._suppressed = root._suppressed
    if (out.argvs.length) root._lastEvent = { kind: out.lastKind, at: now }
  }

  function _notifiedLastMin() { var now = Date.now(); return root._notifyLog.filter(function(t) { return now - t < 60000 }).length }

  // Reaper tick: the action ledger keeps 300 s (the longest window a rule reads), the
  // dedupe ledger 3600 s (the "recovered" window). Mutate-then-self-assign, only on change.
  function _pruneNotify(now) {
    var a = root._actionAt, ka = Object.keys(a), changed = false
    if (ka.length) {
      for (var i = 0; i < ka.length; i++) if (now - a[ka[i]] > 300000) { delete a[ka[i]]; changed = true }
      if (changed) root._actionAt = a
    }
    var l = root._lastNotified, kl = Object.keys(l); changed = false
    if (!kl.length) return
    for (var j = 0; j < kl.length; j++) if (now - l[kl[j]] > 3600000) { delete l[kl[j]]; changed = true }
    if (changed) root._lastNotified = l
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
        // root._deployments still holds the previous poll; the baseline flag is read before _markPoll flips it.
        var diff = Model.diffDeployments(root._deployments, norm, !root._baseline.deployments)
        if (diff.vanished.length) {
          var q = root._terminalQueue.slice()
          diff.vanished.forEach(function(u) { if (q.indexOf(u) < 0 && q.length < 20) q.push(u) })
          root._terminalQueue = q
        }
        root._activeUuids = norm.map(function(d) { return d.uuid })
        root._deployments = norm
        root._markPoll("deployments", now)
        root._queueNotify(diff.events)
        root._drainTerminal()
        break
      }
      case "deployment": {
        // Joined here (the deployments-kind join at the end of _finish does not run for this
        // kind) so the toast body has a branch and recent carries appUuid at once. The
        // terminal toast fires once per uuid: `recent` is the intra-session ledger, and a
        // non-terminal status (a transient vanish) yields no event.
        var d = Model.joinBranch([Model.normaliseDeployment(json.value)], root._resources)[0]
        if (d.uuid) {
          root._drainDispatched = true
          if (!Model.hasTerminal(root._recent, d.uuid)) root._queueNotify([Model.terminalEvent(d)])
          var rec = root._recent.filter(function(x) { return x.uuid !== d.uuid })
          rec.unshift(d)
          root._recent = rec.slice(0, 20)
          root._saveRecent()
          if (d.status === "failed" && root._baselineDone && root._openPanels === 0 && root._failedUnacked.indexOf(d.uuid) < 0)
            root._failedUnacked = root._failedUnacked.concat([d.uuid])
        }
        break
      }
      case "resources": {
        var nextRes = Model.normaliseResources(json.value)
        root._queueNotify(Model.resourceEvents(root._resourcesRaw, nextRes, !root._baseline.resources))
        root._resourcesRaw = nextRes
        root._markPoll("resources", now)
        break
      }
      case "servers": {
        var nextSrv = Model.normaliseServers(json.value)
        root._queueNotify(Model.serverEvents(root._servers, nextSrv, !root._baseline.servers))
        root._servers = nextSrv
        root._markPoll("servers", now)
        root._enqueueMissingServerResources()
        break
      }
      case "projects":
        root._projects = Model.normaliseProjects(json.value)
        root._markPoll("topology", now)
        root._topologyStage2()
        break
      case "project": {
        var envs = root._envsByProject; envs[req.arg] = Model.environmentsOf(json.value); root._envsByProject = envs
        break
      }
      case "serverResources": {
        var bs = root._byServer; bs[req.arg] = Model.serverResourceUuids(json.value); root._byServer = bs
        break
      }
    }
    console.log("coolwatch " + req.kind + " " + r.code + " exit=" + r.exit + " " + r.timeMs + "ms " + r.bytes + "B")
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
    root._joinDeployments()
  }

  function _joinDeployments() {
    root._deployments = Model.joinBranch(root._deployments, root._resources)
    root._recent = Model.joinBranch(root._recent, root._resources)
  }

  // Stage 2 is spread one block per topologyStep tick (40 s) so the fan-out never
  // adds more than 2 requests to any 60 s window; the 20/min line is a sliding window.
  // Server membership first (few blocks, and "group by server" depends on it), then
  // the per-project environment lists. Descriptors already queued are kept, not replaced.
  function _topologyStage2() {
    var q = root._topologyQueue.slice()
    var have = {}
    q.forEach(function(d) { have[d.kind + ":" + d.arg] = true })
    root._servers.forEach(function(s) { if (!have["serverResources:" + s.uuid]) q.push(Api.reqServerResources(s.uuid)) })
    root._projects.forEach(function(p) { if (!have["project:" + p.uuid]) q.push(Api.reqProject(p.uuid)) })
    root._topologySec = Model.topologyIntervalSec(root._cfg ? root._cfg.poll.topologySec : 600, root._projects.length, root._servers.length)
    root._topologyQueue = q
    if (!q.length) { root._topologyFetched = true; root._topologyLoaded = true }
    // The first block waits for topologyStep like the rest: a burst of P + S blocks
    // right after /projects is what pushed a 60 s window past the budget.
  }

  function _topologyStep() {
    if (!root._ready || root._paused || root._probeMode || topologyReq.running || topologyReq.stopping) return
    if (!root._topologyQueue.length) return
    if (root._backoffUntil("topology") > Date.now()) return
    var q = root._topologyQueue.slice()
    var d = q.shift()
    root._topologyQueue = q
    root._lastTopologyStepAt = Date.now()
    root._launch(topologyReq, [d], 8)
  }

  // A server that answered after stage 2 was built (or a stage 2 that never ran)
  // gets its resource list on the next ticks instead of at the next topology cycle.
  function _enqueueMissingServerResources() {
    if (!root._projects.length && !root._topologyFetched) return
    var q = root._topologyQueue.slice()
    var queued = {}
    q.forEach(function(d) { if (d.kind === "serverResources") queued[d.arg] = true })
    var added = false
    root._servers.forEach(function(s) { if (!root._byServer[s.uuid] && !queued[s.uuid]) { q.push(Api.reqServerResources(s.uuid)); added = true } })
    if (added) { root._topologyQueue = q; root._topologyFetched = false }
  }

  function _drainTerminal() {
    if (!root._ready || root._paused || root._probeMode || deploymentReq.running || deploymentReq.stopping || !root._terminalQueue.length) return
    if (root._backoffUntil("deployment") > Date.now()) return
    var q = root._terminalQueue.slice()
    var uuid = q.shift()
    root._terminalQueue = q
    deploymentReq.inflight = { uuid: uuid }
    root._launch(deploymentReq, Api.reqDeployment(uuid), 6)
  }

  // The one place a terminal fetch's outcome is settled (called from _finish and the reaper
  // before the next _drainTerminal). ok: dispatched; gone: 404. Anything else re-queues.
  function _drainDone(ok, gone) {
    var f = deploymentReq.inflight; deploymentReq.inflight = null
    if (!f || !f.uuid) return
    var t = root._drainTries
    if (ok || gone) {
      if (gone) console.log("coolwatch drain 404 " + Model.uuid8(f.uuid))
      if (Object.prototype.hasOwnProperty.call(t, f.uuid)) { delete t[f.uuid]; root._drainTries = t }
      return
    }
    var n = (t[f.uuid] || 0) + 1
    if (n > 2) { delete t[f.uuid]; root._drainTries = t; console.log("coolwatch drain gave up " + Model.uuid8(f.uuid)); return }
    var q = root._terminalQueue.slice()
    if (q.indexOf(f.uuid) >= 0 || q.length >= 20) { delete t[f.uuid]; root._drainTries = t; return }   // already queued, or the cap: no retry is scheduled, so none is counted
    t[f.uuid] = n; root._drainTries = t; root._drainRetries += 1
    q.push(f.uuid)                                                   // the back: one failing uuid must not stall the healthy ones twice
    root._terminalQueue = q
  }

  // ---- errors, backoff, pause, probe ---------------------------------------------------

  function _succeeded(kind) {
    var b = root._backoff; if (b[kind]) { delete b[kind]; root._backoff = b }
    if (root._error && root._error.request === kind) root._error = null
    if (root._probeMode) { root._probeMode = false; root._prime("all"); root._drainTerminal() }
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
      root._pauseFor(headers)
    } else if (e.kind !== "ability") {
      var bo = root._backoff; var a = ((bo[kind] && bo[kind].attempt) || 0) + 1
      bo[kind] = { until: Date.now() + (a <= 1 ? 30 : 60) * 1000, attempt: a }; root._backoff = bo
    }
    console.warn("coolwatch " + kind + " failed: " + e.kind + " http=" + e.httpCode + " exit=" + e.curlExit + " " + e.detail)
  }

  // 429 is instance-wide: pause every timer for Retry-After (clamped) or the ladder.
  // Shared by _fail and _finishAction; touches nothing but the pause state.
  function _pauseFor(headers) {
    var b = root._backoff; var attempt = ((b.ratelimited && b.ratelimited.attempt) || 0) + 1
    root._backoffSec = Model.retryAfterSec(headers, attempt)
    b.ratelimited = { until: Date.now() + root._backoffSec * 1000, attempt: attempt }; root._backoff = b
    root._paused = true
    pauseTimer.interval = root._backoffSec * 1000
    pauseTimer.restart()
  }

  function _backoffUntil(kind) { var b = root._backoff[kind]; return b ? b.until : 0 }
  function _maxBackoffUntil() { var m = 0; for (var k in root._backoff) if (k !== "action") m = Math.max(m, root._backoff[k].until); return m }

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

  function _actionsLastMin() {
    var now = Date.now()
    return root._actionLog.filter(function(t) { return now - t < 60000 }).length
  }

  // ---- actions (Phase 2) ---------------------------------------------------------------
  // act() is the only path to _launch for an action; the panel, both monitors and the
  // IPC verbs call it. Model.actionRequest is the single applicability gate (SR3);
  // Api builds the descriptor here because Model never imports Api.

  // targetHint: the panel passes the row type so a vanished target is named correctly.
  function act(verb, uuid, fromIpc, targetHint) {
    if (!root._ready) return root._refuse(root._error && root._error.kind === "unsafe" ? "unsafe" : "notconfigured", verb, uuid)
    if (root._probeMode) return root._refuse("probe", verb, uuid)
    if (root._paused) return root._refuse("ratelimited", verb, uuid)
    if (root._requestsLastMin() >= 120) return root._refuse("toomany", verb, uuid)
    var a = Model.actionRequest(root.snapshot, verb, uuid)
    if (!a.ok) return root._refuse(a.why, verb, uuid, targetHint)
    if (fromIpc && root._ipcAbilityStreak >= 3) return root._refuse("ipcability", a.verb, uuid)
    var why = Model.canAct(root._pending, root._inflightAction, a.uuid, Date.now(), root._lastActionLaunchAt)
    if (why) return root._refuse(why, a.verb, a.uuid)
    var req = root._descriptorFor(a)
    if (!req) return root._refuse("notapplicable", a.verb, a.uuid)
    root._inflightAction = { verb: a.verb, uuid: a.uuid, name: a.name, targetType: a.targetType, kind: a.kind, status: a.status, at: Date.now(), fromIpc: !!fromIpc }
    root._setPending(root._inflightAction, null)
    root._lastActionLaunchAt = Date.now()
    var log = root._actionLog.filter(function(t) { return Date.now() - t < 60000 }); log.push(Date.now()); root._actionLog = log
    if (!root._launch(actionReq, req, 10)) {
      root._clearPending(a.uuid); root._inflightAction = null
      return root._refuse("busy", a.verb, a.uuid)
    }
    console.log("coolwatch action launch " + a.verb + " " + a.uuid.slice(0, 8) + (fromIpc ? " ipc" : ""))
    return "queued"
  }

  function _descriptorFor(a) {
    switch (a.verb) {
      case "deploy": case "redeploy": return Api.reqDeploy(a.uuid, false)
      case "rebuild": return Api.reqDeploy(a.uuid, true)
      case "start": case "stop": case "restart": return Api.reqLifecycle(a.kind, a.uuid, a.verb)
      case "cancel": return Api.reqCancel(a.uuid)
      case "validate": return Api.reqValidate(a.uuid)
      default: return null
    }
  }

  // Local refusals: one status line each, no request, lastAction.result "refused".
  // Returns the IPC token; the panel reads the status line.
  function _refuse(why, verb, uuid, targetHint) {
    // The uuid is caller input: bounded and single-line before it reaches stdout; the log gets 8 chars.
    var u = String(uuid || "").replace(/[\r\n\t]/g, " ").slice(0, 64), u8 = u.slice(0, 8), token = why
    switch (why) {
      case "notconfigured": root._say("Not configured", "urgent"); token = "not configured"; break
      case "unsafe": root._say("Config is unsafe", "urgent"); token = "config unsafe"; break
      case "probe": root._say("Token rejected", "urgent"); token = "token rejected"; break
      case "ratelimited": root._say("Rate limited · backing off " + root._backoffSec + "s", "urgent"); token = "rate limited"; break
      case "toomany": root._say("Too many requests · try again shortly", "urgent"); token = "rate limited"; break
      case "invalid": case "unknown": {
        var word = targetHint === "deployment" || targetHint === "server" ? targetHint : "resource"
        root._say("Coolify no longer has that " + word, "urgent"); token = "unknown uuid " + u; break
      }
      case "notapplicable": root._say("Nothing to " + verb, "dim"); token = "not applicable " + verb + " " + u; break
      case "already pending": {
        var p = root._pending[u] || (root._inflightAction && root._inflightAction.uuid === u ? root._inflightAction : null)
        root._say((p && p.name ? p.name : "It") + " is already " + Model.gerund(p ? p.verb : verb), "dim"); token = "already pending " + u; break
      }
      case "busy": root._say("Busy, try again", "dim"); token = "busy"; break
      case "ipcability": root._say("Token lacks the " + (root._lastAbility || "required") + " permission", "urgent"); token = "refused: token lacks the " + (root._lastAbility || "required") + " permission"; break
      default: root._say("Nothing to " + verb, "dim")
    }
    root._lastAction = { verb: String(verb || ""), uuid8: u8, code: 0, curlExit: 0, ms: 0, at: Date.now(), result: "refused" }
    console.log("coolwatch action refuse " + why + " " + String(verb || "").slice(0, 16) + " " + u8)
    return token
  }

  // Called from _finish after _syncBusy() and the liveSeq guard. Never _fail, never
  // _error/_backoff/_probeMode/consecutiveFailures; the one escalation is a 429 pause.
  function _finishAction(p, code, out, err) {
    var a = root._inflightAction; root._inflightAction = null
    if (!a) return
    var rec = Model.splitResponses(out)[0] || { exit: code || 1, code: 0, body: "", timeMs: 0, bytes: 0, errmsg: "",
                                               headers: { retryAfter: null, rateLimitRemaining: null, rateLimitLimit: null } }
    var o = Model.actionOutcome(a.verb, a.targetType, rec)
    root._record("action", rec)
    var limited = !!(o.error && o.error.kind === "ratelimited")
    if (limited) root._pauseFor(rec.headers)
    // Any non-2xx clears pending (a 429 answers before the action runs); only a reap keeps it.
    if (o.ok) root._setPending(a, o.deploymentUuid)
    else root._clearPending(a.uuid)
    if (o.error && o.error.kind === "ability") {
      root._lastAbility = Model.abilityOf(o.error.detail) || ""
      if (a.fromIpc) root._ipcAbilityStreak += 1
    } else if (o.ok) root._ipcAbilityStreak = 0
    var result = o.ok ? (o.deploymentUuid ? "queued" : "ok") : (o.error ? (o.error.kind === "ability" ? "ability" : (o.error.kind === "offline" ? "offline" : "http")) : "http")
    root._say(o.text, o.tone)
    root._lastAction = { verb: a.verb, uuid8: a.uuid.slice(0, 8), code: rec.code, curlExit: rec.exit, ms: rec.timeMs, at: Date.now(), result: result }
    console.log("coolwatch action " + a.verb + " " + rec.code + " exit=" + rec.exit + " " + rec.timeMs + "ms " + a.uuid.slice(0, 8))
  }

  function _say(text, tone) {
    root._actionStatus = String(text || "")
    root._actionTone = tone === "urgent" ? "urgent" : "dim"
    actionStatusTimer.interval = tone === "urgent" ? 6000 : 2200
    actionStatusTimer.restart()
  }

  function _copyPending() { var p = {}; for (var k in root._pending) p[k] = root._pending[k]; return p }

  function _setPending(a, depUuid) {
    var p = root._copyPending(); var ex = p[a.uuid]
    p[a.uuid] = { verb: a.verb, targetType: a.targetType, kind: a.kind || null, name: a.name || "",
                  since: ex ? ex.since : Date.now(),
                  baseStatus: a.targetType === "resource" ? (a.status || null) : null,
                  baseState: a.targetType === "resource" ? Model.parseStatus(a.status || "").state : null,
                  deploymentUuid: depUuid || (ex ? ex.deploymentUuid : null), stale: !!(ex && ex.stale) }
    root._pending = p
    root._actionAt[a.uuid] = Date.now(); root._actionAt = root._actionAt   // a user action explains a later flap (Phase 3)
  }

  function _clearPending(uuid) {
    if (!Object.prototype.hasOwnProperty.call(root._pending, uuid)) return
    var p = root._copyPending(); delete p[uuid]; root._pending = p
  }

  // The per-verb clear table (docs/architecture.md, Actions). Runs on the reaper tick;
  // reassigns _pending only when an entry was dropped or flipped to stale.
  function _expirePending(now) {
    var keys = Object.keys(root._pending)
    if (!keys.length) return
    var p = root._copyPending(), changed = false
    for (var i = 0; i < keys.length; i++) {
      var u = keys[i], e = p[u], drop = false
      var res = null, srv = null, dep = null
      if (e.targetType === "resource") res = root._resources.filter(function(r) { return r.uuid === u })[0] || null
      else if (e.targetType === "server") srv = root._servers.filter(function(s) { return s.uuid === u })[0] || null
      else dep = root._deployments.filter(function(d) { return d.uuid === u })[0] || null
      var gone = e.targetType === "resource" ? !res : (e.targetType === "server" ? !srv : !dep)
      if (gone || now - e.since >= Model.PENDING_DROP_MS) drop = true
      else if (e.verb === "deploy" || e.verb === "redeploy" || e.verb === "rebuild" || e.verb === "restart") {
        if (e.deploymentUuid) {
          // Seen in the active list or in recent; or two deployments polls have run since the
          // action without listing it (a deployment shorter than the poll interval): the
          // deployment row, not this entry, carries the state from here.
          drop = root._activeUuids.indexOf(e.deploymentUuid) >= 0 || root._recent.some(function(d) { return d.uuid === e.deploymentUuid })
              || (root._lastPollAt.deployments || 0) > e.since + 10000
        } else if (e.kind === "application") {
          // Before the response names the deployment: only a deployment created for this
          // action (not one already running) clears it.
          drop = root._deployments.some(function(d) { return d.appUuid === u && Date.parse(d.createdAt || "") >= e.since - 5000 })
        } else {
          drop = (root._lastPollAt.resources || 0) > e.since + 2000
        }
      } else if (e.verb === "stop" || e.verb === "start") {
        // Prefix match on the state (AGENTS.md): a health blip must not clear a stop.
        if (Model.parseStatus(res.status || "").state !== e.baseState) drop = true
        else if (!e.stale && now - e.since >= Model.PENDING_STALE_MS) { e.stale = true; p[u] = e; changed = true }
      } else if (e.verb === "validate") {
        drop = (root._lastPollAt.servers || 0) > e.since + 2000
      }
      // cancel: the deployment leaving the active list is the `gone` case above
      if (drop) { delete p[u]; changed = true }
    }
    if (changed) root._pending = p
  }

  Timer { id: actionStatusTimer; interval: 2200; repeat: false; running: false; onTriggered: root._actionStatus = "" }

  // ---- scheduler -----------------------------------------------------------------------

  function _pollVersion() { if (root._backoffUntil("version") <= Date.now()) root._launch(versionReq, Api.reqVersion(), 6) }
  function _pollDeployments() { if (root._backoffUntil("deployments") <= Date.now()) root._launch(deploymentsReq, Api.reqDeployments(), 6) }
  function _pollResources() { if (root._backoffUntil("resources") <= Date.now()) root._launch(resourcesReq, Api.reqResources(), 10) }
  function _pollServers() { if (root._backoffUntil("servers") <= Date.now()) root._launch(serversReq, Api.reqServers(), 10) }
  // A tick that lands while stage 2 is still draining is skipped: the queue finishes first.
  function _pollTopology() {
    if (root._topologyQueue.length || topologyReq.running || topologyReq.stopping) return
    if (root._backoffUntil("topology") <= Date.now()) root._launch(topologyReq, [Api.reqProjects()], 8)
  }

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
          onTriggered: { root._pollServers(); root._selfHeal(); if (!root._baseline.version) root._pollVersion() } }
  Timer { id: topologyTimer; interval: root._topologySec * 1000; repeat: true; triggeredOnStart: false; running: root._timersOn
          onTriggered: root._pollTopology() }
  // Startup spreads its requests: 4 kinds at token-ready, /projects at +65 s (outside the
  // first minute's burst), then one stage-2 block every 40 s, so no 60 s window holds
  // more than 2 topology requests.
  // The kick is skipped when a panel opening already drained the topology (with 10 s
  // spacing the first drain finishes before 65 s; the kick would run the fan-out twice).
  Timer { id: topologyKick; interval: 65000; repeat: false; running: false; onTriggered: if (root._ready && !root._topologyLoaded) root._pollTopology() }
  // One block per 10 s while a panel is open and the topology is incomplete (six blocks
  // in the first minute on top of the ≈20/min panel-open idle rate stays under the 60
  // line); 40 s otherwise, so the closed-panel "under 20" bar is untouched. A running
  // Timer restarts on an interval change, so opening a panel mid-drain re-arms at 10 s.
  // The fast spacing applies to the first drain only (the latch), so the periodic
  // refresh keeps the 40 s cadence. A Timer restarts on an interval change, so a panel
  // opening or closing mid-drain launches at once when the last block is already older
  // than the new interval (the _catchUp shape) instead of waiting a whole interval again.
  Timer { id: topologyStep; interval: root._panelOpen && !root._topologyLoaded ? 10000 : 40000; repeat: true; triggeredOnStart: false; running: root._timersOn && root._topologyQueue.length > 0
          onTriggered: root._topologyStep()
          onIntervalChanged: if (root._topologyQueue.length && Date.now() - root._lastTopologyStepAt >= interval) root._topologyStep() }

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
  Timer { id: pauseTimer; interval: 30000; repeat: false; running: false; onTriggered: { root._paused = false; root._prime("all"); root._drainTerminal() } }

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
        p.escalate(now)
        if (p.running && p.deadline > 0 && now > p.deadline) {
          p.kill()
          var pk = root._perKindEntry(p.kind)
          pk.reaps += 1; pk.lastReapAt = now
          if (p === actionReq) {
            // A reaped POST may have landed: pending stays, no backoff, no retry (SR7).
            root._perKind = root._perKind
            var ia = root._inflightAction; root._inflightAction = null
            root._say("Sent, but Coolify did not answer", "urgent")
            root._lastAction = { verb: ia ? ia.verb : "", uuid8: ia ? ia.uuid.slice(0, 8) : "", code: 0, curlExit: 0, ms: 0, at: now, result: "reaped" }
            console.warn("coolwatch reaped action")
            continue
          }
          pk.consecutiveFailures += 1
          root._perKind = root._perKind
          var bo = root._backoff; var a = ((bo[p.kind] && bo[p.kind].attempt) || 0) + 1
          bo[p.kind] = { until: now + (a <= 1 ? 30 : 60) * 1000, attempt: a }; root._backoff = bo
          console.warn("coolwatch reaped " + p.kind)
          if (p.kind === "deployment") { root._drainDone(false, false); root._drainTerminal() }
        }
      }
      var changed = false
      for (var id in root._panels) if (now - root._panels[id] > 5000) { delete root._panels[id]; changed = true }
      if (changed) { root._panels = root._panels; root._syncOpenPanels() }
      root._expirePending(now)
      root._pruneNotify(now)
      root._syncBusy()
    }
  }

  Component.onCompleted: mkdirProc.running = true

  Component.onDestruction: {
    reaper.running = false
    deploymentsTimer.running = false; resourcesTimer.running = false; serversTimer.running = false; topologyTimer.running = false
    startupRamp.running = false; probeTimer.running = false; pauseTimer.running = false; topologyKick.running = false; topologyStep.running = false
    actionStatusTimer.running = false
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
      topologyLoaded: root._topologyLoaded,
      terminalQueue: root._terminalQueue.length,
      drainRetries: root._drainRetries,
      recentPersisted: root._recentPersisted,
      recentRejected: root._recentRejected,
      error: root._error ? { kind: root._error.kind, request: root._error.request, httpCode: root._error.httpCode, curlExit: root._error.curlExit } : null,
      warning: root._warning ? root._warning.kind : null,
      bar: { glyph: "U+" + root.bar.glyph.codePointAt(0).toString(16).toUpperCase(), dimmed: root.bar.dimmed, active: root.bar.active },
      topologyQueue: root._topologyQueue.length,
      lastAction: root._lastAction,
      pending: Object.keys(root._pending).length,
      pendingStale: Object.keys(root._pending).filter(function(k) { return !!root._pending[k].stale }).length,
      actionsLastMin: root._actionsLastMin(),
      inflightAction: root._inflightAction !== null,
      baseline: { deployments: root._baseline.deployments, resources: root._baseline.resources, servers: root._baseline.servers, version: root._baseline.version },
      notify: {
        enabled: root._cfg ? root._cfg.notify : Model.notifyDefaults(),
        warning: root._cfg && root._cfg.warning ? root._cfg.warning : null,   // visible even when another warning holds the callout
        sentLastMin: root._notifiedLastMin(),
        suppressed: root._suppressed,     // cumulative per rule since the last config change
        queued: root._notifyQueue.length,
        lastEvent: root._lastEvent,       // { kind: <event name>, at }; never a name
        dnd: (function() { var d = root._dnd(); return d === null ? null : (d ? "on" : "off") })()
      }
    }
  }

  // CLI verbs never confirm: typing the verb is the confirmation. The result is the
  // stdout token and status.lastAction; omarchy-shell exits 0 on dispatch regardless.
  function _ipcAct(verb, uuid) {
    var u = String(uuid === undefined || uuid === null ? "" : uuid).replace(/[\r\n\t]/g, " ").trim()
    if (!u) return "usage: " + verb + " <uuid>"
    var r = root.act(verb, u, true)
    var token = r === "queued" ? "queued " + verb + " " + u.slice(0, 64) : r
    console.log("coolwatch ipc " + verb + " " + u.slice(0, 8) + " -> " + token.split(" ")[0])
    return token
  }

  IpcHandler {
    target: "io.github.danjonesio.coolwatch"
    function refresh(): string { root.refresh(); return "ok" }
    function status(): string { return JSON.stringify(root._status()) }
    function deploy(uuid: string): string { return root._ipcAct("deploy", uuid) }
    function restart(uuid: string): string { return root._ipcAct("restart", uuid) }
    function stop(uuid: string): string { return root._ipcAct("stop", uuid) }
    function start(uuid: string): string { return root._ipcAct("start", uuid) }
  }
}
