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
  moduleName: "io.github.danjonesio.omarify"
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
  property bool _resourcesCursorPending: false

  readonly property var snapshot: svc ? svc.snapshot : null
  readonly property var rows: root.opened && root.snapshot
    ? Model.panelRows(root.snapshot, { groupBy: root.groupBy, folded: root.folded }) : []
  readonly property int selectedIndex: Model.indexOfKey(root.rowsModel, root.cursorKey)
  readonly property var currentRow: root.selectedIndex >= 0 ? root.rowsModel[root.selectedIndex] : null
  readonly property bool heroHasCursor: root.cursorActive && root.focusSection === "hero"
  readonly property var callout: Model.callout(root.snapshot, root.nowMs)
  readonly property bool busy: !!(root.snapshot && root.snapshot.busy)

  onRowsChanged: applyRows()
  onGroupByChanged: root._resourcesCursorPending = true
  onOpenedChanged: {
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
    root.rowsModel = next
    var i = Model.indexOfKey(next, root.cursorKey)
    if (i < 0 && next.length) {
      // Nearest surviving row: the old position, else the last selectable one.
      i = Model.nextSelectable(next, Math.min(Math.max(prev, 0), next.length - 1) - 1, 1)
      if (i < 0) i = Model.nextSelectable(next, next.length, -1)
    }
    if (root._resourcesCursorPending) {
      root._resourcesCursorPending = false
      var r = Model.firstSelectableInSection(next, "RESOURCES")
      if (r >= 0) i = r
    }
    if (i >= 0 && next[i].key !== root.cursorKey) root.cursorKey = next[i].key
    if (root.cursorActive && i !== prev) Qt.callLater(root.scrollToSelection)
  }

  function focusHero() {
    root.cursorActive = true
    root.focusSection = "hero"
  }

  function setCursor(key) {
    root.cursorActive = true
    root.focusSection = "list"
    root.cursorKey = key
  }

  function moveCursor(dx, dy) {
    root.cursorActive = true
    if (dx !== 0) return                        // h/l: chips are Phase 4, action rows Phase 2
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
    if (row && row.type === "fold") root.toggleFold(row.key)
    // Leaf rows do nothing in Phase 1; the action row arrives in Phase 2.
  }

  function toggleFold(key) {
    var f = {}
    for (var k in root.folded) f[k] = root.folded[k]
    f[key] = !f[key]
    root.folded = f
  }

  // The only rung today is close(); Phase 2 adds "close confirm" and "collapse row".
  function closeLadder() { root.close() }

  function scrollToSelection() {
    if (!listView || root.selectedIndex < 0) return
    listView.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(Style.space(480), Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      // `x` arrives here, not through textKey. Phase 2 wires cancel-deployment to it.
      onDeleteRequested: {}
      onCloseRequested: root.closeLadder()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refreshNow()
        else if (t === "g" || t === "G") root.groupBy = root.groupBy === "project" ? "server" : "project"
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
        text: Model.footerHints(root.focusSection, root.currentRow)
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

        delegate: Column {
          id: rowDelegate
          required property var modelData
          required property int index
          width: listView.width
          readonly property string rowType: modelData.type
          readonly property bool selected: root.cursorActive && root.focusSection === "list" && root.cursorKey === modelData.key
          readonly property bool selectable: rowType === "fold" || rowType === "deployment" || rowType === "server" || rowType === "resource"

          // ---- section header, optionally with the grouping toggle
          Item {
            visible: rowDelegate.rowType === "section"
            width: parent.width
            implicitHeight: visible ? Math.max(sectionHeader.implicitHeight, groupToggle.visible ? groupToggle.implicitHeight : 0) : 0
            height: implicitHeight

            PanelSectionHeader {
              id: sectionHeader
              text: modelData.title || ""
              foreground: root.foreground
              fontFamily: root.fontFamily
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
            }

            // Centred on the header's glyphs, not its box: PanelSectionHeader carries
            // topPadding for Nerd Font overshoot (the network panel's band header idiom).
            ButtonGroup {
              id: groupToggle
              visible: modelData.control === "groupBy"
              options: [{ value: "project", label: "by project" }, { value: "server", label: "by server" }]
              value: root.groupBy
              fontSize: Style.font.bodySmall
              focusable: false
              foreground: root.foreground
              fontFamily: root.fontFamily
              accent: root.accent
              anchors.right: parent.right
              anchors.verticalCenter: sectionHeader.verticalCenter
              anchors.verticalCenterOffset: Math.round(sectionHeader.topPadding / 2)
              onChanged: function(v) { root.groupBy = v }
            }
          }

          // ---- separator
          PanelSeparator {
            visible: rowDelegate.rowType === "separator"
            height: visible ? 1 : 0
            width: parent.width
            foreground: root.foreground
          }

          // ---- note (empty section)
          Text {
            visible: rowDelegate.rowType === "note"
            height: visible ? implicitHeight : 0
            width: parent.width
            textFormat: Text.PlainText
            text: modelData.text || ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          // ---- fold (project / environment or server)
          CursorSurface {
            visible: rowDelegate.rowType === "fold"
            enabled: visible
            width: parent.width
            implicitHeight: visible ? foldRow.implicitHeight + Style.spacing.rowPaddingX : 0
            height: implicitHeight
            hasCursor: rowDelegate.selected
            foreground: root.foreground
            accent: root.accent
            HoverHandler {
              enabled: parent.visible
              onHoveredChanged: if (hovered) root.setCursor(rowDelegate.modelData.key)
            }
            MouseArea {
              anchors.fill: parent
              enabled: parent.visible
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
                text: modelData.open ? Model.G.foldOpen : Model.G.foldClosed
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                anchors.verticalCenter: parent.verticalCenter
              }
              Text {
                textFormat: Text.PlainText
                text: String(modelData.title || "").toUpperCase()
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.1
                elide: Text.ElideRight
                anchors.verticalCenter: parent.verticalCenter
              }
              Text {
                textFormat: Text.PlainText
                text: String(modelData.count === undefined ? "" : modelData.count)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                anchors.verticalCenter: parent.verticalCenter
              }
            }
          }

          // ---- deployment row: glyph · name over "branch · message" · elapsed/age
          CursorSurface {
            visible: rowDelegate.rowType === "deployment"
            enabled: visible
            width: parent.width
            implicitHeight: visible ? depRow.implicitHeight + Style.spacing.rowPaddingX : 0
            height: implicitHeight
            hasCursor: rowDelegate.selected
            foreground: root.foreground
            accent: root.accent
            HoverHandler {
              enabled: parent.visible
              onHoveredChanged: if (hovered) root.setCursor(rowDelegate.modelData.key)
            }
            MouseArea {
              anchors.fill: parent
              enabled: parent.visible
              onClicked: root.setCursor(rowDelegate.modelData.key)
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
                text: modelData.glyph || ""
                color: root.toneColor(modelData.tone)
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
                  text: modelData.name || ""
                  color: modelData.tone === "urgent" ? root.urgent : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }
                Text {
                  width: parent.width
                  visible: text.length > 0
                  textFormat: Text.PlainText
                  text: modelData.sub || ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }
              Text {
                id: depTime
                textFormat: Text.PlainText
                // The only delegate that reads nowMs: rows carry timestamps, not strings.
                text: modelData.terminal ? Model.age(modelData.updatedAt, root.nowMs) : Model.elapsed(modelData.createdAt, root.nowMs)
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                anchors.verticalCenter: parent.verticalCenter
              }
            }
          }

          // ---- server row: dot · name · "ip · N resources · unreachable"
          CursorSurface {
            visible: rowDelegate.rowType === "server"
            enabled: visible
            width: parent.width
            implicitHeight: visible ? srvRow.implicitHeight + Style.spacing.rowPaddingX : 0
            height: implicitHeight
            hasCursor: rowDelegate.selected
            foreground: root.foreground
            accent: root.accent
            HoverHandler {
              enabled: parent.visible
              onHoveredChanged: if (hovered) root.setCursor(rowDelegate.modelData.key)
            }
            MouseArea {
              anchors.fill: parent
              enabled: parent.visible
              onClicked: root.setCursor(rowDelegate.modelData.key)
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
                text: modelData.dot || ""
                color: root.toneColor(modelData.tone)
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                horizontalAlignment: Text.AlignHCenter
                anchors.verticalCenter: parent.verticalCenter
              }
              Text {
                textFormat: Text.PlainText
                text: modelData.name || ""
                color: modelData.dim ? root.dim : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
                anchors.verticalCenter: parent.verticalCenter
              }
              Text {
                width: parent.width - Style.space(22) - parent.spacing * 2 - Style.space(120)
                textFormat: Text.PlainText
                text: modelData.sub || ""
                color: modelData.tone === "urgent" ? root.urgent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
                anchors.verticalCenter: parent.verticalCenter
              }
            }
          }

          // ---- resource row: dot · name · status words · kind hint
          CursorSurface {
            visible: rowDelegate.rowType === "resource"
            enabled: visible
            width: parent.width
            implicitHeight: visible ? resRow.implicitHeight + Style.spacing.rowPaddingX : 0
            height: implicitHeight
            hasCursor: rowDelegate.selected
            foreground: root.foreground
            accent: root.accent
            HoverHandler {
              enabled: parent.visible
              onHoveredChanged: if (hovered) root.setCursor(rowDelegate.modelData.key)
            }
            MouseArea {
              anchors.fill: parent
              enabled: parent.visible
              onClicked: root.setCursor(rowDelegate.modelData.key)
            }
            Row {
              id: resRow
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.leftMargin: Style.space(8) + Style.space(14) * (modelData.indent || 0)
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(8)
              Text {
                width: Style.space(22)
                textFormat: Text.PlainText
                text: modelData.dot || ""
                color: root.toneColor(modelData.tone)
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                horizontalAlignment: Text.AlignHCenter
                anchors.verticalCenter: parent.verticalCenter
              }
              Text {
                width: parent.width - Style.space(22) - resStatus.implicitWidth - resKind.implicitWidth - parent.spacing * 3
                textFormat: Text.PlainText
                text: modelData.name || ""
                color: modelData.dim ? root.dim : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
                anchors.verticalCenter: parent.verticalCenter
              }
              Text {
                id: resStatus
                textFormat: Text.PlainText
                text: modelData.statusWords || ""
                color: modelData.tone === "urgent" ? root.urgent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                anchors.verticalCenter: parent.verticalCenter
              }
              Text {
                id: resKind
                textFormat: Text.PlainText
                text: modelData.kindHint || ""
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
