import QtQuick
import Quickshell
import qs.Ui
import qs.Commons
import "Model.js" as Model

// One instance per monitor. Renders the service's bar state and hosts the panel.
BarWidget {
  id: root
  moduleName: "io.github.danjonesio.coolwatch"

  readonly property var svc: bar && bar.shell && typeof bar.shell.serviceFor === "function"
    ? bar.shell.serviceFor(root.moduleName)
    : null

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("service" in target) target.service = root.svc
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  onBarChanged: injectPanel()
  onSvcChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // The Coolify mark for the configured states; colour follows the button's own rule for
  // a glyph (active → activeColor, else foreground) so dimmed and active read the same.
  Component {
    id: markComponent
    Item {
      Mark {
        anchors.centerIn: parent
        size: parent.width                 // the canvas is square; the mark fills its width and sits centred
        color: button.active && button.useActiveColor ? button.activeColor : button.foreground
      }
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.svc && Model.barMark(root.svc.bar) ? "" : (root.svc ? root.svc.bar.glyph : Model.G.cloudOutline)
    iconComponent: root.svc && Model.barMark(root.svc.bar) ? markComponent : null
    keepSpace: true
    dimmed: root.svc ? root.svc.bar.dimmed : true
    active: root.svc ? root.svc.bar.active : false
    tooltipText: root.svc ? root.svc.bar.tooltip : "Coolwatch — starting"
    onPressed: function(b) {
      if (b === Qt.LeftButton) root.toggle()
      else if (b === Qt.MiddleButton && root.svc) root.svc.cycleInstance(1)   // Phase 4: next instance
      // Right click opens the instance itself; the origin is validated by Model (SR9).
      else if (b === Qt.RightButton && root.svc && root.svc.snapshot && root.svc.snapshot.instance) {
        var o = Model.origin(root.svc.snapshot.instance.url)
        if (o) Util.execArgv(["omarchy-launch-browser", o])
      }
    }
  }
}
