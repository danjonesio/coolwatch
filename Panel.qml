import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "Api.js" as Api

// One instance per monitor. Reads the service snapshot; never polls. Rows are
// flattened by Model.panelRows only while open; `rowsModel` (a plain array) is the index
// space for the cursor and `rowsList` (a ListModel) is what the ListView renders, patched
// in place by key so the scroll position and the delegates survive a change (a wholesale
// model swap resets contentY to 0 and rebuilds every row). The cursor is a row key.
Panel {
  id: root
  moduleName: "io.github.danjonesio.coolwatch"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var service: null
  readonly property var barIdentity: hostWidget || root
  readonly property var svc: service || (bar && bar.shell && typeof bar.shell.serviceFor === "function"
    ? bar.shell.serviceFor(root.moduleName) : null)

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color accent: Color.accent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property string panelId: String(Date.now()) + "-" + Math.random().toString(36).slice(2)
  property double nowMs: Date.now()
  property string groupBy: "project"
  property var folded: ({})
  property bool cursorActive: false
  property string focusSection: "list"      // "hero" | "list"
  property string cursorKey: ""
  property var rowsModel: []
  property bool reflowing: false            // rows just swapped: ignore the hover the recreated delegates emit

  // Phase 2 panel-local state (per monitor): the expanded leaf row, the focused action
  // button (an id, never an index, so a shrinking set keeps focus), and the confirm.
  property string expandedKey: ""
  property string actionFocus: ""
  property bool moreOpen: false             // the strip's secondary line (Logs · History · Open) is shown
  property bool confirmOpen: false
  property var confirmAction: null          // immutable { verb, uuid, name } captured when the dialog opens
  property bool confirmArmed: false         // Enter resolves the dialog only after confirmArm fires
  property double _lastLadderAt: 0

  // Phase 4 overlay views (per monitor). A view is a plain object; its live record is read
  // from svc.views by uuid, never from the pushed object. The overlay owns its own
  // ListModel: log lines are appended by absolute entry index, never routed through rows.
  property var viewStack: []                // [] | [view] | [history, buildlog]
  readonly property var view: root.viewStack.length ? root.viewStack[root.viewStack.length - 1] : null
  property bool following: true             // build log sticks to the newest line until the user scrolls up
  property bool showHidden: false           // H: internal steps (the failing one is always shown)
  property string viewCursorKey: ""         // cursor inside a history/picker view (a key, never an index)
  property int consumed: 0                  // absolute entry index the ListModel has been filled up to
  property int seenDropped: 0
  property int tailI: -1                    // the last rendered entry and its output length: a poll can grow the last entry in place
  property int tailLen: -1
  property int lastFailIndex: -1
  property string _prevFocus: "list"
  readonly property var liveRec: root.view && root.svc && root.svc.views
    ? (root.view.kind === "buildlog" ? (root.svc.views.buildLogs[root.view.uuid] || null)
     : root.view.kind === "containerlog" ? (root.svc.views.containerLogs[root.view.uuid] || null)
     : root.view.kind === "history" ? (root.svc.views.history[root.view.uuid] || null)
     : (root.svc.views.picks[root.view.uuid] || null)) : null
  // One string that changes exactly when the overlay must re-sync (never on an unrelated slice).
  readonly property string myRev: !root.view ? "" : !root.liveRec ? "none"
    : root.view.kind === "buildlog" ? [root.liveRec.rev, root.liveRec.status, root.liveRec.message || "", root.liveRec.refused, root.liveRec.bytes].join("|")
    : root.view.kind === "containerlog" ? [root.liveRec.fetchedAt, root.liveRec.message || "", root.liveRec.lines ? root.liveRec.lines.length : -1].join("|")
    : root.view.kind === "history" ? [root.liveRec.at, root.liveRec.rows.length, root.liveRec.loading, root.liveRec.message || "", root.liveRec.count].join("|")
    : [root.liveRec.names ? root.liveRec.names.length : -1, root.liveRec.message || ""].join("|")
  onMyRevChanged: root.syncView(false)
  onShowHiddenChanged: root.syncView(true)

  readonly property var snapshot: svc ? svc.snapshot : null
  readonly property var pending: svc && svc.pending ? svc.pending : ({})
  readonly property var rows: root.opened && root.snapshot
    ? Model.panelRows(root.snapshot, { groupBy: root.groupBy, folded: root.folded, nowMs: root.ageMs, expandedKey: root.expandedKey, moreOpen: root.moreOpen, pending: root.pending }) : []
  // Coarse clock for the one-hour age-out, so rows are not recomputed every second.
  readonly property double ageMs: Math.floor(root.nowMs / 60000) * 60000
  readonly property int selectedIndex: Model.indexOfKey(root.rowsModel, root.cursorKey)
  readonly property var currentRow: root.selectedIndex >= 0 ? root.rowsModel[root.selectedIndex] : null
  readonly property bool heroHasCursor: root.cursorActive && root.focusSection === "hero"
  readonly property var callout: Model.callout(root.snapshot, root.nowMs)
  readonly property bool busy: !!(root.snapshot && root.snapshot.busy)

  onRowsChanged: applyRows()
  onOpenedChanged: {
    if (!opened) { root.confirmOpen = false; root.confirmAction = null; root.confirmArmed = false; root.expandedKey = ""; root.actionFocus = ""; root.moreOpen = false; root.clearViews() }
    if (!svc) return
    if (opened) svc.panelOpened(panelId)
    else svc.panelClosed(panelId)
  }
  Component.onDestruction: if (svc) svc.panelClosed(panelId)
  // Phase 4: an instance switch (chip, h/l, middle-click, IPC) pops every view and collapses
  // the row: the rows underneath belong to the new instance now.
  Connections {
    target: root.svc
    function onActiveIdChanged() { root.clearViews(); root.expandedKey = ""; root.actionFocus = ""; root.moreOpen = false }
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.opened
    // The heartbeat re-asserts the watched build log every second, so the service never loses it.
    onTriggered: { root.nowMs = Date.now(); if (root.svc) root.svc.panelAlive(root.panelId, root.view && root.view.kind === "buildlog" ? root.view.uuid : "") }
  }
  // Arms the confirm 250 ms after it opens: an Enter that opened it (and its auto-repeat)
  // cannot also resolve it, and a pointer already over the Confirm cell is re-overridden.
  Timer { id: confirmArm; interval: 250; repeat: false; running: false; onTriggered: { root.confirmArmed = true; confirm.selectedIndex = 0 } }
  // Two roles, fixed from the first insert: `key` and the plain row object (a variant map,
  // so a nested `actions` array reaches the delegate as an array). Patched by applyRows only.
  ListModel { id: rowsList }

  function open() { root.controller.show() }
  function close() { root.controller.hide() }
  function toggle() { root.opened ? close() : open() }
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }
  function refreshNow() { if (svc) svc.refresh() }

  function toneColor(t) {
    if (t === "urgent") return root.urgent
    if (t === "accent") return root.accent
    if (t === "dim") return root.dim
    return root.foreground
  }

  function applyRows() {
    var next = root.rows
    if (Model.sameRows(root.rowsModel, next)) return
    var prev = root.selectedIndex
    root.reflowing = true
    var ops = Model.listPatch(root.rowsModel, next)
    root.rowsModel = next
    for (var o = 0; o < ops.length; o++) {
      var op = ops[o]
      if (op.op === "remove") rowsList.remove(op.i, op.n)
      else if (op.op === "set") rowsList.set(op.i, { key: op.row.key, row: op.row })
      else for (var r = 0; r < op.rows.length; r++) rowsList.insert(op.i + r, { key: op.rows[r].key, row: op.rows[r] })
    }
    Qt.callLater(function() { root.reflowing = false })
    var i = Model.indexOfKey(next, root.cursorKey)
    if (i < 0 && next.length) {
      // Nearest surviving row: the old position, else the last selectable one.
      i = Model.nextSelectable(next, Math.min(Math.max(prev, 0), next.length - 1) - 1, 1)
      if (i < 0) i = Model.nextSelectable(next, next.length, -1)
    }
    if (i >= 0 && next[i].key !== root.cursorKey) root.cursorKey = next[i].key
    if (root.cursorActive && i !== prev && !root.view) Qt.callLater(root.scrollToSelection)   // never fights the overlay's follow
    // The expansion and the focused button are repaired the same way as the cursor.
    if (root.expandedKey) {
      var ai = Model.indexOfKey(next, "act:" + root.expandedKey)
      if (ai < 0) { root.expandedKey = ""; root.actionFocus = "" }
      else if (root.actionFocus) {
        var ids = next[ai].actions.map(function(a) { return a.id })
        if (ids.indexOf(root.actionFocus) < 0) root.actionFocus = ids[0]
      }
    }
  }

  // The rows binding re-evaluates synchronously on groupBy, so by the time this
  // returns rowsModel already holds the new grouping and the cursor can be placed.
  function setGroupBy(v) {
    if (v !== "project" && v !== "server") return
    root.expandedKey = ""; root.actionFocus = ""
    root.groupBy = v
    var r = Model.firstSelectableInSection(root.rowsModel, "RESOURCES")
    if (r >= 0) { root.cursorActive = true; root.focusSection = "list"; root.cursorKey = root.rowsModel[r].key; Qt.callLater(root.scrollToSelection) }
  }

  function focusHero() {
    if (root.view) return                     // the ring stays put while a view is open
    root.cursorActive = true
    root.focusSection = "hero"
  }

  function hoverCursor(key) {
    if (root.reflowing || root.confirmOpen || root.view) return
    root.setCursor(key)
  }

  // A button under the pointer takes the ring; same guards as hoverCursor (a reflow
  // recreates delegates under a stationary mouse).
  function hoverAction(parentKey, id) {
    if (root.reflowing || root.confirmOpen) return
    root.setCursor(parentKey)
    root.actionFocus = id
  }

  function setCursor(key) {
    root.cursorActive = true
    root.focusSection = "list"
    root.cursorKey = key
  }

  function moveCursor(dx, dy) {
    root.cursorActive = true
    if (dx !== 0) {
      if (root.focusSection === "hero") { if (svc && svc.instances.length > 1) svc.cycleInstance(dx); return }   // Phase 4: h/l on the hero switch instance
      var row = root.currentRow
      if (!row) return
      if (row.type === "fold") { if (dx > 0 ? row.open : !row.open) return; root.toggleFold(row.key); return }   // l unfolds, h folds
      if (root.expandedKey === row.key) {
        var ar = root.actionsRowFor(row.key)
        if (!ar) return
        if (!root.actionFocus) { if (dx > 0) root.actionFocus = ar.actions[0].id; else root.collapse(); return }
        root.actionFocus = Model.nextAction(ar.actions, root.actionFocus, dx)   // "" on h from the first: back to the row
        return
      }
      if (dx > 0) root.expand(row)
      return
    }
    if (root.actionFocus) root.actionFocus = ""
    if (root.focusSection === "hero") {
      if (dy > 0) {
        var first = Model.nextSelectable(root.rowsModel, -1, 1)
        if (first >= 0) { root.focusSection = "list"; root.cursorKey = root.rowsModel[first].key; Qt.callLater(root.scrollToSelection) }
      }
      return
    }
    var idx = root.selectedIndex
    var next = Model.nextSelectable(root.rowsModel, idx, dy)
    if (next < 0) {
      if (dy < 0) root.focusSection = "hero"
      return
    }
    root.cursorKey = root.rowsModel[next].key
    Qt.callLater(root.scrollToSelection)
  }

  function activateCursor() {
    if (root.focusSection === "hero") { root.refreshNow(); return }
    var row = root.currentRow
    if (!row) return
    if (row.type === "fold") { root.toggleFold(row.key); return }
    if (root.expandedKey === row.key) {
      if (root.actionFocus) root.runAction(root.actionFocus, row.key)
      else root.collapse()
      return
    }
    root.expand(row)
  }

  function toggleFold(key) {
    var f = {}
    for (var k in root.folded) f[k] = root.folded[k]
    f[key] = !f[key]
    root.folded = f
  }

  // ---- Phase 2: expansion, actions, confirm --------------------------------------------

  function actionsRowFor(key) {
    var i = Model.indexOfKey(root.rowsModel, "act:" + key)
    return i >= 0 ? root.rowsModel[i] : null
  }

  // Emits the actions row (the rows binding re-evaluates synchronously on expandedKey),
  // focuses its first button, and pulls the strip into view after the parent.
  function expand(row) {
    if (!row || !Model.actionsFor(row).length) return
    root.moreOpen = false
    root.expandedKey = row.key
    var ar = root.actionsRowFor(row.key)
    root.actionFocus = ar ? ar.actions[0].id : ""
    Qt.callLater(function() { root.scrollToKey("act:" + row.key) })
  }

  function collapse() { root.expandedKey = ""; root.actionFocus = ""; root.moreOpen = false }

  // More/Less is a panel toggle, never a verb: it re-emits the strip with or without its
  // secondary line and keeps the ring on the toggle (the id survives the re-emit).
  function toggleMore(key) {
    if (root.expandedKey !== key) return
    root.moreOpen = !root.moreOpen
    root.actionFocus = Model.MORE_ID
    Qt.callLater(function() { root.scrollToKey("act:" + key) })
  }

  // A left click on a leaf row places the cursor and opens its action strip (or closes
  // it when it is the expanded one); the strip's buttons are themselves clickable.
  function clickRow(row) {
    if (!row || root.confirmOpen) return
    root.setCursor(row.key)
    if (root.expandedKey === row.key) root.collapse()
    else root.expand(row)
  }

  // Every action funnels through here: a button click, a text key, or the confirm.
  // The service re-resolves the uuid and is the authoritative gate; this only decides
  // whether to confirm first and turns "open" into a browser launch.
  function runAction(verb, key) {
    var i = Model.indexOfKey(root.rowsModel, key)
    var row = i >= 0 ? root.rowsModel[i] : null
    if (!row) return
    if (verb === Model.MORE_ID) { root.toggleMore(key); return }
    var a = Model.actionFor(row, verb)
    if (!a) return
    if (a.id === "open") { root.openRow(row); return }
    if (a.id === "logs") { root.openLogsFor(row); return }        // Phase 4: navigation, never act()
    if (a.id === "history") { root.openHistoryFor(row); return }
    if (!svc) return
    if (a.id === "dismiss") { svc.dismissRecent(row.uuid); return }     // Phase 4b: local, never act()
    // Fail closed: a confirming verb never reaches act() from here; only resolveConfirm does.
    if (a.confirm) { if (!root.confirmOpen) root.openConfirm(a.id, row); return }
    svc.act(a.id, row.uuid, false, row.type)
  }

  // SR9: the only browser launch in the panel, and it only ever receives row.url, which
  // Model.openUrl built from the instance origin. One argv element, no shell parsing.
  function openRow(row) {
    if (root.confirmOpen) return          // the scrim only absorbs left clicks; right clicks reach the rows
    if (row && row.url) Util.execArgv(["omarchy-launch-browser", row.url])
  }

  function openConfirm(verb, row) {
    var c = Model.confirmCopy(verb, row.name)
    root.confirmAction = { verb: verb, uuid: row.uuid, name: row.name, type: row.type, instanceId: svc ? svc.activeId : "" }   // Phase 4: bound to the instance it was opened on (SR38)
    confirm.message = c.message; confirm.cancelText = c.cancelText; confirm.confirmText = c.confirmText
    confirm.selectedIndex = 0
    root.confirmArmed = false
    root.confirmOpen = true
    confirmArm.restart()
  }

  // Idempotent: the second signal of a Return (returnRequested + activateRequested), a
  // click and a key, or a held key all find confirmAction already null.
  function resolveConfirm(ok) {
    var c = root.confirmAction
    root.confirmAction = null
    root.confirmOpen = false
    root.confirmArmed = false
    if (ok && c && svc) svc.act(c.verb, c.uuid, false, c.type, c.instanceId)   // the service refuses with "Instance changed; nothing sent" on a mismatch
  }

  // Esc ladder: close the confirm, else collapse the row, else close the panel. One
  // rung per 250 ms, so a held Esc (auto-repeat is not filtered) cannot run all three.
  function closeLadder() {
    var now = Date.now()
    if (now - root._lastLadderAt < 250) return
    root._lastLadderAt = now
    if (root.confirmOpen) { root.resolveConfirm(false); return }
    if (root.viewStack.length) { root.popView(); return }       // Phase 4: a view is the first rung
    if (root.expandedKey) { root.collapse(); return }
    root.close()
  }

  function scrollToSelection() {
    if (!listView || root.selectedIndex < 0) return
    listView.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  // Parent first, strip last: the parent only leaves the view when both cannot fit.
  function scrollToKey(key) {
    if (!listView) return
    if (root.selectedIndex >= 0) listView.positionViewAtIndex(root.selectedIndex, ListView.Contain)
    var i = Model.indexOfKey(root.rowsModel, key)
    if (i >= 0) listView.positionViewAtIndex(i, ListView.Contain)
  }

  // ---- Phase 4: overlay views (build log, container log, service picker, history) --------
  // The service owns every byte of log text; the panel appends lines to its own ListModel
  // by absolute entry index and removes from the head when the tail cap drops entries.

  function pushView(v) {
    if (!root.viewStack.length) root._prevFocus = root.focusSection
    root.viewStack = root.viewStack.concat([v])
    root.focusSection = "view"; root.cursorActive = true
    root.following = true; root.showHidden = false
    if (root.viewStack.length === 1) root.viewCursorKey = ""        // a nested log keeps the history cursor underneath
    root.syncView(true)
  }
  function popView() {
    if (!root.viewStack.length) return
    root.viewStack = root.viewStack.slice(0, -1)
    root.following = true; root.showHidden = false                 // the cursor key survives: back from a log lands on the row it came from
    if (root.view) { root.syncView(true); root._watch() }
    else { root.focusSection = root._prevFocus === "hero" ? "hero" : "list"; viewModel.clear(); if (svc) svc.closeView(root.panelId) }
  }
  function clearViews() { if (root.viewStack.length) { root.viewStack = []; root.focusSection = root._prevFocus === "hero" ? "hero" : "list"; viewModel.clear(); if (svc) svc.closeView(root.panelId) } }
  // Tell the service which build log this panel is watching (pinned against eviction).
  function _watch() { if (!svc) return; if (root.view && root.view.kind === "buildlog") svc.openBuildLog(root.panelId, root.view.uuid); else svc.closeView(root.panelId) }

  function openLogsFor(row) {
    if (!row || !svc) return
    if (row.type === "deployment" || row.type === "history") {
      root.pushView({ kind: "buildlog", uuid: row.uuid, name: row.name || row.uuid, url: row.url || "", status: row.status || "",
                      at: row.finishedAt || row.updatedAt || "", createdAt: row.createdAt || "" })
      root._watch()
    } else if (row.type === "resource") {
      if (row.kind === "service") {
        root.pushView({ kind: "servicepick", uuid: row.uuid, name: row.name || row.uuid, url: row.url || "", ckind: "service" })
        svc.fetchContainerLog("service", row.uuid, row.name || "")
      } else {
        root.pushView({ kind: "containerlog", uuid: row.uuid, name: row.name || row.uuid, url: row.url || "", ckind: row.kind, sub: "" })
        svc.fetchContainerLog(row.kind, row.uuid, row.name || "")
      }
    }
  }
  function openHistoryFor(row) {
    if (!row || !svc || row.type !== "resource" || row.kind !== "application") return
    root.pushView({ kind: "history", uuid: row.uuid, name: row.name || row.uuid, url: row.url || "" })
    svc.fetchHistory(row.uuid, 0, row.name || "")
  }
  // Enter inside a history or picker view.
  function activateView() {
    var v = root.view
    if (!v || !svc) return
    var i = root.viewIndex(root.viewCursorKey)
    if (i < 0) return
    var r = viewModel.get(i)
    if (v.kind === "history") {
      var hrow = { type: "history", uuid: String(r.uuid || ""), name: String(r.name || ""), url: String(r.url || ""), status: String(r.status || ""),
                   finishedAt: String(r.finishedAt || ""), updatedAt: String(r.updatedAt || ""), createdAt: String(r.createdAt || "") }   // copied before any view change
      if (r.rowType === "history") root.openLogsFor(hrow)
      else if (r.rowType === "more" && root.liveRec && !root.liveRec.loading) svc.fetchHistory(v.uuid, root.liveRec.rows.length, v.name)
    } else if (v.kind === "servicepick" && r.rowType === "pick") {
      var sub = String(r.name || "")                 // read before the view swap: it clears the model `r` lives in
      root.viewStack = root.viewStack.slice(0, -1).concat([{ kind: "containerlog", uuid: v.uuid, name: v.name, url: v.url, ckind: "service", sub: sub }])
      root.following = true; root.viewCursorKey = ""
      svc.fetchContainerLogSub(v.uuid, sub, v.name)
      root.syncView(true)
    }
  }
  function refetchView() {
    var v = root.view
    if (!v || !svc) return
    if (v.kind === "containerlog") { if (v.ckind === "service") svc.fetchContainerLogSub(v.uuid, v.sub, v.name); else svc.fetchContainerLog(v.ckind, v.uuid, v.name) }
    else if (v.kind === "buildlog") svc.refetchBuildLog(v.uuid)
    else if (v.kind === "history") svc.fetchHistory(v.uuid, 0, v.name)
    else if (v.kind === "servicepick") svc.fetchContainerLog("service", v.uuid, v.name)
  }
  function openView() { if (root.view && root.view.url) root.openRow({ url: root.view.url }) }
  function viewRows() { var out = []; for (var i = 0; i < viewModel.count; i++) out.push(viewModel.get(i)); return out }
  function viewIndex(key) { for (var i = 0; i < viewModel.count; i++) if (viewModel.get(i).key === key) return i; return -1 }
  function moveViewCursor(dy) {
    var rows = root.viewRows()
    var i = root.viewIndex(root.viewCursorKey)
    var n = Model.nextSelectable(rows, i, dy)
    if (n < 0) return
    root.viewCursorKey = rows[n].key
    viewList.positionViewAtIndex(n, ListView.Contain)
  }
  function scrollLog(dy) {
    var max = Math.max(0, viewList.contentHeight - viewList.height)
    viewList.contentY = Util.clamp(viewList.contentY + dy * Style.space(18), 0, max)
    if (dy < 0) root.following = false
    else if (viewList.atYEnd) root.following = true
  }
  function followNewest() { root.following = true; viewList.positionViewAtEnd() }

  // Fill or top up the overlay model from the live record. `rebuild` clears first.
  function syncView(rebuild) {
    var v = root.view
    if (!v) return
    var rec = root.liveRec
    if (v.kind === "buildlog") {
      var failing = rec ? Model.failingEntry(rec.entries, rec.status) : null
      var fi = failing ? failing.i : -1
      if (rebuild || !rec || fi !== root.lastFailIndex) { viewModel.clear(); root.consumed = 0; root.seenDropped = 0; root.tailI = -1; root.tailLen = -1; root.lastFailIndex = fi }
      if (!rec) return
      if (rec.dropped > root.seenDropped) {                         // the tail cap dropped entries: trim the head by absolute index
        var k = 0
        while (k < viewModel.count && viewModel.get(k).i >= 0 && viewModel.get(k).i < rec.dropped) k++
        if (k) viewModel.remove(0, k)
        root.seenDropped = rec.dropped
        if (root.consumed < rec.dropped) root.consumed = rec.dropped
      }
      var last = rec.entries.length ? rec.entries[rec.entries.length - 1] : null
      var tail = root.tailI >= rec.dropped ? rec.entries.filter(function(e) { return e.i === root.tailI })[0] : null
      if (tail && tail.output.length !== root.tailLen) {
        // The entry that was newest last sync grew in place (whether or not a newer one landed in the
        // same poll): drop its rows and everything after, then let the filter re-append from it.
        var n = 0
        while (n < viewModel.count && viewModel.get(viewModel.count - 1 - n).i >= tail.i) n++
        if (n) viewModel.remove(viewModel.count - n, n)
        root.consumed = tail.i
      }
      var fresh = rec.entries.filter(function(e) { return e.i >= root.consumed })
      if (fresh.length) {
        var lines = Model.buildLogLines(fresh, { showHidden: root.showHidden, failing: failing, uuid: v.uuid })
        if (lines.length) viewModel.append(lines)               // one batched insert, not one model change per line
        root.consumed = fresh[fresh.length - 1].i + 1          // from the last index, not the count: the parser may skip a malformed element
      }
      if (last) { root.tailI = last.i; root.tailLen = last.output.length }
      if (root.following) Qt.callLater(function() { if (root.following) viewList.positionViewAtEnd() })
    } else if (v.kind === "containerlog") {
      viewModel.clear()
      if (rec && rec.lines) for (var c = 0; c < rec.lines.length; c++) viewModel.append(Model.viewRow("line", { key: v.uuid + ":" + c, i: c, text: rec.lines[c], tone: "fg", hidden: false }))
      Qt.callLater(function() { viewList.positionViewAtEnd() })
    } else if (v.kind === "history") {
      viewModel.clear()
      var o = Model.origin(root.snapshot && root.snapshot.instance ? root.snapshot.instance.url : "")
      if (rec) {
        for (var h = 0; h < rec.rows.length; h++) viewModel.append(Model.historyRow(rec.rows[h], v.uuid, o))
        var more = Model.moreRow(rec, Api.HISTORY_TAKE)
        if (more) viewModel.append(more)
      }
      if (root.viewIndex(root.viewCursorKey) < 0 && viewModel.count) root.viewCursorKey = viewModel.get(Math.max(0, Model.nextSelectable(root.viewRows(), -1, 1))).key
    } else if (v.kind === "servicepick") {
      if (rec && rec.names && rec.names.length === 1) {
        // One container: the service already fetched its tail; show it instead of a one-row picker.
        root.viewStack = root.viewStack.slice(0, -1).concat([{ kind: "containerlog", uuid: v.uuid, name: v.name, url: v.url, ckind: "service", sub: rec.names[0] }])
        root.following = true; root.viewCursorKey = ""
        root.syncView(true)
        return
      }
      viewModel.clear()
      if (rec && rec.names) for (var p = 0; p < rec.names.length; p++) viewModel.append(Model.pickRow(v.uuid, rec.names[p]))
      if (root.viewIndex(root.viewCursorKey) < 0 && viewModel.count) root.viewCursorKey = viewModel.get(0).key
    }
  }

  // The note above or below the lines: loading, queued, empty, refused, message, truncated head.
  readonly property string viewHeadNote: {
    var v = root.view, rec = root.liveRec
    if (!v) return ""
    if (v.kind === "buildlog" && rec && rec.dropped > 0) return "… " + rec.dropped + " earlier entries not shown. Open it in Coolify for the full log."
    return ""
  }
  readonly property string viewNote: {
    var v = root.view, rec = root.liveRec
    if (!v) return ""
    if (v.kind === "buildlog") {
      if (!rec) return "Loading log…"
      if (rec.message) return rec.message
      if (rec.refused) return "This build log is larger than 3 MB. Open it in Coolify."
      if (rec.entries.length) return ""
      if (rec.status === "queued") return "Queued. Coolify has not started this build yet."
      if (rec.status === "in_progress") return "Starting…"
      if (rec.terminal && rec.bytes === 0 && rec.source !== "fetch") return "Loading log…"
      if (rec.terminal) return "The log is empty."
      return "Loading log…"
    }
    if (v.kind === "containerlog") {
      if (!rec || rec.lines === null) return rec && rec.message ? rec.message : "Fetching the last 200 lines…"
      if (rec.message) return rec.message
      if (!rec.lines.length) return "The container has written nothing."
      return rec.truncated ? "… earlier lines not shown." : ""
    }
    if (v.kind === "history") {
      if (!rec) return "Loading history…"
      if (rec.message) return rec.message
      if (rec.loading && !rec.rows.length) return "Loading history…"
      if (!rec.rows.length) return "No deployments recorded for this application."
      return ""
    }
    if (!rec || rec.names === null) return rec && rec.message ? rec.message : "Loading containers…"
    if (rec.message) return rec.message
    return rec.names.length ? "Pick a container." : "This service has no containers."
  }
  readonly property string breadcrumb: {
    var v = root.view, rec = root.liveRec
    if (!v) return ""
    var bits = [v.name]
    if (v.kind === "buildlog") {
      var st = rec && rec.status ? rec.status : v.status
      if (st) bits.push(st === "in_progress" ? "building" : st === "cancelled-by-user" ? "cancelled" : st)
      // The deployment's own age (a finished build) or its elapsed time (a running one), never the fetch time.
      if (rec && rec.terminal || Model.TERMINAL[st]) { if (v.at) bits.push(Model.age(v.at, root.nowMs)) }
      else if (v.createdAt) bits.push(Model.elapsed(v.createdAt, root.nowMs))
    }
    else if (v.kind === "containerlog") { bits.push("last 200 lines"); if (v.sub) bits.push(v.sub); if (rec && rec.fetchedAt) bits.push(Model.elapsed(rec.fetchedAt, root.nowMs) + " ago") }
    else if (v.kind === "history") bits.push(rec && rec.count ? rec.count + " deployments" : "history")
    else bits.push("pick a container")
    return Model.G.back + " " + bits.join(" · ")
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    // Fitted to what is actually in the card, capped: an error or empty state collapses it.
    // While a view is open the body is pinned so a filling log does not resize under the reader.
    contentHeight: panel.fittedContentHeight(header.implicitHeight + Style.space(14) + (root.view ? Style.space(480) : listView.contentHeight) + Style.space(10) + footer.implicitHeight, Style.space(640))

    // The confirm dialog is driven from the key catcher's signals below (its handleKey
    // needs a raw KeyEvent from a Keys.onPressed, which this panel never adds). It is a
    // sibling of the catcher, not a child, so it fills the card above every row and
    // adds nothing to contentHeight. Cancel is preselected on open and re-asserted when
    // the dialog arms, because the component moves selection on hover.
    ConfirmDialog {
      id: confirm
      anchors.fill: parent
      z: 10
      opened: root.confirmOpen
      foreground: root.foreground
      selectedText: root.accent
      fontFamily: root.fontFamily
      onCanceled: root.resolveConfirm(false)
      onConfirmed: if (root.confirmArmed) root.resolveConfirm(true)
    }
    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (root.confirmOpen) { if (dx !== 0) confirm.selectedIndex = confirm.selectedIndex === 0 ? 1 : 0; return }
        // Phase 4: a view owns h/j/k/l before the cursor guard. h pops through the ladder; l is a no-op.
        if (root.view) {
          if (dx < 0) { root.closeLadder(); return }
          if (dx > 0) return
          if (root.view.kind === "buildlog" || root.view.kind === "containerlog") root.scrollLog(dy)
          else root.moveViewCursor(dy)
          return
        }
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: {
        if (root.confirmOpen) { if (root.confirmArmed) root.resolveConfirm(confirm.selectedIndex === 1); return }
        if (root.view) { if (root.view.kind === "history" || root.view.kind === "servicepick") root.activateView(); return }   // Enter/Space: nothing in a log
        if (root.cursorActive) root.activateCursor()
      }
      // `x` arrives here, not through textKey: cancel, only on a deployment row (the
      // applicability lookup drops it on a terminal one).
      onDeleteRequested: {
        if (root.confirmOpen || root.view || root.focusSection !== "list") return
        var row = root.currentRow
        if (row && row.type === "deployment") root.runAction(row.terminal ? "dismiss" : "cancel", row.key)   // x: cancel an active build, dismiss a finished one
      }
      onCloseRequested: root.closeLadder()
      onTabRequested: function(direction) { if (!root.confirmOpen) { root.clearViews(); root.switchPanel(direction) } }
      onTextKey: function(t) {
        if (root.confirmOpen) return
        // Phase 4: the view's keys come first, above r and g, which must not touch the list underneath.
        if (root.view) {
          var kind = root.view.kind
          if (t === "H" && kind === "buildlog") root.showHidden = !root.showHidden
          else if (t === "b" && (kind === "buildlog" || kind === "containerlog")) root.followNewest()
          else if (t === "r" || t === "R") root.refetchView()
          else if (t === "o" || t === "O") root.openView()
          return
        }
        if (t === "r" || t === "R") { root.refreshNow(); return }
        if (t === "g" || t === "G") { root.setGroupBy(root.groupBy === "project" ? "server" : "project"); return }
        if (root.focusSection !== "list" || !root.currentRow) return
        var row = root.currentRow
        // d / D is the one deliberate case-sensitive pair: D is the no-cache rebuild.
        if (t === "d") root.runAction("d", row.key)          // deploy a stopped app, redeploy a running one
        else if (t === "D") root.runAction("D", row.key)          // rebuild without cache (confirms)
        else if (t === "s" || t === "S") root.runAction("s", row.key)
        else if (t === "t" || t === "T") root.runAction("restart", row.key)
        else if (t === "v" || t === "V") root.runAction("validate", row.key)
        else if (t === "L") root.runAction("L", row.key)          // Phase 4: the build or container log (the catcher takes lowercase l)
        else if (t === "o" || t === "O") root.openRow(row)
      }

      Column {
        id: header
        width: parent.width
        spacing: Style.space(10)

        PanelHero {
          id: hero
          width: parent.width
          title: Model.heroTitle(root.snapshot)
          meta: Model.heroMeta(root.snapshot)
          detail: Model.heroDetail(root.snapshot)
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconOpacity: root.snapshot && root.snapshot.error ? 0.45 : 1
          iconComponent: Component {
            Text {
              width: hero.iconSize
              height: hero.iconSize
              text: Model.G.cloud
              textFormat: Text.PlainText
              color: hero.foreground
              font.family: root.fontFamily
              font.pixelSize: hero.iconSize
              horizontalAlignment: Text.AlignHCenter
              verticalAlignment: Text.AlignVCenter
            }
          }
          trailingControl: Component {
            Button {
              id: refreshButton
              bordered: false
              iconText: Model.G.refresh
              iconSpinning: root.busy
              width: implicitWidth
              height: implicitHeight
              foreground: hero.foreground
              fontFamily: root.fontFamily
              hasCursor: root.heroHasCursor
              tooltipText: "Refresh"
              onHovered: function(on) { if (on) root.focusHero() }
              onClicked: root.refreshNow()
            }
          }
        }

        // Phase 4: instance chips, only with two or more instances. No hasCursor: the hero's
        // refresh button owns the ring (Risk 3); h/l on the hero, a click here and a
        // middle-click on the bar icon switch. Hidden under a view.
        Row {
          id: chipRow
          readonly property var chips: svc ? Model.instanceChips(svc.instances, svc.activeId) : []
          visible: chips.length > 1 && !root.view
          width: parent.width
          spacing: Style.spacing.md
          readonly property real cellWidth: chips.length > 0 ? (width - spacing * (chips.length - 1)) / chips.length : 0
          Repeater {
            model: chipRow.chips
            Button {
              required property var modelData
              width: chipRow.cellWidth
              text: modelData.label + (modelData.trouble ? " ·" : "")
              selected: modelData.selected
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              verticalPadding: Style.spacing.controlPaddingY
              tooltipText: modelData.trouble ? "Needs attention" : ""
              onClicked: if (svc) svc.selectInstance(modelData.id)
            }
          }
        }

        // Phase 4: the breadcrumb of the open view; a click pops it. Lives in the header so it
        // never scrolls away under the overlay's own list.
        Item {
          id: breadcrumbRow
          width: parent.width
          visible: root.view !== null
          implicitHeight: visible ? breadcrumbText.implicitHeight + Style.space(4) : 0
          height: implicitHeight
          Text {
            id: breadcrumbText
            width: parent.width
            textFormat: Text.PlainText
            text: root.breadcrumb
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: true
            elide: Text.ElideRight
            anchors.verticalCenter: parent.verticalCenter
          }
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.popView() }
        }

        // Status line: the outcome of the last action, 2.2 s for success, 6 s for a
        // failure (tailscale's actionStatus, with the durations from docs/design.md).
        Text {
          id: statusLine
          width: parent.width
          visible: text.length > 0
          textFormat: Text.PlainText
          text: root.svc ? root.svc.actionStatus : ""
          color: root.svc && root.svc.actionTone === "urgent" ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          maximumLineCount: 2
          elide: Text.ElideRight
        }

        BorderSurface {
          id: calloutBox
          visible: !!root.callout
          width: parent.width
          implicitHeight: visible ? calloutCol.implicitHeight + Style.spacing.xl * 2 : 0
          height: implicitHeight
          color: Util.alpha(root.urgent, 0.10)
          borderSpec: Border.flat(Util.alpha(root.urgent, 0.35), 1)
          radius: Style.cornerRadius

          Column {
            id: calloutCol
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(12)
            anchors.rightMargin: Style.space(12)
            spacing: Style.space(4)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: root.callout ? root.callout.title : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              wrapMode: Text.Wrap
            }
            Text {
              width: parent.width
              visible: text.length > 0
              textFormat: Text.PlainText
              text: root.callout ? root.callout.body : ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.Wrap
            }
          }
        }
      }

      Text {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        textFormat: Text.PlainText
        text: Model.footerHints(root.focusSection, root.currentRow,
                                { expanded: !!root.currentRow && root.expandedKey === root.currentRow.key, actionFocus: root.actionFocus, moreOpen: root.moreOpen, confirmOpen: root.confirmOpen,
                                  instances: svc ? svc.instances.length : 0,
                                  view: root.view ? { kind: root.view.kind, following: root.following, terminal: !!(root.liveRec && root.liveRec.terminal),
                                                      paused: !!(root.snapshot && root.snapshot.paused), hasUrl: !!root.view.url } : null })
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      // ---- Phase 4 overlay: a view over the list, inside the catcher so it anchors to the
      // header and footer. Paints above the list (z), below the confirm; the list itself is
      // hidden while a view is open. A full-fill MouseArea beneath its own list swallows
      // pointer input over the head and foot notes; a button-less one above observes the
      // wheel to release the follow.
      Item {
        id: overlay
        z: 9
        visible: root.view !== null
        anchors.top: header.bottom
        anchors.bottom: footer.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.topMargin: Style.space(14)
        anchors.bottomMargin: Style.space(10)

        MouseArea { anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.AllButtons; onWheel: function(w) { w.accepted = true } }

        // Wrapper Items size from their child's implicitHeight (which follows width), so no
        // height binding loops back on itself.
        Item {
          id: viewHead
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          visible: headText.text.length > 0
          height: visible ? headText.implicitHeight + Style.space(4) : 0
          Text {
            id: headText
            width: parent.width - Style.space(16)
            x: Style.space(8)
            textFormat: Text.PlainText
            text: root.viewHeadNote
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        ListView {
          id: viewList
          anchors.top: viewHead.bottom
          anchors.bottom: viewFoot.top
          anchors.left: parent.left
          anchors.right: parent.right
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          spacing: Style.space(2)
          model: ListModel { id: viewModel }
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
          // The hold is driven by user input only, never by contentY: an append moves contentY too.
          onMovementStarted: root.following = false
          onFlickStarted: root.following = false

          delegate: Item {
            id: viewDelegate
            required property var modelData
            required property int index
            width: viewList.width
            implicitHeight: viewLoader.item ? viewLoader.item.implicitHeight : 0
            height: implicitHeight
            readonly property string rowType: modelData.rowType
            readonly property bool selected: root.focusSection === "view" && root.viewCursorKey === modelData.key

            Loader {
              id: viewLoader
              width: parent.width
              sourceComponent: viewDelegate.rowType === "line" ? lineComp
                : viewDelegate.rowType === "note" ? viewNoteComp
                : viewDelegate.rowType === "history" ? historyComp
                : viewDelegate.rowType === "more" ? moreComp
                : viewDelegate.rowType === "pick" ? pickComp
                : null
            }

            // One physical log line, wrapped anywhere: a horizontal scroll would hide the
            // tail of exactly the line that matters.
            Component {
              id: lineComp
              Text {
                width: viewDelegate.width - Style.space(16)
                x: Style.space(8)
                textFormat: Text.PlainText
                text: viewDelegate.modelData.text || ""
                color: root.toneColor(viewDelegate.modelData.tone)
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WrapAnywhere
              }
            }

            Component {
              id: viewNoteComp
              Text {
                width: viewDelegate.width - Style.space(16)
                x: Style.space(8)
                textFormat: Text.PlainText
                text: viewDelegate.modelData.text || ""
                color: root.toneColor(viewDelegate.modelData.tone)
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
              }
            }

            // A history row: glyph · name over sub · age. Enter opens its build log.
            Component {
              id: historyComp
              CursorSurface {
                implicitHeight: histRow.implicitHeight + Style.spacing.rowPaddingX
                hasCursor: viewDelegate.selected
                foreground: root.foreground
                accent: root.accent
                HoverHandler { onHoveredChanged: if (hovered && !root.reflowing) root.viewCursorKey = viewDelegate.modelData.key }
                MouseArea {
                  anchors.fill: parent
                  acceptedButtons: Qt.LeftButton | Qt.RightButton
                  onClicked: function(m) { root.viewCursorKey = viewDelegate.modelData.key; if (m.button === Qt.RightButton) root.openRow(viewDelegate.modelData); else root.activateView() }
                }
                Row {
                  id: histRow
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.leftMargin: Style.space(8)
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(8)
                  Text {
                    width: Style.space(22)
                    textFormat: Text.PlainText
                    text: viewDelegate.modelData.glyph || ""
                    color: root.toneColor(viewDelegate.modelData.tone)
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.title
                    horizontalAlignment: Text.AlignHCenter
                    anchors.verticalCenter: parent.verticalCenter
                  }
                  Column {
                    width: parent.width - Style.space(22) - histTime.implicitWidth - parent.spacing * 2
                    spacing: Style.space(2)
                    anchors.verticalCenter: parent.verticalCenter
                    Text {
                      width: parent.width
                      textFormat: Text.PlainText
                      text: viewDelegate.modelData.status === "in_progress" ? "building" : (viewDelegate.modelData.status || "")
                      color: viewDelegate.modelData.tone === "urgent" ? root.urgent : root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      elide: Text.ElideRight
                    }
                    Text {
                      width: parent.width
                      visible: text.length > 0
                      textFormat: Text.PlainText
                      text: viewDelegate.modelData.sub || ""
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                    }
                  }
                  Text {
                    id: histTime
                    textFormat: Text.PlainText
                    // Rows carry timestamps, not strings: the age ticks with nowMs.
                    text: Model.age(viewDelegate.modelData.finishedAt || viewDelegate.modelData.updatedAt || viewDelegate.modelData.createdAt, root.nowMs)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }
              }
            }

            // "Show N more (shown of total)" and a container name share one shape.
            Component {
              id: moreComp
              CursorSurface {
                implicitHeight: moreText.implicitHeight + Style.spacing.rowPaddingX
                hasCursor: viewDelegate.selected
                foreground: root.foreground
                accent: root.accent
                HoverHandler { onHoveredChanged: if (hovered && !root.reflowing) root.viewCursorKey = viewDelegate.modelData.key }
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { root.viewCursorKey = viewDelegate.modelData.key; root.activateView() } }
                Text {
                  id: moreText
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.leftMargin: Style.space(8) + Style.space(22) + Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: viewDelegate.modelData.text || ""
                  color: viewDelegate.modelData.loading ? root.dim : root.accent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  elide: Text.ElideRight
                }
              }
            }
            Component {
              id: pickComp
              CursorSurface {
                implicitHeight: pickText.implicitHeight + Style.spacing.rowPaddingX
                hasCursor: viewDelegate.selected
                foreground: root.foreground
                accent: root.accent
                HoverHandler { onHoveredChanged: if (hovered && !root.reflowing) root.viewCursorKey = viewDelegate.modelData.key }
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { root.viewCursorKey = viewDelegate.modelData.key; root.activateView() } }
                Text {
                  id: pickText
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.leftMargin: Style.space(8) + Style.space(22) + Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: viewDelegate.modelData.name || ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }
              }
            }
          }
        }

        // A button-less area above the list: it sees the wheel (releasing the follow) and
        // lets every event through to the rows.
        MouseArea { anchors.fill: viewList; hoverEnabled: false; acceptedButtons: Qt.NoButton; onWheel: function(w) { root.following = false; w.accepted = false } }

        Item {
          id: viewFoot
          anchors.bottom: parent.bottom
          anchors.left: parent.left
          anchors.right: parent.right
          visible: footText.text.length > 0
          height: visible ? footText.implicitHeight + Style.space(6) : 0
          Text {
            id: footText
            width: parent.width - Style.space(16)
            x: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.viewNote
            color: root.liveRec && root.liveRec.message ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }
        }
      }

      ListView {
        id: listView
        anchors.top: header.bottom
        anchors.bottom: footer.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.topMargin: Style.space(14)
        anchors.bottomMargin: Style.space(10)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        spacing: Style.space(6)
        model: rowsList
        reuseItems: false
        visible: root.view === null          // the overlay replaces the list, it does not float over it
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        // One Loader per row: a row builds only its own variant's subtree.
        delegate: Item {
          id: rowDelegate
          required property string key
          required property var row              // the Model.panelRows object, updated in place on a rev change
          required property int index
          width: listView.width
          implicitHeight: rowLoader.item ? rowLoader.item.implicitHeight : 0
          height: implicitHeight
          readonly property string rowType: row.type
          readonly property bool selected: root.cursorActive && root.focusSection === "list" && root.cursorKey === key

          Loader {
            id: rowLoader
            width: parent.width
            sourceComponent: rowDelegate.rowType === "section" ? sectionComp
              : rowDelegate.rowType === "separator" ? separatorComp
              : rowDelegate.rowType === "note" ? noteComp
              : rowDelegate.rowType === "fold" ? foldComp
              : rowDelegate.rowType === "deployment" ? deploymentComp
              : rowDelegate.rowType === "server" ? serverComp
              : rowDelegate.rowType === "resource" ? resourceComp
              : rowDelegate.rowType === "tag" ? tagComp
              : rowDelegate.rowType === "actions" ? actionsComp
              : null
          }

          // ---- action strip under an expanded leaf row (Phase 2). Not selectable; the
          // ring follows root.actionFocus (an id). Destructive buttons paint urgent
          // through Button.foreground, which drives both the label and the hover fill.
          Component {
            id: actionsComp
            Item {
              implicitHeight: actCol.implicitHeight + Style.space(6)
              // Two lines: the lifecycle verbs with a More/Less toggle, then the secondaries
              // (Logs · History · Open) only while More is open. A strip of four or fewer
              // buttons has no toggle and an empty second line (Model.stripFor).
              Column {
                id: actCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8) + Style.space(22) + Style.space(8)
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.spacing.md
                Repeater {
                  model: [rowDelegate.row.primary, rowDelegate.row.secondary]
                  Flow {
                    required property var modelData
                    width: actCol.width
                    visible: modelData.length > 0
                    spacing: Style.spacing.md
                    Repeater {
                      model: modelData
                      Button {
                        required property var modelData
                        bordered: true
                        focusable: false
                        text: modelData.label
                        fontSize: Style.font.bodySmall
                        fontFamily: root.fontFamily
                        foreground: modelData.destructive ? root.urgent : modelData.id === Model.MORE_ID ? root.dim : root.foreground
                        accent: root.accent
                        hasCursor: root.expandedKey === rowDelegate.row.parentKey && root.actionFocus === modelData.id
                        onHovered: function(on) { if (on) root.hoverAction(rowDelegate.row.parentKey, modelData.id) }
                        onClicked: root.runAction(modelData.id, rowDelegate.row.parentKey)
                      }
                    }
                  }
                }
              }
            }
          }

          // ---- section header, optionally with the grouping toggle
          Component {
            id: sectionComp
            Item {
              implicitHeight: Math.max(sectionHeader.implicitHeight, groupToggle.item ? groupToggle.item.implicitHeight : 0)
              PanelSectionHeader {
                id: sectionHeader
                text: rowDelegate.row.title || ""
                foreground: root.foreground
                fontFamily: root.fontFamily
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
              }
              // Centred on the header's glyphs, not its box: PanelSectionHeader carries
              // topPadding for Nerd Font overshoot (the network panel's band header idiom).
              Loader {
                id: groupToggle
                active: rowDelegate.row.control === "groupBy"
                anchors.right: parent.right
                anchors.verticalCenter: sectionHeader.verticalCenter
                anchors.verticalCenterOffset: Math.round(sectionHeader.topPadding / 2)
                sourceComponent: ButtonGroup {
                  options: [{ value: "project", label: "by project" }, { value: "server", label: "by server" }]
                  value: root.groupBy
                  fontSize: Style.font.bodySmall
                  focusable: false
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  accent: root.accent
                  onChanged: function(v) { root.setGroupBy(v) }
                }
              }
            }
          }

          Component {
            id: separatorComp
            PanelSeparator { foreground: root.foreground }
          }

          Component {
            id: noteComp
            Text {
              textFormat: Text.PlainText
              text: rowDelegate.row.text || ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WordWrap
            }
          }

          // ---- fold (project / environment or server)
          Component {
            id: foldComp
            CursorSurface {
              implicitHeight: foldRow.implicitHeight + Style.spacing.rowPaddingX
              hasCursor: rowDelegate.selected
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.row.key) }
              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: { root.setCursor(rowDelegate.row.key); root.toggleFold(rowDelegate.row.key) }
              }
              Row {
                id: foldRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)
                Text {
                  width: Style.space(14)
                  textFormat: Text.PlainText
                  text: rowDelegate.row.open ? Model.G.foldOpen : Model.G.foldClosed
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  width: parent.width - Style.space(14) - foldCount.implicitWidth - parent.spacing * 2
                  textFormat: Text.PlainText
                  text: String(rowDelegate.row.title || "").toUpperCase()
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                  font.letterSpacing: 1.1
                  elide: Text.ElideRight
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: foldCount
                  textFormat: Text.PlainText
                  text: String(rowDelegate.row.count === undefined ? "" : rowDelegate.row.count)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
            }
          }

          // ---- deployment row: glyph · name over "branch · message" · elapsed/age
          Component {
            id: deploymentComp
            CursorSurface {
              implicitHeight: depRow.implicitHeight + Style.spacing.rowPaddingX
              hasCursor: rowDelegate.selected && !(root.actionFocus && root.expandedKey === rowDelegate.row.key)
              current: rowDelegate.selected && !!root.actionFocus && root.expandedKey === rowDelegate.row.key
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.row.key) }
              MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(m) { if (m.button === Qt.RightButton) root.openRow(rowDelegate.row); else root.clickRow(rowDelegate.row) }
              }
              Row {
                id: depRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)
                Text {
                  width: Style.space(22)
                  textFormat: Text.PlainText
                  text: rowDelegate.row.glyph || ""
                  color: root.toneColor(rowDelegate.row.tone)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                  horizontalAlignment: Text.AlignHCenter
                  anchors.verticalCenter: parent.verticalCenter
                }
                Column {
                  width: parent.width - Style.space(22) - depTime.implicitWidth - (depDismiss.visible ? depDismiss.width + parent.spacing : 0) - parent.spacing * 2
                  spacing: Style.space(2)
                  anchors.verticalCenter: parent.verticalCenter
                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: rowDelegate.row.name || ""
                    color: rowDelegate.row.tone === "urgent" ? root.urgent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }
                  Text {
                    width: parent.width
                    visible: text.length > 0
                    textFormat: Text.PlainText
                    text: rowDelegate.row.sub || ""
                    color: rowDelegate.row.pendingVerb ? root.toneColor(rowDelegate.row.tone) : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }
                Text {
                  id: depTime
                  textFormat: Text.PlainText
                  // The only delegate that reads nowMs: rows carry timestamps, not strings.
                  text: rowDelegate.row.terminal ? Model.age(rowDelegate.row.updatedAt, root.nowMs) : Model.elapsed(rowDelegate.row.createdAt, root.nowMs)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }
                // Phase 4b: the visible clear control on a terminal row. Dim, brighter while the
                // row has the cursor (never from containsMouse); one click acknowledges. Declared
                // after the row's MouseArea, so it takes the click first.
                Text {
                  id: depDismiss
                  visible: !!rowDelegate.row.terminal
                  width: Style.space(22)
                  textFormat: Text.PlainText
                  text: Model.G.dismiss
                  color: rowDelegate.selected ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                  horizontalAlignment: Text.AlignHCenter
                  anchors.verticalCenter: parent.verticalCenter
                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.runAction("dismiss", rowDelegate.row.key)
                  }
                }
              }
            }
          }

          // ---- server row: dot · name · "ip · N resources · unreachable"
          Component {
            id: serverComp
            CursorSurface {
              implicitHeight: srvRow.implicitHeight + Style.spacing.rowPaddingX
              hasCursor: rowDelegate.selected && !(root.actionFocus && root.expandedKey === rowDelegate.row.key)
              current: rowDelegate.selected && !!root.actionFocus && root.expandedKey === rowDelegate.row.key
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.row.key) }
              MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(m) { if (m.button === Qt.RightButton) root.openRow(rowDelegate.row); else root.clickRow(rowDelegate.row) }
              }
              Row {
                id: srvRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)
                Text {
                  width: Style.space(22)
                  textFormat: Text.PlainText
                  text: rowDelegate.row.dot || ""
                  color: root.toneColor(rowDelegate.row.tone)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  horizontalAlignment: Text.AlignHCenter
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: srvName
                  // The name elides; the caption keeps at least Style.space(150) so "unreachable" stays visible.
                  width: Math.min(implicitWidth, parent.width - Style.space(22) - parent.spacing * 2 - Math.min(srvSub.implicitWidth, Style.space(150)))
                  textFormat: Text.PlainText
                  text: rowDelegate.row.name || ""
                  color: rowDelegate.row.dim ? root.dim : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: srvSub
                  width: parent.width - Style.space(22) - parent.spacing * 2 - srvName.width
                  textFormat: Text.PlainText
                  text: rowDelegate.row.sub || ""
                  color: rowDelegate.row.pendingVerb ? root.toneColor(rowDelegate.row.tone) : (rowDelegate.row.tone === "urgent" ? root.urgent : root.dim)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
            }
          }

          // ---- tag row (Phase 4): name · "deploying…" while pending. No page in Coolify, so no Open.
          Component {
            id: tagComp
            CursorSurface {
              implicitHeight: tagRow.implicitHeight + Style.spacing.rowPaddingX
              hasCursor: rowDelegate.selected && !(root.actionFocus && root.expandedKey === rowDelegate.row.key)
              current: rowDelegate.selected && !!root.actionFocus && root.expandedKey === rowDelegate.row.key
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.row.key) }
              MouseArea { anchors.fill: parent; onClicked: root.clickRow(rowDelegate.row) }
              Row {
                id: tagRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8) + Style.space(14)
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)
                Text {
                  width: Style.space(22)
                  textFormat: Text.PlainText
                  text: rowDelegate.row.dot || ""
                  color: rowDelegate.row.pendingVerb ? root.toneColor(rowDelegate.row.tone) : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  horizontalAlignment: Text.AlignHCenter
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  width: parent.width - Style.space(22) - tagSub.implicitWidth - parent.spacing * 2
                  textFormat: Text.PlainText
                  text: rowDelegate.row.name || ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                  elide: Text.ElideRight
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: tagSub
                  textFormat: Text.PlainText
                  text: rowDelegate.row.sub || ""
                  color: rowDelegate.row.pendingVerb ? root.toneColor(rowDelegate.row.tone) : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
            }
          }

          // ---- resource row: dot · name · status words · kind hint
          Component {
            id: resourceComp
            CursorSurface {
              implicitHeight: resRow.implicitHeight + Style.spacing.rowPaddingX
              hasCursor: rowDelegate.selected && !(root.actionFocus && root.expandedKey === rowDelegate.row.key)
              current: rowDelegate.selected && !!root.actionFocus && root.expandedKey === rowDelegate.row.key
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.row.key) }
              MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(m) { if (m.button === Qt.RightButton) root.openRow(rowDelegate.row); else root.clickRow(rowDelegate.row) }
              }
              Row {
                id: resRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8) + Style.space(14) * (rowDelegate.row.indent || 0)
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)
                Text {
                  width: Style.space(22)
                  textFormat: Text.PlainText
                  text: rowDelegate.row.dot || ""
                  color: root.toneColor(rowDelegate.row.tone)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  horizontalAlignment: Text.AlignHCenter
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  width: parent.width - Style.space(22) - resStatus.implicitWidth - resKind.implicitWidth - parent.spacing * 3
                  textFormat: Text.PlainText
                  text: rowDelegate.row.name || ""
                  color: rowDelegate.row.dim ? root.dim : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                  elide: Text.ElideRight
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: resStatus
                  textFormat: Text.PlainText
                  text: rowDelegate.row.statusWords || ""
                  color: rowDelegate.row.pendingVerb ? root.toneColor(rowDelegate.row.tone) : (rowDelegate.row.tone === "urgent" ? root.urgent : root.dim)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: resKind
                  textFormat: Text.PlainText
                  text: rowDelegate.row.kindHint || ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
            }
          }
        }
      }
    }
  }
}
