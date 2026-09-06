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
  property bool reflowing: false            // rows just swapped: ignore the hover the recreated delegates emit

  readonly property var snapshot: svc ? svc.snapshot : null
  readonly property var rows: root.opened && root.snapshot
    ? Model.panelRows(root.snapshot, { groupBy: root.groupBy, folded: root.folded, nowMs: root.nowMs }) : []
  readonly property int selectedIndex: Model.indexOfKey(root.rowsModel, root.cursorKey)
  readonly property var currentRow: root.selectedIndex >= 0 ? root.rowsModel[root.selectedIndex] : null
  readonly property bool heroHasCursor: root.cursorActive && root.focusSection === "hero"
  readonly property var callout: Model.callout(root.snapshot, root.nowMs)
  readonly property bool busy: !!(root.snapshot && root.snapshot.busy)

  onRowsChanged: applyRows()
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
  }

  // The rows binding re-evaluates synchronously on groupBy, so by the time this
  // returns rowsModel already holds the new grouping and the cursor can be placed.
  function setGroupBy(v) {
    if (v !== "project" && v !== "server") return
    root.groupBy = v
    var r = Model.firstSelectableInSection(root.rowsModel, "RESOURCES")
    if (r >= 0) { root.cursorActive = true; root.focusSection = "list"; root.cursorKey = root.rowsModel[r].key; Qt.callLater(root.scrollToSelection) }
  }

  function focusHero() {
    root.cursorActive = true
    root.focusSection = "hero"
  }

  function hoverCursor(key) {
    if (root.reflowing) return
    root.setCursor(key)
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
    // Fitted to what is actually in the card, capped: an error or empty state collapses it.
    contentHeight: panel.fittedContentHeight(header.implicitHeight + Style.space(14) + listView.contentHeight + Style.space(10) + footer.implicitHeight, Style.space(640))

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
        else if (t === "g" || t === "G") root.setGroupBy(root.groupBy === "project" ? "server" : "project")
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
              : null
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
              hasCursor: rowDelegate.selected
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.modelData.key) }
              MouseArea { anchors.fill: parent; onClicked: root.setCursor(rowDelegate.modelData.key) }
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
              hasCursor: rowDelegate.selected
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.modelData.key) }
              MouseArea { anchors.fill: parent; onClicked: root.setCursor(rowDelegate.modelData.key) }
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
                  color: rowDelegate.modelData.tone === "urgent" ? root.urgent : root.dim
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
              hasCursor: rowDelegate.selected
              foreground: root.foreground
              accent: root.accent
              HoverHandler { onHoveredChanged: if (hovered) root.hoverCursor(rowDelegate.modelData.key) }
              MouseArea { anchors.fill: parent; onClicked: root.setCursor(rowDelegate.modelData.key) }
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
                  color: rowDelegate.modelData.tone === "urgent" ? root.urgent : root.dim
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
