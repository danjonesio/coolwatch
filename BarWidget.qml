import QtQuick
import Quickshell
import qs.Ui
import qs.Commons
import "Model.js" as Model

// One instance per monitor. Renders the service's bar state and hosts the panel.
BarWidget {
  id: root
  moduleName: "io.github.danjonesio.omarify"

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

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.svc ? root.svc.bar.glyph : Model.G.cloudOutline
    keepSpace: true
    dimmed: root.svc ? root.svc.bar.dimmed : true
    active: root.svc ? root.svc.bar.active : false
    tooltipText: root.svc ? root.svc.bar.tooltip : "Omarify — starting"
    onPressed: function(b) {
      if (b === Qt.LeftButton) root.toggle()
      // Right click opens the instance itself; the origin is validated by Model (SR9).
      else if (b === Qt.RightButton && root.svc && root.svc.snapshot && root.svc.snapshot.instance) {
        var o = Model.origin(root.svc.snapshot.instance.url)
        if (o) Util.execArgv(["omarchy-launch-browser", o])
      }
    }
  }
}
