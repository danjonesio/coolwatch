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
  property var _error: null            // Model error object or null
  property var _warning: null
  property bool _ready: false
  property string _version: ""
  property var _perKind: ({})
  property var _requestLog: []
  property int _backoffSec: 0
  property bool _needToken: false

  readonly property var snapshot: ({
    instance: root._instance ? { id: root._instance.id, name: root._instance.name, url: root._instance.url, version: root._version, plaintext: root._instance.plaintext } : null,
    error: root._error, warning: root._warning,
    servers: [], resources: [], deployments: [], recent: [], tree: [], byServer: {},
    failedUnacked: [], lastPollAt: {}, busy: false, openPanels: 0, baselineDone: false,
    backoffSec: root._backoffSec
  })
  readonly property var bar: Model.barState(root.snapshot)

  function refresh() {
    root._selfHeal()
    root._primeAll()
  }

  // Re-arm the directory watch (a removed directory strands it) and re-stat; the
  // config text is only re-read when nothing is loaded, so a refresh never cascades.
  function _selfHeal() { mkdirProc.running = true }

  function _primeAll() {
    if (root._ready) root._launch(versionReq, Api.reqVersion(), 6)
  }

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
    onFileChanged: { configFile.reload(); root._stat() }
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
    command: ["stat", "-c", "%a %U", root.configPath]
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

  // Start rather than restart: a stat already in flight answers for the current file;
  // a change that lands meanwhile is replayed from onExited.
  function _stat() {
    if (statProc.running) root._statPending = true
    else statProc.running = true
  }

  function _configText(t) {
    root._version = ""
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
    root._needToken = true
    root._error = null
    root._stat()                       // token resolution continues in _applyStat
  }

  function _applyStat(text) {
    var parts = String(text || "").trim().split(/\s+/)
    root._configMode = parts[0] || ""
    root._configOwner = parts[1] || ""
    if (!root._cfg) return
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
    root._primeAll()
  }

  function _setError(e) {
    root._error = e
  }

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
    running: false
    command: Api.argv()
    stdout: StdioCollector { id: out; waitForEnd: true }
    stderr: StdioCollector { id: err; waitForEnd: true }
    // write() then stdinEnabled = false closes curl's stdin (EOF), which is what
    // makes `curl -K -` start the transfer.
    onStarted: { liveSeq = seq; write(cfg); cfg = ""; stdinEnabled = false }
    onExited: function(code) { root._finish(req, code, out.text, err.text) }
  }

  Req { id: versionReq }

  readonly property var _reqs: [versionReq]

  function _launch(p, reqs, maxTime) {
    if (p.running) return false
    var list = Array.isArray(reqs) ? reqs : [reqs]
    p.seq += 1
    p.kind = Array.isArray(reqs) ? "topology" : reqs.kind
    p.arg = list
    p.deadline = Date.now() + (list.length * maxTime + 3) * 1000
    p.stdinEnabled = true
    p.cfg = Api.config(root._instance, root._token, list, maxTime)   // the only call site
    p.running = true
    root._noteRequest(p.kind, list.length)
    return true
  }

  function _finish(p, code, stdoutText, stderrText) {
    if (p.liveSeq !== p.seq) return
    var results = Model.splitResponses(stdoutText)
    if (results.length === 0) {
      root._fail(p.kind, Model.errorFor({ curlExit: code || 1, errmsg: stderrText, request: p.kind }))
      return
    }
    for (var i = 0; i < results.length; i++) {
      var r = results[i]
      root._record(p.kind, r)
      var e = Model.errorFor({ curlExit: r.exit, httpCode: r.code, body: r.body, headers: r.headers, request: p.kind })
      if (e) root._fail(p.kind, e)
      else root._dispatch(p.arg[i], r)
    }
  }

  function _dispatch(req, r) {
    if (req.kind === "version") {
      root._version = Model.parseVersion(r.body)
    }
    console.log("omarify " + req.kind + " " + r.code + " exit=" + r.exit + " " + r.timeMs + "ms " + r.bytes + "B")
  }

  function _fail(kind, e) {
    var pk = root._perKindEntry(kind)
    pk.consecutiveFailures += 1
    root._perKind = root._perKind
    console.warn("omarify " + kind + " failed: " + e.kind + " http=" + e.httpCode + " exit=" + e.curlExit + " " + e.detail)
  }

  function _record(kind, r) {
    var pk = root._perKindEntry(kind)
    pk.lastAt = Date.now(); pk.lastCode = r.code; pk.lastMs = r.timeMs; pk.lastBytes = r.bytes
    if (r.exit === 0 && r.code < 400) pk.consecutiveFailures = 0
    root._perKind = root._perKind
  }

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

  // Reaper: armed once, never restarted (tailscale lesson). A Req past its
  // deadline is killed; bumping seq first makes its onExited a no-op.
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
          p.seq += 1
          p.running = false
          var pk = root._perKindEntry(p.kind)
          pk.reaps += 1; pk.lastReapAt = now; pk.consecutiveFailures += 1
          root._perKind = root._perKind
          console.warn("omarify reaped " + p.kind)
        }
      }
    }
  }

  Component.onCompleted: mkdirProc.running = true

  Component.onDestruction: {
    reaper.running = false
    tokenCmd.running = false
    statProc.running = false
    mkdirProc.running = false
    for (var i = 0; i < root._reqs.length; i++) { root._reqs[i].seq += 1; root._reqs[i].running = false }
  }

  // ---- IPC ---------------------------------------------------------------------------
  function _status() {
    return {
      configState: root._error && root._error.kind !== "auth" && root._error.kind !== "offline" && root._error.kind !== "http" ? root._error.kind : (root._ready ? "ok" : "unconfigured"),
      configMode: root._configMode || null,
      tokenSource: root._ready ? root._tokenSource : null,
      instance: root._instance ? { id: root._instance.id, version: root._version } : null,
      counts: { servers: 0, resources: 0, deployments: 0, recent: 0 },
      perKind: root._perKind,
      requestsLastMin: root._requestsLastMin(),
      rateLimitRemaining: null,
      backoffUntil: 0,
      openPanels: 0,
      baselineDone: false,
      error: root._error ? { kind: root._error.kind, httpCode: root._error.httpCode, curlExit: root._error.curlExit } : null,
      warning: root._warning ? root._warning.kind : null
    }
  }

  IpcHandler {
    target: "io.github.danjonesio.omarify"
    function refresh(): string { root.refresh(); return "ok" }
    function status(): string { return JSON.stringify(root._status()) }
  }
}
