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

  readonly property var snapshot: ({
    instance: null, error: null, warning: null,
    servers: [], resources: [], deployments: [], recent: [], tree: [], byServer: {},
    failedUnacked: [], lastPollAt: {}, busy: false, openPanels: 0, baselineDone: false
  })
  readonly property var bar: ({ glyph: "󰅜", dimmed: true, active: false, tooltip: "Omarify — starting" })

  function refresh() {}

  IpcHandler {
    target: "io.github.danjonesio.omarify"
    function refresh(): string { root.refresh(); return "ok" }
    function status(): string { return "{}" }
  }
}
