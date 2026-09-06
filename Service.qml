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

  // Private. `_` is a naming convention, not access control: any plugin in this
  // shell can read these through shell.serviceFor(). The token is never placed in
  // argv, console output, snapshot, status or disk.
  property var _instance: null
  property string _token: ""
  property string _tokenSource: ""
  property bool _ready: false
  property string _version: ""
  property var _perKind: ({})
  property var _requestLog: []

  readonly property var snapshot: ({
    instance: root._instance ? { id: root._instance.id, name: root._instance.name, url: root._instance.url, version: root._version } : null,
    error: null, warning: null,
    servers: [], resources: [], deployments: [], recent: [], tree: [], byServer: {},
    failedUnacked: [], lastPollAt: {}, busy: false, openPanels: 0, baselineDone: false
  })
  readonly property var bar: ({ glyph: "󰅜", dimmed: true, active: false, tooltip: "Omarify — starting" })

  function refresh() {
    if (root._ready) root._launch(versionReq, Api.reqVersion(), 6)
  }

  // ---- config (temporary loader; replaced in step 6) -----------------------------
  FileView {
    id: configFile
    path: root.configPath
    printErrors: false
    onLoaded: root._tempLoadConfig(text())
    onLoadFailed: root._ready = false
  }
  function _tempLoadConfig(t) {
    try {
      var c = JSON.parse(t)
      var i = c.instances[0]
      root._instance = { id: String(i.id || ""), name: String(i.name || ""), url: String(i.url || "") }
      root._token = String(i.token || "")
      root._tokenSource = "file"
      root._ready = root._token.length > 0 && root._instance.url.length > 0
    } catch (e) {
      root._ready = false
    }
    if (root._ready) root.refresh()
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
      root._fail(p.kind, { kind: "http", httpCode: 0, curlExit: code, detail: "curl " + code + ": " + Model.elide(Model.redact(stderrText), 140) })
      return
    }
    for (var i = 0; i < results.length; i++) {
      var r = results[i]
      root._record(p.kind, r)
      if (r.exit !== 0 || r.code >= 400) {
        root._fail(p.kind, { kind: "http", httpCode: r.code, curlExit: r.exit, detail: Model.elide(Model.redact(r.errmsg || r.body), 140) })
      } else {
        root._dispatch(p.arg[i], r)
      }
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
    console.warn("omarify " + kind + " failed: http=" + e.httpCode + " exit=" + e.curlExit + " " + e.detail)
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

  Component.onDestruction: {
    reaper.running = false
    for (var i = 0; i < root._reqs.length; i++) { root._reqs[i].seq += 1; root._reqs[i].running = false }
  }

  // ---- IPC ---------------------------------------------------------------------------
  function _status() {
    return {
      configState: root._ready ? "ok" : "unconfigured",
      configMode: null,
      tokenSource: root._ready ? root._tokenSource : null,
      instance: root._instance ? { id: root._instance.id, version: root._version } : null,
      counts: { servers: 0, resources: 0, deployments: 0, recent: 0 },
      perKind: root._perKind,
      requestsLastMin: root._requestsLastMin(),
      rateLimitRemaining: null,
      backoffUntil: 0,
      openPanels: 0,
      baselineDone: false,
      error: null
    }
  }

  IpcHandler {
    target: "io.github.danjonesio.omarify"
    function refresh(): string { root.refresh(); return "ok" }
    function status(): string { return JSON.stringify(root._status()) }
  }
}
