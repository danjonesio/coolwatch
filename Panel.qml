import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One instance per monitor. Reads the service snapshot; never polls. Rows are
// flattened by Model.panelRows only while open and the ListView model is only
// reassigned when Model.sameRows says they changed. The cursor is a row key.
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
  property bool confirmOpen: false
  property var confirmAction: null          // immutable { verb, uuid, name } captured when the dialog opens
  property bool confirmArmed: false         // Enter resolves the dialog only after confirmArm fires
  property double _lastLadderAt: 0

  readonly property var snapshot: svc ? svc.snapshot : null
  readonly property var pending: svc && svc.pending ? svc.pending : ({})
  readonly property var rows: root.opened && root.snapshot
    ? Model.panelRows(root.snapshot, { groupBy: root.groupBy, folded: root.folded, nowMs: root.ageMs, expandedKey: root.expandedKey, pending: root.pending }) : []
  // Coarse clock for the one-hour age-out, so rows are not recomputed every second.
  readonly property double ageMs: Math.floor(root.nowMs / 60000) * 60000
  readonly property int selectedIndex: Model.indexOfKey(root.rowsModel, root.cursorKey)
  readonly property var currentRow: root.selectedIndex >= 0 ? root.rowsModel[root.selectedIndex] : null
  readonly property bool heroHasCursor: root.cursorActive && root.focusSection === "hero"
  readonly property var callout: Model.callout(root.snapshot, root.nowMs)
  readonly property bool busy: !!(root.snapshot && root.snapshot.busy)

  onRowsChanged: applyRows()
  onOpenedChanged: {
    if (!opened) { root.confirmOpen = false; root.confirmAction = null; root.confirmArmed = false; root.expandedKey = ""; root.actionFocus = "" }
    if (!svc) return
    if (opened) svc.panelOpened(panelId)
    else svc.panelClosed(panelId)
  }
  Component.onDestruction: if (svc) svc.panelClosed(panelId)

  Timer {
    interval: 1000
    repeat: true
    running: root.opened
    onTriggered: { root.nowMs = Date.now(); if (root.svc) root.svc.panelAlive(root.panelId) }
  }
  // Arms the confirm 250 ms after it opens: an Enter that opened it (and its auto-repeat)
  // cannot also resolve it, and a pointer already over the Confirm cell is re-overridden.
  Timer { id: confirmArm; interval: 250; repeat: false; running: false; onTriggered: { root.confirmArmed = true; confirm.selectedIndex = 0 } }

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
    root.rowsModel = next
    Qt.callLater(function() { root.reflowing = false })
    var i = Model.indexOfKey(next, root.cursorKey)
    if (i < 0 && next.length) {
      // Nearest surviving row: the old position, else the last selectable one.
      i = Model.nextSelectable(next, Math.min(Math.max(prev, 0), next.length - 1) - 1, 1)
      if (i < 0) i = Model.nextSelectable(next, next.length, -1)
    }
    if (i >= 0 && next[i].key !== root.cursorKey) root.cursorKey = next[i].key
    if (root.cursorActive && i !== prev) Qt.callLater(root.scrollToSelection)
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
    root.cursorActive = true
    root.focusSection = "hero"
  }

  function hoverCursor(key) {
    if (root.reflowing || root.confirmOpen) return
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
      if (root.focusSection === "hero") return  // h/l on the hero: chips are Phase 4
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
    root.expandedKey = row.key
    var ar = root.actionsRowFor(row.key)
    root.actionFocus = ar ? ar.actions[0].id : ""
    Qt.callLater(function() { root.scrollToKey("act:" + row.key) })
  }

  function collapse() { root.expandedKey = ""; root.actionFocus = "" }

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
    var a = Model.actionFor(row, verb)
    if (!a) return
    if (a.id === "open") { root.openRow(row); return }
    if (!svc) return
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
    root.confirmAction = { verb: verb, uuid: row.uuid, name: row.name, type: row.type }
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
    if (ok && c && svc) svc.act(c.verb, c.uuid, false, c.type)
  }

  // Esc ladder: close the confirm, else collapse the row, else close the panel. One
  // rung per 250 ms, so a held Esc (auto-repeat is not filtered) cannot run all three.
  function closeLadder() {
    var now = Date.now()
    if (now - root._lastLadderAt < 250) return
    root._lastLadderAt = now
    if (root.confirmOpen) { root.resolveConfirm(false); return }
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

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    // Fitted to what is actually in the card, capped: an error or empty state collapses it.
    contentHeight: panel.fittedContentHeight(header.implicitHeight + Style.space(14) + listView.contentHeight + Style.space(10) + footer.implicitHeight, Style.space(640))

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
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: {
        if (root.confirmOpen) { if (root.confirmArmed) root.resolveConfirm(confirm.selectedIndex === 1); return }
        if (root.cursorActive) root.activateCursor()
      }
      // `x` arrives here, not through textKey: cancel, only on a deployment row (the
      // applicability lookup drops it on a terminal one).
      onDeleteRequested: {
        if (root.confirmOpen || root.focusSection !== "list") return
        var row = root.currentRow
        if (row && row.type === "deployment") root.runAction("cancel", row.key)
      }
      onCloseRequested: root.closeLadder()
      onTabRequested: function(direction) { if (!root.confirmOpen) root.switchPanel(direction) }
      onTextKey: function(t) {
        if (root.confirmOpen) return
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
                                { expanded: !!root.currentRow && root.expandedKey === root.currentRow.key, actionFocus: root.actionFocus, confirmOpen: root.confirmOpen })
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
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
        model: root.rowsModel
        reuseItems: false
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        // One Loader per row: a row builds only its own variant's subtree.
        delegate: Item {
          id: rowDelegate
          required property var modelData
          required property int index
          width: listView.width
          implicitHeight: rowLoader.item ? rowLoader.item.implicitHeight : 0
          height: implicitHeight
          readonly property string rowType: modelData.type
          readonly property bool selected: root.cursorActive && root.focusSection === "list" && root.cursorKey === modelData.key

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
              : rowDelegate.rowType === "actions" ? actionsComp
              : null
          }

          // ---- action strip under an expanded leaf row (Phase 2). Not selectable; the
          // ring follows root.actionFocus (an id). Destructive buttons paint urgent
          // through Button.foreground, which drives both the label and the hover fill.
          Component {
            id: actionsComp
            Item {
              implicitHeight: actRow.implicitHeight + Style.space(6)
              Row {
                id: actRow
                anchors.left: parent.left
                anchors.leftMargin: Style.space(8) + Style.space(22) + Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.spacing.md
                Repeater {
                  model: rowDelegate.modelData.actions
                  Button {
                    required property var modelData
                    bordered: true
                    focusable: false
                    text: modelData.label
                    fontSize: Style.font.bodySmall
                    fontFamily: root.fontFamily
                    foreground: modelData.destructive ? root.urgent : root.foreground
                    accent: root.accent
                    hasCursor: root.expandedKey === rowDelegate.modelData.parentKey && root.actionFocus === modelData.id
                    onHovered: function(on) { if (on) root.hoverAction(rowDelegate.modelData.parentKey, modelData.id) }
                    onClicked: root.runAction(modelData.id, rowDelegate.modelData.parentKey)
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
                text: rowDelegate.modelData.title || ""
                foreground: root.foreground
                fontFamily: root.fontFamily
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
              }
              // Centred on the header's glyphs, not its box: PanelSectionHeader carries
              // topPadding for Nerd Font overshoot (the network panel's band header idiom).
              Loader {
                id: groupToggle
                active: rowDelegate.modelData.control === "groupBy"
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
              text: rowDelegate.modelData.text || ""
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
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.modelData.key) }
              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: { root.setCursor(rowDelegate.modelData.key); root.toggleFold(rowDelegate.modelData.key) }
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
                  text: rowDelegate.modelData.open ? Model.G.foldOpen : Model.G.foldClosed
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  width: parent.width - Style.space(14) - foldCount.implicitWidth - parent.spacing * 2
                  textFormat: Text.PlainText
                  text: String(rowDelegate.modelData.title || "").toUpperCase()
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
                  text: String(rowDelegate.modelData.count === undefined ? "" : rowDelegate.modelData.count)
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
              hasCursor: rowDelegate.selected && !(root.actionFocus && root.expandedKey === rowDelegate.modelData.key)
              current: rowDelegate.selected && !!root.actionFocus && root.expandedKey === rowDelegate.modelData.key
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.modelData.key) }
              MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(m) { if (m.button === Qt.RightButton) root.openRow(rowDelegate.modelData); else root.clickRow(rowDelegate.modelData) }
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
                  text: rowDelegate.modelData.glyph || ""
                  color: root.toneColor(rowDelegate.modelData.tone)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                  horizontalAlignment: Text.AlignHCenter
                  anchors.verticalCenter: parent.verticalCenter
                }
                Column {
                  width: parent.width - Style.space(22) - depTime.implicitWidth - parent.spacing * 2
                  spacing: Style.space(2)
                  anchors.verticalCenter: parent.verticalCenter
                  Text {
                    width: parent.width
                    textFormat: Text.PlainText
                    text: rowDelegate.modelData.name || ""
                    color: rowDelegate.modelData.tone === "urgent" ? root.urgent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }
                  Text {
                    width: parent.width
                    visible: text.length > 0
                    textFormat: Text.PlainText
                    text: rowDelegate.modelData.sub || ""
                    color: rowDelegate.modelData.pendingVerb ? root.toneColor(rowDelegate.modelData.tone) : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                  }
                }
                Text {
                  id: depTime
                  textFormat: Text.PlainText
                  // The only delegate that reads nowMs: rows carry timestamps, not strings.
                  text: rowDelegate.modelData.terminal ? Model.age(rowDelegate.modelData.updatedAt, root.nowMs) : Model.elapsed(rowDelegate.modelData.createdAt, root.nowMs)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
            }
          }

          // ---- server row: dot · name · "ip · N resources · unreachable"
          Component {
            id: serverComp
            CursorSurface {
              implicitHeight: srvRow.implicitHeight + Style.spacing.rowPaddingX
              hasCursor: rowDelegate.selected && !(root.actionFocus && root.expandedKey === rowDelegate.modelData.key)
              current: rowDelegate.selected && !!root.actionFocus && root.expandedKey === rowDelegate.modelData.key
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.modelData.key) }
              MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(m) { if (m.button === Qt.RightButton) root.openRow(rowDelegate.modelData); else root.clickRow(rowDelegate.modelData) }
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
                  text: rowDelegate.modelData.dot || ""
                  color: root.toneColor(rowDelegate.modelData.tone)
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
                  text: rowDelegate.modelData.name || ""
                  color: rowDelegate.modelData.dim ? root.dim : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: srvSub
                  width: parent.width - Style.space(22) - parent.spacing * 2 - srvName.width
                  textFormat: Text.PlainText
                  text: rowDelegate.modelData.sub || ""
                  color: rowDelegate.modelData.pendingVerb ? root.toneColor(rowDelegate.modelData.tone) : (rowDelegate.modelData.tone === "urgent" ? root.urgent : root.dim)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
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
              hasCursor: rowDelegate.selected && !(root.actionFocus && root.expandedKey === rowDelegate.modelData.key)
              current: rowDelegate.selected && !!root.actionFocus && root.expandedKey === rowDelegate.modelData.key
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.modelData.key) }
              MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: function(m) { if (m.button === Qt.RightButton) root.openRow(rowDelegate.modelData); else root.clickRow(rowDelegate.modelData) }
              }
              Row {
                id: resRow
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: Style.space(8) + Style.space(14) * (rowDelegate.modelData.indent || 0)
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(8)
                Text {
                  width: Style.space(22)
                  textFormat: Text.PlainText
                  text: rowDelegate.modelData.dot || ""
                  color: root.toneColor(rowDelegate.modelData.tone)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  horizontalAlignment: Text.AlignHCenter
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  width: parent.width - Style.space(22) - resStatus.implicitWidth - resKind.implicitWidth - parent.spacing * 3
                  textFormat: Text.PlainText
                  text: rowDelegate.modelData.name || ""
                  color: rowDelegate.modelData.dim ? root.dim : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: true
                  elide: Text.ElideRight
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: resStatus
                  textFormat: Text.PlainText
                  text: rowDelegate.modelData.statusWords || ""
                  color: rowDelegate.modelData.pendingVerb ? root.toneColor(rowDelegate.modelData.tone) : (rowDelegate.modelData.tone === "urgent" ? root.urgent : root.dim)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  id: resKind
                  textFormat: Text.PlainText
                  text: rowDelegate.modelData.kindHint || ""
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
