> Reference generated 2026-09-06 by reading `/usr/share/omarchy/shell` (Omarchy
> 4.0.0.alpha, Quickshell 0.3.1). It is the factual basis for `docs/design.md`. Omarchy
> is alpha; when `omarchy update` changes the shell, re-verify names against the source
> before trusting this file.

# Omarchy shell (4.0.0.alpha) — UI kit and plugin runtime reference

Source of truth: `/usr/share/omarchy/shell` (read-only). All property, function and
signal names below are quoted verbatim from that tree. Third-party plugins import the
kit with `import qs.Ui` and `import qs.Commons`; the latter exposes the singletons
`Style`, `Color`, `Util`, `Border` (`Commons/qmldir`).

---

## 1. Plugin runtime contract

### 1.1 Manifest and discovery

- `manifest.json` at the plugin root, validated by
  `services/PluginRegistry.qml::validateManifest`. Required: `schemaVersion: 1`, `id`,
  `name`, `version`, `kinds` (non-empty array), `entryPoints` (object). Every entry
  point must be a relative path inside the plugin dir (no leading `/`, no `..`).
- Third-party plugins live in `~/.config/omarchy/plugins/<id>/`. Ids beginning with
  `omarchy.` are rejected for third parties (`parseScanOutput`).
- `kinds`: `bar-widget`, `panel`, `overlay`, `menu`, `service`, `bar`
  (`README.md` "Supported kinds"). A plugin may declare several, e.g. `omarchy.media`
  declares `["service", "bar-widget"]` with `entryPoints: { "service": "Service.qml",
  "barWidget": "BarWidget.qml" }`.
- `keepLoaded: true` keeps a panel/overlay/menu instance mounted between summons
  (`omarchy.osd`, `omarchy.notifications`, `omarchy.image-picker`).
- `barWidget` block: `displayName`, `description`, `category`, `allowMultiple`,
  `defaultSection` (`left|center|right`, validated), `aliases`, `defaults`, `schema`,
  `settingsForm`. `shell.qml::syncPluginWidgets` copies these into the
  `BarWidgetRegistry` metadata (`defaults: meta.defaults || {}`, `schema: meta.schema
  || []`).
- The agents manifest also carries `"activation": "on-demand"`; nothing in
  `PluginRegistry.qml` or `shell.qml` reads that key.
- Enabled state: a third-party plugin is enabled iff its id appears in
  `~/.config/omarchy/shell.json` — in `bar.layout.<section>[]` for bar widgets, or in
  top-level `plugins[]` for every other kind (`PluginRegistry.isEnabled`,
  `findEntryLocation`). `omarchy plugin enable <id>` writes that entry.

### 1.2 What the shell injects, per kind

Injection is duck-typed: the host checks `"prop" in item` and assigns only if the
plugin root declares the property. Declare exactly the ones you want.

