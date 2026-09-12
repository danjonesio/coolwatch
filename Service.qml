import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons                    // Util.execArgv for the notification helper (Phase 3)
import "Model.js" as Model
import "Api.js" as Api

// One service per shell; one InstanceCtx per configured instance (Phase 4). The root owns
// the config file, the panel registry, the notification minute budget, the reaper and the
// public surface; every store, timer, request, ledger, baseline, pending map, notify state
// and state file lives in its instance's context. `snapshot`, `bar`, `views`, `pending` and
// the action surface mirror the active instance, so every panel and every documented
// command keeps working unchanged with one instance.
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

  // Private. `_` is a naming convention, not access control: any plugin in this
  // shell can read these through shell.serviceFor(). Tokens are never placed in
  // argv, console output, snapshot, status or disk; each context holds its own, so the
  // exposure through serviceFor scales with the instance count (SR34).
  property var _cfg: null              // Model.normaliseConfig result
  property var _configError: null      // noconfig / configerror / unsafe: no context can run; shown over the active context's own error
  property string _configMode: ""
  property string _configOwner: ""
  property bool _statPending: false
  property string _stamp: ""           // "inode mtime" of the config the contexts were built from
  property bool _acceptStamp: false    // the reload in flight owns the next stamp
  property var _panels: ({})           // panelId -> last alive ms
  property var _panelCandidates: ({})  // panelId -> first alive ms seen while unregistered
  property int _openPanels: 0
  readonly property bool _panelOpen: root._openPanels > 0
  readonly property string pluginId: "io.github.danjonesio.coolwatch"
  property var _notifyLog: []          // bare timestamps: the ≤ 12 non-critical toasts a minute is per shell, charged through _chargeNotify
  property bool _stateDirReady: false
  readonly property string sensitiveMessage: "Logs need the read:sensitive ability. Create a new token under Security → API Tokens with read, read:sensitive and deploy, and swap it in."

  // Contexts. `_instanceIds` is the config order (recentPath reads an id's index); the
  // Instantiator runs on `idModel`, edited in place by _setInstanceIds; _ctxs is rebuilt
  // from onObjectAdded/onObjectRemoved, never read through objectAt().
  property var _instanceIds: []
  property var _ctxs: []
  property string _activeId: ""
  readonly property var _active: root._ctxs.filter(function(c) { return c.instId === root._activeId })[0] || root._ctxs[0] || null

  // ---- public: the active context, mirrored -------------------------------------------

  readonly property var snapshot: root._active ? root._overlayConfigError(root._active.snapshot) : root._emptySnapshot()
  readonly property var bar: (function() {
    var b = Model.barState(root.snapshot), t = root.trouble
    if (t) b.tooltip = b.tooltip + " · " + t
    return b
  })()
  readonly property var views: root._active ? root._active.views : ({ buildLogs: {}, containerLogs: {}, picks: {}, history: {} })
  readonly property var pending: root._active ? root._active.pending : ({})
  readonly property string actionStatus: root._active ? root._active.actionStatus : ""
  readonly property string actionTone: root._active ? root._active.actionTone : "dim"
  // Chips input and the bar tooltip suffix (Model.instanceChips / instanceTrouble).
  readonly property var instances: root._ctxs.map(function(c) { return c.summary })
  readonly property string activeId: root._activeId
  readonly property string trouble: Model.instanceTrouble(root.instances, root._activeId)

  function refresh() {
    root._selfHeal()
    root._ctxs.forEach(function(c) { c._prime("all") })
  }
  function selectInstance(id) {
    id = String(id || "")
    if (root._instanceIds.indexOf(id) < 0) return false
    if (root._activeId !== id) root._activeId = id
    return true
  }
  function cycleInstance(dx) {
    var ids = root._instanceIds
    if (ids.length < 2) return
    var i = ids.indexOf(root._activeId); if (i < 0) i = 0
    root._activeId = ids[((i + (dx < 0 ? -1 : 1)) % ids.length + ids.length) % ids.length]
  }

  function panelOpened(id) {
    var p = root._panels; p[String(id)] = Date.now(); root._panels = p
    root._syncOpenPanels()
    root.acknowledgeFailures()
    if (root._active) root._active._panelOpened()
  }
  function panelClosed(id) {
    var p = root._panels; delete p[String(id)]; root._panels = p
    root._syncOpenPanels()
    root.closeView(id)
  }
  // Also the re-registration path: a hot-reloaded service starts with an empty
  // registry and open panels ping every second. A single stray ping does not register;
  // two within 2.5 s (a panel that is really open) do. `viewUuid` (Phase 4) re-asserts
  // the build log the panel is showing every second, so a candidate panel never loses it.
  function panelAlive(id, viewUuid) {
    var key = String(id), now = Date.now()
    if (root._active) root._active._setLogTarget(key, viewUuid)
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
  function acknowledgeFailures() { if (root._active) root._active.acknowledgeFailures() }
  function _syncOpenPanels() { root._openPanels = Object.keys(root._panels).length }

  // Actions and view fetches resolve against the active context; `instanceId` (the panel's
  // confirm dialog captures it) makes a context refuse an action opened on another one (SR38).
  function act(verb, uuid, fromIpc, targetHint, instanceId) {
    if (!root._active) return root._refuseNoContext(verb, uuid)
    return root._active.act(verb, uuid, fromIpc, targetHint, instanceId)
  }
  function _refuseNoContext(verb, uuid) {
    console.log("coolwatch action refuse notconfigured " + String(verb || "").slice(0, 16))
    return root._configError && root._configError.kind === "unsafe" ? "config unsafe" : "not configured"
  }
  function openBuildLog(panelId, uuid) { if (root._active) root._active.openBuildLog(panelId, uuid) }
  function refetchBuildLog(uuid) { if (root._active) root._active.refetchBuildLog(uuid) }
  function closeView(panelId) { root._ctxs.forEach(function(c) { c.closeView(panelId) }) }   // every context: a view survives no instance switch
  function fetchContainerLog(kind, uuid, label) { if (root._active) root._active.fetchContainerLog(kind, uuid, label) }
  function fetchContainerLogSub(uuid, sub, label) { if (root._active) root._active.fetchContainerLogSub(uuid, sub, label) }
  function fetchHistory(appUuid, skip, label) { if (root._active) root._active.fetchHistory(appUuid, skip, label) }
  function fetchTags() { if (root._active) root._active.fetchTags() }

  function _overlayConfigError(s) {
    if (!root._configError) return s
    var o = {}; for (var k in s) o[k] = s[k]
    o.error = root._configError
    return o
  }
  function _emptySnapshot() {
    return { instance: null, error: root._configError, warning: null,
             servers: [], resources: [], deployments: [], recent: [], tree: [], byServer: {},
             failedUnacked: [], lastPollAt: { deployments: 0, resources: 0, servers: 0, topology: 0, version: 0 },
             busy: false, openPanels: root._openPanels, baselineDone: false, backoffSec: 0, topologyFetched: false,
             tags: [], sensitive: "unknown", paused: false }
  }

  // ---- config (root) ----------------------------------------------------------------
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
    // _stateDirReady false: no recent file is then read or written by any context.
    command: ["bash", "-c", 'mkdir -m 700 -p "$1" "$2" && chmod 700 "$2"', "bash", root.configDirPath, root.stateDirPath]
    onExited: function(code) {
      configDir.path = ""
      configDir.path = root.configDirPath
      root._stateDirReady = code === 0             // a failed mkdir/chmod means no read and no write: the 0700 dir is the control
      if (code !== 0) console.warn("coolwatch state dir unavailable (mkdir exit " + code + ")")
      root._ctxs.forEach(function(c) { c._armRecent() })
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

  // Re-arm the directory watch (a removed directory strands it) and re-stat; the
  // config text is only re-read when nothing is loaded, so a refresh never cascades.
  function _selfHeal() { mkdirProc.running = true }

  // Start rather than restart: a stat already in flight answers for the current file;
  // a change that lands meanwhile is replayed from onExited.
  function _stat() {
    if (statProc.running) root._statPending = true
    else statProc.running = true
  }

  // Reconciled per instance id: a new id creates a context, a removed id releases one (its
  // Component.onDestruction kills its requests and drops its token), a changed entry resets
  // that context's store; unchanged entries keep theirs. A notify-only edit touches nothing.
  function _configText(t) {
    root._acceptStamp = true
    if (t !== null && t !== undefined && root._cfg) {
      // Same config text (an attribute change, a touch): keep every store, just re-stat.
      var again = Model.normaliseConfig(String(t))
      if (again.ok && JSON.stringify(again) === JSON.stringify(root._cfg)) { root._stat(); return }
      // A notify-only edit applies live: no reset, no new baseline, no killed request, no
      // token re-resolution (_stat -> _applyStat keeps the stamp bookkeeping and recomputes
      // the warnings; _needToken and _ready are untouched so _tokenReady does not re-fire).
      if (again.ok && JSON.stringify(Model.configSansNotify(again)) === JSON.stringify(Model.configSansNotify(root._cfg))) {
        root._cfg = again
        root._stat()
        return
      }
    }
    if (t === null || t === undefined || String(t).trim() === "") {
      root._cfg = null
      root._configError = Model.makeError("noconfig")
      root._setInstanceIds([])
      return
    }
    var c = Model.normaliseConfig(String(t))
    if (!c.ok) {
      root._cfg = null
      root._configError = Model.makeError("configerror", c.error)
      root._setInstanceIds([])
      return
    }
    root._cfg = c
    if (root._configError && root._configError.kind !== "unsafe") root._configError = null
    root._setInstanceIds(c.instances.map(function(i) { return i.id }))
    root._ctxs.forEach(function(x) { x._configApplied() })
    root._stat()                       // token resolution continues in _applyStat
  }
  // The Instantiator's model is a ListModel edited in place (a reassigned JS array would
  // tear down every context just to build identical ones, agents/Main.qml): a vanished id
  // is removed, a new id inserted, an existing one left alone (a reorder moves its row).
  function _setInstanceIds(ids) {
    if (JSON.stringify(ids) !== JSON.stringify(root._instanceIds)) root._instanceIds = ids   // first: a context created below reads its index at once
    for (var i = idModel.count - 1; i >= 0; i--) if (ids.indexOf(idModel.get(i).instId) < 0) idModel.remove(i)
    for (var j = 0; j < ids.length; j++) {
      var cur = -1
      for (var k = 0; k < idModel.count; k++) if (idModel.get(k).instId === ids[j]) { cur = k; break }
      if (cur < 0) idModel.insert(j, { instId: ids[j] })
      else if (cur !== j) idModel.move(cur, j, 1)
    }
    if (ids.indexOf(root._activeId) < 0) root._activeId = ids.length ? ids[0] : ""
    root._rebuildCtxs()                                       // a move adds and removes nothing, so the handlers stay silent (review: data 5)
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
      root._configError = Model.makeError("unsafe")
      root._ctxs.forEach(function(c) { c._halt() })
      return
    }
    if (root._configError && root._configError.kind === "unsafe") root._configError = null
    root._ctxs.forEach(function(c) { c._applyConfig() })
  }

  ListModel { id: idModel }            // one row per instance id, in config order
  Instantiator {
    id: ctxMaker
    model: idModel
    delegate: InstanceCtx {}           // instId arrives as the row's role
    onObjectAdded: (index, object) => root._rebuildCtxs()
    onObjectRemoved: (index, object) => root._rebuildCtxs()
  }
  function _rebuildCtxs() {
    var result = []
    for (var i = 0; i < ctxMaker.count; i++) { var c = ctxMaker.objectAt(i); if (c) result.push(c) }
    root._ctxs = result
  }

  // ---- HTTP client ----------------------------------------------------------------
  // One Process per request kind per context: kinds overlap but never stack. Every request is
  // a curl config on stdin (Api.config); the token is only ever inside that text.
  component Req: Process {
    id: req
    property var owner: null           // the InstanceCtx whose _finish settles this request
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
    onExited: function(code) { req.cfg = ""; req.stopping = false; owner._finish(req, code, out.text, err.text) }
    function kill() { if (running) { seq += 1; stopping = true; stopSince = Date.now(); cfg = ""; running = false } }
    function escalate(now) {           // SIGTERM ignored: SIGKILL after 5 s, give up the flag after 10 s
      if (!stopping) return
      if (now - stopSince > 10000) { stopping = false; return }
      if (now - stopSince > 5000) { try { signal(9) } catch (e) {} }
    }
  }

  // ---- notifications (Phase 3): the per-shell parts ------------------------------------

  // true | false | null (the notifications service is unreachable: the toast keeps the
  // plugin id and is silenced under DND; status.notify.dnd reports null).
  function _dnd() {
    var n = root.shell && typeof root.shell.serviceFor === "function" ? root.shell.serviceFor("omarchy.notifications") : null
    if (!n || typeof n.doNotDisturb !== "boolean") return null
    return n.doNotDisturb
  }
  function _notifiedLastMin() { var now = Date.now(); return root._notifyLog.filter(function(t) { return now - t < 60000 }).length }
  // Read and charge in one call: a context plans against what every context already sent.
  function _chargeNotify(n, now) {
    var log = root._notifyLog.filter(function(t) { return now - t < 60000 })
    for (var j = 0; j < n; j++) log.push(now)         // critical toasts are exempt from the minute cap and never charge it
    root._notifyLog = log
  }

  // Reaper: armed once, never restarted (tailscale lesson). Each context reaps its own
  // requests, pending entries and ledgers; the panel registry is the root's.
  Timer {
    id: reaper
    interval: 5000
    repeat: true
    running: true
    onTriggered: {
      var now = Date.now()
      root._ctxs.forEach(function(c) { c._reap(now) })
      var changed = false
      for (var id in root._panels) if (now - root._panels[id] > 5000) { delete root._panels[id]; changed = true; root.closeView(id) }
      if (changed) { root._panels = root._panels; root._syncOpenPanels() }
    }
  }

  Component.onCompleted: mkdirProc.running = true

  Component.onDestruction: {
    reaper.running = false
    statProc.running = false
    mkdirProc.running = false
    root._ctxs.forEach(function(c) { c._halt() })
  }

  // ---- IPC ---------------------------------------------------------------------------
  // Top-level keys mirror the active context; `instances[]` carries every context's status.
  function _status() {
    var a = root._active
    var s = a ? a._status() : root._emptyStatus()
    s.activeInstance = root._activeId || null
    s.instances = root._ctxs.map(function(c) { return c._status() })
    var total = 0; root._ctxs.forEach(function(c) { total += c._requestsLastMin() })
    s.requestsTotalLastMin = total
    s.bar = { glyph: "U+" + root.bar.glyph.codePointAt(0).toString(16).toUpperCase(), dimmed: root.bar.dimmed, active: root.bar.active, tooltip: root.bar.tooltip }   // the shell-wide bar: with the trouble suffix
    return s
  }
  // The same key set as a context's _status(), so the documented jq lines keep their shape
  // while nothing is configured (review: data 3).
  function _emptyStatus() {
    return { configState: root._configError ? root._configError.kind : "unconfigured", configMode: root._configMode || null, tokenSource: null,
             instance: null, counts: { servers: 0, resources: 0, deployments: 0, recent: 0 }, perKind: {}, requestsLastMin: 0,
             rateLimitRemaining: null, backoffUntil: 0, paused: false, probeMode: false, openPanels: root._openPanels, baselineDone: false,
             topologyFetched: false, topologyLoaded: false, terminalQueue: 0, drainRetries: 0, recentPersisted: 0, recentRejected: false,
             error: root._configError ? { kind: root._configError.kind, request: "", httpCode: 0, curlExit: 0 } : null, warning: null,
             bar: { glyph: "U+" + root.bar.glyph.codePointAt(0).toString(16).toUpperCase(), dimmed: root.bar.dimmed, active: root.bar.active },
             topologyQueue: 0, lastAction: null, pending: 0, pendingStale: 0, actionsLastMin: 0, inflightAction: false,
             baseline: { deployments: false, resources: false, servers: false, version: false },
             logView: null, buildLogsHeld: 0, history: null, tags: { count: 0, fetchedAt: 0 }, sensitive: "unknown",
             notify: { enabled: root._cfg ? root._cfg.notify : Model.notifyDefaults(), warning: root._cfg && root._cfg.warning ? root._cfg.warning : null,
                       sentLastMin: root._notifiedLastMin(), suppressed: Model.suppressedZero(), queued: 0, lastEvent: null,
                       dnd: (function() { var d = root._dnd(); return d === null ? null : (d ? "on" : "off") })() } }
  }

  // CLI verbs never confirm: typing the verb is the confirmation. The result is the
  // stdout token and status.lastAction; omarchy-shell exits 0 on dispatch regardless.
  // Verbs resolve against the active instance only (SR38).
  function _ipcAct(verb, uuid) {
    var u = String(uuid === undefined || uuid === null ? "" : uuid).replace(/[\r\n\t]/g, " ").trim()
    if (!u) return "usage: " + verb + " <uuid>"
    var r = root.act(verb, u, true)
    var token = r === "queued" ? "queued " + verb + " " + u.slice(0, 64) : r
    console.log("coolwatch ipc " + verb + " " + u.slice(0, 8) + " -> " + token.split(" ")[0])
    return token
  }
  function _ipcInstances() {
    return root._instanceIds.map(function(id) { return id + (id === root._activeId ? " (active)" : "") }).join(", ")
  }
  function _ipcInstance(id) {
    var u = String(id === undefined || id === null ? "" : id).replace(/[\r\n\t]/g, " ").trim().slice(0, 64)
    if (!u) return "usage: instance <id>"
    return root.selectInstance(u) ? "active " + u : "unknown instance " + u
  }

  IpcHandler {
    target: "io.github.danjonesio.coolwatch"
    function refresh(): string { root.refresh(); return "ok" }
    function status(): string { return JSON.stringify(root._status()) }
    function deploy(uuid: string): string { return root._ipcAct("deploy", uuid) }
    function restart(uuid: string): string { return root._ipcAct("restart", uuid) }
    function stop(uuid: string): string { return root._ipcAct("stop", uuid) }
    function start(uuid: string): string { return root._ipcAct("start", uuid) }
    function instances(): string { return root._ipcInstances() }
    function instance(id: string): string { return root._ipcInstance(id) }
  }

  // ---- InstanceCtx: everything that is per Coolify instance --------------------------------
  // Everything below was the root's until Phase 4 (git diff -w against the depth branch shows
  // the moves). `root.` names the few shell-wide things; `ctx.` is this instance.
  component InstanceCtx: Item {
    id: ctx
    required property string instId
    readonly property var _entry: root._cfg && root._cfg.instances ? (root._cfg.instances.filter(function(i) { return i.id === ctx.instId })[0] || null) : null
    property string _instKey: ""       // JSON of the entry and poll this context's store was built from
    // instances[0] keeps recent.json (Phase 3's file); every further instance gets recent-<id>.json.
    readonly property int _index: root._instanceIds.indexOf(ctx.instId)   // -1 while the id is not (yet, or no longer) configured
    readonly property string recentPath: ctx._index < 0 ? "" : root.stateDirPath + (ctx._index === 0 ? "/recent.json" : "/recent-" + ctx.instId + ".json")
    readonly property string sensitiveMessage: root.sensitiveMessage
    // Chips and the tooltip suffix read this (Model.instanceChips / instanceTrouble).
    readonly property var summary: ({ id: ctx.instId, name: ctx._instance ? ctx._instance.name : ctx.instId,
                                      error: ctx._error ? ctx._error.kind : "", failed: ctx._failedUnacked.length,
                                      down: ctx._servers.filter(function(x) { return !x.reachable && !x.disabled }).length })

    property var _instance: null         // this entry without the token
    property string _token: ""           // written only by _tokenReady, read only by _launch
    property string _tokenSource: ""     // "file" | "command"
    property string _tokenCmdKey: ""     // JSON of the tokenCommand that produced the cached token
    property int _tokenCmdSeq: 0         // a superseded token command's exit is ignored
    property bool _needToken: false
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
    readonly property var pending: ctx._pending
    readonly property string actionStatus: ctx._actionStatus
    readonly property string actionTone: ctx._actionTone

    // Notifications (Phase 3). Events are produced inside _dispatch from the previous store
    // value and drained once per _finish; Model.notifyPlan decides everything (toggles,
    // suppression, ordering, caps, argv) so tests/run.js covers it. Nothing here enters
    // `snapshot` (the `pending` precedent). Every diff is gated on its kind's own _baseline
    // flag, never _baselineDone.

    property var _notifyQueue: []
    property var _actionAt: ({})         // uuid -> last user action ms (resource uuid; deployment uuid for cancel); pruned > 300 s
    property var _lastNotified: ({})     // "<kind>:<uuid>:<event>" -> ms; the dedupe/flap ledger; pruned > 3600 s
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
    property bool _recentLoaded: false
    property string _recentKey: ""       // Model.origin(instance.url) the loaded file was checked against; "" never arms
    property string _lastRecentKey: ""   // stamp-free guard key of the last write
    property int _recentPersisted: 0
    property bool _recentRejected: false

    // Depth (Phase 4). View slices live beside `snapshot` (the `pending` precedent): log
    // text never enters snapshot, _status(), recent.json, a console line or a toast (SR26).
    // Every write assigns a fresh shallow copy (_fresh) so the panel's bindings fire.
    property var _buildLogs: ({})        // uuid -> { uuid, entries, dropped, rev, status, terminal, source, truncated, refused, bytes, fetchedAt, message, at }; LRU 3, targets pinned
    property var _containerLogs: ({})    // uuid -> { uuid, kind, sub, label, lines (null while loading), truncated, fetchedAt, message, at }; LRU 3
    property var _servicePicks: ({})     // uuid -> { uuid, label, names (null while loading), message }
    property var _history: ({})          // appUuid -> { appUuid, label, count, rows, skip, loading, message, at }; LRU 3
    property var _tags: []
    property double _tagsAt: 0
    property var _logTargets: ({})       // panelId -> uuid: pins a build log against eviction; re-asserted by panelAlive, released with the panel
    property string _sensitive: "unknown"   // SR37: "no" only from a terminal row without logs, one-way toward "yes"
    property int _deploymentsBytes: 0    // last deployments body size; written by Qt.callLater after _finish, never inside it
    property var _bytesAt: []            // bare numbers, three parallel rings (the _requestLog idiom): when, how many, which kind
    property var _bytesN: []
    property var _bytesKind: []
    readonly property var _viewKinds: ({ buildlog: true, containerlog: true, service: true, history: true, tags: true })
    readonly property var views: ({ buildLogs: ctx._buildLogs, containerLogs: ctx._containerLogs, picks: ctx._servicePicks, history: ctx._history })
    property double _lastViewFetchAt: 0     // the view refetch keys have no auto-repeat filter upstream: one launch per second at most

    readonly property int _activeCount: ctx._deployments.filter(function(d) { return d.status === "queued" || d.status === "in_progress" }).length
    readonly property bool _deploying: ctx._activeCount > 0

    // Byte-aware cadence (SR30): 2 s while deploying unless the last body was large.
    readonly property int _deploymentsSec: Model.deploymentsInterval(ctx._deploying, root._cfg ? root._cfg.poll.deploymentsSec : 4, ctx._deploymentsBytes)
    on_DeployingChanged: if (!ctx._deploying) ctx._deploymentsBytes = 0
    readonly property int _resourcesSec: Math.min(root._cfg ? root._cfg.poll.resourcesSec : 60, ctx._deploying ? 15 : 100000, root._panelOpen ? 30 : 100000)
    readonly property int _serversSec: root._cfg ? root._cfg.poll.serversSec : 120
    property int _topologySec: 600
    readonly property bool _timersOn: ctx._ready && !ctx._paused && !ctx._probeMode

    readonly property var snapshot: ({
      instance: ctx._instance ? { id: ctx._instance.id, name: ctx._instance.name, url: ctx._instance.url, version: ctx._version, plaintext: ctx._instance.plaintext } : null,
      error: ctx._error, warning: ctx._warning,
      servers: ctx._servers, resources: ctx._resources, deployments: ctx._deployments, recent: ctx._recent,
      tree: ctx._tree, byServer: ctx._byServer,
      failedUnacked: ctx._failedUnacked, lastPollAt: ctx._lastPollAt,
      busy: ctx._busy, openPanels: root._openPanels, baselineDone: ctx._baselineDone,
      backoffSec: ctx._backoffSec, topologyFetched: ctx._topologyLoaded,   // the latch: "loading" is a startup state, not a per-cycle one
      tags: ctx._tags, sensitive: ctx._sensitive, paused: ctx._paused      // Phase 4: names only; never log text; paused feeds the view footer
    })
    readonly property var bar: Model.barState(ctx.snapshot)

      // ---- the panel-facing surface (called through the root) --------------------------------

      function _panelOpened() {
        if (!ctx._ready) return
        ctx._prime("stale")
        ctx.fetchTags()                                       // Phase 4: the TAGS fold exists only once the names are known; at most once a minute, never on a timer
        if (!ctx._topologyFetched && !ctx._topologyQueue.length && !topologyReq.running) ctx._pollTopology()
      }
      function acknowledgeFailures() { if (ctx._failedUnacked.length) ctx._failedUnacked = [] }

      // ---- config, applied per context -------------------------------------------------------

      // The entry (with its token) and the poll block are the store's inputs: a change to either
      // resets this context, as any non-notify edit reset the whole service before Phase 4. Runs
      // at creation and after every config load; a reorder re-arms the recent file.
      function _configApplied() {
        var e = ctx._entry
        if (!e) return
        var key = Model.instanceKey(e, root._cfg.poll)   // the entry with a token fingerprint, never the token (SR34; review: security 3)
        if (key !== ctx._instKey) {
          var first = ctx._instKey === ""
          ctx._instKey = key
          if (!first) ctx._resetStore()
          ctx._ready = false
          ctx._instance = { id: e.id, name: e.name, url: e.url, plaintext: e.plaintext }
          ctx._topologySec = root._cfg.poll.topologySec
          ctx._needToken = true
          ctx._error = null
        }
        ctx._armRecent()                   // the file is keyed on the instance, not the token: no wait on a vault
      }
      // After the root's stat: the warnings, then token resolution when needed.
      function _applyConfig() {
        var i = ctx._entry
        if (!i) return
        // The mode is the one shared file's; an inline token in ANY entry makes it every context's warning (review: security 1).
        if (Model.configLoose(root._configMode) && root._cfg.instances.some(function(x) { return !x.tokenCommand })) ctx._warning = { kind: "permissions", title: "Config is readable by others", detail: "" }
        else if (i.plaintext) ctx._warning = { kind: "plaintext", title: "Plaintext instance", detail: "" }
        else if (root._cfg.warning) ctx._warning = { kind: "notify", title: "Notify setting ignored", detail: root._cfg.warning + "; using the default" }
        else if (root._cfg.instancesWarning) ctx._warning = { kind: "instances", title: "Same Coolify twice", detail: root._cfg.instancesWarning }
        else ctx._warning = null
        if (ctx._needToken || !ctx._ready) { ctx._needToken = false; ctx._resolveToken() }
      }
      // The config went unsafe, or the context is being released: stop everything, keep nothing.
      function _halt() {
        ctx._ready = false
        ctx._needToken = true
        ctx._resetStore()
        ctx._token = ""
      }
      Component.onCompleted: ctx._configApplied()

    // Write-only shape (plugins/agents/Main.qml): no watch on a file this service writes.
    FileView {
      id: recentFile
      path: ""
      watchChanges: false
      atomicWrites: true
      printErrors: false
      onLoaded: ctx._loadRecent(text())
      onLoadFailed: function(err) { ctx._loadRecent(null) }
      onSaveFailed: function(err) { console.log("coolwatch recent save failed") }
    }

    // Called from _configApplied (after _instance is set) and from mkdirProc.onExited; needs both.
    // Do not hoist the path assignment to Component.onCompleted: the directory must exist first.
    function _armRecent() {
      if (!root._stateDirReady || !ctx._instance || !ctx.recentPath) return   // an unknown id has no file (review: security 2)
      var key = Model.origin(ctx._instance.url)
      if (key === ctx._recentKey && recentFile.path === ctx.recentPath) return
      ctx._recentKey = key; ctx._recentLoaded = false
      if (recentFile.path === ctx.recentPath) recentFile.reload(); else recentFile.path = ctx.recentPath
    }
    function _loadRecent(text) {         // idempotent: onLoaded may fire more than once
      var r = Model.parseRecent(text, ctx._recentKey, Date.now(), ctx.instId, ctx._index === 0)   // an id-less (pre-Phase-4) file is the first instance's
      ctx._recent = Model.joinBranch(Model.mergeRecent(ctx._recent, r.recent), ctx._resources)
      ctx._recentPersisted = r.recent.length; ctx._recentRejected = r.rejected; ctx._recentLoaded = true
      console.log(r.rejected ? "coolwatch recent rejected" : "coolwatch recent loaded " + r.recent.length)
    }
    function _saveRecent() {             // the deployment arm is the only caller
      if (!ctx._recentLoaded || !root._stateDirReady || ctx._recentKey === "") return
      var out = Model.serialiseRecent(ctx._recent, ctx._recentKey, Date.now(), ctx.instId)
      if (out.key === ctx._lastRecentKey) return
      ctx._lastRecentKey = out.key
      recentFile.setText(out.text)
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
        if (tokenCmd.seq !== ctx._tokenCmdSeq) return
        var t = String(tokenOut.text || "").trim()
        if (code === 0 && t.length > 0) { ctx._tokenCmdKey = tokenCmd.key; ctx._tokenReady(t, "command") }
        else ctx._setError(Model.makeError("tokencmd", "", { curlExit: code }))
      }
    }


    function _resetStore() {
      ctx._version = ""
      ctx._servers = []; ctx._resourcesRaw = []; ctx._resources = []; ctx._deployments = []; ctx._recent = []
      ctx._activeUuids = []; ctx._terminalQueue = []; ctx._projects = []; ctx._envsByProject = {}; ctx._byServer = {}; ctx._tree = []
      ctx._failedUnacked = []
      ctx._lastPollAt = { deployments: 0, resources: 0, servers: 0, topology: 0, version: 0 }
      ctx._baseline = { deployments: false, resources: false, servers: false, version: false }
      ctx._baselineDone = false
      ctx._topologyFetched = false; ctx._topologyLoaded = false; ctx._lastTopologyStepAt = 0; ctx._topologyQueue = []
      ctx._backoff = {}; ctx._paused = false; ctx._backoffSec = 0; ctx._probeMode = false
      startupRamp.ticks = 0
      var interrupted = ctx._inflightAction !== null
      ctx._pending = {}; ctx._inflightAction = null; ctx._ipcAbilityStreak = 0; ctx._lastAbility = ""
      ctx._actionStatus = ""; actionStatusTimer.stop()
      ctx._notifyQueue = []; ctx._actionAt = {}; ctx._lastNotified = {}; ctx._suppressed = Model.suppressedZero(); ctx._lastEvent = null
      ctx._drainTries = {}; deploymentReq.inflight = null
      ctx._recentLoaded = false; ctx._recentKey = ""; ctx._lastRecentKey = ""   // never writes; _configText re-arms the read
      // Phase 4: a revoked or swapped token must not leave fetched log text on screen (SR26).
      ctx._buildLogs = {}; ctx._containerLogs = {}; ctx._servicePicks = {}; ctx._history = {}; ctx._tags = []; ctx._tagsAt = 0
      ctx._logTargets = {}; ctx._sensitive = "unknown"; ctx._deploymentsBytes = 0
      logReq.target = null; historyReq.target = null; serviceReq.target = null
      for (var i = 0; i < ctx._reqs.length; i++) ctx._reqs[i].kill()
      ctx._syncBusy()
      if (interrupted) ctx._say("Action interrupted by a config change", "urgent")
    }

    function _resolveToken() {
      var i = ctx._entry
      if (!i) return
      if (i.tokenCommand) {
        var key = JSON.stringify(i.tokenCommand)
        if (key === ctx._tokenCmdKey && ctx._token.length > 0) { ctx._tokenReady(ctx._token, "command"); return }
        ctx._ready = false
        ctx._setError(Model.makeError("waitingtoken"))
        if (tokenCmd.running && tokenCmd.key === key) return       // already waiting on this command
        if (tokenCmd.running) { ctx._tokenCmdSeq += 1; tokenCmd.running = false }   // supersede
        ctx._tokenCmdSeq += 1
        tokenCmd.seq = ctx._tokenCmdSeq
        tokenCmd.key = key
        tokenCmd.command = ["timeout", "-k", "2", "30"].concat(i.tokenCommand)
        tokenCmd.running = true
        return
      }
      ctx._tokenCmdKey = ""
      ctx._tokenReady(i.token, "file")
    }

    function _tokenReady(token, source) {
      ctx._token = token
      ctx._tokenSource = source
      if (ctx._error && (ctx._error.kind === "waitingtoken" || ctx._error.kind === "tokencmd" || ctx._error.kind === "noconfig" || ctx._error.kind === "configerror")) ctx._error = null
      ctx._ready = true
      ctx._prime("all")
      topologyKick.restart()
    }

    function _setError(e) { ctx._error = e }

      // Phase 4: each context owns its ten Reqs; `owner` routes the exit to this context.
    Req { id: versionReq; owner: ctx }
    Req { id: deploymentsReq; owner: ctx }
    Req { id: deploymentReq; owner: ctx; property var inflight: null }   // { uuid } of the terminal fetch in flight; p.arg stays the descriptor list
    Req { id: resourcesReq; owner: ctx }
    Req { id: serversReq; owner: ctx }
    Req { id: topologyReq; owner: ctx }
    Req { id: actionReq; owner: ctx }                // single-flight; every action goes through _launch like a poll
    // Phase 4 view fetches: one-shot, panel-driven, settled by _viewDone from the same three
    // sites as _drainDone. Bookkeeping rides on `target`; p.arg stays the descriptor list.
    Req { id: logReq; owner: ctx; property var target: null }        // buildlog (one-shot, a uuid neither active nor drained) and containerlog
    Req { id: historyReq; owner: ctx; property var target: null }    // history pages
    Req { id: serviceReq; owner: ctx; property var target: null }    // GET /services/{uuid} for the picker, and GET /tags

    readonly property var _reqs: [versionReq, deploymentsReq, deploymentReq, resourcesReq, serversReq, topologyReq, actionReq, logReq, historyReq, serviceReq]

    function _syncBusy() { ctx._busy = ctx._reqs.some(function(p) { return p.running }) }
    function _isViewKind(kind) { return !!ctx._viewKinds[kind] }

    function _launch(p, reqs, maxTime) {
      if (p.running || p.stopping) {
        // A dropped tick is starvation, not silence: count it so a byte-starved poll is visible (SR30).
        var k0 = Array.isArray(reqs) ? "topology" : reqs.kind
        ctx._perKindEntry(k0).skipped += 1; ctx._perKind = ctx._perKind
        return false
      }
      var list = Array.isArray(reqs) ? reqs : [reqs]
      p.seq += 1
      p.kind = Array.isArray(reqs) ? "topology" : reqs.kind
      p.arg = list
      p.deadline = Date.now() + (list.length * maxTime + 3) * 1000
      p.stdinEnabled = true
      p.cfg = Api.config(ctx._instance, ctx._token, list, maxTime)   // the only call site
      p.running = true
      ctx._noteRequest(p.kind, list.length)
      ctx._syncBusy()
      return true
    }

    function _finish(p, code, stdoutText, stderrText) {
      ctx._syncBusy()
      if (p.liveSeq !== p.seq) return
      if (p === actionReq) { ctx._finishAction(p, code, stdoutText, stderrText); return }   // after the stale guard, never before
      var isView = ctx._isViewKind(p.kind)
      var results = Model.splitResponses(stdoutText)
      if (results.length === 0) {
        // A view fetch's failure is text inside the view, never the panel-wide error (SR29).
        if (isView) { ctx._viewFail(p, { exit: code || 1, code: 0, body: "", errmsg: stderrText, headers: null }); ctx._viewDone(p); return }
        ctx._fail(p.kind, Model.errorFor({ curlExit: code || 1, errmsg: stderrText, request: p.kind }), null)
        if (p.kind === "deployment") { ctx._drainDone(false, false); ctx._drainTerminal() }
        return
      }
      var anyOk = false, gone = false
      ctx._drainDispatched = false
      for (var i = 0; i < results.length; i++) {
        if (i >= p.arg.length) break               // more trailers than blocks: malformed stream
        var r = results[i]
        ctx._record(p.kind, r)
        var e = Model.errorFor({ curlExit: r.exit, httpCode: r.code, body: r.body, errmsg: r.errmsg, headers: r.headers, request: p.kind })
        if (e) {
          if (p.kind === "deployment" && r.code === 404) gone = true                     // vanished for good: no _fail, no retry
          else if (isView) ctx._viewFail(p, r)
          else ctx._fail(p.kind, e, r.headers)
        } else {
          anyOk = true
          ctx._dispatch(p.arg[i], r, p.kind)
        }
      }
      if (isView) { ctx._viewDone(p); ctx._flushNotify(); return }   // never _succeeded: a user fetch must not lift probe mode
      if (anyOk) ctx._succeeded(p.kind)
      // The interval binding reads this; written after the loop so the byte input cannot make
      // _catchUp re-enter _launch mid-_finish (the other input, _deploying, is guarded by the
      // _markPoll ordering in the deployments arm) (SR30).
      if (p.kind === "deployments" && results[0]) { var nb = results[0].bytes || 0; Qt.callLater(function() { ctx._deploymentsBytes = nb }) }
      if (p.kind === "resources" || p.kind === "servers" || p.kind === "topology") ctx._rejoin()
      else if (p.kind === "deployments") ctx._joinDeployments()
      if (p.kind === "deployment") { ctx._drainDone(ctx._drainDispatched, gone); ctx._drainTerminal() }   // dispatch success, not HTTP success
      // Only a successful block can mark the cycle complete: a failed /projects leaves the
      // flag false so the 65 s kick, a panel open and the next cycle all retry it.
      // (A failed stage-2 block after a successful /projects still counts: the tree is usable.)
      if (p.kind === "topology" && (anyOk || ctx._projects.length)) { ctx._topologyFetched = ctx._topologyQueue.length === 0; if (ctx._topologyFetched) ctx._topologyLoaded = true }   // the next block waits for topologyStep
      ctx._flushNotify()                // last: after the joins, so every toast reads the joined snapshot
    }

    // ---- notifications (Phase 3) ---------------------------------------------------------

    function _queueNotify(evs) { ctx._notifyQueue = ctx._notifyQueue.concat((evs || []).filter(function(e) { return !!e })) }

    function _flushNotify() {
      var q = ctx._notifyQueue
      if (!q.length) return
      ctx._notifyQueue = []
      var now = Date.now()
      var c = { notify: root._cfg ? root._cfg.notify : Model.notifyDefaults(),
                origin: ctx._instance ? Model.origin(ctx._instance.url) : "",
                dnd: root._dnd(), pending: ctx._pending, actionAt: ctx._actionAt,
                lastNotified: ctx._lastNotified, sentLastMin: root._notifiedLastMin(), now: now, pluginId: root.pluginId,
                instanceLabel: root._ctxs.length > 1 && ctx._instance ? ctx._instance.name : "" }   // Phase 4: the body names the instance when there are several
      var out = Model.notifyPlan(q, ctx.snapshot, c)
      out.notified.forEach(function(n) { ctx._lastNotified[n.key] = n.at }); ctx._lastNotified = ctx._lastNotified
      out.log.forEach(function(l) { console.log("coolwatch notify " + l) })          // event + uuid8 only, at intent
      for (var i = 0; i < out.argvs.length; i++) Util.execArgv(out.argvs[i])
      root._chargeNotify(out.nonCritical, now)                          // the minute budget is per shell
      for (var k in out.suppressed) ctx._suppressed[k] = (ctx._suppressed[k] || 0) + out.suppressed[k]
      ctx._suppressed = ctx._suppressed
      if (out.argvs.length) ctx._lastEvent = { kind: out.lastKind, at: now }
    }


    // Reaper tick: the action ledger keeps 300 s (the longest window a rule reads), the
    // dedupe ledger 3600 s (the "recovered" window). Mutate-then-self-assign, only on change.
    function _pruneNotify(now) {
      var a = ctx._actionAt, ka = Object.keys(a), changed = false
      if (ka.length) {
        for (var i = 0; i < ka.length; i++) if (now - a[ka[i]] > 300000) { delete a[ka[i]]; changed = true }
        if (changed) ctx._actionAt = a
      }
      var l = ctx._lastNotified, kl = Object.keys(l); changed = false
      if (!kl.length) return
      for (var j = 0; j < kl.length; j++) if (now - l[kl[j]] > 3600000) { delete l[kl[j]]; changed = true }
      if (changed) ctx._lastNotified = l
    }

    function _dispatch(req, r, kind) {
      var now = Date.now()
      var json = req.json === false ? null : Model.parseJson(r.body)
      if (req.json !== false && !json.ok) { ctx._fail(kind, Model.makeError("http", "Coolify returned something that is not JSON", { httpCode: r.code, request: kind }), r.headers); return }
      switch (req.kind) {
        case "version":
          ctx._version = Model.parseVersion(r.body)
          ctx._markPoll("version", now)
          break
        case "deployments": {
          // Phase 4: every active row carries its build log (read:sensitive); capture it here,
          // before normalise drops it, for at most three deployments (targets pinned).
          if (Array.isArray(json.value)) json.value.forEach(function(row) {
            if (!row || typeof row !== "object") return
            ctx._noteSensitive(row)
            if (typeof row.deployment_uuid === "string" && row.deployment_uuid) ctx._captureLog(row.deployment_uuid, row.logs, row.status, "list", true)
          })
          var norm = Model.normaliseDeployments(json.value)
          // ctx._deployments still holds the previous poll; the baseline flag is read before _markPoll flips it.
          var diff = Model.diffDeployments(ctx._deployments, norm, !ctx._baseline.deployments)
          if (diff.vanished.length) {
            var q = ctx._terminalQueue.slice()
            diff.vanished.forEach(function(u) { if (q.indexOf(u) < 0 && q.length < 20) q.push(u) })
            ctx._terminalQueue = q
          }
          ctx._activeUuids = norm.map(function(d) { return d.uuid })
          // _markPoll first: assigning _deployments flips _deploying, which re-evaluates the
          // deployments interval and runs _catchUp against _lastPollAt synchronously; a stale
          // stamp there would re-enter _launch on this Req while _finish is still on the stack.
          ctx._markPoll("deployments", now)
          ctx._deployments = norm
          ctx._queueNotify(diff.events)
          ctx._drainTerminal()
          break
        }
        case "deployment": {
          // Joined here (the deployments-kind join at the end of _finish does not run for this
          // kind) so the toast body has a branch and recent carries appUuid at once. The
          // terminal toast fires once per uuid: `recent` is the intra-session ledger, and a
          // non-terminal status (a transient vanish) yields no event.
          var d = Model.joinBranch([Model.normaliseDeployment(json.value)], ctx._resources)[0]
          if (d.uuid) {
            ctx._drainDispatched = true
            // Phase 4: the terminal body is the log view's terminal source, present in the
            // same dispatch as the Deployed/Failed toast at zero extra requests.
            ctx._noteSensitive(json.value)
            ctx._captureLog(d.uuid, json.value.logs, d.status, "drain", false)
            if (!Model.hasTerminal(ctx._recent, d.uuid)) ctx._queueNotify([Model.terminalEvent(d)])
            var rec = ctx._recent.filter(function(x) { return x.uuid !== d.uuid })
            rec.unshift(d)
            ctx._recent = rec.slice(0, 20)
            ctx._saveRecent()
            if (d.status === "failed" && ctx._baselineDone && root._openPanels === 0 && ctx._failedUnacked.indexOf(d.uuid) < 0)
              ctx._failedUnacked = ctx._failedUnacked.concat([d.uuid])
          }
          break
        }
        case "resources": {
          var nextRes = Model.normaliseResources(json.value)
          ctx._queueNotify(Model.resourceEvents(ctx._resourcesRaw, nextRes, !ctx._baseline.resources))
          ctx._resourcesRaw = nextRes
          ctx._markPoll("resources", now)
          break
        }
        case "servers": {
          var nextSrv = Model.normaliseServers(json.value)
          ctx._queueNotify(Model.serverEvents(ctx._servers, nextSrv, !ctx._baseline.servers))
          ctx._servers = nextSrv
          ctx._markPoll("servers", now)
          ctx._enqueueMissingServerResources()
          break
        }
        case "projects":
          ctx._projects = Model.normaliseProjects(json.value)
          ctx._markPoll("topology", now)
          ctx._topologyStage2()
          break
        case "project": {
          var envs = ctx._envsByProject; envs[req.arg] = Model.environmentsOf(json.value); ctx._envsByProject = envs
          break
        }
        case "serverResources": {
          var bs = ctx._byServer; bs[req.arg] = Model.serverResourceUuids(json.value); ctx._byServer = bs
          break
        }
        // ---- Phase 4 view kinds: one-shot, settled by _viewDone in _finish ----
        case "buildlog": {
          var raw = json.value && typeof json.value === "object" ? json.value : {}
          ctx._noteSensitive(raw)
          ctx._captureLog(req.arg, raw.logs, raw.status, "fetch", false)
          break
        }
        case "containerlog": {
          var ct = logReq.target || {}
          ctx._setContainerLog(req.arg, ct.ckind || "application", ct.sub || null, Model.parseContainerLog(json.value), null, ct.label || "")
          break
        }
        case "service": {
          var sv = json.value && typeof json.value === "object" ? json.value : {}
          var names = []
          ;(Array.isArray(sv.applications) ? sv.applications : []).concat(Array.isArray(sv.databases) ? sv.databases : []).forEach(function(c) {
            if (c && typeof c === "object" && typeof c.name === "string" && c.name && Model.TAG_RE.test(c.name)) names.push(c.name)
          })
          var st = serviceReq.target || {}
          if (names.length === 1) { ctx._setPick(req.arg, names, null, st.label || ""); ctx._fetchContainerLogSub("service", req.arg, names[0], st.label || "", true) }
          else ctx._setPick(req.arg, names, names.length ? null : "This service has no containers.", st.label || "")
          break
        }
        case "history": {
          var ht = historyReq.target || {}
          var rawRows = json.value && Array.isArray(json.value.deployments) ? json.value.deployments : []
          rawRows.forEach(function(row) { ctx._noteSensitive(row) })
          var page = Model.normaliseHistory(json.value)
          page.rows = Model.joinBranch(page.rows, ctx._resources)   // the deployments-kind join does not run for this kind (the drain precedent)
          ctx._setHistoryPage(req.arg, ht.skip || 0, page.count, page.rows)
          break
        }
        case "tags":
          ctx._tags = Model.normaliseTags(json.value)
          ctx._tagsAt = now
          break
      }
      console.log("coolwatch " + ctx.instId + "/" + req.kind + " " + r.code + " exit=" + r.exit + " " + r.timeMs + "ms " + r.bytes + "B")   // per-request line names the instance (Phase 4)
    }

    // ---- depth (Phase 4): capture, view slices, view failures ------------------------------
    // The store slices hold log text; nothing here reaches snapshot, _status() or a console
    // line beyond counts (SR26). A failed view fetch sets the record's message and nothing
    // else: never _error, _backoff, _probeMode or _failedUnacked; 429 still pauses (SR29).

    function _noteSensitive(raw) {
      var s = Model.sensitiveState(raw)
      if (s === "yes") { if (ctx._sensitive !== "yes") ctx._sensitive = "yes" }
      else if (s === "no" && ctx._sensitive === "unknown") ctx._sensitive = "no"
    }

    // A var property assigned the same object emits no change; the panel binds on these maps,
    // so every writer assigns a fresh shallow copy.
    function _fresh(m) { var o = {}; for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) o[k] = m[k]; return o }

    function _isLogTarget(uuid) { for (var k in ctx._logTargets) if (ctx._logTargets[k] === uuid) return true; return false }

    function _setLogTarget(panelKey, uuid) {
      var t = ctx._logTargets, cur = t[panelKey]
      if (uuid) { if (cur !== uuid) { t[panelKey] = uuid; ctx._logTargets = ctx._fresh(t) } }
      else if (cur !== undefined) { delete t[panelKey]; ctx._logTargets = ctx._fresh(t) }
    }

    // Oldest unpinned records go first; the map is reassigned by the caller.
    function _evictLru(m, cap, isPinned) {
      var keys = Object.keys(m)
      while (keys.length > cap) {
        var oldest = null
        for (var i = 0; i < keys.length; i++) {
          if (isPinned && isPinned(keys[i])) continue
          if (oldest === null || (m[keys[i]].at || 0) < (m[oldest].at || 0)) oldest = keys[i]
        }
        if (oldest === null) return
        delete m[oldest]
        keys = Object.keys(m)
      }
    }

    // source/fetchedAt always update, status/terminal only when a status is supplied; the
    // parse runs only when the raw length changed. `opportunistic` (the list poll) never grows the map past the cap.
    function _captureLog(uuid, raw, status, source, opportunistic) {
      if (!uuid) return
      var m = ctx._buildLogs, rec = m[uuid] || null
      if (!rec && opportunistic && !ctx._isLogTarget(uuid) && Object.keys(m).length >= 3) return
      var now = Date.now()
      if (!rec) rec = { uuid: uuid, entries: [], dropped: 0, rev: "", status: "", terminal: false, source: source, truncated: false, refused: false, bytes: -1, fetchedAt: 0, message: null, at: 0 }
      if (status) { rec.status = String(status); rec.terminal = !!Model.TERMINAL[rec.status] }   // a call without a status keeps what is known (a refetch must not erase "failed")
      rec.source = source; rec.fetchedAt = now; rec.at = now
      if (typeof raw === "string") {
        if (raw.length !== rec.bytes) {
          var p = Model.parseBuildLog(raw)
          rec.entries = p.entries; rec.dropped = p.dropped; rec.truncated = p.truncated; rec.refused = p.refused; rec.bytes = p.bytes
          rec.rev = Model.buildLogRev(p.entries, p.dropped)
          var n = p.entries.length
          console.log("coolwatch logview " + source + " " + Model.uuid8(uuid) + " n=" + n + " dropped=" + p.dropped + " bytes=" + p.bytes + (p.refused ? " refused" : ""))
        }
        rec.message = null
      } else {
        if (rec.bytes < 0) rec.bytes = 0
        if (ctx._sensitive === "no" && rec.terminal) rec.message = ctx.sensitiveMessage   // SR37: a terminal row with no log
      }
      m[uuid] = ctx._fresh(rec)                                   // a fresh record too: the panel binds on the record reference
      ctx._evictLru(m, 3, ctx._isLogTarget)
      ctx._buildLogs = ctx._fresh(m)
    }

    function _setBuildLogMessage(uuid, text) {
      var m = ctx._buildLogs, rec = m[uuid]
      if (!rec) { rec = { uuid: uuid, entries: [], dropped: 0, rev: "", status: "", terminal: false, source: "fetch", truncated: false, refused: false, bytes: 0, fetchedAt: 0, message: null, at: Date.now() }; m[uuid] = rec }
      rec.message = text; rec.at = Date.now()
      m[uuid] = ctx._fresh(rec)
      ctx._buildLogs = ctx._fresh(m)
    }

    function _setContainerLog(uuid, kind, sub, parsed, message, label) {
      var m = ctx._containerLogs, rec = m[uuid] || { uuid: uuid, kind: kind, sub: sub, label: label || "", lines: null, truncated: false, fetchedAt: 0, message: null, at: 0 }
      rec.kind = kind; rec.sub = sub; if (label) rec.label = label
      if (parsed) { rec.lines = parsed.lines; rec.truncated = !!parsed.truncated; rec.fetchedAt = Date.now(); rec.message = null }
      else if (message !== undefined) rec.message = message
      if (!parsed && message === null) rec.lines = null      // loading again
      rec.at = Date.now()
      m[uuid] = ctx._fresh(rec)
      ctx._evictLru(m, 3, null)
      ctx._containerLogs = ctx._fresh(m)
    }
    function _setContainerLogMessage(uuid, text) { ctx._setContainerLog(uuid, (ctx._containerLogs[uuid] || {}).kind || "application", (ctx._containerLogs[uuid] || {}).sub || null, null, text, "") }

    function _setPick(uuid, names, message, label) {
      var m = ctx._servicePicks
      m[uuid] = { uuid: uuid, label: label || ((m[uuid] || {}).label || ""), names: names, message: message === undefined ? null : message }
      ctx._servicePicks = ctx._fresh(m)
    }

    function _setHistoryPage(appUuid, skip, count, rows) {
      var h = ctx._history, page = h[appUuid] || { appUuid: appUuid, label: "", count: 0, rows: [], skip: 0, loading: false, message: null, at: 0 }
      var merged = skip > 0 ? page.rows.slice() : []
      var seen = {}; merged.forEach(function(r) { seen[r.uuid] = true })
      rows.forEach(function(r) { if (!seen[r.uuid]) { merged.push(r); seen[r.uuid] = true } })
      page.rows = merged; page.count = count; page.skip = skip; page.loading = false; page.message = null; page.at = Date.now()
      h[appUuid] = ctx._fresh(page)
      ctx._evictLru(h, 3, null)
      ctx._history = ctx._fresh(h)
    }
    function _setHistoryMessage(appUuid, text) {
      var h = ctx._history, page = h[appUuid]
      if (!page) return
      page.loading = false; page.message = text; page.at = Date.now()
      h[appUuid] = ctx._fresh(page)
      ctx._history = ctx._fresh(h)
    }

    function _viewFail(p, r) {
      var t = p.target || {}
      var o = Model.fetchOutcome(p.kind, r, t.label || "")
      var text = o ? o.text : "Coolify returned nothing"
      switch (p.kind) {
        case "buildlog": ctx._setBuildLogMessage(t.uuid || (p.arg && p.arg[0] ? p.arg[0].arg : ""), text); break
        case "containerlog": ctx._setContainerLogMessage(t.uuid || (p.arg && p.arg[0] ? p.arg[0].arg : ""), text); break
        case "service": ctx._setPick(t.uuid || (p.arg && p.arg[0] ? p.arg[0].arg : ""), [], text, t.label || ""); break
        case "history": ctx._setHistoryMessage(t.appUuid || (p.arg && p.arg[0] ? p.arg[0].arg : ""), text); break
        case "tags": break                                   // the fold simply stays as it was
      }
      if (o && o.error && o.error.kind === "ratelimited") ctx._pauseFor(r ? r.headers : null)
      console.warn("coolwatch " + p.kind + " view failed: " + (o && o.error ? o.error.kind + " http=" + o.error.httpCode + " exit=" + o.error.curlExit : "empty"))
    }
    function _viewDone(p) { p.target = null }

    // ---- depth (Phase 4): the panel-facing surface ------------------------------------------

    // A build log for a deployment: active -> the list poll captures it (pinned from now);
    // drained or fetched before -> already here; anything else -> one fetch.
    function openBuildLog(panelId, uuid) {
      uuid = String(uuid || "")
      if (!uuid) return
      ctx._setLogTarget(String(panelId), uuid)
      if (ctx._buildLogs[uuid]) return
      var dep = ctx._deployments.filter(function(d) { return d.uuid === uuid })[0] || null
      if (dep) { ctx._captureLog(uuid, undefined, dep.status, "list", false); return }   // a placeholder until the next poll
      ctx.refetchBuildLog(uuid)
    }
    // A held `r` would otherwise fire one request per round trip (PanelKeyCatcher has no
    // auto-repeat filter) until the token's 429 paused every timer. A view's first fetch
    // (`first`: no record yet for that target) is never dropped: dropping it would leave the
    // view on its loading note with nothing to refetch.
    function _viewThrottled(first) {
      var now = Date.now()
      if (!first && now - ctx._lastViewFetchAt < 1000) return true
      ctx._lastViewFetchAt = now
      return false
    }
    function refetchBuildLog(uuid) {
      if (ctx._activeUuids.indexOf(uuid) >= 0) return       // the list poll owns an active one
      if (ctx._viewThrottled(!ctx._buildLogs[uuid])) return
      var rec = ctx._recent.filter(function(d) { return d.uuid === uuid })[0] || null
      var known = ctx._buildLogs[uuid] || null
      ctx._captureLog(uuid, undefined, rec ? rec.status : (known ? known.status : ""), "fetch", false)
      if (logReq.running || logReq.stopping) { ctx._setBuildLogMessage(uuid, "Busy · press r to retry"); return }
      logReq.target = { kind: "buildlog", uuid: uuid, label: "" }
      ctx._launch(logReq, Api.reqBuildLog(uuid), 12)
    }
    function closeView(panelId) { ctx._setLogTarget(String(panelId), "") }

    function fetchContainerLog(kind, uuid, label) {
      uuid = String(uuid || ""); label = String(label || "")
      if (kind === "service") {
        if (ctx._viewThrottled(!ctx._servicePicks[uuid])) return
        ctx._setPick(uuid, null, null, label)
        if (serviceReq.running || serviceReq.stopping) { ctx._setPick(uuid, [], "Busy · try again", label); return }
        serviceReq.target = { kind: "service", uuid: uuid, label: label }
        ctx._launch(serviceReq, Api.reqService(uuid), 12)
        return
      }
      ctx._fetchContainerLogSub(kind, uuid, null, label)
    }
    function fetchContainerLogSub(uuid, sub, label) { ctx._fetchContainerLogSub("service", String(uuid || ""), String(sub || ""), String(label || "")) }
    function _fetchContainerLogSub(kind, uuid, sub, label, internal) {
      var req = Api.reqContainerLog(kind, uuid, sub)
      if (!req) return
      var known = ctx._containerLogs[uuid] || null
      if (!internal && ctx._viewThrottled(!known || known.sub !== sub)) return   // internal: the service arm's own continuation, not a key press
      ctx._setContainerLog(uuid, kind, sub, null, null, label)   // lines null: loading
      if (logReq.running || logReq.stopping) { ctx._setContainerLogMessage(uuid, "Busy · press r to retry"); return }
      logReq.target = { kind: "containerlog", uuid: uuid, label: label, ckind: kind, sub: sub }
      ctx._launch(logReq, req, 12)   // measured 1.1-1.3 s regardless of size: a live docker logs over SSH
    }

    function fetchHistory(appUuid, skip, label) {
      appUuid = String(appUuid || ""); skip = Math.max(0, skip | 0)
      var h = ctx._history, page = h[appUuid] || { appUuid: appUuid, label: String(label || ""), count: 0, rows: [], skip: 0, loading: false, message: null, at: 0 }
      if (label) page.label = String(label)
      if (ctx._viewThrottled(!h[appUuid] || skip !== page.skip)) return   // a first page or a new page is never dropped
      if (historyReq.running || historyReq.stopping) { page.message = "Busy · try again"; h[appUuid] = ctx._fresh(page); ctx._history = ctx._fresh(h); return }
      page.loading = true; page.message = null; page.skip = skip; page.at = Date.now()
      h[appUuid] = ctx._fresh(page); ctx._evictLru(h, 3, null); ctx._history = ctx._fresh(h)
      historyReq.target = { kind: "history", appUuid: appUuid, skip: skip, label: page.label }
      ctx._launch(historyReq, Api.reqHistory(appUuid, skip), 12)
    }

    // On panel open, at most once a minute; never on a timer (the fold cannot bootstrap itself).
    function fetchTags() {
      if (!ctx._ready || Date.now() - ctx._tagsAt < 60000) return
      if (serviceReq.running || serviceReq.stopping) return
      ctx._tagsAt = Date.now()                                 // stamped at launch: a failing /tags must not refetch on every panel open
      serviceReq.target = { kind: "tags" }
      ctx._launch(serviceReq, Api.reqTags(), 12)
    }

    function _markPoll(kind, now) {
      var lp = ctx._lastPollAt; lp[kind] = now; ctx._lastPollAt = lp
      if (ctx._baseline[kind] === false) {
        var b = ctx._baseline; b[kind] = true; ctx._baseline = b
        if (b.deployments && b.resources && b.servers && b.version) ctx._baselineDone = true
      }
    }

    function _rejoin() {
      ctx._tree = Model.buildTree(ctx._projects, ctx._envsByProject, ctx._resourcesRaw)
      ctx._resources = Model.applyJoins(ctx._resourcesRaw, ctx._tree, ctx._byServer, ctx._servers)
      var counts = Model.resourceCounts(ctx._byServer)
      ctx._servers = ctx._servers.map(function(x) { var o = {}; for (var k in x) o[k] = x[k]; o.resourceCount = counts[x.uuid] || 0; return o })
      ctx._joinDeployments()
    }

    function _joinDeployments() {
      ctx._deployments = Model.joinBranch(ctx._deployments, ctx._resources)
      ctx._recent = Model.joinBranch(ctx._recent, ctx._resources)
    }

    // Stage 2 is spread one block per topologyStep tick (40 s) so the fan-out never
    // adds more than 2 requests to any 60 s window; the 20/min line is a sliding window.
    // Server membership first (few blocks, and "group by server" depends on it), then
    // the per-project environment lists. Descriptors already queued are kept, not replaced.
    function _topologyStage2() {
      var q = ctx._topologyQueue.slice()
      var have = {}
      q.forEach(function(d) { have[d.kind + ":" + d.arg] = true })
      ctx._servers.forEach(function(s) { if (!have["serverResources:" + s.uuid]) q.push(Api.reqServerResources(s.uuid)) })
      ctx._projects.forEach(function(p) { if (!have["project:" + p.uuid]) q.push(Api.reqProject(p.uuid)) })
      ctx._topologySec = Model.topologyIntervalSec(root._cfg ? root._cfg.poll.topologySec : 600, ctx._projects.length, ctx._servers.length)
      ctx._topologyQueue = q
      if (!q.length) { ctx._topologyFetched = true; ctx._topologyLoaded = true }
      // The first block waits for topologyStep like the rest: a burst of P + S blocks
      // right after /projects is what pushed a 60 s window past the budget.
    }

    function _topologyStep() {
      if (!ctx._ready || ctx._paused || ctx._probeMode || topologyReq.running || topologyReq.stopping) return
      if (!ctx._topologyQueue.length) return
      if (ctx._backoffUntil("topology") > Date.now()) return
      var q = ctx._topologyQueue.slice()
      var d = q.shift()
      ctx._topologyQueue = q
      ctx._lastTopologyStepAt = Date.now()
      ctx._launch(topologyReq, [d], 8)
    }

    // A server that answered after stage 2 was built (or a stage 2 that never ran)
    // gets its resource list on the next ticks instead of at the next topology cycle.
    function _enqueueMissingServerResources() {
      if (!ctx._projects.length && !ctx._topologyFetched) return
      var q = ctx._topologyQueue.slice()
      var queued = {}
      q.forEach(function(d) { if (d.kind === "serverResources") queued[d.arg] = true })
      var added = false
      ctx._servers.forEach(function(s) { if (!ctx._byServer[s.uuid] && !queued[s.uuid]) { q.push(Api.reqServerResources(s.uuid)); added = true } })
      if (added) { ctx._topologyQueue = q; ctx._topologyFetched = false }
    }

    function _drainTerminal() {
      if (!ctx._ready || ctx._paused || ctx._probeMode || deploymentReq.running || deploymentReq.stopping || !ctx._terminalQueue.length) return
      if (ctx._backoffUntil("deployment") > Date.now()) return
      var q = ctx._terminalQueue.slice()
      var uuid = q.shift()
      ctx._terminalQueue = q
      deploymentReq.inflight = { uuid: uuid }
      ctx._launch(deploymentReq, Api.reqDeployment(uuid), 12)   // log-bearing: 12 s, 4 MB (SR30)
    }

    // The one place a terminal fetch's outcome is settled (called from _finish and the reaper
    // before the next _drainTerminal). ok: dispatched; gone: 404. Anything else re-queues.
    function _drainDone(ok, gone) {
      var f = deploymentReq.inflight; deploymentReq.inflight = null
      if (!f || !f.uuid) return
      var t = ctx._drainTries
      if (ok || gone) {
        if (gone) console.log("coolwatch drain 404 " + Model.uuid8(f.uuid))
        if (Object.prototype.hasOwnProperty.call(t, f.uuid)) { delete t[f.uuid]; ctx._drainTries = t }
        return
      }
      var n = (t[f.uuid] || 0) + 1
      if (n > 2) { delete t[f.uuid]; ctx._drainTries = t; console.log("coolwatch drain gave up " + Model.uuid8(f.uuid)); return }
      var q = ctx._terminalQueue.slice()
      if (q.indexOf(f.uuid) >= 0 || q.length >= 20) { delete t[f.uuid]; ctx._drainTries = t; return }   // already queued, or the cap: no retry is scheduled, so none is counted
      t[f.uuid] = n; ctx._drainTries = t; ctx._drainRetries += 1
      q.push(f.uuid)                                                   // the back: one failing uuid must not stall the healthy ones twice
      ctx._terminalQueue = q
    }

    // ---- errors, backoff, pause, probe ---------------------------------------------------

    function _succeeded(kind) {
      var b = ctx._backoff; if (b[kind]) { delete b[kind]; ctx._backoff = b }
      if (ctx._error && ctx._error.request === kind) ctx._error = null
      if (ctx._probeMode) { ctx._probeMode = false; ctx._prime("all"); ctx._drainTerminal() }
    }

    function _record(kind, r) {
      var pk = ctx._perKindEntry(kind)
      pk.lastAt = Date.now(); pk.lastCode = r.code; pk.lastMs = r.timeMs; pk.lastBytes = r.bytes
      if (r.exit === 0 && r.code < 400) pk.consecutiveFailures = 0
      if (r.headers && r.headers.rateLimitRemaining !== null) ctx._rateLimitRemaining = r.headers.rateLimitRemaining
      ctx._perKind = ctx._perKind
      ctx._noteBytes(kind, r.bytes || 0)
    }

    // Three parallel bare-number rings: bytes per minute per kind, the number the request
    // count cannot show once a body is sized by a build log (SR30).
    function _noteBytes(kind, n) {
      var now = Date.now(), at = [], num = [], kinds = []
      for (var i = 0; i < ctx._bytesAt.length; i++) if (now - ctx._bytesAt[i] < 60000) { at.push(ctx._bytesAt[i]); num.push(ctx._bytesN[i]); kinds.push(ctx._bytesKind[i]) }
      at.push(now); num.push(n); kinds.push(kind)
      ctx._bytesAt = at; ctx._bytesN = num; ctx._bytesKind = kinds
    }
    function _bytesLastMin(kind) {
      var now = Date.now(), sum = 0
      for (var i = 0; i < ctx._bytesAt.length; i++) if (now - ctx._bytesAt[i] < 60000 && ctx._bytesKind[i] === kind) sum += ctx._bytesN[i]
      return sum
    }

    function _fail(kind, e, headers) {
      var pk = ctx._perKindEntry(kind)
      pk.consecutiveFailures += 1
      ctx._perKind = ctx._perKind
      e.at = Date.now()
      e.staleSince = ctx._lastPollAt[kind === "deployment" ? "deployments" : kind] || 0
      if (!(ctx._error && ctx._error.kind === "ratelimited" && e.kind !== "ratelimited")) ctx._error = e
      if (e.kind === "auth" || e.kind === "apidisabled" || e.kind === "ipblocked") {
        ctx._probeMode = true
        probeTimer.restart()
      } else if (e.kind === "ratelimited") {
        ctx._pauseFor(headers)
      } else if (e.kind !== "ability") {
        var bo = ctx._backoff; var a = ((bo[kind] && bo[kind].attempt) || 0) + 1
        bo[kind] = { until: Date.now() + (a <= 1 ? 30 : 60) * 1000, attempt: a }; ctx._backoff = bo
      }
      console.warn("coolwatch " + kind + " failed: " + e.kind + " http=" + e.httpCode + " exit=" + e.curlExit + " " + e.detail)
    }

    // 429 is instance-wide: pause every timer for Retry-After (clamped) or the ladder.
    // Shared by _fail and _finishAction; touches nothing but the pause state.
    function _pauseFor(headers) {
      var b = ctx._backoff; var attempt = ((b.ratelimited && b.ratelimited.attempt) || 0) + 1
      ctx._backoffSec = Model.retryAfterSec(headers, attempt)
      b.ratelimited = { until: Date.now() + ctx._backoffSec * 1000, attempt: attempt }; ctx._backoff = b
      ctx._paused = true
      pauseTimer.interval = ctx._backoffSec * 1000
      pauseTimer.restart()
    }

    function _backoffUntil(kind) { var b = ctx._backoff[kind]; return b ? b.until : 0 }
    function _maxBackoffUntil() { var m = 0; for (var k in ctx._backoff) if (k !== "action") m = Math.max(m, ctx._backoff[k].until); return m }

    function _perKindEntry(kind) {
      if (!ctx._perKind[kind]) ctx._perKind[kind] = { lastAt: 0, lastCode: 0, lastMs: 0, lastBytes: 0, interval: 0, consecutiveFailures: 0, reaps: 0, lastReapAt: 0, skipped: 0 }
      return ctx._perKind[kind]
    }

    function _noteRequest(kind, n) {
      var now = Date.now()
      var log = ctx._requestLog.filter(function(t) { return now - t < 60000 })
      for (var i = 0; i < n; i++) log.push(now)
      ctx._requestLog = log
    }

    function _requestsLastMin() {
      var now = Date.now()
      return ctx._requestLog.filter(function(t) { return now - t < 60000 }).length
    }

    function _actionsLastMin() {
      var now = Date.now()
      return ctx._actionLog.filter(function(t) { return now - t < 60000 }).length
    }

    // ---- actions (Phase 2) ---------------------------------------------------------------
    // act() is the only path to _launch for an action; the panel, both monitors and the
    // IPC verbs call it. Model.actionRequest is the single applicability gate (SR3);
    // Api builds the descriptor here because Model never imports Api.

    // targetHint: the panel passes the row type so a vanished target is named correctly.
    function act(verb, uuid, fromIpc, targetHint, instanceId) {
      // instanceId: the instance the confirm was opened on; a switch in between refuses (SR38).
      if (instanceId !== undefined && instanceId !== null && String(instanceId) !== ctx.instId) return ctx._refuse("wronginstance", verb, uuid)
      if (!ctx._ready) return ctx._refuse(ctx._error && ctx._error.kind === "unsafe" ? "unsafe" : "notconfigured", verb, uuid)
      if (ctx._probeMode) return ctx._refuse("probe", verb, uuid)
      if (ctx._paused) return ctx._refuse("ratelimited", verb, uuid)
      if (ctx._requestsLastMin() >= 120) return ctx._refuse("toomany", verb, uuid)
      var a = Model.actionRequest(ctx.snapshot, verb, uuid)
      if (!a.ok) return ctx._refuse(a.why, verb, uuid, targetHint)
      if (fromIpc && ctx._ipcAbilityStreak >= 3) return ctx._refuse("ipcability", a.verb, uuid)
      var why = Model.canAct(ctx._pending, ctx._inflightAction, a.uuid, Date.now(), ctx._lastActionLaunchAt)
      if (why) return ctx._refuse(why, a.verb, a.uuid)
      var req = ctx._descriptorFor(a)
      if (!req) return ctx._refuse("notapplicable", a.verb, a.uuid)
      ctx._inflightAction = { verb: a.verb, uuid: a.uuid, name: a.name, targetType: a.targetType, kind: a.kind, status: a.status, at: Date.now(), fromIpc: !!fromIpc }
      ctx._setPending(ctx._inflightAction, null)
      ctx._lastActionLaunchAt = Date.now()
      var log = ctx._actionLog.filter(function(t) { return Date.now() - t < 60000 }); log.push(Date.now()); ctx._actionLog = log
      if (!ctx._launch(actionReq, req, 10)) {
        ctx._clearPending(a.uuid); ctx._inflightAction = null
        return ctx._refuse("busy", a.verb, a.uuid)
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
        case "deployTag": return Model.TAG_RE.test(a.name || "") ? Api.reqDeployTag(a.name) : null   // the name is the query value (SR28)
        default: return null
      }
    }

    // Local refusals: one status line each, no request, lastAction.result "refused".
    // Returns the IPC token; the panel reads the status line.
    function _refuse(why, verb, uuid, targetHint) {
      // The uuid is caller input: bounded and single-line before it reaches stdout; the log gets 8 chars.
      var u = String(uuid || "").replace(/[\r\n\t]/g, " ").slice(0, 64), u8 = u.slice(0, 8), token = why
      switch (why) {
        case "notconfigured": ctx._say("Not configured", "urgent"); token = "not configured"; break
        case "unsafe": ctx._say("Config is unsafe", "urgent"); token = "config unsafe"; break
        case "probe": ctx._say("Token rejected", "urgent"); token = "token rejected"; break
        case "ratelimited": ctx._say("Rate limited · backing off " + ctx._backoffSec + "s", "urgent"); token = "rate limited"; break
        case "toomany": ctx._say("Too many requests · try again shortly", "urgent"); token = "rate limited"; break
        case "invalid": case "unknown": {
          var word = targetHint === "deployment" || targetHint === "server" || targetHint === "tag" ? targetHint : "resource"
          ctx._say("Coolify no longer has that " + word, "urgent"); token = "unknown uuid " + u; break
        }
        case "nav":                      // Phase 4: open/logs/history are the panel's, never an action
        case "notapplicable": ctx._say("Nothing to " + verb, "dim"); token = "not applicable " + verb + " " + u; break
        case "already pending": {
          var p = ctx._pending[u] || (ctx._inflightAction && ctx._inflightAction.uuid === u ? ctx._inflightAction : null)
          ctx._say((p && p.name ? p.name : "It") + " is already " + Model.gerund(p ? p.verb : verb), "dim"); token = "already pending " + u; break
        }
        case "busy": ctx._say("Busy, try again", "dim"); token = "busy"; break
        case "wronginstance": ctx._say("Instance changed; nothing sent", "urgent"); token = "wrong instance"; break
        case "ipcability": ctx._say("Token lacks the " + (ctx._lastAbility || "required") + " permission", "urgent"); token = "refused: token lacks the " + (ctx._lastAbility || "required") + " permission"; break
        default: ctx._say("Nothing to " + verb, "dim")
      }
      ctx._lastAction = { verb: String(verb || ""), uuid8: u8, code: 0, curlExit: 0, ms: 0, at: Date.now(), result: "refused", instance: ctx.instId }
      console.log("coolwatch action refuse " + why + " " + String(verb || "").slice(0, 16) + " " + u8)
      return token
    }

    // Called from _finish after _syncBusy() and the liveSeq guard. Never _fail, never
    // _error/_backoff/_probeMode/consecutiveFailures; the one escalation is a 429 pause.
    function _finishAction(p, code, out, err) {
      var a = ctx._inflightAction; ctx._inflightAction = null
      if (!a) return
      var rec = Model.splitResponses(out)[0] || { exit: code || 1, code: 0, body: "", timeMs: 0, bytes: 0, errmsg: "",
                                                 headers: { retryAfter: null, rateLimitRemaining: null, rateLimitLimit: null } }
      var o = Model.actionOutcome(a.verb, a.targetType, rec)
      ctx._record("action", rec)
      var limited = !!(o.error && o.error.kind === "ratelimited")
      if (limited) ctx._pauseFor(rec.headers)
      // Any non-2xx clears pending (a 429 answers before the action runs); only a reap keeps it.
      if (o.ok) ctx._setPending(a, o.deploymentUuid, o.deploymentUuids)
      else ctx._clearPending(a.uuid)
      if (o.error && o.error.kind === "ability") {
        ctx._lastAbility = Model.abilityOf(o.error.detail) || ""
        if (a.fromIpc) ctx._ipcAbilityStreak += 1
      } else if (o.ok) ctx._ipcAbilityStreak = 0
      var result = o.ok ? (o.deploymentUuid ? "queued" : "ok") : (o.error ? (o.error.kind === "ability" ? "ability" : (o.error.kind === "offline" ? "offline" : "http")) : "http")
      ctx._say(o.text, o.tone)
      ctx._lastAction = { verb: a.verb, uuid8: a.uuid.slice(0, 8), code: rec.code, curlExit: rec.exit, ms: rec.timeMs, at: Date.now(), result: result, instance: ctx.instId }
      console.log("coolwatch action " + a.verb + " " + rec.code + " exit=" + rec.exit + " " + rec.timeMs + "ms " + a.uuid.slice(0, 8))
    }

    function _say(text, tone) {
      ctx._actionStatus = String(text || "")
      ctx._actionTone = tone === "urgent" ? "urgent" : "dim"
      actionStatusTimer.interval = tone === "urgent" ? 6000 : 2200
      actionStatusTimer.restart()
    }

    function _copyPending() { var p = {}; for (var k in ctx._pending) p[k] = ctx._pending[k]; return p }

    function _setPending(a, depUuid, depUuids) {
      var p = ctx._copyPending(); var ex = p[a.uuid]
      p[a.uuid] = { verb: a.verb, targetType: a.targetType, kind: a.kind || null, name: a.name || "",
                    since: ex ? ex.since : Date.now(),
                    baseStatus: a.targetType === "resource" ? (a.status || null) : null,
                    baseState: a.targetType === "resource" ? Model.parseStatus(a.status || "").state : null,
                    deploymentUuid: depUuid || (ex ? ex.deploymentUuid : null),
                    deploymentUuids: Array.isArray(depUuids) && depUuids.length ? depUuids.slice() : (ex && ex.deploymentUuids ? ex.deploymentUuids : []),   // Phase 4: a tag deploy names several
                    stale: !!(ex && ex.stale) }
      ctx._pending = p
      ctx._actionAt[a.uuid] = Date.now(); ctx._actionAt = ctx._actionAt   // a user action explains a later flap (Phase 3)
    }

    function _clearPending(uuid) {
      if (!Object.prototype.hasOwnProperty.call(ctx._pending, uuid)) return
      var p = ctx._copyPending(); delete p[uuid]; ctx._pending = p
    }

    // The per-verb clear table (docs/architecture.md, Actions). Runs on the reaper tick;
    // reassigns _pending only when an entry was dropped or flipped to stale.
    function _expirePending(now) {
      var keys = Object.keys(ctx._pending)
      if (!keys.length) return
      var p = ctx._copyPending(), changed = false
      for (var i = 0; i < keys.length; i++) {
        var u = keys[i], e = p[u], drop = false
        var res = null, srv = null, dep = null
        if (e.targetType === "resource") res = ctx._resources.filter(function(r) { return r.uuid === u })[0] || null
        else if (e.targetType === "server") srv = ctx._servers.filter(function(s) { return s.uuid === u })[0] || null
        else if (e.targetType !== "tag") dep = ctx._deployments.filter(function(d) { return d.uuid === u })[0] || null
        // A tag is in none of the three lists, so it is never `gone`; its own arm below clears it.
        var gone = e.targetType === "tag" ? false : (e.targetType === "resource" ? !res : (e.targetType === "server" ? !srv : !dep))
        if (gone || now - e.since >= Model.PENDING_DROP_MS) drop = true
        else if (e.verb === "deployTag") {
          // Phase 4: cleared when any named deployment is listed or finished, or 10 s of
          // deployments polls have run since the action without listing one.
          var ids = e.deploymentUuids || []
          drop = ids.some(function(id) { return ctx._activeUuids.indexOf(id) >= 0 || ctx._recent.some(function(d) { return d.uuid === id }) })
              || (ctx._lastPollAt.deployments || 0) > e.since + 10000
        }
        else if (e.verb === "deploy" || e.verb === "redeploy" || e.verb === "rebuild" || e.verb === "restart") {
          if (e.deploymentUuid) {
            // Seen in the active list or in recent; or two deployments polls have run since the
            // action without listing it (a deployment shorter than the poll interval): the
            // deployment row, not this entry, carries the state from here.
            drop = ctx._activeUuids.indexOf(e.deploymentUuid) >= 0 || ctx._recent.some(function(d) { return d.uuid === e.deploymentUuid })
                || (ctx._lastPollAt.deployments || 0) > e.since + 10000
          } else if (e.kind === "application") {
            // Before the response names the deployment: only a deployment created for this
            // action (not one already running) clears it.
            drop = ctx._deployments.some(function(d) { return d.appUuid === u && Date.parse(d.createdAt || "") >= e.since - 5000 })
          } else {
            drop = (ctx._lastPollAt.resources || 0) > e.since + 2000
          }
        } else if (e.verb === "stop" || e.verb === "start") {
          // Prefix match on the state (AGENTS.md): a health blip must not clear a stop.
          if (Model.parseStatus(res.status || "").state !== e.baseState) drop = true
          else if (!e.stale && now - e.since >= Model.PENDING_STALE_MS) { e.stale = true; p[u] = e; changed = true }
        } else if (e.verb === "validate") {
          drop = (ctx._lastPollAt.servers || 0) > e.since + 2000
        }
        // cancel: the deployment leaving the active list is the `gone` case above
        if (drop) { delete p[u]; changed = true }
      }
      if (changed) ctx._pending = p
    }

    Timer { id: actionStatusTimer; interval: 2200; repeat: false; running: false; onTriggered: ctx._actionStatus = "" }

    // ---- scheduler -----------------------------------------------------------------------

    function _pollVersion() { if (ctx._backoffUntil("version") <= Date.now()) ctx._launch(versionReq, Api.reqVersion(), 6) }
    function _pollDeployments() { if (ctx._backoffUntil("deployments") <= Date.now()) ctx._launch(deploymentsReq, Api.reqDeployments(), 12) }   // log-bearing: 12 s, 4 MB (SR30)
    function _pollResources() { if (ctx._backoffUntil("resources") <= Date.now()) ctx._launch(resourcesReq, Api.reqResources(), 10) }
    function _pollServers() { if (ctx._backoffUntil("servers") <= Date.now()) ctx._launch(serversReq, Api.reqServers(), 10) }
    // A tick that lands while stage 2 is still draining is skipped: the queue finishes first.
    function _pollTopology() {
      if (ctx._topologyQueue.length || topologyReq.running || topologyReq.stopping) return
      if (ctx._backoffUntil("topology") <= Date.now()) ctx._launch(topologyReq, [Api.reqProjects()], 8)
    }

    // which: "all" (refresh, token ready), "stale" (panel open), "missing" (startup ramp)
    function _prime(which) {
      if (!ctx._ready) return
      var now = Date.now()
      if (which === "all") { if (now - ctx._lastPrimeAt < 2000) return; ctx._lastPrimeAt = now }
      function want(kind, idleSec) {
        if (which === "all") return true
        if (which === "missing") return !ctx._baseline[kind]
        return now - (ctx._lastPollAt[kind] || 0) >= idleSec * 1000
      }
      if (want("deployments", ctx._deploymentsSec)) ctx._pollDeployments()
      if (want("version", 100000)) ctx._pollVersion()
      if (want("resources", ctx._resourcesSec)) ctx._pollResources()
      if (want("servers", ctx._serversSec)) ctx._pollServers()
    }

    // Changing a running Timer's interval restarts it, so after a cadence flip a kind
    // whose last poll is older than the new interval launches immediately.
    function _catchUp(kind, sec, fn) {
      if (!ctx._timersOn) return
      if (Date.now() - (ctx._lastPollAt[kind] || 0) >= sec * 1000) fn()
    }

    Timer { id: deploymentsTimer; interval: ctx._deploymentsSec * 1000; repeat: true; triggeredOnStart: false; running: ctx._timersOn
            onTriggered: ctx._pollDeployments(); onIntervalChanged: ctx._catchUp("deployments", ctx._deploymentsSec, ctx._pollDeployments) }
    Timer { id: resourcesTimer; interval: ctx._resourcesSec * 1000; repeat: true; triggeredOnStart: false; running: ctx._timersOn
            onTriggered: ctx._pollResources(); onIntervalChanged: ctx._catchUp("resources", ctx._resourcesSec, ctx._pollResources) }
    Timer { id: serversTimer; interval: ctx._serversSec * 1000; repeat: true; triggeredOnStart: false; running: ctx._timersOn
            onTriggered: { ctx._pollServers(); root._selfHeal(); if (!ctx._baseline.version) ctx._pollVersion() } }
    Timer { id: topologyTimer; interval: ctx._topologySec * 1000; repeat: true; triggeredOnStart: false; running: ctx._timersOn
            onTriggered: ctx._pollTopology() }
    // Startup spreads its requests: 4 kinds at token-ready, /projects at +65 s (outside the
    // first minute's burst), then one stage-2 block every 40 s, so no 60 s window holds
    // more than 2 topology requests.
    // The kick is skipped when a panel opening already drained the topology (with 10 s
    // spacing the first drain finishes before 65 s; the kick would run the fan-out twice).
    Timer { id: topologyKick; interval: 65000; repeat: false; running: false; onTriggered: if (ctx._ready && !ctx._topologyLoaded) ctx._pollTopology() }
    // One block per 10 s while a panel is open and the topology is incomplete (six blocks
    // in the first minute on top of the ≈20/min panel-open idle rate stays under the 60
    // line); 40 s otherwise, so the closed-panel "under 20" bar is untouched. A running
    // Timer restarts on an interval change, so opening a panel mid-drain re-arms at 10 s.
    // The fast spacing applies to the first drain only (the latch), so the periodic
    // refresh keeps the 40 s cadence. A Timer restarts on an interval change, so a panel
    // opening or closing mid-drain launches at once when the last block is already older
    // than the new interval (the _catchUp shape) instead of waiting a whole interval again.
    Timer { id: topologyStep; interval: root._panelOpen && !ctx._topologyLoaded ? 10000 : 40000; repeat: true; triggeredOnStart: false; running: ctx._timersOn && ctx._topologyQueue.length > 0
            onTriggered: ctx._topologyStep()
            onIntervalChanged: if (ctx._topologyQueue.length && Date.now() - ctx._lastTopologyStepAt >= interval) ctx._topologyStep() }

    // First 30 s after the token is ready: retry kinds that have not answered yet every 2 s.
    Timer {
      id: startupRamp
      property int ticks: 0
      interval: 2000
      repeat: true
      running: ctx._ready && !ctx._baselineDone && !ctx._paused && !ctx._probeMode && ticks < 15
      onTriggered: { ticks += 1; ctx._prime("missing") }
    }
    // 401/403: everything stops; one deployments probe a minute until a 2xx or a config change.
    Timer { id: probeTimer; interval: 60000; repeat: true; running: ctx._ready && ctx._probeMode; onTriggered: ctx._launch(deploymentsReq, Api.reqDeployments(), 12) }   // log-bearing: 12 s, 4 MB (SR30)
    // 429: everything pauses for Retry-After (clamped) or the ladder.
    Timer { id: pauseTimer; interval: 30000; repeat: false; running: false; onTriggered: { ctx._paused = false; ctx._prime("all"); ctx._drainTerminal() } }

    // Reaper: armed once, never restarted (tailscale lesson). A Req past its deadline is

    // The root's reaper tick: kill Reqs past their deadline, expire pending, prune ledgers.
    function _reap(now) {
        for (var i = 0; i < ctx._reqs.length; i++) {
          var p = ctx._reqs[i]
          p.escalate(now)
          if (p.running && p.deadline > 0 && now > p.deadline) {
            p.kill()
            var pk = ctx._perKindEntry(p.kind)
            pk.reaps += 1; pk.lastReapAt = now
            if (p === actionReq) {
              // A reaped POST may have landed: pending stays, no backoff, no retry (SR7).
              ctx._perKind = ctx._perKind
              var ia = ctx._inflightAction; ctx._inflightAction = null
              ctx._say("Sent, but Coolify did not answer", "urgent")
              ctx._lastAction = { verb: ia ? ia.verb : "", uuid8: ia ? ia.uuid.slice(0, 8) : "", code: 0, curlExit: 0, ms: 0, at: now, result: "reaped", instance: ctx.instId }
              console.warn("coolwatch reaped action")
              continue
            }
            if (ctx._isViewKind(p.kind)) {
              // A reaped view fetch is a message in the view: no failure count, no backoff (SR29).
              ctx._perKind = ctx._perKind
              ctx._viewFail(p, { exit: 28, code: 0, body: "", errmsg: "no answer in time", headers: null })
              ctx._viewDone(p)
              console.warn("coolwatch reaped " + p.kind)
              continue
            }
            pk.consecutiveFailures += 1
            ctx._perKind = ctx._perKind
            var bo = ctx._backoff; var a = ((bo[p.kind] && bo[p.kind].attempt) || 0) + 1
            bo[p.kind] = { until: now + (a <= 1 ? 30 : 60) * 1000, attempt: a }; ctx._backoff = bo
            console.warn("coolwatch reaped " + p.kind)
            if (p.kind === "deployment") { ctx._drainDone(false, false); ctx._drainTerminal() }
          }
        }
        ctx._expirePending(now)
        ctx._pruneNotify(now)
        ctx._syncBusy()
    }

    // A released context (its id left the config, or the shell is going down) kills its
    // requests and forgets its token (SR34).
    Component.onDestruction: {
      deploymentsTimer.running = false; resourcesTimer.running = false; serversTimer.running = false; topologyTimer.running = false
      startupRamp.running = false; probeTimer.running = false; pauseTimer.running = false; topologyKick.running = false; topologyStep.running = false
      actionStatusTimer.running = false
      tokenCmd.running = false
      for (var i = 0; i < ctx._reqs.length; i++) ctx._reqs[i].kill()
      ctx._token = ""
    }

    // ---- status: this context's part of `status` ------------------------------------------
    function _status() {
      var intervals = { deployments: ctx._deploymentsSec, resources: ctx._resourcesSec, servers: ctx._serversSec, topology: ctx._topologySec, version: 0, deployment: 0 }
      var per = {}
      for (var k in ctx._perKind) { per[k] = {}; for (var f in ctx._perKind[k]) per[k][f] = ctx._perKind[k][f]; per[k].interval = intervals[k] || 0; per[k].bytesLastMin = ctx._bytesLastMin(k) }
      // Phase 4: the newest pinned build log, counts only (SR26).
      var lv = null, tk = Object.keys(ctx._logTargets)
      if (tk.length) { var tu = ctx._logTargets[tk[tk.length - 1]]; lv = Model.logViewStatus({ kind: "buildlog", uuid: tu }, ctx._buildLogs[tu] || null) }
      var hist = null, hk = Object.keys(ctx._history)
      if (hk.length) { var hp = ctx._history[hk[hk.length - 1]]; hist = { uuid8: Model.uuid8(hp.appUuid), rows: hp.rows.length, count: hp.count, skip: hp.skip, loading: hp.loading, pages: Math.ceil(hp.rows.length / Api.HISTORY_TAKE) } }
      var configState = root._configError ? root._configError.kind
        : (ctx._error && ["tokencmd", "waitingtoken"].indexOf(ctx._error.kind) >= 0 ? ctx._error.kind : (ctx._ready ? "ok" : "unconfigured"))
      return {
        configState: configState,
        configMode: root._configMode || null,
        tokenSource: ctx._ready ? ctx._tokenSource : null,
        instance: ctx._instance ? { id: ctx._instance.id, name: ctx._instance.name, version: ctx._version } : null,
        counts: { servers: ctx._servers.length, resources: ctx._resources.length, deployments: ctx._activeCount, recent: ctx._recent.length },
        perKind: per,
        requestsLastMin: ctx._requestsLastMin(),
        rateLimitRemaining: ctx._rateLimitRemaining,
        backoffUntil: ctx._maxBackoffUntil(),
        paused: ctx._paused,
        probeMode: ctx._probeMode,
        openPanels: root._openPanels,
        baselineDone: ctx._baselineDone,
        topologyFetched: ctx._topologyFetched,
        topologyLoaded: ctx._topologyLoaded,
        terminalQueue: ctx._terminalQueue.length,
        drainRetries: ctx._drainRetries,
        recentPersisted: ctx._recentPersisted,
        recentRejected: ctx._recentRejected,
        error: ctx._error ? { kind: ctx._error.kind, request: ctx._error.request, httpCode: ctx._error.httpCode, curlExit: ctx._error.curlExit } : null,
        id: ctx.instId,
        warning: ctx._warning ? ctx._warning.kind : null,
        bar: { glyph: "U+" + ctx.bar.glyph.codePointAt(0).toString(16).toUpperCase(), dimmed: ctx.bar.dimmed, active: ctx.bar.active },
        topologyQueue: ctx._topologyQueue.length,
        lastAction: ctx._lastAction,
        pending: Object.keys(ctx._pending).length,
        pendingStale: Object.keys(ctx._pending).filter(function(k) { return !!ctx._pending[k].stale }).length,
        actionsLastMin: ctx._actionsLastMin(),
        inflightAction: ctx._inflightAction !== null,
        baseline: { deployments: ctx._baseline.deployments, resources: ctx._baseline.resources, servers: ctx._baseline.servers, version: ctx._baseline.version },
        logView: lv,
        buildLogsHeld: Object.keys(ctx._buildLogs).length,
        history: hist,
        tags: { count: ctx._tags.length, fetchedAt: ctx._tagsAt },
        sensitive: ctx._sensitive,
        notify: {
          enabled: root._cfg ? root._cfg.notify : Model.notifyDefaults(),
          warning: root._cfg && root._cfg.warning ? root._cfg.warning : null,   // visible even when another warning holds the callout
          sentLastMin: root._notifiedLastMin(),
          suppressed: ctx._suppressed,     // cumulative per rule since the last config change
          queued: ctx._notifyQueue.length,
          lastEvent: ctx._lastEvent,       // { kind: <event name>, at }; never a name
          dnd: (function() { var d = root._dnd(); return d === null ? null : (d ? "on" : "off") })()
        }
      }
    }
  }
}