| Kind | Instantiated by | Injected properties (if declared) |
|---|---|---|
| `bar-widget` | `plugins/bar/Bar.qml` `ModuleSlot.injectProps()` (Loader per slot, **one instance per monitor**, `Variants { model: Quickshell.screens }`) | `bar` (the Bar root), `moduleName` (string, the layout entry id), `settings` (object) |
| `service` | `shell.qml::ensureService` → `comp.createObject(serviceHost)` at startup for enabled service plugins (`_syncServices`) | `omarchyPath`, `shell`, `manifest`, `barWidgetRegistry`, `pluginRegistry` |
| `panel` / `overlay` / `menu` | `shell.qml` `Instantiator { model: shell.panelEntries }` → per-plugin `Loader { asynchronous: true }`, `active` when `keepLoaded` or `shell.openPanelIds[id] === true` | `omarchyPath`, `shell`, `manifest`, `barWidgetRegistry`, `pluginRegistry`, **`service`** (= `shell.serviceFor(pluginId)`, the same plugin's service instance) |
| `bar` | `shell.qml::configureBar` | `shell`, `manifest` (plus required `omarchyPath`, `barWidgetRegistry`, `barConfig`) |

Bar widgets do **not** receive `shell` directly; they reach it through `bar.shell`
(`Bar.qml` line 25: `property var shell: null`, injected by the host).

`settings` for a bar widget is the inline shell.json entry with `id` stripped
(`plugins/bar/BarModel.js::entrySettings`). **Manifest `barWidget.defaults` are not
merged into `settings` at runtime** — the only consumer of `defaults` is the registry
metadata (`shell.qml` line 694) used by the settings UI. Always read with a fallback:

```qml
BarWidget {
  readonly property int refreshSec: Math.max(30, Number(setting("refreshIntervalSec", 900)))
}
```

`BarWidget.setting(name, fallback)` / `Panel.setting(name, fallback)` return
`fallback` for `undefined`/`null` (`Ui/BarWidget.qml`, `Ui/Panel.qml`).

### 1.3 The `bar` object (what a widget can use)

From `plugins/bar/Bar.qml` and `plugins/bar/README.md`:

- Colors: `bar.foreground`, `bar.barForeground` (swaps when the bar is transparent),
  `bar.background`, `bar.urgent`, `bar.foregroundAnimationEnabled`.
- Geometry: `bar.position` (`"top"|"bottom"|"left"|"right"`), `bar.vertical`,
  `bar.barSize`, `bar.fontFamily`.
- Actions: `bar.run(command)` (→ `Util.execDetached`, i.e. `bash -lc`),
  `bar.shellQuote(v)`, `bar.showTooltip(target, text)`, `bar.hideTooltip(target)`,
  `bar.requestPopout(owner)`, `bar.releasePopout(owner)`, `bar.activePopout`,
  `bar.switchPanelFrom(owner, direction)`, `bar.moduleWidgets(pluginId)` (every live
  instance of a widget id across monitors), `bar.registerClickTarget(t)`,
  `bar.unregisterClickTarget(t)`, `bar.clickTargets`, `bar.targetBelongsToWindow`.
- Host: `bar.shell` — the `ShellRoot`; `bar.barWidgetRegistry`; `bar.manifest`.

### 1.4 Lifecycle

- **Services**: created at startup (`_syncServices` runs on every
  `pluginRegistry.pluginsChanged`), destroyed with `inst.destroy()` when the plugin is
  disabled/removed or on plugin reload (`unloadPluginServices`).
- **Panels/overlays/menus**: `summon` sets `openPanelIds[id] = true`, which activates
  the Loader. `hide` calls `close()` on the item (`invokeIfLoaded(id, "close", null)`)
  and clears `openPanelIds[id]`; without `keepLoaded` the Loader deactivates and the
  item is destroyed, so `Component.onDestruction` runs on each hide. With `keepLoaded`
  the same instance is reused and `open(payload)` is delivered immediately
  (`deliverIfLoaded`). `Loader.Error` triggers `shell.hide(id)` with a console warning.
- **Bar widgets**: rebuilt on plugin reload, on any layout change (`applyBarConfig`
  reassigns `layoutConfig`, which rebuilds every widget on every monitor), and on
  disable. An inline-settings-only change patches `item.settings` in place
  (`applySettingsDelta`). Widgets that hold OS resources release them in
  `Component.onDestruction` (network panel: `if (scannerDevice)
  scannerDevice.scannerEnabled = false`). `WidgetButton` unregisters its click target in
  `Component.onDestruction`.
- Saving a file under `~/.config/omarchy/plugins/` hot-reloads plugins
  (`PluginRegistry.localPluginWatcher` → `shell.reloadPlugins`).

### 1.5 How `omarchy-shell shell summon <id> '<json>'` reaches you

`bin/omarchy-shell` forwards to `quickshell ipc`. `shell.qml` has
`IpcHandler { target: "shell" }` with `summon(id, payloadJson)`, `hide(id)`,
`toggle(id, payloadJson)`, `call(id, method, arg)`, `togglePanelAt(section, index)`.

`shell.summon(pluginId, payloadJson)`:

1. `resolveEnabledId` (a cloned plugin answers to its source id); unknown or disabled
   ids return `false` with a console warning.
2. If the plugin's kinds contain `bar-widget` and none of `panel|overlay|menu`
   (`isBarWidgetPanelPlugin`), the call is routed to
   `shell.bar.summonBarWidget(id)` → `Bar.findPanelWidget(id)` → `item.open()`.
   **The payload is dropped on this path.** `findPanelWidget` only accepts a widget root
   that has `function open()`, `function close()` and a `property bool opened`; it picks
   the per-monitor instance on Hyprland's focused output (`BarModel.pickPanelSlot`).
   `hide` → `item.close()`; `toggle` reads `item.opened`.
3. Otherwise the payload string is queued in `pendingPayloads[id]` and, once the Loader
   has an item, `deliverIfLoaded` calls **`loader.item.open(payloadJson)`** once per
   queued payload (in arrival order). So a `panel`/`overlay` root must implement
   `function open(payloadJson)`, `function close()`, and expose `property bool opened`
   (used by `isPluginOpen`).

Worked examples: `plugins/osd/Osd.qml` (`open(payloadJson)` → `JSON.parse` →
`show(...)`), `plugins/panels/speedtest/Panel.qml` and
`plugins/panels/wifiqr/Panel.qml` (both `Item { property var shell; property var
manifest; property bool opened; function open(payloadJson) {...} function close()
{...} }`). A panel dismisses itself through the host so bookkeeping stays right:
`shell.hide((manifest && manifest.id) || "my.plugin")` (speedtest `dismiss()`).

`omarchy-shell shell call <id> <method> <arg>` → `callIfLoaded` → invokes
`loader.item[method](arg)` on a loaded panel and returns the string result (or `"ok"`,
`"unknown"`, `"error"`).

Per-plugin IPC targets: any plugin may declare `IpcHandler { target: "my-target" }`
(`omarchy-shell my-target <method> ...`). Only one handler per target may exist; a bar
widget exists once per monitor, so an IPC call lands on one instance only — use
`BarWidget.broadcast(method)` to relay to peers via `bar.moduleWidgets(moduleName)`.
`Ui/Panel.qml` auto-registers a handler with `open/close/show/hide/toggle` when
`ipcTarget !== ""` and `manageIpc` is true; first-party panels set `manageIpc: false`
and declare their own handler with extra methods (`refresh`, `next`, `brightness`,
`state`, `toggleNetwork`).

### 1.6 Bar widget ↔ Service of the same plugin

There is **no** JS-module sharing and no per-plugin singleton import. The mechanism is
a registry lookup on the shell root:

```qml
// plugins/services/media/BarWidget.qml
readonly property var mediaService: bar?.shell?.firstPartyServiceFor("omarchy.media")
```

`shell.firstPartyServiceFor(pluginId)` is literally `return serviceFor(pluginId)`, and
`serviceFor` is `_services[String(pluginId)] || null` — it works for any enabled plugin
id, first- or third-party. `plugins/bar/indicators/Dnd.qml` does the same for
`"omarchy.notifications"`. Because services are created synchronously at startup and
widgets bind to `bar.shell`, the property re-evaluates as soon as `bar` is injected. If
you need to force-create one: `bar.shell.ensureService(id)`.

`panel`/`overlay` roots get the same object injected as `service` (`if ("service" in
item) item.service = shell.serviceFor(panelEntry.pluginId)`), so declare
`property var service: null`.

Services can reach the host too: they receive `shell` and use it, e.g. the media
service's `shell.summon("omarchy.osd", JSON.stringify({...}))`.

Alternative pattern when nothing needs to be shared across plugins: a `bar-widget`-only
plugin instantiates its logic component inside the panel and passes settings down —
`Service { id: tailscale; settings: root.settings }` (`plugins/panels/tailscale/Panel.qml`),
`Main { id: usage; settings: root.settings }` (`plugins/agents/Panel.qml`). That gives one
logic instance per monitor, which is fine for cheap pollers.

### 1.7 Reading and writing per-widget settings

- Read: `settings.<key>` or `setting("<key>", fallback)`. `settings` is re-assigned live
  when shell.json changes (`onModuleSettingsChanged: injectProps()` and
  `applySettingsDelta`).
- Write (from QML): build the full entry and call `bar.shell.updateEntryInline`:

```qml
// plugins/panels/clock/BarWidget.qml
var entry = { id: root.moduleName }
for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
entry[vertical ? "verticalFormat" : "format"] = next
root.settings = entry   // optimistic local apply
if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
  root.bar.shell.updateEntryInline(root.moduleName, entry)
```

  `shell.updateEntryInline(moduleName, settings)` replaces the layout entry (or the
  `plugins[]` entry for non-widgets) with `{ id, ...settings }` and persists only if it
  changed. Tailscale uses the same call to persist `recentMullvadRegions`.
- Write (from CLI): `omarchy bar set <id> <key> <value> [--json]` →
  `shell.setBarWidget` → `PluginRegistry.setBarWidget` sets `entry[key] = value`.
  Numbers need `--json` or they are stored as strings (agents README).
- Schema entry shapes seen in first-party manifests: `{ key, type: "integer", label,
  min, max, step, defaultValue }`, `{ type: "enum", options: [...] }`, `{ type: "path" }`,
  `{ type: "string", description }`. `settingsForm: "<name>"` points at a custom form.

---

## 2. Component catalog (`qs.Ui`)

All files under `/usr/share/omarchy/shell/Ui/`; exports listed in `Ui/qmldir`.

### BarWidget (`Ui/BarWidget.qml`)
Base `Item` for every bar widget. Properties: `bar: QtObject`, `moduleName: string`,
`settings: var`, readonly `vertical`, `barSize`. Functions: `broadcast(method)` (run a
method on every live instance of this widget across monitors), `setting(name, fallback)`.
```qml
BarWidget { id: root; moduleName: "acme.thing"
  implicitWidth: button.implicitWidth; implicitHeight: button.implicitHeight
  BarIconButton { id: button; anchors.fill: parent; bar: root.bar; text: "󰍹"; onPressed: function(b) { /* ... */ } } }
```

### WidgetButton (`Ui/WidgetButton.qml`)
Text label button sized to the bar. Properties: `bar`, `text`, `fontFamily` (defaults to
`bar.fontFamily`), `fontSize` (`Style.font.body`), `foreground` (`bar.barForeground`),
`activeColor` (`bar.urgent`), `active`, `horizontalMargin: 8.5`, `verticalPadding: 6`,
`fixedWidth`, `fixedHeight`, `textRotation`, `keepSpace`, `dimmed`, `concealed`,
`interactive`, `pressable`, `useActiveColor`, `labelVisible`, `hasVisualContent`,
`tooltipText`, readonly `labelWidth`. Signals: `pressed(int button)`,
`wheelMoved(int delta)`. Registers itself as a bar click target and shows the shared
bar tooltip on hover.
```qml
WidgetButton { bar: root.bar; text: "12:00"; tooltipText: "Clock"; onPressed: function(b) { root.toggle() } }
```

### BarIconButton (`Ui/BarIconButton.qml`)
`WidgetButton` specialised for a single glyph, optically centred through
`OpticalGlyph`. Properties: `iconComponent: Component` (custom drawn icon instead of
text), `slotSize` (`Style.bar.iconSlot`), `opticalSize` (`Style.bar.iconCanvas`),
`fontSize` = `Style.bar.iconFont`. Same signals as WidgetButton. This is what every
first-party panel uses as its bar button.
```qml
BarIconButton { id: button; anchors.fill: parent; bar: root.bar; text: "󰤨"; active: root.alarming
  onPressed: function(b) { root.toggle() }; onWheelMoved: function(d) { ... } }
```

### BarIndicator (`Ui/BarIndicator.qml`)
`BarIconButton` for on/off status glyphs in the indicators drawer. Properties:
`moduleName`, `settings`, `activeText`, `inactiveText`, `activeTooltipText`,
`inactiveTooltipText`, `indicatorBlock` (`"single"|"active"|"inactive"`),
`indicatorHost`, `activeOverride`, readonly `effectiveActive`, `belongsInBlock`,
`inactiveRevealed`. Function `extractData(raw)` (Waybar-style JSON). Dims to 0.45 when
inactive and revealed, hides otherwise. Font `Style.font.caption`, slot
`Style.bar.statusSlot`.
```qml
BarIndicator { active: svc.doNotDisturb; activeText: "󰂛"; activeTooltipText: "Allow Notifications"; onPressed: function() { svc.setDoNotDisturb(!svc.doNotDisturb) } }
```

### Panel (`Ui/Panel.qml`)
Base `Item` for "bar button + popup" plugins. Properties: `bar`, `moduleName`,
`settings`, `ipcTarget`, `manageIpc: true`, alias `controller` (a `PanelController`),
`popoutSwitching`, `popoutSwitchClosing`, readonly `opened`, `barForeground`. Functions:
`open()`, `close()`, `toggle()`, `closeForPopoutSwitch()`, `switchPanel(direction)`
(Tab between panels via `bar.switchPanelFrom`), `setting(name, fallback)`. Declares an
`IpcHandler` (`open/close/show/hide/toggle`) when `manageIpc && ipcTarget !== ""`. Its
`open/close/opened` shape is exactly what `Bar.findPanelWidget` requires for summon
routing.
```qml
Panel { id: root; moduleName: "acme.thing"; ipcTarget: "acme.thing"
  implicitWidth: button.implicitWidth; implicitHeight: button.implicitHeight
  BarIconButton { id: button; bar: root.bar; text: "󰍹"; onPressed: function() { root.toggle() } }
  KeyboardPanel { anchorItem: button; owner: root; bar: root.bar; open: root.opened; /* content */ } }
```

### PanelController (`Ui/PanelController.qml`)
`QtObject { property bool open; toggle(); show(); hide() }`. Owned by `Panel`; the
network panel overrides `close()` and calls `root.controller.hide()` directly.

### KeyboardPanel (`Ui/KeyboardPanel.qml`)
Layer-shell (`PanelWindow`, layer `Overlay`, namespace `omarchy-keyboard-panel`) popup
anchored to a bar item, with keyboard-focus priming (`Exclusive` → `OnDemand`),
outside-click dismissal on every monitor, bar-strip click-through, fade and popout
coordination. Required: `anchorItem: Item`, `bar: QtObject`. Properties: `owner`,
`margin` (`Style.gapsOut`), `padding` (`Style.spacing.popupPadding`), `contentWidth`
(`Style.space(280)`), `contentHeight` (`Style.space(200)`), `borderSpec`
(`Border.surfaceSpec("popups","border",...)`), `centerOnBar`, `open`, `gap`,
`focusTarget: Item` (forced active focus after mapping — point it at your
`PanelKeyCatcher`), default property `contentItem`. Readonly: `availableCardWidth`,
`availableCardHeight`, `cardOrigin`, `verticalContentInset`. Functions:
`fittedContentWidth(width, cap)`, `fittedContentHeight(implicitHeight, cap)`,
`cappedContentHeight(height)`, `close()`. Card is `BorderSurface` with
`Color.popups.background`, `radius: Style.cornerRadius`.
```qml
KeyboardPanel { id: panel; anchorItem: button; owner: root; bar: root.bar; open: root.opened; focusTarget: keyCatcher
  contentWidth: panel.fittedContentWidth(Style.space(380))
  contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))
  PanelKeyCatcher { id: keyCatcher; anchors.fill: parent; /* ... */ Column { id: column; width: parent.width } } }
```

### PanelKeyCatcher (`Ui/PanelKeyCatcher.qml`)
`Item { focus: true; Keys.priority: Keys.BeforeItem }` that turns keys into semantic
signals: `moveRequested(int dx, int dy)` (arrows and h/j/k/l), `activateRequested()`
(Enter/Space), `returnRequested()`, `closeRequested()` (Esc), `deleteRequested()` (x),
`tabRequested(int direction)` (Tab/Shift+Tab), `textKey(string text)` (any other single
char). Property `blocked` forwards everything to descendants (set it to
`editor.activeFocus` while an inline TextField is open).
```qml
PanelKeyCatcher { anchors.fill: parent; blocked: root.passwordSsid !== ""
  onMoveRequested: function(dx, dy) { root.moveCursor(dx, dy) }
  onActivateRequested: root.activateCursor(); onCloseRequested: root.close()
  onTabRequested: function(d) { root.switchPanel(d) }; onTextKey: function(t) { if (t === "r") root.refresh() } }
```

### PanelHero (`Ui/PanelHero.qml`)
Header row: icon slot, bold `title` (`Style.font.title`), optional `detail` pill
(bordered, `Style.cornerRadius`), uppercase `meta` line (`Style.font.caption`, bold,
`letterSpacing: 1.2`, colour `Qt.darker(foreground, 1.4)`), optional `trailingControl:
Component` centred on the right. Properties: `iconComponent: Component`, `title`,
`meta`, `detail`, `foreground`, `fontFamily`, `iconSize` (`Style.font.display`),
`iconOpacity`, alias `metaOpacity`; readonly `dim`, `trailingInset`. Fills parent width.
```qml
PanelHero { title: "Tailscale"; meta: "Connected"; foreground: root.bar.foreground; fontFamily: root.bar.fontFamily
  iconComponent: Component { Text { text: "󰍹"; font.pixelSize: Style.font.display; font.family: root.bar.fontFamily; color: root.bar.foreground } }
  trailingControl: Component { ToggleSwitch { checked: svc.active; onToggled: svc.toggle() } } }
```

### PanelSectionHeader (`Ui/PanelSectionHeader.qml`)
`Text` for section titles ("DNS PROVIDER"): bold, `Style.font.caption`, colour
`Qt.darker(foreground, 1.4)`, `textFormat: PlainText`, `topPadding` reserving Nerd Font
overshoot. Properties `foreground`, `fontFamily`, `fontSize`. Pass uppercase text.
```qml
PanelSectionHeader { text: "LIMITS"; foreground: root.foreground; fontFamily: root.fontFamily }
```

### PanelSeparator (`Ui/PanelSeparator.qml`)
1px `Rectangle` divider, colour = `foreground` at alpha `strength` (0.12). Fills parent
width. Place one before each section.
```qml
PanelSeparator { foreground: root.bar.foreground }
```

### PanelActionButton (`Ui/PanelActionButton.qml`)
Small square icon button (`size` = max(`Style.space(22)`, font + `sm`×2)) for
row-edge actions. Properties: `iconText`, `tooltipText`, `foreground`, `hoverColor`
(set to `bar.urgent` for destructive), `fontFamily`, `fontSize` (`Style.font.icon`),
`focusable`, `hasCursor`, `bordered`, `enabled` (dims icon). Signals: `clicked()`,
`hovered(bool)`. Renders its own `PanelToolTip`.
```qml
PanelActionButton { iconText: "󰄬"; tooltipText: "Connect"; enabled: canSubmit; foreground: root.bar.foreground; fontFamily: root.bar.fontFamily; onClicked: submit() }
```

### PanelSlider (`Ui/PanelSlider.qml`)
Horizontal slider with knob (`BorderSurface`), track, animated fill, optional ticks.
Properties: `bar`, `value`, `minimum: 0`, `maximum: 1`, `step: 0.05`, `integer`,
`trackColor` (`Style.selectedFillFor(bar.foreground, Color.accent)`), `fillColor`,
`knobColor`, `dragging`, `trackHeight`, `knobSize`, `liveValue` (value while dragging),
`tickCount`, `tickColor`. Signals: `moved(real value)` (continuous), `released(real
value)`, `rightClicked()`. Wheel steps by `step`. `implicitWidth: Style.space(200)`.
```qml
PanelSlider { bar: root.bar; minimum: 1; maximum: 100; step: 1; integer: true; value: root.percent
  onMoved: function(v) { root.preview(v) }; onReleased: function(v) { root.commit(v) } }
```

### PanelToolTip (`Ui/PanelToolTip.qml`)
Styled `QtQuick.Controls.ToolTip` (`delay: 400`) using `Color.tooltip.*` and
`Border.localOrSurfaceSpec("tooltip", "border", ...)`. Properties `panelForeground`,
`panelBackground`, `panelBorder`, `fontFamily`, `fontSize` (`Style.font.bodySmall`).
Declare inside the hovered item and bind `visible`.
```qml
MouseArea { id: hover; anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.NoButton }
PanelToolTip { visible: hover.containsMouse; text: "Forget network"; fontFamily: root.bar.fontFamily }
```

### PopupCard (`Ui/PopupCard.qml`)
xdg-popup (`PopupWindow`) card anchored to a bar item, using `HyprlandFocusGrab` for
outside-click dismissal (`triggerMode: "click"`) or passive hover mode (`"hover"`).
Required: `anchorItem`, `bar`. Properties: `owner`, `margin`, `padding`, `contentWidth`,
`contentHeight`, `borderColor`, `borderSpec`, `open`, `centerOnBar`, `triggerMode`,
readonly `containsMouse`, default `contentItem`. Functions `fittedContentWidth`,
`fittedContentHeight`, `cappedContentHeight`, `close()`. No keyboard focus — use
`KeyboardPanel` for anything navigable. Media widget uses it for the right-click popup.
```qml
PopupCard { anchorItem: root; bar: root.bar; owner: root; open: root.popupOpen
  contentWidth: fittedContentWidth(Style.space(320)); contentHeight: fittedContentHeight(col.implicitHeight)
  Column { id: col; anchors.fill: parent } }
```

### Button (`Ui/Button.qml`)
The one button. `BorderSurface` with text and/or icon; state priority pressed >
focus > `hasCursor`/hover > `selected` > `active` > idle, all painted from `Style`
tokens. Properties: `text`, `iconText`, `tooltipText`, `selected`, `active`,
`hasCursor`, `focusable`, `bordered`, `foreground`, `background`, `accent`,
`fontFamily`, `fontSize`, `iconSize`, `iconRotation`, `iconSpinning`,
`horizontalPadding` (`Style.spacing.controlPaddingX`), `verticalPadding`
(`controlPaddingY`), `leftAlign`, `tooltipBackground/Foreground/Border`, readonly `hot`.
Signals: `clicked()`, `rightClicked()`, `hovered(bool isHovered)`. `radius:
Style.cornerRadius`; reserves the widest border so hover never relayouts.
```qml
Button { text: "Cloudflare"; bordered: true; active: root.dns === "Cloudflare"; hasCursor: root.cursorActive && root.dnsIndex === 1
  foreground: root.bar.foreground; fontFamily: root.bar.fontFamily; fontSize: Style.font.bodySmall
  onClicked: root.setDns("Cloudflare"); onHovered: function(h) { if (h) root.setCursor(1) } }
```

### ButtonGroup (`Ui/ButtonGroup.qml`)
`Row` of bordered `Button` chips, mutually exclusive. Properties: `options`
(`string[]` or `{ value, label, icon?, tooltip? }[]`), `value`, `foreground`,
`background`, `accent`, `fontFamily`, `fontSize`, `focusable`, `cursorIndex` (-1 = none;
drive from your panel cursor). Signals: `changed(string value)`, `hovered(int index, bool
isHovered)`. One Tab stop; h/l/arrows walk chips when focused.
```qml
ButtonGroup { options: ["top","bottom","left","right"]; value: root.position; cursorIndex: root.cursorActive ? root.posIndex : -1
  onChanged: function(v) { root.setPosition(v) }; onHovered: function(i, h) { if (h) root.posIndex = i } }
```

### ConfirmDialog (`Ui/ConfirmDialog.qml`)
In-panel modal: scrim + card with `message`, Cancel/Confirm buttons (confirm is
urgent-tinted). Properties: `opened`, `message`, `cancelText`, `confirmText`,
`selectedIndex` (1 = confirm), colours, `fontFamily`, `cornerRadius`. Signals
`canceled()`, `confirmed()`. Function `handleKey(event)` — call it from your key handler
first and return if it returns `true` (Esc, Left/Right/Tab, Enter).
```qml
ConfirmDialog { id: confirm; anchors.fill: parent; message: "Forget " + ssid + "?"; onConfirmed: { forget(); opened = false }; onCanceled: opened = false }
```

### Dropdown (`Ui/Dropdown.qml`)
Single-select trigger + `Popup` list (`Color.popups.*`). Properties: `label`, `value`,
`options` (`string[]` or `{ value, label }[]`), `foreground`, `background`,
`popupBorder`, `accent`, `fontFamily`, `rowHeight` (`Style.spacing.controlHeight`),
`popupRowHeight`, `showLabel`, `hasCursor`, readonly `popupOpen`. Functions `open()`,
`close()`, `toggle()`, `currentLabel()`. Signals `changed(string value)`,
`hovered(bool)`. Suspend your key catcher while `popupOpen`. `implicitWidth:
Style.spacing.dropdownWidth`.
```qml
Dropdown { label: "Output"; options: sinks; value: current; onChanged: function(v) { select(v) } }
```

### SearchableDropdown (`Ui/SearchableDropdown.qml`)
Same trigger, popup leads with an embedded `TextField` filter. Adds `placeholderText`,
`emptyText`, `triggerLabel`, `popupMinHeight` (`Style.spacing.searchablePopupMinHeight`),
options may carry `description`. Same signals/functions as Dropdown.

### MultiSelect (`Ui/MultiSelect.qml`)
Searchable multi-select with checkbox rows. Properties: `label`, `values: []`,
`options`, `optionsCommand: []` (argv whose stdout is JSON array or one item per
line, run on open and via the refresh button), `optionsCommandCwd`, `placeholderText`,
`emptyText`, `noSelectionText`, `triggerLabel`, `showLabel`, colours, `hasCursor`,
readonly `popupOpen`, `resolvedOptions`, `loadingOptions`, `optionsError`. Signal
`changed(var values)`. Functions `open/close/toggle/refresh/toggleValue(v)/isSelected(v)`.
```qml
MultiSelect { label: "Interfaces"; optionsCommand: ["ls", "/sys/class/net"]; values: root.ifaces; onChanged: function(v) { root.ifaces = v } }
```

### TextField (`Ui/TextField.qml`)
`QtQuick.Controls.TextField` subclass with kit chrome (`Style.controlFill`,
`Border.controlSpec` focus/hover/normal, `radius: Style.cornerRadius`). Properties:
`foreground`, `accent`, `selectionTint`, `password` (echo mode), `horizontalPadding`
(`controlPaddingX`), `verticalPadding` (`Style.spacing.inputPaddingY`), `hasCursor`.
Inherits `text`, `placeholderText`, `accepted`, `editingFinished`, `hovered`.
```qml
TextField { placeholderText: "Passphrase"; password: true; foreground: root.bar.foreground; onAccepted: submit(); Keys.onEscapePressed: cancel() }
```

### NumberField (`Ui/NumberField.qml`)
`Column` of caption label + themed `QQC.SpinBox`. Properties: `label`, `value`, `from`,
`to`, `stepSize`, `foreground`, `accent`, `fontFamily`, `fontSize`, `fieldWidth`
(`Style.spacing.numberFieldWidth`), `hasCursor`, alias `field`. Signals `modified(int
value)`, `hovered(bool)`.
```qml
NumberField { label: "Refresh (s)"; from: 5; to: 3600; stepSize: 5; value: root.refreshSec; onModified: function(v) { root.save("refreshIntervalSec", v) } }
```

### Toggle (`Ui/Toggle.qml`)
Labelled row (`label` bold `Style.font.subtitle`, optional `description`
`Style.font.caption`) with a presentation-only `ToggleSwitch` at the right; the whole row
is the click target. Properties: `label`, `description`, `checked`, `hasCursor`,
`rounded` (auto from `Style.cornerRadius > 0`), colours, `fontFamily`, `titleSize`,
`descriptionSize`. Signals `clicked()`, `hovered(bool)`. Stateless: flip `checked`
yourself. `implicitHeight: max(54, content + Style.spacing.huge)`.
```qml
Toggle { width: parent.width; label: "Sync"; description: "Merge snapshots"; checked: root.sync; onClicked: root.sync = !root.sync }
```

### ToggleSwitch (`Ui/ToggleSwitch.qml`)
Bare track + knob. Properties: `checked`, `busy` (swallow clicks while in flight),
`interactive`, `hasCursor`, `cursorRing`, `cursorPad`, `rounded`, `foreground`,
`accent`, `trackHeight` (settable for compact header placement), `trackWidth`,
`knobSize`, `knobInset`, readonly `containsMouse`, `hot`. Signals `toggled()`,
`hovered(bool)`. Caller owns the value (bind `checked` to optimistic state).
```qml
ToggleSwitch { checked: svc.active; busy: svc.busy; hasCursor: root.headerHasCursor; foreground: root.bar.foreground; onToggled: svc.toggle() }
```

### OpticalGlyph (`Ui/OpticalGlyph.qml`)
`Item` that renders one glyph horizontally corrected to its painted (tight) bounds
using `TextMetrics`. Properties: `text`, `fontFamily`, `fontSize`, `color`,
`debugBounds`; readonly `renderedFontSize`, `tightWidth`, `horizontalCorrection`,
`paintedCenterX`, `baselineY`. Used by `BarIconButton`; use directly when you draw a
Nerd Font glyph inside a fixed box and want it visually centred.
```qml
OpticalGlyph { width: 16; height: 16; text: "󰍹"; fontFamily: root.bar.fontFamily; fontSize: Style.bar.iconFont; color: root.bar.foreground }
```

### BorderSurface (`Ui/BorderSurface.qml`)
`Rectangle` that accepts a `borderSpec` (from `Border.*`). Uses native
`Rectangle.border` when the spec is flat/uniform, otherwise a `BorderOverlay` (gradients,
per-side widths). Properties: `borderSpec`, `padding`, `topPadding`, `rightPadding`,
`bottomPadding`, `leftPadding`; readonly `borderTop/Right/Bottom/Left`,
`contentTopInset/RightInset/BottomInset/LeftInset`, `usesOverlayBorder`. This is the
primitive behind every card, pill, row, tooltip and popup in the kit.
```qml
BorderSurface { width: parent.width; radius: Style.cornerRadius; color: Style.normalFillFor(fg, Color.accent); borderSpec: Border.controlSpec("normal", fg, Color.accent); padding: Style.space(12)
  Item { anchors.fill: parent; anchors.margins: parent.contentTopInset } }
```

### BorderOverlay (`Ui/BorderOverlay.qml`)
Visual-only `Shape` ring renderer for a `borderSpec` (`radius`, `z: 100000`). You
rarely instantiate it; `BorderSurface` loads it when `Border.needsOverlay(spec)`.

### CursorSurface (`Ui/CursorSurface.qml`, not in the requested list but central)
`BorderSurface` row chrome for keyboard/mouse-navigable rows: `hasCursor` paints
`Style.hoverFillFor` + hover-cursor border, `current` paints `Style.selectedFillFor` +
selected border, `bordered` paints the normal border at rest. Properties `foreground`,
`accent`, `fill`, `currentFill`, `outline`. Contract: never colour from
`containsMouse`; update the panel's cursor state on hover and let `hasCursor` drive.

### SpeedTestOverlay (`Ui/SpeedTestOverlay.qml`)
Full-screen `PanelWindow` (layer Overlay, `keyboardFocus: Exclusive`) with a
`Qt.rgba(0,0,0,0.78)` scrim and two 270° gauge dials. Required: `fontFamily`,
`running`, `leftLabel`, `rightLabel`. Properties: `unit`, `title`, `layerNamespace`,
`runAgainTooltip`, `leftValue`, `rightValue`, `leftLive`, `rightLive`, `error`, `open`,
`scaleStops`, `fullScale`. Signals `closeRequested()`, `runAgainRequested()`. Used by
`omarchy.speedtest` and `disk-speedtest`. Deliberately uses fixed white on-scrim colours.

Also exported: `PointerMoveGate` (filters synthetic hover when rows move under a still
pointer; `reset()`, `moved(item, mouse)`, `allowInitialSample()`) and `ScreenMoveRemap`
(remaps a layer surface when its monitor moves; fold `!guard.remapping` into `visible`).

---

## 3. Tokens: `Color`, `Style`, `Util`, `Border` (`Commons/`)

### 3.1 `Color` (`Commons/Color.qml`)
Foundational palette loaded from `~/.local/state/omarchy/current/theme/colors.toml`
(`loadColors`): `Color.foreground`, `Color.background`, `Color.accent`, `Color.urgent`
(from `red`/`color1`), `Color.muted` (from `muted`, else `color8`, else foreground). All
`property color`, live-updated on theme switch (theme IPC pushes new values).

Per-surface roles from `shell.toml` (fall back to the palette):
- `Color.bar.background`, `Color.bar.text`, `Color.bar.active` (bar's `urgent`)
- `Color.popups.background`, `Color.popups.text`, `Color.popups.border` — **use these
  for panel cards**
- `Color.tooltip.background/text/border`
- `Color.notifications.background/text/border/countdown`
- `Color.menu.background/text/border/scrim/selectedBackground/selectedText/selectedBorder`
- `Color.polkit.*`, `Color.lock.*`, `Color.imagePicker.*`

Helpers: `Color.shellValues` (flat `"section.key"` dict), `pick(key, fallback)`,
`pickAlpha(key, fallback)`, `flatColor(value, fallback)` (resolves role names
`foreground|text|accent|urgent|muted|background|transparent` or hex), `composed(colorKey,
alphaKey, colorFallback, alphaFallback)`.

There are no `dim`/`muted` variants per role. First-party convention for secondary text:
`Qt.darker(foreground, 1.4)` (section headers, hero meta, labels), `1.5` (descriptions,
inactive status), `1.55` (agents `dim`), `1.6` (placeholders, empty states), `2.0`
(disabled icons); or `Util.alpha(foreground, 0.55)` for secondary bars and `opacity:
0.6` on info labels (network `InfoLabel`).

### 3.2 `Style` (`Commons/Style.qml`)
- `Style.cornerRadius` (Hyprland `decoration:rounding`), `Style.gapsOut` (half of
  Hyprland `general:gaps_out`). Both refresh live.
- Spacing: `Style.space(px)` (int, scaled by `[spacing] scale` × font scale, min 1),
  `Style.spaceReal(px)`, `Style.spacing.scale`, and tokens `Style.spacing.hairline`(1),
  `xxs`(2), `xs`(3), `sm`(4), `md`(6), `lg`(8), `xl`(10), `xxl`(12), `xxxl`(14),
  `huge`(18), `controlGap`(8), `controlPaddingX`(10), `controlPaddingY`(6),
  `inputPaddingY`(7), `controlHeight`(28), `popupRowHeight`(28), `dropdownWidth`(240),
  `searchableDropdownWidth`(260), `numberFieldWidth`(120),
  `searchablePopupMinHeight`(220), `rowGap`(8), `rowPaddingX`(12), `labelGap`(4),
  `panelGap`(14), `panelPadding`(18), `popupPadding`(14). Numbers are the 12px-base
  defaults before scaling.
- Typography: `Style.fontFamily` / `Style.font.family` (`"monospace"` alias — bind
  `font.family` to it), `Style.font.resolvedFamily` (display only), `Style.font.menuFamily`,
  `Style.font.baseSize`, `Style.font.caption`(10), `bodySmall`(11), `body`(12),
  `subtitle`(13), `title`(14), `heading`(16), `display`(24), `displayLarge`(28),
  `iconSmall`(=bodySmall), `icon`(=title), `iconLarge`(18). `Style.fontScale`.
- Bar: `Style.bar.sizeHorizontal`(26), `sizeVertical`(28), `iconSlot`(27),
  `iconCanvas`(16), `iconFont`(13), `statusSlot`(21).
- State tokens (themeable via `[controls]` in shell.toml): `normalFillAlpha`(0.04),
  `hoverFillAlpha`(0.08), `selectedFillAlpha`(0.18), `pressedFillAlpha`(0.22),
  `focusFillAlpha`, `selectionFillAlpha`(0.35); `normalBorderAlpha`(0.4),
  `hoverBorderAlpha`(0.25), `selectedBorderAlpha`(1.0), `focusBorderAlpha`;
  `normalBorderWidth`(1), `hoverBorderWidth`, `selectedBorderWidth`(0), `focusBorderWidth`.
- State colour/fill/border functions, each `(foreground, accent, urgent)`:
  `normalStateColor`, `hoverStateColor`, `selectedStateColor`, `pressedStateColor`,
  `focusStateColor`, `selectionStateColor`; `normalFillFor`, `hoverFillFor`,
  `selectedFillFor`, `pressedFillFor`, `focusFillFor`, `selectionFillFor`;
  `normalBorderFor`, `hoverBorderFor`, `selectedBorderFor`, `focusBorderFor`.
- Composite helpers: `Style.controlFill(focused, hot, foreground, accent)`,
  `Style.controlBorder(focused, hot, foreground, accent)`,
  `Style.controlBorderWidth(focused, hot)`.
- Pre-resolved colours against the palette: `Style.normalFill`, `hoverFill`,
  `selectedFill`, `pressedFill`, `focusFillColor`, `normalBorderColor`,
  `hoverBorderColor`, `selectedBorderColor`, `focusBorderColor`, `selectedAccentFill`,
  `selectionFill`.
- Misc: `Style.colorFromHex(value, fallback)`, `Style.boolToken(value, fallback)`.

### 3.3 `Util` (`Commons/Util.qml`) — pure helpers
`clamp(value, min, max)`, `clampAlpha(v)`, `wheelSteps(accumulator, delta)` → `{ steps,
remainder }` (use for bar wheel handling), `alpha(color, opacity)` (colour or hex string
→ `Qt.rgba`), `fileUrl(path)`, `shellQuote(value)`, `execDetached(command)` (`bash -lc`),
`execArgv(argv)` (safe argv exec — prefer for anything built from data),
`isPlainObject(v)`, `canonicalWidgetId(id)`, `decodeBase64(v)`, `cloneJson(v)`,
`parseModuleJson(raw)` (Waybar-style `{text, class, tooltip}`), `editsFilter(event,
text)` / `editedFilter(event, text)` (Backspace / Ctrl+Backspace / Ctrl+U for search
filters), `normalizeLayoutEntry/Section/Layout`.

There is no number/byte formatter in `Util`; first-party panels keep those in their own
`Model.js` (`formatBytes`, `formatRate` in network; `formatTokenCount` in agents).

### 3.4 `Border` (`Commons/Border.qml`)
A spec is `{ color, widths: {top,right,bottom,left}, gradient }`. Factories:
`Border.none()`, `Border.flat(color, width)`, `Border.controlSpec(state, foreground,
accent, urgent)` with `state` ∈ `"normal" | "hover-cursor" (alias "hover"/"hot") |
"selected" | "focus"`, `Border.surfaceSpec(section, token, fallbackColor,
fallbackWidth, alphaKey)` (theme surface, e.g. `("popups","border",
Color.popups.border, 2)`), `Border.localOrSurfaceSpec(section, token, localColor,
defaultColor, fallbackWidth, alphaKey)` (per-instance override wins),
`Border.hyprlandActiveSpec(fallbackColor, fallbackWidth)`, `Border.withWidth(spec,
width)`. Accessors: `top/right/bottom/left/uniformWidth/color(spec)`, `isNone`,
`needsOverlay`, `canUseNative`, `controlHasWidth(state)`, `controlWidths(state)`.

---

## 4. Icon conventions

- Icons are **Nerd Font glyphs** (Material Design Icons range U+F0001–U+F1AF0) placed in
  a `Text` (or `OpticalGlyph`) whose `font.family` is bound to the bar font: in widgets
  `root.bar.fontFamily`, in shell-level panels `Style.font.family`. The family is the
  fontconfig `monospace` alias, which Omarchy points at a Nerd Font (default
  JetBrainsMono Nerd Font per `PanelSectionHeader` comment). Never hardcode a family.
- No icon theme / SVG icon lookups for glyphs. SVG assets are used only for brand marks
  (`plugins/agents/assets/<id>.svg`, with an `Image` fallback to the glyph).
- Sizes: bar button glyph `Style.bar.iconFont` inside a `Style.bar.iconSlot` slot
  (`BarIconButton` handles this); hero icon `Style.font.display`; row icon
  `Style.font.title` in a `Style.space(22)` wide, centred `Text`; action buttons
  `Style.font.icon`; hero action buttons `Style.font.subtitle * 1.5`.
- Glyphs used by the worked examples:
  - monitor: `󰍹` U+F0379 (single display), `󰍺` U+F037A (multiple, chosen by
    `Quickshell.screens.length > 1`), `󰄬` U+F012C (check / enabled)
  - network (`plugins/panels/network/Model.js`): Wi-Fi strength ladder
    `["󰤯","󰤟","󰤢","󰤥","󰤨"]` = U+F092F, U+F091F, U+F0922, U+F0925, U+F0928
    (`wifiIconFor(strength)` picks `ceil(strength/20)-1`), ethernet `󰈀` U+F0200,
    disconnected `󰤮` U+F092E, QR `󰐲` U+F0432, speed test `󰓅` U+F04C5, lock `󰌾`
    U+F033E, forget `󰅙` U+F0159
  - agents: `󱚣` U+F16A3; media: play `󰐊` U+F040A, pause `󰏤` U+F03E4, note `󰝚`
    U+F075A; DND `󰂛` U+F009B; kit internals: dropdown chevron `󰅀` U+F0140, refresh
    `󰑐` U+F0450, spinner `󰦖` U+F0996.
- `bar.foreground` vs `bar.barForeground`: the bar button uses `barForeground` (contrast
  colour on a transparent bar); panel content uses `bar.foreground`.
- Active/alarm state on a bar icon: set `active: true` on `BarIconButton` → paints
  `activeColor` (= `bar.urgent`).

---

## 5. Layout conventions of a native panel

Reference implementations: `plugins/panels/monitor/Panel.qml`,
`plugins/panels/network/Panel.qml`, `plugins/agents/Panel.qml`.

### 5.1 Skeleton
```
Panel (root; moduleName, ipcTarget, manageIpc:false + own IpcHandler)
├── implicitWidth/Height: button.implicitWidth/Height
├── BarIconButton { id: button; bar: root.bar; text: glyph; onPressed → toggle }
└── KeyboardPanel { anchorItem: button; owner: root; bar: root.bar; open: root.opened; focusTarget: keyCatcher
    contentWidth: fittedContentWidth(Style.space(380))
    contentHeight: fittedContentHeight(column.implicitHeight[, Style.space(560|640)])
    └── PanelKeyCatcher { id: keyCatcher; anchors.fill: parent; …signals… }
        └── ScrollView | Flickable | (plain Column)
            └── Column { id: column; width: …; spacing: Style.space(12) or Style.space(14)
                ├── hero (PanelHero, or Text icon @ display + Column of title/meta)
                ├── PanelSeparator
                ├── section Column { spacing: Style.space(6..10); PanelSectionHeader; rows… }
                ├── PanelSeparator … } }
```
- Panel width is `Style.space(380)` in monitor, network and agents. Card padding is
  `KeyboardPanel.padding` = `Style.spacing.popupPadding`; do not add outer margins.
- Section header row often pairs a `PanelSectionHeader` on the left with a
  caption-size, bold, `Qt.darker(fg,1.4)` value on the right (`anchors.rightMargin:
  Style.space(6)`), e.g. "BRIGHTNESS … 45%".
- Row height: content `implicitHeight + Style.spacing.xl` (monitor `MonitorRow`) or
  `+ Style.spacing.rowPaddingX` (network `NetworkRow`); horizontal inset
  `Style.space(6)`–`Style.space(10)`; inner spacing `Style.space(8)`–`Style.space(10)`.
- Body text `Style.font.body`, secondary `Style.font.caption`, values in tables
  `Style.font.bodySmall`; `elide: Text.ElideRight`; always `textFormat: Text.PlainText`
  on any text that carries external data (SSIDs, names).
- Key/value grids: `GridLayout { columns: 4; columnSpacing: Style.space(20); rowSpacing:
  Style.spacing.labelGap }` with label (`opacity: 0.6`) / value pairs (network).
- Pill rows: `Row { spacing: Style.space(6); readonly property real cellWidth: (width -
  spacing*(count-1))/count }` of `Button { bordered: true; active; selected; hasCursor;
  fontSize: Style.font.bodySmall }` (network DNS/band, monitor scale, agents provider
  switch). A `Grid { columns: n; spacing: Style.spacing.xs }` is used when cells wrap.
- Status/error callout: `BorderSurface { color: Util.alpha(urgent, 0.10); borderSpec:
  Border.flat(Util.alpha(urgent, 0.35), 1); radius: Style.cornerRadius }` with caption
  text inside (agents).

### 5.2 Bars, meters, gauges
- **Linear meter** (agents `Meter`, `DayRow`): two `Rectangle`s — track
  `color: Style.selectedFillFor(foreground, Color.accent)`, `radius: height/2`,
  `height: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))`;
  fill anchored left, `width: track.width * clamp(value,0,1)`, colour `foreground` (or
  `urgent` when alarming; `Util.alpha(foreground, 0.55)` for non-emphasised rows),
  `Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }`.
- **Row-background share bar** (agents `ModelRow`): a `Rectangle` at
  `Util.alpha(foreground, 0.05)` behind the row plus a left-anchored `Rectangle` at
  `Util.alpha(foreground, 0.14)` sized to the share, `radius: Style.cornerRadius`.
- **Adjustable value**: `PanelSlider` inside a `CursorSurface { outline: true; height:
  slider.implicitHeight + Style.spacing.controlGap }` (monitor brightness/text size).
  The monitor panel has no CPU/memory gauges; brightness is the slider, not a gauge.
- **Dials**: only `SpeedTestOverlay` draws arcs (QtQuick.Shapes). Panels don't.

### 5.3 Lists and scrolling
- Short/variable content: `Flickable { contentHeight: column.implicitHeight; clip: true;
  boundsBehavior: Flickable.StopAtBounds; flickableDirection: VerticalFlick;
  interactive: contentHeight > height; ScrollBar.vertical: ScrollBar { policy:
  ScrollBar.AsNeeded } }` (agents) or `ScrollView` with the same policy binding
  (monitor). The KeyboardPanel's `contentHeight: fittedContentHeight(column.implicitHeight,
  cap)` is what clamps the card to the screen and makes the Flickable scroll.
- Long dynamic lists inside a section: `ListView { height:
  Math.min(contentHeight, Style.space(240)); spacing: Style.space(4); clip: true;
  currentIndex: root.selectedIndex; onCurrentIndexChanged: positionViewAtIndex(currentIndex,
  ListView.Contain) }` with delegate wrapper `Item { required property var modelData;
  required property int index; width: ListView.view.width }` (network). Feed the
  ListView **primitive row objects** (`Model.wifiRow`) rather than live QObjects.
- Keep the keyboard cursor visible in a ScrollView with a helper like monitor's
  `ensureCursorVisible(item)` (maps the item into the flick's content and adjusts
  `contentY`).

### 5.4 Keyboard navigation — the `hasCursor` pattern
- State lives on the panel root: `property string focusSection`, `property int
  selectedIndex`, `property bool cursorActive` (false on open; first navigation key or
  hover sets it true so nothing is highlighted until the user moves).
- `PanelKeyCatcher.onMoveRequested(dx, dy)` moves between sections (dy) and within
  horizontal rows (dx); `onActivateRequested` acts on the current target; `onTextKey`
  maps single letters (`r` refresh, `w` toggle wifi…); `onTabRequested` →
  `root.switchPanel(direction)`; `onCloseRequested` → `root.close()`.
- Every target binds `hasCursor: root.cursorActive && root.focusSection === "x" &&
  root.selectedIndex === index` and on hover writes the same state back
  (`onHovered: function(h) { if (h) { root.cursorActive = true; root.focusSection = "x";
  root.selectedIndex = index } }` or a `HoverHandler`/`MouseArea.onContainsMouseChanged`).
  Visuals never read `containsMouse` directly (CursorSurface contract).
- Clamp the cursor whenever the model shrinks (`onDisplaysChanged: clampCursor()`).
- Inline editors: set `keyCatcher.blocked` while the TextField has focus and call
  `keyCatcher.forceActiveFocus()` when it closes (network `onPasswordSsidChanged`).

### 5.5 Tabs / chips (agents provider switch)
Agents renders one `Button` per provider in a `Row` (`spacing: Style.spacing.md`,
equal `cellWidth`), `selected: index === root.providerIndex`, `hasCursor:
root.cursorActive && index === root.providerIndex`, `bordered: true`, `fontSize:
Style.font.bodySmall`; `h`/`l` (dx in `onMoveRequested`) call
`selectProvider(providerIndex ± 1)`; the selection is keyed by id
(`selectedProviderId`) so a list reshuffle doesn't move it; `onProviderIndexChanged`
resets the Flickable's `contentY`. Middle-click on the bar icon cycles the same way. The
row is hidden when there is only one option. `ButtonGroup` is the kit's generic
equivalent for settings forms.

---

## 6. Notifications

The notifications plugin (`plugins/notifications/Service.qml`) is a freedesktop
**`NotificationServer`** (`Quickshell.Services.Notifications`); it has no public
`notify()` function. Notifications therefore enter over D-Bus. The recommended way for a
plugin to raise one is the bundled CLI, which calls
`org.freedesktop.Notifications.Notify` via `busctl` with Omarchy's hints:

```qml
Util.execArgv(["omarchy-notification-send", "-g", "󰤨", "--app-name", "acme.thing", "Headline", "Body text"])
// or, for a static command: bar.run("omarchy-notification-send \"$(omarchy-weather-status)\"")
```

Flags (`/usr/share/omarchy/bin/omarchy-notification-send`): `-g <glyph>` (Nerd Font
glyph rendered on the toast via the `omarchy-glyph` hint), `-u low|normal|critical`,
`-i <icon>`, `--image <path>`, `-t <ms>`, `-r <id>` / `-p` (replace / print id),
`--app-name`, and `--exec <program> [args...]` (click action stored as
`omarchy-exec-argv` JSON, executed via `Util.execArgv`). Behaviour notes from
`NotificationLogic.js`: app name `omarchy-action` (the CLI default) and `notify-send`
are *ephemeral* (never written to history) and `omarchy-action` bypasses Do Not
Disturb; `notify-send` bypasses DND only at critical urgency. Pass `--app-name <your
id>` if you want the notification to land in history and respect DND. First-party code
also shells out this way (`weather/BarWidget.qml`, `reminders/ReminderFlow.qml`,
battery → `omarchy-battery-low`).

To read/toggle DND from a widget: `bar.shell.firstPartyServiceFor("omarchy.notifications")`
exposes `doNotDisturb` (readonly), `setDoNotDisturb(value)`, `popupModel`,
`historyLimit`; IPC target `notifications` offers `toggleDnd`, `setDnd`, `showHistory`,
`dismissAll`, `dismissOne`, `invokeLast`, `dismiss(summary)`.

For transient in-shell feedback (volume-style), summon the OSD instead:
`bar.shell.summon("omarchy.osd", JSON.stringify({ icon: "brightness", value: 40 }))`
(payload keys: `icon`, `message`, `value`, `max`, `progressText`, `duration`).

---

## 7. Processes, files, and HTTP

- **Subprocesses**: `Quickshell.Io` `Process { id: p; command: [argv…]; stdout:
  StdioCollector { waitForEnd: true; onStreamFinished: root.parse(text) }; onExited:
  function(exitCode, exitStatus) {…} }`, started with `p.running = true` (guard with `if
  (!p.running)`), stopped with `p.running = false`. Streaming output uses `stdout:
  SplitParser { onRead: function(line) {…} }` (`PluginRegistry.localPluginWatcher`).
  Secrets go over stdin: `stdinEnabled: true; onStarted: { write(secret + "\n") }`
  (network enterprise connect) — never in argv.
- **Polling**: `Timer { interval: …; running: root.opened; repeat: true; onTriggered:
  refresh() }` for panel-only data (monitor 5 s, network 1.5 s / 4 s), and a settings-
  driven `refreshIntervalSec` timer with `triggeredOnStart: true` for background data
  (agents, tailscale). Refresh on `Component.onCompleted` and `onOpenedChanged`.
- **Fire-and-forget**: `bar.run("cmd")` / `Util.execDetached` for trusted literal
  strings; `Util.execArgv([...])` for anything containing data;
  `Quickshell.execDetached(["bash","-c", "printf %s " + Util.shellQuote(v) + " | wl-copy"])`
  for the clipboard (network `copyToClipboard`).
- **Files**: `FileView { path; watchChanges: true; printErrors: false; onFileChanged:
  reload(); onLoaded: parse(text()); onLoadFailed: … }` for JSON state written by
  helpers (`agents/Agent.qml` watches `~/.local/state/omarchy/agents/usage/<id>.json`;
  weather watches `~/.local/state/omarchy/settings/weather.json`). Writes use
  `FileView { atomicWrites: true }` + `setText(JSON.stringify(obj, null, 2))`
  (agents sync snapshot). `PersistentProperties { reloadableId }` survives in-process
  reloads (notifications).
- **HTTP**: there is no `XMLHttpRequest` use anywhere in the tree. The weather panel
  fetches with curl through `Process`:
  `command: ["curl", "-fsS", "--max-time", "10", "https://wttr.in/" + query + "?format=j1"]`
  and `["curl","-fsS","--max-time","5", openMeteoUrl]`, parses `JSON.parse(text)` in
  `onStreamFinished`, keeps the last good result on failure, and retries up to 3× with a
  2.5 s `Timer`. `MultiSelect.optionsCommand` follows the same pattern with a 6 s timeout
  and a monotonic sequence number to drop stale output — copy that when requests can
  overlap.
- **System services**: prefer the Quickshell native services when they exist
  (`Quickshell.Networking`, `Quickshell.Services.UPower`, `Mpris`, `Pipewire`,
  `Notifications`) over shelling out; the network panel mixes both.

---

## 8. Do / don't for looking native

**Do**
- Extend `BarWidget` or `Panel`; put the bar button in a `BarIconButton { bar: root.bar }`
  and the popup in a `KeyboardPanel { anchorItem: button; owner: root; bar: root.bar;
  open: root.opened; focusTarget: keyCatcher }`; size the root to the button.
- Expose `open()`, `close()`, `property bool opened` on the widget root (Panel does) so
  `omarchy-shell shell summon/toggle <id>` and `togglePanelAt` reach you.
- Bind every `font.family` to `root.bar.fontFamily` (widgets) or `Style.font.family`
  (panels/overlays); size text with `Style.font.*` only.
- Take colours from `bar.foreground` / `bar.barForeground` / `bar.urgent` and
  `Color.popups.*`, `Color.accent`; derive secondary tones with `Qt.darker(fg, 1.4)` or
  `Util.alpha(fg, a)`; build fills/borders with `Style.*FillFor` / `Border.controlSpec`.
- Use `Style.space(px)` and `Style.spacing.*` for every margin, gap and height;
  `Style.cornerRadius` for every radius (`height/2` only for pills/meters/knobs).
- Draw surfaces with `BorderSurface`/`CursorSurface`, actions with `Button`,
  `PanelActionButton`, `ToggleSwitch`; headers with `PanelSectionHeader` +
  `PanelSeparator`; tooltips with `PanelToolTip`.
- Implement the single-cursor model (`cursorActive`, `focusSection`, `selectedIndex`,
  `hasCursor`) and wire `PanelKeyCatcher` so j/k/h/l, Enter, Esc, Tab all work.
- Gate pollers on `root.opened`; release hardware/scanners in `Component.onDestruction`.
- Keep parsing/formatting in a sibling `Model.js` (`import "Model.js" as Model`) with a
  `module.exports` block so it is unit-testable in Node, as every first-party panel does.
- Read settings with `setting(key, fallback)`; persist with
  `bar.shell.updateEntryInline(moduleName, entry)`; declare `defaults`/`schema` in the
  manifest for the settings UI.
- Use `textFormat: Text.PlainText` and `elide` on any text carrying external strings.

**Don't**
- Don't hardcode hex colours, font families, pixel sizes or radii (the only exceptions in
  the tree are fixed white-on-scrim overlays and debug outlines).
- Don't create your own `PanelWindow`/`FloatingWindow` for a bar popup — `KeyboardPanel`
  already solves focus priming, multi-monitor dismissal, bar click-through, popout
  coordination and fade. Use a custom `PanelWindow` only for a full-screen `panel`/
  `overlay` kind (OSD, wifiqr, speedtest style), and then set
  `WlrLayershell.namespace`, `layer: WlrLayer.Overlay`, `exclusionMode: ExclusionMode.Ignore`.
- Don't colour rows from `containsMouse`; hover must update the panel cursor state.
- Don't use `MouseArea` hover on a `Button`/`Toggle` to track cursor — use their
  `hovered(bool)` signal.
- Don't put live QObjects into ListView models; snapshot to plain objects.
- Don't rely on manifest `defaults` being present in `settings`; they are not merged.
- Don't build shell strings from user data for `bar.run`; use `Util.execArgv`.
- Don't register an `IpcHandler` from a bar widget and assume it fires on every monitor;
  relay with `broadcast()` or route through `shell summon`.
- Don't expect a payload when a bar-widget-only plugin is summoned; it is discarded.
- Don't use `omarchy.*` as your plugin id, or absolute/`..` entry-point paths — the
  registry rejects the manifest.
- Don't use `XMLHttpRequest` or Qt network types for HTTP; follow the curl-in-`Process`
  pattern so timeouts and retries match the rest of the shell.
- Don't `import` shell singletons by relative path; use `qs.Commons` (relative imports
  create private copies, per `shell.qml` and `BarWidgetRegistry.qml` comments).
