# Omarify Phase 1 — "see" (read-only bar icon + panel)

Repo `/home/danjones/Projects/omarify`, branch `master`, 0 commits. Dan merges. Build with `/deej-stack:d-implement`.

## Context

Omarify is a Quickshell plugin for the Omarchy shell that shows Coolify state in the bar. The repo holds only docs (`AGENTS.md`, `docs/*.md`, `README.md`, `LICENSE`, `.gitignore`); every shipping file is unwritten. `docs/roadmap.md:13-38` defines Phase 1: config loading, a curl-over-stdin client, polling, a bar icon, a read-only panel, node tests, and dev scripts.

The planning panel found that the docs, taken literally, would ship a plugin that fails its own acceptance list: the documented polling schedule exceeds both request budgets (21.2/min idle, 70.6/min with one deployment against `docs/roadmap.md:33`'s < 20 and < 60), `curl -K -` blocks until stdin EOF and the documented client never closes stdin, the curl config text is injectable from API-supplied strings, the documented `qmllint` line resolves nothing and exits 0, and several panel fields have no data source in the scheduled endpoints. A second pass found that curl's per-transfer options (write-out, timeouts, size cap, protocol allowlist) reset at every `--next`, so a batched request must carry them inside every config block. This plan fixes each with evidence and reconciles the docs so they stay the spec.

**Outcome.** After `bin/dev-sync` and `omarchy plugin enable io.github.danjonesio.omarify right`, a cloud icon sits in the bar on every monitor. Within 10 s it reflects Dan's Coolify Cloud account: dimmed cloud-outline when unconfigured, dimmed alert-cloud when the token is rejected, urgent progress-clock while something deploys, urgent close-circle after a failure until a panel is opened. Clicking opens a native panel: hero (instance name, version, counts), DEPLOYMENTS, SERVERS, RESOURCES grouped by project or by server, refresh, keyboard cursor, footer hints. Nothing acts on Coolify and nothing notifies. `bin/check` is green and each of its gates has been seen to fail.

## Brief

**Ask (user's words):** "phase 1, opus 5 sub agents."

**Assumptions (stated, not asked):**
- Phase 1 renders `instances[0]` only. The config parser accepts the full `instances[]` array; chips and cycling are Phase 4.
- Deployment rows are read-only. The action row and keys `d D s t x v o` are Phase 2 and are not rendered. Enter on a leaf row does nothing (open-in-browser is the Phase 2 `o` action).
- Finished deployments tracked after they vanish from `GET /deployments` are kept in memory only (store cap 20, render cap 5); `recent.json` is Phase 3.
- `docs/design.md` is the end-state spec. Elements that ship in a later phase stay in it with a "(Phase N)" marker. Elements dropped from the product (the bar count caption) are removed from it.

**Out of scope:** actions (Phase 2), notifications and `recent.json` (Phase 3), logs, history, chips, tag deploy (Phase 4), SSH/Sentinel, overlay, marketplace (Phase 5). Dropped from the product: the bar count caption (no badge slot on `BarIconButton`; a hand-rolled row loses click registration). Deferred out of Phase 1: server proxy status and `unreachable_count` (`GET /servers/{uuid}` per server), which no acceptance line needs.

## Findings from exploration

Runtime (verified by the panel against `/usr/share/omarchy/shell`, Quickshell 0.3.1 qmltypes and the `quickshell` binary):

- `shell.qml:302-307` injects only `omarchyPath, shell, manifest, barWidgetRegistry, pluginRegistry` into a service. No `settings`, no `bar`. Poll intervals come from `~/.config/omarify/config.json`. `setting()` exists only on `Ui/BarWidget.qml:41` and `Ui/Panel.qml:39`.
- `shell.qml:275` `serviceFor(pluginId)` returns the service to any caller with no check. `shell.qml:337-343` destroys the service and reassigns `_services` on disable or reload, so `serviceFor` can return null while a bar widget on another monitor is alive. `Component.onDestruction` must stop timers and processes.
- `Quickshell.Io.Process` exposes `write(QString)`, `signal(int)`, `stdinEnabled`, `environment`, and no `closeStdin()` (`/usr/lib/qt6/qml/Quickshell/Io/quickshell-io.qmltypes:95-183`). **Disassembly of `/usr/bin/quickshell` shows the `stdinEnabled` property setter calls `QProcess::closeWriteChannel()` when set to false on a live process**, and `startProcessIfReady` re-honours the flag on the next start. So `write(cfg); stdinEnabled = false` delivers EOF. `curl -K -` does block until EOF (measured: exit 124 under `timeout 2`).
- `StdioCollector` and `Process` have no `parent` property (they are not `Item`s). `parent.x` inside them resolves to the service root's parent. Every first-party handler writes to an `id` (`plugins/panels/dropbox/Service.qml:220-232` reads `statusStdout.text` in `onExited`).
- `Quickshell.Io.FileView` has no mode/owner property; the 0600 check needs `stat`. `plugins/bar/Bar.qml:936-968`: FileView cannot watch a file that does not exist yet, so watch the parent directory; the directory watch can go silent, so keep an IPC nudge; "start rather than restart" a probe `Process` (assigning `running = true` to a running process is a no-op).
- `Ui/KeyboardPanel.qml:40-41` requires `anchorItem` and `bar`; input property is `open`; `fittedContentHeight(h, cap)` at `:168-173` clamps a *given* height, it does not measure children. omasnitch passes a literal (`Panel.qml:113`) and anchors header/list/footer without a `Column`.
- `Ui/PanelKeyCatcher.qml`: `x`/`X` emit `deleteRequested` (`:78-80`) before `textKey`; Esc emits `closeRequested` (`:51-53`); `h/l` arrive as `moveRequested(±1,0)`; Return fires `returnRequested` then `activateRequested`, Space only the latter (`:71-77`); `textKey` is not accepted.
- `Ui/PanelHero.qml:28-34, 105-110`: icon and trailing loaders do not size children; `meta` is uppercased at `:94`; `iconOpacity` at `:14`. `Ui/PanelSectionHeader.qml:29` adds `topPadding` for glyph overshoot; `plugins/panels/network/Panel.qml:1285-1322` shows how to pair a control with it (`verticalCenterOffset: topPadding/2`, `Math.max` height).
- `Ui/BarIconButton.qml:17-21`: `labelVisible: false`, `fixedWidth: slotSize`. `Ui/WidgetButton.qml:44-55` registers in `bar.clickTargets`, used by `Ui/KeyboardPanel.qml:302-322` to swap panels on a bar click; `foreground: bar.barForeground`, `activeColor: bar.urgent` (`:11-12`).
- `Ui/Button.qml:44,172-178` `iconSpinning`; `:29` `hasCursor`; `:63` `hovered(bool)`. `Ui/ButtonGroup.qml:26-27,45` `options/value/changed`; `:33,50` `focusable` defaults true. `Ui/PanelSeparator.qml:17` draws the rule. `Ui/CursorSurface.qml:4-13` never colours from `containsMouse`.
- `Ui/MultiSelect.qml:216-252`: `seq`/`liveSeq` stale-output guard. `plugins/panels/tailscale/Service.qml:414-435`: arm the watchdog on launch, never restart it per refresh (mechanism there is one-shot; only the arming rule is reused). `plugins/panels/dropbox/Service.qml:90-93, 160-198`: `elideStatus` (140 chars + `…`), `startupRamp`, `delayedRefresh`. `plugins/panels/dropbox/Model.js:99-113`: `relativeTime`.
- `plugins/bar/Bar.qml:68-72`: `bar.foreground` vs `bar.barForeground`; `bar.urgent = Color.bar.active`, the only non-foreground bar colour. `bar.fontFamily` defaults to `Style.font.family` (`:62`). omasnitch declares root colour/font properties once (`Panel.qml:26-28`) and wires its hero trailing control's `hasCursor`/`onHovered` (`:165-169`).
- `Commons/Style.qml:240,256`: `spacing.xl = 10` (card padding), `spacing.rowPaddingX = 12` (row height addend; `tailscale/Panel.qml:890` and 8 others). `Commons/Util.qml:44` `fileUrl` percent-encodes per segment; `:33` `alpha`; `:62` `execArgv`. `Commons/Border.qml:16` `Border.flat`. `Commons/Color.qml:242-253`: `onFileChanged: reload()`, `text()` is stale inside the change signal.
- `omarchy-plugin-validate:111-116`: any symlink anywhere under the validated dir fails it; extra files ignored; bash + jq only. `PluginRegistry.qml:304` returns `not ready` during a scan; `:636-651` inotify-watches the plugins dir so a new dir is picked up without `rescanPlugins`. `shell.qml:739-773` `rescanPlugins` unloads and reloads every plugin. `PluginRegistry.setEnabled` disable path splices the bar layout entry (placement lost). `omarchy-refresh-shell` resets `shell.json`. `omarchy-plugin-remove:87-116` moves a non-git dir to `.<id>.bak.<ts>`.
- `omarchy-plugin-add:120` clones a git checkout into the plugin dir.
- qmllint 6.11.2: `-I /usr/share/omarchy/shell` cannot resolve `qs.Ui` (the qmldir sits under `Ui/`, not `qs/Ui/`); exit 0 regardless. With an import root containing `qs -> /usr/share/omarchy/shell` it resolves; `-W 0` then fails on ~100 `[unqualified]` warnings from delegate/Component scopes that omasnitch's structure (and this plan's) produce, so `-W 0` can never be green. `--missing-property disable` is a valid flag.
- bash: under `set -e`, `! cmd` never aborts, and a non-final command in an `&&` list never aborts. `grep -c` counts lines; `grep -o | wc -l` counts occurrences. GNU `timeout 10 -- cmd` exits 127 (`--` must precede the duration); `timeout -k 2 30 cmd` works. `mkdir -p` creates 0755. jq 1.8.2 has `walk`.
- curl 8.21.0: global options are only `--fail-early --libcurl --parallel* --progress-bar --rate --show-error --stderr --styled-output --trace* --verbose`; everything else (`-w`, `-s`, `--max-time`, `--connect-timeout`, `--max-filesize`, `--proto`, headers) resets at each `next` and must be repeated per config block. `-w` in argv after `-K -` emits one trailer for the whole batch. A `write-out = "…"` line per block emits one trailer per transfer, including failed ones; `%{exitcode}` and `%{errormsg}` are available per transfer. `%{header_json}` is multi-line and includes `set-cookie`. Raw 0x1E/0x1F bytes inside a quoted config value survive verbatim (`\x1e` is not a config escape). Config double-quote escapes are `\\ \" \t \n \r \v`. `-q` must be argv[1] to skip `~/.curlrc`. `--expand-header` and `--variable` exist (undocumented in `--help all`).
- `nmcli` exists, so `nmcli networking off` would drop the machine's SSH and browser sessions; curl exit 7 is reachable with `url: https://127.0.0.1:9`.
- Fonts: `◐` U+25D0 is absent from JetBrainsMono Nerd Font (falls back to Liberation Sans). `U+F015F` `md-cloud` (filled), `U+F0163` `md-cloud_outline`, `U+F0164` `md-cloud_off_outline`, `U+F09E0` `md-cloud_alert`, `U+F0159` `md-close_circle`, `U+F0996` `md-progress_clock`, `U+F1396` `md-circle_half_full`, `U+F0765/F0766/F09DF` circles; all present at advance 600.
- Machine: 3 monitors, node v26.8.1 via mise (not on a non-interactive PATH), jq/inotifywait/rsync/flock at `/usr/bin`, Omarchy `4.0.0.alpha`, `~/.config/omarchy/shell.toml` exists with Dan's `[font] base-size = 11`. `~/.config/omarify/` and the plugin dir do not exist. `/run/user/1000/op-daemon.sock` exists (1Password).

Coolify API (`docs/coolify-api.md` cross-checked with `docs/reference/coolify-openapi-v4.3.17.yaml`):

- `GET /version` returns `text/html` with a bare `4.3.17` (sometimes `v`-prefixed). Not JSON.
- `GET /deployments` items key on `deployment_uuid`. Same schema as `GET /deployments/{uuid}` (openapi `:6054-6077`), so polling by uuid while active buys nothing. `logs` rides along when the token has `read:sensitive`; `configuration_snapshot`/`configuration_diff` always.
- `GET /projects` returns `{id, uuid, name, description}` (openapi `:14276`); environments come from `GET /projects/{uuid}`, whose `Environment.id` is the integer `/resources` items carry as `environment_id`. `GET /projects/{uuid}/{env}` omits keydb/dragonfly/clickhouse and is not needed.
- `GET /servers` list: `name, uuid, ip, user, port, description, is_reachable, is_usable, settings{}`. Apps carry `destination_id`, not a server uuid; `GET /servers/{uuid}/resources` gives `{uuid, name, type, status}` per resource.
- 403 API-disabled body is `{"success": true, "message": "API is disabled."}`. Never read `success`.
- Measured: 78 ms round trip to `app.coolify.io` (29 ms TLS); curl spawn 5.9 ms; `/resources` for 60 resources ≈ 163 KB, parses < 1 ms. Cloud's 401 carries no `X-RateLimit-*`; presence on authenticated responses is unverified.

## Design

### Caller's usage first

```qml
// BarWidget.qml — one per monitor, renders only
readonly property var svc: bar && bar.shell && typeof bar.shell.serviceFor === "function"
                           ? bar.shell.serviceFor(root.moduleName) : null
BarIconButton {
  bar: root.bar
  text: svc ? svc.bar.glyph : "󰅜"
  keepSpace: true
  dimmed: svc ? svc.bar.dimmed : true
  active: svc ? svc.bar.active : false
  tooltipText: svc ? svc.bar.tooltip : "Omarify — starting"
  onPressed: function(b) { if (b === Qt.LeftButton) root.toggle() }
}
```

```qml
// Panel.qml — reads the snapshot; flattens rows only while open; registers itself by id
readonly property string panelId: String(Date.now()) + "-" + Math.random().toString(36).slice(2)
readonly property var rows: root.opened && svc
  ? Model.panelRows(svc.snapshot, { groupBy: root.groupBy, folded: root.folded }) : []
onOpenedChanged: { if (!svc) return; if (opened) svc.panelOpened(panelId); else svc.panelClosed(panelId) }
Component.onDestruction: if (svc) svc.panelClosed(panelId)
Timer { interval: 1000; repeat: true; running: root.opened
        onTriggered: { root.nowMs = Date.now(); if (svc) svc.panelAlive(panelId) } }
```

```qml
// Service.qml — the only thing that talks to Coolify
readonly property var snapshot   // plain object, see Data shapes
readonly property var bar        // { glyph, dimmed, active, tooltip } from Model.barState
function refresh()
```

```sh
omarchy-shell io.github.danjonesio.omarify refresh
omarchy-shell io.github.danjonesio.omarify status | jq '{requestsLastMin, openPanels, error}'
```

### Data shapes

`~/.config/omarify/config.json` (0600 in a 0700 directory). `Model.normaliseConfig(json) -> {ok, error, instances[], poll{}}`:

```json
{ "version": 1,
  "instances": [ { "id": "cloud", "name": "Coolify Cloud", "url": "https://app.coolify.io",
                   "token": "67|…", "tokenCommand": ["op","read","op://Private/Coolify/credential"] } ],
  "poll": { "deploymentsSec": 4, "resourcesSec": 60, "serversSec": 120, "topologySec": 600 } }
```
`tokenCommand` must be an array of strings whose first element does not start with `-`; anything else is a config error. `tokenCommand` wins over `token`. `url` must start with `http://` or `https://`; `http://` sets the `plaintext` warning. Every `poll` key has the default above; values below 2 clamp to 2; `topologySec` is additionally raised at runtime so the topology fan-out costs at most 3 req/min (see Scheduler).

`Service.snapshot` (plain JS, rebuilt on each store write, never a QObject):

```js
{
  instance:    { id, name, url, version, plaintext },
  error:       null | { kind, title, detail, httpCode, curlExit, at, staleSince },
  warning:     null | { kind, title, detail },          // permissions | plaintext, non-fatal
  servers:     [ { uuid, name, ip, reachable, usable, disabled, buildServer, resourceCount } ],
  resources:   [ { uuid, name, kind, type, status, state, health, fqdn, environmentId,
                   serverUuid, projectUuid, projectName, environmentName, gitBranch } ],
  deployments: [ { uuid, appUuid, appName, branch, status, commit, commitMessage,
                   createdAt, updatedAt, url, restartOnly, force, isApi, isWebhook } ],
  recent:      [ /* same shape, terminal only, newest first, cap 20 */ ],
  tree:        [ { projectUuid, projectName, environments: [ { id, name, resourceUuids: [] } ] } ],
  byServer:    { "<serverUuid>": [ "<resourceUuid>" ] },
  failedUnacked: [ "<deploymentUuid>" ],
  lastPollAt:  { deployments, resources, servers, topology },   // ms epoch or 0
  busy: bool, openPanels: int, baselineDone: bool
}
```

`error.kind` ∈ `noconfig | configerror | unsafe | tokencmd | waitingtoken | auth | apidisabled | ipblocked | ability | ratelimited | offline | toolarge | http`. `title` is the hero meta; `detail` is the callout body, passed through `Model.elide(text, 140)`.

Panel row model, one flat array for one `ListView`. No time strings in rows: the deployment delegate computes `elapsed`/`age` from `createdAt`/`updatedAt` and the panel's `nowMs`; no other delegate reads `nowMs`.

```js
{ type: "section",    key, title, control }         // control: null | "groupBy"
{ type: "separator",  key }
{ type: "note",       key, text }
{ type: "fold",       key, title, open, count, indent }
{ type: "deployment", key, uuid, glyph, tone, name, sub, createdAt, updatedAt, terminal }
{ type: "server",     key, uuid, dot, tone, name, sub, dim }
{ type: "resource",   key, uuid, dot, tone, name, statusWords, kindHint, dim, indent }
```
`tone` ∈ `"fg" | "dim" | "urgent" | "accent"`, resolved to a colour in QML only. `key` is uuid-derived and stable. `sameRows` compares keys plus a per-row `rev` of `type, glyph|dot, tone, name, sub|statusWords, open, count, dim`; `updatedAt` and `createdAt` are excluded so an in-progress deployment's ticking `updated_at` does not churn delegates.

Bar state (`Model.barState(snapshot) -> {glyph, dimmed, active, tooltip}`), first match wins:

| # | state | selector | glyph | dimmed | active | tooltip |
|---|---|---|---|---|---|---|
| 1 | not configured | `error.kind === "noconfig"` | `󰅜` F0163 | yes | no | `Omarify — no config at ~/.config/omarify/config.json` |
| 2 | config error / unsafe | `configerror`, `unsafe` | `󰦠` F09E0 | yes | no | `Omarify — config error: <first line>` / `Omarify — config is writable by others` |
| 3 | token unavailable | `tokencmd` | `󰦠` | yes | no | `Omarify — token command failed (exit N)` |
| 4 | waiting for token | `waitingtoken` | `󰅟` F015F | yes | no | `Omarify — waiting for token command` |
| 5 | token rejected | `auth` | `󰦠` | yes | no | `Omarify — token rejected` |
| 6 | API disabled / IP blocked | `apidisabled`, `ipblocked` | `󰦠` | yes | no | `Omarify — API disabled on this instance` / `Omarify — this IP is not allowed` |
| 7 | offline | `offline` | `󰅤` F0164 | yes | no | `Omarify — offline, retrying` |
| 8 | rate limited | `ratelimited` | `󰅟` | yes | no | `Omarify — rate limited, backing off Ns` |
| 9 | starting | `!baselineDone && !error` | `󰅟` | yes | no | `Omarify — starting` |
| 10 | failed, unacknowledged | `failedUnacked.length > 0` | `󰅙` F0159 | no | **yes** | `Deployment failed: <app>` (+ ` +N more`) |
| 11 | server unreachable | any `!reachable && !disabled` | `󰅤` | no | **yes** | `<server> unreachable` (+ ` +N more`) |
| 12 | deploying | any deployment `queued`/`in_progress` | `󰦖` F0996 | no | **yes** | `Deploying <app>` / `N deployments running` |
| 13 | partial | `error` of kind `http`/`toolarge` with data present | `󰅟` | no | no | `<name> — N servers · M resources (<kind> unavailable)` |
| 14 | idle | else | `󰅟` | no | no | `<name> — N servers · M resources` / `<name> — no resources` |

Hero `meta` (mixed case; the component uppercases): healthy → `3 servers · 14 resources · 1 deploying` (drop zero clauses); empty account → `No resources on this team`; starting → `Loading`; `noconfig` → `Not configured`; `configerror` → `Config error`; `unsafe` → `Config unsafe`; `tokencmd` → `Token unavailable`; `waitingtoken` → `Waiting for token`; `auth` → `Token rejected`; `apidisabled` → `API disabled`; `ipblocked` → `IP not allowed`; `offline` → `Offline · retrying`; `ratelimited` → `Rate limited`; `toolarge` → `Response too large`; `http` → `Coolify error`; partial → `<kind> unavailable · showing last known`. Precedence: config > token > auth > network > partial > loading > healthy. Warnings never touch `meta`.

Callout copy (`Model.callout(snapshot) -> null | { title, body }`; null when healthy and no warning; the staleness suffix `Showing data from <age>.` is appended whenever `error.staleSince` is set):

| kind | body |
|---|---|
| `noconfig` | `Create ~/.config/omarify/config.json (chmod 600):` + the three-line sample from `docs/design.md:173` |
| `configerror` | the parse or validation error, plain text |
| `unsafe` | `Anyone on this machine can rewrite it. Run: chmod 600 ~/.config/omarify/config.json` |
| `permissions` (warning) | `Anyone on this machine can read your token. Run: chmod 600 ~/.config/omarify/config.json` |
| `plaintext` (warning) | `This instance is http://, so the token crosses the network in the clear.` |
| `tokencmd` | `The token command exited <n>. Its output is never logged; run it yourself to see why.` |
| `waitingtoken` | `Running the token command…` |
| `auth` | `Create a token in Coolify → Security → API Tokens with the read ability.` |
| `apidisabled` | `Enable it in Settings → Advanced → API Access.` |
| `ipblocked` | `Add this machine's IP to the token's allowed list in Coolify → Security → API Tokens.` |
| `ability` | `The token is missing the <ability> ability.` |
| `ratelimited` | `Backing off <n>s.` |
| `offline` | `Retrying.` |
| `toolarge` | `Coolify's response exceeded 8 MB and was dropped.` |
| `http` | the redacted, elided Coolify `message`, else `Coolify returned <code>.` |
| partial | `<kind> is unavailable.` |

Empty-section notes: `Nothing deploying.` / `No servers on this team.` / `No resources on this team.`

### Module map

| path | status | owns |
|---|---|---|
| `manifest.json` | new, ships | `service` + `bar-widget`, `keepLoaded: true`, `barWidget.defaultSection: "right"` |
| `Service.qml` | new, ships | config load/watch/stat, token resolution, curl client, scheduler, store, panel registry, IPC. One per shell. |
| `BarWidget.qml` | new, ships | `Ui/BarWidget` + `BarIconButton` + `Loader` on `Panel.qml`. One per monitor. Renders only. |
| `Panel.qml` | new, ships | `Ui/Panel` + `KeyboardPanel` + `PanelKeyCatcher` + hero + callout + one `ListView` + footer. |
| `Model.js` | new, ships | `.pragma library`, pure: config, transport splitting, normalise, join, diff, error mapping, redact/elide, bar state, hero and callout copy, rows, formatting. |
| `Api.js` | new, ships | `.pragma library`, pure, self-contained (no `.import`): curl argv, per-block config text, request descriptors, quoting, path encoding. |
| `tests/run.js` | new, repo | node `vm` runner, two contexts, fixtures. |
| `tests/fixtures/*` | new, repo | recorded with a read-only token, scrubbed by replacement. |
| `bin/check`, `bin/dev-sync`, `bin/dev-watch`, `bin/record-fixture` | new, repo | see Changes 1 and 5. |
| `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/design.md`, `docs/roadmap.md`, `docs/product.md`, `docs/omarchy-shell-reference.md` | exist, edit | reconciled in Change 4. |

### Interfaces

`Api.js`:

```js
var RS = "", US = ""                     // literal bytes, embedded not escaped
var TRAILER = "\n" + RS + "%{exitcode} %{http_code} %{time_total} %{size_download} %{errormsg}\n%{header_json}\n" + US
function quote(v)                  // \\ \" \n \r \t \v per man curl -K; used for EVERY emitted value
function seg(v)                    // encodeURIComponent for one path segment
function base(instance)            // instance.url without trailing "/" + "/api/v1"
function argv()                    // ["curl","-q","-S","-K","-"]   -q first; nothing else in argv
function block(instance, token, req, maxTimeSec)
//   url = "…"\nsilent\nconnect-timeout = "5"\nmax-time = "<maxTimeSec>"\nmax-filesize = "8388608"\n
//   proto = "=https,http"\nheader = "Authorization: Bearer …"\nheader = "Accept: application/json"\n
//   write-out = "<quote(TRAILER)>"\n
function config(instance, token, reqs, maxTimeSec)   // blocks joined with "next\n"; every block is complete
// descriptors — data only, no secrets
function reqVersion()              // { kind:"version", path:"/version", json:false }
function reqDeployments()          // { kind:"deployments", path:"/deployments" }
function reqDeployment(uuid)       // { kind:"deployment", path:"/deployments/"+seg(uuid), arg:uuid }
function reqResources()            // { kind:"resources", path:"/resources" }
function reqServers()              // { kind:"servers", path:"/servers" }
function reqProjects()             // { kind:"projects", path:"/projects" }
function reqProject(uuid)          // { kind:"project", path:"/projects/"+seg(uuid), arg:uuid }
function reqServerResources(uuid)  // { kind:"serverResources", path:"/servers/"+seg(uuid)+"/resources", arg:uuid }
```

`Model.js`:

```js
// config
normaliseConfig(json)                 -> { ok, error, instances, poll }
configUnsafe(modeStr, owner, me)      -> bool            // group/other write bit, or owner !== me
configLoose(modeStr)                  -> bool            // group/other read bit
// transport
splitResponses(text)                  -> [ { body, exit, code, timeMs, bytes, errmsg, headers } ]
//   scan for RS; the text after it must match /^(\d+) (\d{3}) ([\d.]+) (\d+) ([^\n]*)\n([\s\S]*?)\n?US/,
//   else that RS is body text; body[i] is the text between the previous US (or start) and RS[i];
//   headers is WHITELISTED: { retryAfter: int|null, rateLimitRemaining: int|null, rateLimitLimit: int|null };
//   the raw header blob is discarded here and never leaves this function
parseJson(text)                       -> { ok, value }
errorFor({ httpCode, curlExit, body, headers }) -> error | null
retryAfterSec(headers, attempt)       -> int             // bare integer clamped to [1, 300]; else 30, 60, 60…
redact(text)                          -> text            // \d+\|[A-Za-z0-9]{10,} → «token»; Bearer\s+\S+ → Bearer «token»;
                                                         // ://user:pw@ → ://«creds»@; set-cookie[^\n]* → «cookie»
elide(text, max)                      -> text            // collapse whitespace, cut at max with …  (dropbox/Service.qml:90-93)
// normalise
parseVersion(text)                    -> "4.3.17"
parseStatus(s)                        -> { state, health, raw }   // prefix; bare "exited" == "exited:unhealthy"
normaliseServers(arr)                 -> server[]
normaliseResources(arr)               -> resource[]      // kind: application|service|database; gitBranch from git_branch
normaliseDeployments(arr)             -> deployment[]    // uuid <- deployment_uuid
normaliseProjects(arr)                -> [{ uuid, name }]
environmentsOf(projectDetail)         -> [{ id, name }]
serverResourceUuids(arr)              -> string[]
// join
buildTree(projects, envsByProject, resources) -> tree   // via environment_id; unmatched → "Ungrouped"
buildByServer(map)                    -> byServer
applyJoins(resources, tree, byServer, servers) -> resource[]
joinBranch(deployments, resources)    -> deployment[]   // app.gitBranch, else commit.slice(0,7)
resourceCounts(byServer)              -> { serverUuid: n }
topologyIntervalSec(configured, P, S) -> int             // max(configured, ceil((1+P+S)/3)*60) → ≤ 3 req/min
// diff
diffActive(prevUuids, next)           -> { added, vanished }
// bar + hero + callout
barState(snapshot)                    -> { glyph, dimmed, active, tooltip }
heroTitle(s) / heroMeta(s) / heroDetail(s) -> string
callout(s)                            -> null | { title, body }
// panel
panelRows(snapshot, ui)               -> row[]           // ui: { groupBy: "project"|"server", folded: {} }; active + newest 5 recent
sameRows(a, b)                        -> bool
indexOfKey(rows, key)                 -> int             // -1 if gone
nextSelectable(rows, index, dir)      -> int             // skips section/separator/note; -1 if none
firstSelectableInSection(rows, title) -> int
footerHints(focusSection, row)        -> string
// format
elapsed(iso, nowMs) / age(iso, nowMs) -> "45s" | "1m 20s" | "2h 03m" | "Just now" | "4m ago"
statusDot(res) / statusWords(res) / kindHint(res) / deploymentGlyph(d)
GLYPHS                                -> the allowlist every glyph-emitting function draws from
```

`Service.qml` public surface (everything else is `_`-prefixed; `_` is a naming convention, not access control — see Security 6):

```qml
readonly property var snapshot
readonly property var bar                    // Model.barState(snapshot)
function refresh()
function panelOpened(id) / panelClosed(id) / panelAlive(id)   // registry; entries expire after 5 s without alive
IpcHandler { target: "io.github.danjonesio.omarify"
  function refresh(): string                 // "ok"
  function status(): string }                // JSON, fixed keys, no secrets, no bodies, no URLs
```

`status` JSON: `{ configState, configMode, tokenSource: "file"|"command"|null, instance: {id, version}, counts: {servers, resources, deployments, recent}, perKind: { <kind>: { lastAt, lastCode, lastMs, lastBytes, interval, consecutiveFailures, reaps, lastReapAt } }, requestsLastMin, rateLimitRemaining, backoffUntil, openPanels, baselineDone, error: { kind, httpCode, curlExit } | null }`.

### The HTTP client

One `Process` per request kind so kinds overlap but never stack. Inline component, dropbox's collector shape:

```qml
component Req: Process {
  id: req
  property string kind: ""
  property var    arg: null
  property int    seq: 0
  property int    liveSeq: -1
  property string cfg: ""
  property double deadline: 0
  running: false
  command: Api.argv()
  stdout: StdioCollector { id: out; waitForEnd: true }
  stderr: StdioCollector { id: err; waitForEnd: true }
  onStarted: { liveSeq = seq; write(cfg); cfg = ""; stdinEnabled = false }   // EOF → curl runs
  onExited: function(code) { root._finish(req, code, out.text, err.text) }
}
```

```qml
function _launch(p, reqs, maxTime) {          // reqs: one descriptor or an array (topology)
  if (p.running) return false
  var list = Array.isArray(reqs) ? reqs : [reqs]
  p.seq += 1; p.kind = Array.isArray(reqs) ? "topology" : reqs.kind; p.arg = list
  p.deadline = Date.now() + (list.length * maxTime + 3) * 1000
  p.stdinEnabled = true                        // before running
  p.cfg = Api.config(root._instance, root._token, list, maxTime)   // the ONLY call site; result never stored elsewhere
  p.running = true
  root._noteRequest(p.kind, list.length)
  return true
}
function _finish(p, code, stdoutText, stderrText) {
  if (p.liveSeq !== p.seq) return
  var results = Model.splitResponses(stdoutText)
  if (results.length === 0) { root._fail(p.kind, Model.errorFor({ curlExit: code })); return }
  results.forEach(function (r, i) {
    var e = Model.errorFor({ curlExit: r.exit, httpCode: r.code, body: r.body, headers: r.headers })
    if (e) root._fail(p.kind, e); else root._dispatch(p.arg[i], r)
  })
}
```

Token path: `config.json` → `FileView.text()` → `Model.normaliseConfig` → `_token` (from `token`) or `tokenCmd` `Process` stdout trimmed → `_token`. `_token` reaches curl only inside `Api.config`'s return value, assigned straight to `p.cfg`, written to stdin in `onStarted` and cleared in the same handler. Never in `command`, never in `console.*`, never in `snapshot`, never in `status`, never returned by any function on the service. Any plugin loaded into the same shell can read `_token` via `serviceFor`; with an inline `token` it could equally read `config.json`, with `tokenCommand` the service is the only silent oracle. No in-process boundary exists in Quickshell, so this is documented, not solved.

Per-kind `--max-time` (per transfer): deployments 6, deployment (one-shot) 6, version 6, resources 10, servers 10, topology 8 per block. The deadline is `blocks × maxTime + 3` s. A single `Timer { interval: 5000; repeat: true }` reaper, armed once at service start, sets `running = false` (bumping `seq` first) on any `Req` past its `deadline`, increments `perKind.reaps` and `consecutiveFailures`, and sets `lastReapAt`.

Error mapping in `Model.errorFor`, keyed on per-transfer `exit` then HTTP status then `message` regex; nothing reads `success`:

| input | kind | hero meta |
|---|---|---|
| exit 6/7/28/35/60 | offline | Offline · retrying |
| exit 63 | toolarge | Response too large |
| other non-zero exit | http | Coolify error (detail: `curl <exit>: <errmsg>`) |
| 401 | auth | Token rejected |
| 403 + `/API is disabled/i` | apidisabled | API disabled |
| 403 + `/not allowed/i` | ipblocked | IP not allowed |
| 403 + `/permission/i` | ability | (callout only) |
| 429 | ratelimited | Rate limited |
| other ≥ 400 | http | Coolify error |

After any error the last good snapshot stays; `error.staleSince` is the last successful poll time of that kind.

Backoff and pause:
- `offline`/`http`/reap: exponential 30 → 60 → 60 s cap on that kind's timer.
- `ratelimited`: pause all timers for `Model.retryAfterSec(headers, attempt)`.
- `auth`/`apidisabled`/`ipblocked`: stop all timers; one `GET /deployments` probe every 60 s; resume full rate on first 2xx or on any config change.

`Process` inherits the session environment (stated decision: the user's own proxy settings apply). Logging: only `kind`, `code`, `exit`, `timeMs`, `bytes`, and `Model.elide(Model.redact(errmsg or message), 140)`; never a body, never config text, never token-command output; `FileView.printErrors: false`.

### Config loading and watching

```qml
FileView { id: configFile; path: root.configPath; watchChanges: true; printErrors: false
           onFileChanged: reload(); onLoaded: root._configText(text()); onLoadFailed: root._configText(null) }
FileView { id: configDir; path: root.configDirPath; watchChanges: true; printErrors: false
           onFileChanged: { configFile.reload(); root._stat() } }
Process  { id: mkdirProc; command: ["mkdir","-m","700","-p",root.configDirPath]
           onExited: Qt.callLater(function(){ configDir.path = ""; configDir.path = root.configDirPath; configFile.reload() }) }
Process  { id: statProc;  command: ["stat","-c","%a %U",root.configPath]
           stdout: StdioCollector { id: statOut; waitForEnd: true }
           onExited: function(code) { root._applyStat(code === 0 ? statOut.text : ""); if (root._statPending) { root._statPending = false; statProc.running = true } } }
Process  { id: tokenCmd;  command: ["timeout","-k","2","30"].concat(root._cfg.tokenCommand)
           stdout: StdioCollector { id: tokenOut; waitForEnd: true }
           onExited: function(code) { if (code === 0 && tokenOut.text.trim()) root._tokenReady(tokenOut.text.trim()); else root._tokenCmdFailed(code) } }
```

- `_stat()`: if `statProc.running` set `_statPending = true`, else `statProc.running = true`.
- `_applyStat("644 danjones")`: `Model.configUnsafe(mode, owner, me)` → `error.kind = "unsafe"`, no polling, no `tokenCommand` (a writable config lets any local process redirect the token to its own `url`). `Model.configLoose(mode)` with an inline `token` → `warning.kind = "permissions"`, polling continues. `me` comes from `Quickshell.env("USER")`.
- `tokenCommand` output and stderr are never logged; failure surfaces `tokencmd` with the exit code only. While it runs: `waitingtoken`. The resolved token is cached across config reloads whose `tokenCommand` JSON is unchanged.
- On every `refresh` IPC call and on the servers tick: run `mkdirProc` (which re-arms the directory watch by reassigning `configDir.path`) and `_stat()`, so a removed directory or a dead watch self-heals.
- Every config change resets `baselineDone`, `recent`, `failedUnacked`, and re-primes.

### Scheduler

Timers `repeat: true`, `triggeredOnStart: false`, `running: root._ready && !root._paused`. First fire is explicit via `primeAll()` (config load, token resolve, `refresh()`, first panel open), rate-limited to once per 2 s. Changing `interval` restarts a Qt Timer (measured), so after any interval change: if `Date.now() - lastPollAt[kind] >= newInterval`, launch that kind immediately. Columns compose: a kind's interval is the minimum across every applicable column.

| kind | idle | any panel open | deployment active | idle req/min |
|---|---|---|---|---|
| deployments | 4 s | 4 s | 2 s | 15 |
| resources | 60 s | 30 s | 15 s | 1 |
| servers | 120 s | 120 s | 120 s | 0.5 |
| topology (batched) | `topologyIntervalSec` ≥ 600 s | on first open, then as idle | as idle | (1 + P + S)/10 ≤ 3, ≈ 0.7 at P=3, S=3 |
| **total** | | | | **≈ 17.2** (panel open ≈ 18.2; P=10, S=5 idle ≈ 18.1) |

With one deployment: 30 + 4 + 0.5 + 0.7 + one terminal one-shot ≈ **36/min**; opening the panel adds nothing (deployments already at 2 s). Five concurrent deployments add nothing.

- **Startup order.** On `_ready`: launch `deployments`, `version`, `resources`, `servers` concurrently; topology 2 s later. The icon lights on the first `deployments` response. `startupRamp`: if the first attempts fail with `offline`, retry every 2 s for 30 s, then the backoff ladder.
- **Topology** is two batched `Req` launches on one `Req` instance, each block complete (headers, timeouts, write-out): stage 1 `[/projects]`; stage 2, launched from stage 1's dispatch, `[/projects/{uuid} × P] + [/servers/{uuid}/resources × S]` with `S` taken from `snapshot.servers` (skipped when empty; the next servers tick launches stage 2 alone if `byServer` is still empty). Results dispatch by block index. After stage 1, `topologyIntervalSec(configured, P, S)` sets the topology timer.
- **Terminal deployments.** Each `/deployments` response runs `Model.diffActive`; vanished uuids go on a deduped queue (cap 20) drained by the `deployment` `Req`; the `deployment` dispatch and fail handlers pop the next uuid immediately, so eight finish in under a second. The result goes to `recent` (cap 20). A `failed` result appends to `failedUnacked` only when `baselineDone && openPanels === 0` (a failure seen while a panel is open is already acknowledged). 404 drops the uuid. `baselineDone` is set when all of `deployments`, `resources`, `servers`, `version` have answered once.
- **Panel registry.** `_panels: { id: lastAliveMs }`. `panelOpened(id)` inserts, `panelClosed(id)` deletes, `panelAlive(id)` refreshes; the reaper tick drops entries older than 5 s. `openPanels = Object.keys(_panels).length`. A hot-reloaded service starts empty and open panels re-register within 1 s via `panelAlive`. `panelOpened` also fires `primeAll()` if any kind's last poll is older than its idle interval, and launches topology if never fetched.
- `_noteRequest` pushes timestamps into a ring; `requestsLastMin` counts the last 60 s. `rateLimitRemaining` is the whitelisted integer from the last response, or null.
- `Component.onDestruction`: every `Req.running = false`, reaper and cadence timers stopped, `tokenCmd`/`statProc`/`mkdirProc` stopped.

### BarWidget.qml

omasnitch's skeleton (`~/.config/omarchy/plugins/io.github.danjones.omasnitch/BarWidget.qml:11-52`) with the state properties replaced: guarded `serviceFor`, `Loader { active: true; source: Qt.resolvedUrl("Panel.qml") }`, `injectPanel()` on `onLoaded` and via `Qt.callLater` (sets `bar`, `settings`, `anchorItem: button`, `hostWidget: root`, `service: root.svc`), `open/close/toggle/closeForPopoutSwitch` proxied to `panelLoader.item`, root `implicitWidth/Height` from the button. Colours come from `BarIconButton` defaults (`bar.barForeground`, `bar.urgent`). Left click toggles; middle and right are inert in Phase 1. No count caption.

### Panel.qml

Root `Ui/Panel { moduleName; manageIpc: false }` declares `readonly property color foreground: bar ? bar.foreground : Color.foreground`, `dim: Qt.darker(foreground, 1.55)`, `urgent: bar ? bar.urgent : Color.urgent`, `fontFamily: bar ? bar.fontFamily : Style.font.family`, and every control below binds `color`/`font.family` from these (omasnitch `Panel.qml:26-28`).

`KeyboardPanel { anchorItem; owner: hostWidget; bar; open: root.opened; focusTarget: keyCatcher; contentWidth: fittedContentWidth(Style.space(380)); contentHeight: fittedContentHeight(Style.space(480), Style.space(640)) }` → `PanelKeyCatcher` → anchored layout as omasnitch `Panel.qml:136-206`: header (`PanelHero` + optional callout) anchored top, footer anchored bottom, `ListView` anchored between with `boundsBehavior: Flickable.StopAtBounds`, `flickableDirection: Flickable.VerticalFlick`, `spacing: Style.space(8)`, `clip: true`, `ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }`, `reuseItems: false`.

- **Hero.** `title: Model.heroTitle(s)` (instance name → id → host), `meta: Model.heroMeta(s)`, `detail: s.instance.version ? "v" + version : ""`, `iconOpacity: s.error ? 0.45 : 1`, `iconComponent: Text { text: "󰅟"; width: hero.iconSize; height: hero.iconSize; font.family: root.fontFamily; font.pixelSize: hero.iconSize; color: root.foreground; textFormat: Text.PlainText }`. `trailingControl: Button { bordered: false; iconText: "󰑐"; iconSpinning: svc && svc.snapshot.busy; width: implicitWidth; height: implicitHeight; hasCursor: root.cursorActive && root.focusSection === "hero"; onHovered: function(on) { if (on) root.focusHero() }; tooltipText: "Refresh"; onClicked: if (svc) svc.refresh() }`.
- **Callout.** Shown when `Model.callout(s)` is non-null: `BorderSurface { color: Util.alpha(root.urgent, 0.10); borderSpec: Border.flat(Util.alpha(root.urgent, 0.35), 1) }` (agents `Panel.qml:498-510`) with title and body `Text`, `wrapMode: Text.Wrap`, `textFormat: Text.PlainText`. Invisible when healthy.
- **Rows.** `rowsModel` is assigned only when `!Model.sameRows(old, new)`. On assignment: `i = Model.indexOfKey(rows, cursorKey)`; if `-1`, `i = Model.nextSelectable(rows, Math.min(prevIndex, rows.length - 1), +1)`; `cursorKey = rows[i].key`; call `positionViewAtIndex(i, ListView.Contain)` only when `cursorActive && i !== prevIndex`. On a `groupBy` flip the cursor moves to `Model.firstSelectableInSection(rows, "RESOURCES")`.
  - `section`: `Item { implicitHeight: Math.max(header.implicitHeight, control.implicitHeight) }` holding `PanelSectionHeader { id: header; text }` and, when `control === "groupBy"`, a right-aligned `ButtonGroup { options: [{value:"project",label:"by project"},{value:"server",label:"by server"}]; value: root.groupBy; fontSize: Style.font.bodySmall; focusable: false; anchors.verticalCenter: header.verticalCenter; anchors.verticalCenterOffset: Math.round(header.topPadding / 2); onChanged: v => root.groupBy = v }` (network `Panel.qml:1285-1322`).
  - `separator`: `PanelSeparator`.
  - `note`: centred dim `Text` (tailscale `Panel.qml:678-691`).
  - `fold`: `▾`/`▸` + uppercase caption label + dim count (omasnitch `Panel.qml:272-304`).
  - `deployment`: glyph cell `Style.space(22)` (`󰦖` in_progress accent · `󰔟` queued dim · `󰄬` finished dim · `󰅙` failed urgent · `󰜺` cancelled dim), name (`Style.font.body`, `ElideRight`) over `branch · commitMessage` caption dim, right caption `elapsed(createdAt, nowMs)` when active else `age(updatedAt, nowMs)`. This is the only delegate that reads `nowMs`.
  - `server`: dot `●` reachable+usable · `󰪶` reachable-not-usable · `○` unreachable/disabled; name; caption `ip` plus `unreachable` (urgent), `disabled`, `build server`, `N resources`.
  - `resource`: dot `●` running (fg) · `󰪶` starting/restarting/degraded (urgent) · `○` exited/paused (dim) · `◌` other; name; `statusWords` caption; right `kindHint`.
  - Row root: `CursorSurface { hasCursor: delegate.selected; implicitHeight: content.implicitHeight + Style.spacing.rowPaddingX }` with a `HoverHandler` writing `cursorActive/cursorKey`. No `containsMouse` colouring. Every `Text` sets `textFormat: Text.PlainText`.
- **Keyboard.** `cursorActive`, `focusSection ∈ {"hero","list"}`, `cursorKey`, `folded` (object keyed by fold key), `groupBy`. `onMoveRequested(dx,dy)`: `dy` walks `Model.nextSelectable`; from the first selectable row `k` goes to the hero; `dx` is a no-op. `onActivateRequested`: fold row → toggle `folded[key]`; hero → refresh; else nothing. `onReturnRequested`: unhandled. `onTextKey`: `r` → refresh, `g` → toggle `groupBy`. `onDeleteRequested`: no-op with a comment reserving it for Phase 2 cancel. `onCloseRequested`: `closeLadder()` whose only rung today is `close()`. `onTabRequested(dir)`: `bar.switchPanelFrom(hostWidget || root, dir)`. No `Keys.onPressed`. Every `svc.` call is null-guarded.
- **Footer.** `Model.footerHints(focusSection, row)`: hero → `enter refresh · j down · r refresh · esc close`; fold → `j/k move · enter fold · g group · r refresh · esc close`; leaf → `j/k move · g group · r refresh · esc close`. Dim caption.

### Rejected alternatives

- **One `Process` with a serial queue for everything.** Less code and an exact budget, but the 2 s deployments poll would queue behind `/resources` and the topology batch and miss the "row within 5 s" acceptance. Only the topology fan-out is batched, where serialisation is wanted.
- **Batching `resources` + `servers` + `version` into one `Req`.** Different cadences (60 / 120 / once), and per-kind error attribution and stale-guard would have to be re-derived per block. Not worth it.
- **`module.exports` for `Model.js`/`Api.js`.** AGENTS.md locks `.pragma library`, omasnitch's runner exists, and the two must not coexist.
- **Env-var token with `--expand-header`.** Not needed: `stdinEnabled = false` closes the write channel (disassembly). Kept only as the contingency in Risks.
- **`XMLHttpRequest`.** Banned by the shell reference and unused in the tree.

## Reuse

- `~/.config/omarchy/plugins/io.github.danjones.omasnitch/BarWidget.qml:11-52` — widget skeleton (step 2).
- `~/.config/omarchy/plugins/io.github.danjones.omasnitch/Panel.qml:26-28, 108-206, 165-169, 243-304` — root colour/font properties, anchored layout with literal height, hero trailing control cursor wiring, CursorSurface rows, fold rows, footer; 12 `Text` blocks all `PlainText` (step 9).
- `~/.config/omarchy/plugins/io.github.danjones.omasnitch/Model.js:227, 341-360` — `panelRows`/`barIcon`/`heroMeta` pure-selector shape (steps 5, 8, 9).
- `~/.config/omarchy/plugins/io.github.danjones.omasnitch/manifest.json` — manifest shape (step 2).
- `~/Projects/omasnitch/tests/run.js:5-9` — vm runner, extended to two contexts and fixtures (step 1).
- `/usr/share/omarchy/shell/plugins/panels/dropbox/Service.qml:220-232` — `Process` + id'd collectors read in `onExited` (step 3); `:90-93` `elideStatus` → `Model.elide`; `:160-198` timer shapes (step 7). `dropbox/Model.js:99-113` `relativeTime` → `Model.age` (step 5).
- `/usr/share/omarchy/shell/Ui/MultiSelect.qml:216-252` — `seq`/`liveSeq` guard (step 3).
- `/usr/share/omarchy/shell/plugins/panels/tailscale/Service.qml:414-435` — the arm-once watchdog rule (step 3); `:396-412` `startupRamp` (step 7); `Panel.qml:678-691, 866-976` empty copy and row geometry (step 9).
- `/usr/share/omarchy/shell/plugins/panels/network/Panel.qml:778-785` — secret over stdin, cleared after write (step 3); `:1285-1322` header + control pairing (step 9).
- `/usr/share/omarchy/shell/plugins/bar/Bar.qml:936-968` — directory watch, start-not-restart probe, IPC nudge (step 6). `Commons/Color.qml:242-253` — `onFileChanged: reload()` idiom (step 6). `plugins/notifications/Service.qml:775-845` — mkdir then `Qt.callLater(reload)` (step 6).
- `/usr/share/omarchy/shell/Commons/Util.qml:44` — per-segment `encodeURIComponent` for `Api.seg` (step 5); `:33` `alpha` (step 9).
- `/usr/share/omarchy/shell/Ui/Button.qml:44` `iconSpinning`; `Ui/ButtonGroup.qml`; `Ui/PanelSeparator.qml`; `Ui/PanelHero.qml` `trailingControl`; `Ui/KeyboardPanel.qml:161-175`; `plugins/agents/Panel.qml:498-510` callout surface (step 9).
- `/usr/share/omarchy/bin/omarchy-plugin-validate` — bash + jq, CI-portable; its explicit `fail()` style is what `bin/check` copies (step 1).

Not reused, with reason: `plugins/panels/weather/Panel.qml:641-673` spinner (`Button.iconSpinning` exists). `Ui/BarWidget.qml:29-35` `broadcast` (IPC lives on the service).

## Security requirements

1. **Curl config injection** (`Api.js`): every emitted value passes `Api.quote`; every URL path segment passes `Api.seg`; the write-out template is emitted as a per-block `write-out` line through `quote` too. Tests assert exactly one `url` line and one `write-out` line per block for hostile inputs. Step 5.
2. **`~/.curlrc` isolation**: `-q` is argv[1]; nothing else is in argv. Step 3, 5.
3. **Write-out and bounds are per block**: `write-out`, `silent`, `connect-timeout`, `max-time`, `max-filesize 8388608`, `proto =https,http` appear in every block; tests count each once per descriptor. Exit 63 → `toolarge`. `instance.url` validated in `Model.normaliseConfig`; `http://` warns. Step 5, 7.
4. **Header whitelist**: `Model.splitResponses` discards the raw `header_json` blob and returns only `retryAfter`, `rateLimitRemaining`, `rateLimitLimit` as integers or null; `retryAfterSec` clamps to [1, 300]. Nothing downstream can reach `set-cookie`. Step 5.
5. **Token scope**: development and fixture recording use a token with `read` only; `deploy` is added in Phase 2, `read:sensitive` in Phase 4 (it also makes `GET /deployments` carry the full build logs on every 2 s poll). This changes the Phase 0 lock in `AGENTS.md:19` and `docs/product.md` Decision 4; open question 6 confirms it. Step 4.
6. **Token handling**: `_token` is never in `command`, `console.*`, `snapshot`, `status`, or disk, and no function on the service returns it or the config text; `Api.config` is called only in `_launch` with its result assigned to `p.cfg`, cleared in `onStarted`. `tokenCommand` is an argv array run via `timeout -k 2 30`, never a shell; its stdout/stderr are never logged. Docs say `tokenCommand` keeps the token off disk but not from other plugins in the same shell. Step 4, 6.
7. **Config file trust**: `mkdir -m 700`; group/other-writable or foreign-owned config → `unsafe`, no polling, no `tokenCommand`. Loose read bits with an inline token → warning. Step 6.
8. **Logging**: only kind, HTTP code, curl exit, timings, bytes, and a redacted, elided `errmsg`/`message`; `Model.redact` covers `\d+\|…`, `Bearer …`, `://user:pw@`, `set-cookie`. `FileView.printErrors: false`. Step 3, 7.
9. **IPC surface**: only `refresh` and `status`; `status` is the fixed JSON above. Step 7.
10. **Rich-text injection**: every `Text` in `Panel.qml` and `BarWidget.qml` sets `textFormat: Text.PlainText`; `bin/check` counts occurrences of `Text {` and `textFormat: Text.PlainText` per file, requires both > 0 and equal (advisory smoke gate; the real guarantee is review in step 9). Step 1, 9.
11. **Fixtures**: recorded via `bin/record-fixture`, which pipes the config through the shell builtin `printf` into `curl -q -S -K -` and replaces (never deletes) values of denylisted keys with `«scrubbed»`: `internal_db_url external_db_url docker_compose docker_compose_raw dockerfile git_full_url private_key sentinel_token value custom_labels configuration_snapshot configuration_diff logs` plus `_token$|_password$|_secret$|_key$`. `bin/check` fails closed if the fixtures dir is missing, on any match of `[0-9]+\|[A-Za-z0-9]{20,}`, `BEGIN .*PRIVATE KEY`, `://[^/]*:[^@/]*@`, or the literal keys `"configuration_snapshot"`, `"logs"`. Step 1, 5.
12. **Dev sync**: explicit allowlist; refuses a target containing `.git`, a `manifest.json` with a different id, or a path outside `~/.config/omarchy/plugins/` and `$TMPDIR`; `flock` around the sync; never touches `~/.config/omarify/`. Step 1.
13. **Verification hygiene**: the token prefix never appears in argv or shell history; greps read the needle via process substitution (`grep -cFf <(jq -r '.instances[0].token // empty' … | cut -c1-12)`). Steps 3, 7, Verification.

## Changes

### 1. Repo scaffolding and the check harness

Files: `bin/check`, `bin/dev-sync`, `bin/dev-watch`, `bin/record-fixture`, `tests/run.js`, `tests/fixtures/.gitkeep`, `.gitignore` (add `.cache/`).

`bin/dev-sync` (bash, `set -euo pipefail`):
```sh
id=io.github.danjonesio.omarify
root=$(cd "$(dirname "$0")/.." && pwd)
dest=${OMARIFY_DEST:-$HOME/.config/omarchy/plugins/$id}
fail() { echo "dev-sync: $*" >&2; exit 1; }
case $dest in "$HOME/.config/omarchy/plugins/"*|"${TMPDIR:-/tmp}"/*) ;; *) fail "refusing target outside plugins dir or TMPDIR: $dest";; esac
[[ -d $dest/.git ]] && fail "$dest is a git checkout (omarchy plugin remove $id first)"   # non-final && is set-e safe
if [[ -f $dest/manifest.json ]] && [[ $(jq -r .id "$dest/manifest.json") != "$id" ]]; then fail "$dest holds a different plugin"; fi
files=(manifest.json LICENSE README.md Service.qml BarWidget.qml Panel.qml Model.js Api.js)
for f in Mark.qml preview.png; do [[ -e $root/$f ]] && files+=("$f"); done
for f in "${files[@]}"; do [[ -e $root/$f ]] || fail "missing: $f"; done
existed=0; [[ -d $dest ]] && existed=1
mkdir -p "$dest"; exec 9>"$dest.lock"; flock 9
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
for f in "${files[@]}"; do install -m 0644 "$root/$f" "$stage/$f"; done
rsync -a --delete "$stage/" "$dest/"
if [[ -z ${OMARIFY_DEST:-} && $existed -eq 0 ]]; then omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true; fi
```
`rescanPlugins` only on first creation: after that the shell's own inotify watch reloads the plugin, and a rescan reloads every plugin.

`bin/dev-watch`: `inotifywait -m -e close_write,move,create --format %f "$root" "$root/tests" | while read -r f; do while read -r -t 0.3 _; do :; done; case $f in *.js) node "$root/tests/run.js" || continue;; esac; case $f in *.qml|*.js|manifest.json) "$root/bin/dev-sync";; esac; done` — events coalesced, tests run before a `.js` sync and block it on failure.

`bin/check` (bash, `set -uo pipefail`, explicit `fail()`; `--no-shell` skips validate and qmllint for CI):
```sh
fail() { echo "check: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || fail "missing tool: $1"; }
need node; need jq
node "$root/tests/run.js" || fail "tests"
find "$root" -name .git -prune -o -type l -print -quit | grep -q . && fail "symlink in repo"
[[ -d $root/tests/fixtures ]] || fail "fixtures dir missing"
if grep -rEl '[0-9]+\|[A-Za-z0-9]{20,}|BEGIN .*PRIVATE KEY|://[^/]*:[^@/]*@|"configuration_snapshot"|"logs"' "$root/tests/fixtures"; then fail "secret material in fixtures"; fi
for q in Panel.qml BarWidget.qml; do
  [[ -f $root/$q ]] || continue
  t=$(grep -o 'Text {' "$root/$q" | wc -l); p=$(grep -o 'textFormat: Text.PlainText' "$root/$q" | wc -l)
  [[ $t -gt 0 && $t -eq $p ]] || fail "$q: $t Text blocks, $p PlainText"
  s=$(grep -o 'font.pixelSize:' "$root/$q" | wc -l); f=$(grep -o 'font.family:' "$root/$q" | wc -l)
  [[ $s -eq $f ]] || fail "$q: $s pixelSize, $f font.family"
done
if compgen -G "$root/*.qml" >/dev/null && grep -nE '#[0-9a-fA-F]{3,8}\b|font\.family: "|pixelSize: [0-9]|radius: [0-9]' "$root"/*.qml; then fail "hardcoded token"; fi
[[ ${1:-} == --no-shell ]] && exit 0
need omarchy; need rsync; need flock
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
OMARIFY_DEST="$stage/plugin" "$root/bin/dev-sync" || fail "dev-sync"
omarchy plugin validate "$stage/plugin" || fail "validate"
mkdir -p "$stage/imports"; ln -s /usr/share/omarchy/shell "$stage/imports/qs"
/usr/lib/qt6/bin/qmllint -I "$stage/imports" --missing-property disable "$root"/*.qml > "$stage/lint.txt" 2>&1 || true
grep -q 'Failed to import qs' "$stage/lint.txt" && fail "qs shim broken; qmllint checked nothing"
grep -E 'Failed to import|was not found|inheritance-cycle|unresolved-type|Error:' "$stage/lint.txt" && fail "qmllint"
echo ok
```
The `qs` shim lives in the temp dir, never in the repo or plugin dir. qmllint is gated on the categories the shim buys (import/type resolution) plus hard errors; `unqualified` is left as noise because delegate scopes produce ~100 of them in first-party-shaped QML (`pragma ComponentBehavior: Bound` is a deviation from every first-party file and is not adopted).

`bin/record-fixture <name> <path>`: reads `token // empty` from `config.json` with jq into a variable, or runs `tokenCommand`; builds the config with builtin `printf` piped into `curl -q -S -K -` (never `-H`, never a temp file); pipes through `jq 'walk(if type=="object" then with_entries(if (.key|test("^(internal_db_url|external_db_url|docker_compose|docker_compose_raw|dockerfile|git_full_url|private_key|sentinel_token|value|custom_labels|configuration_snapshot|configuration_diff|logs)$|_token$|_password$|_secret$|_key$")) then .value = "«scrubbed»" else . end) else . end)'` into `tests/fixtures/<name>.json`. `/version` saves raw as `version.txt`.

`tests/run.js`: two `vm` contexts (`Model.js`, `Api.js`), `.pragma library` stripped, `fixture(name)` helper, `test(name, fn)` wrapper printing `ok`/`FAIL` and exiting 1 on any failure; prints the test count. Starts with one test per file asserting a known function exists (they run against the step-2 stubs).

**Verify**: `bin/check --no-shell` exits 0 printing `ok` (absent QML files are skipped; tests report 0 or 2 cases). Gate self-tests, each expected to exit 1 then be reverted: `echo '67|aaaaaaaaaaaaaaaaaaaaaaaaaa' > tests/fixtures/x.json`; `ln -s /etc/hostname tests/x`; a `Panel.qml` containing `Text {` and no `PlainText`. `bin/check` (full) exits 1 with `dev-sync: missing: manifest.json`.

### 2. Manifest, stubs and walking skeleton

Files: `manifest.json`, `Service.qml`, `BarWidget.qml`, `Panel.qml`, `Model.js` (stub: `.pragma library` + `function version() { return "0" }`), `Api.js` (stub likewise).

`manifest.json`: `schemaVersion: 1`, `id`, `name: "Omarify"`, `version: "0.1.0"`, `description`, `kinds: ["service","bar-widget"]`, `keepLoaded: true`, `entryPoints: { service: "Service.qml", barWidget: "BarWidget.qml" }`, `barWidget: { defaultSection: "right" }`. `Service.qml`: `Item` with `property var shell; property var manifest`, `readonly property var snapshot` (empty shape), `readonly property var bar: ({ glyph: "󰅜", dimmed: true, active: false, tooltip: "Omarify — starting" })`, `IpcHandler` with `status()` returning `"{}"` and `refresh()` returning `"ok"`. `BarWidget.qml`: the omasnitch skeleton bound to `svc.bar`. `Panel.qml`: root properties, `KeyboardPanel` with a hero and one `note` row, all `Text` PlainText.

**Verify**: `bin/check` prints `ok`; `bin/dev-sync && omarchy plugin enable io.github.danjonesio.omarify right`; icon on every monitor; click opens a native card with the hero; `omarchy-shell io.github.danjonesio.omarify status` prints `{}`; `omarchy plugin list --json | jq -r '.[].id' | grep -c omarify` is 1.

### 3. The curl-over-stdin smoke test

Files: `Api.js` (`quote`, `seg`, `base`, `argv`, `block`, `config`, `reqVersion`, `TRAILER`), `Service.qml` (one `Req`, the reaper, `_launch`, `_finish`, and a temporary `FileView` that does `JSON.parse` of `instances[0].url`/`token` with no validation, marked `// replaced in step 6`), `Model.js` (`splitResponses`, `parseVersion`, `redact`, `elide`).

Create the read-only token (open question 6) and a hand-written `~/.config/omarify/config.json` (`chmod 600`). Wire `reqVersion`. Log only `kind`, `code`, `exit`, `timeMs`, `bytes`.

**Verify**: within 2 s `status` shows the version and `perKind.version.reaps` is 0 (the process exited on its own, proving EOF); `ps -eww -o args= | grep -cFf <(jq -r '.instances[0].token // empty' ~/.config/omarify/config.json | cut -c1-12) || true` prints 0 during a poll; `quickshell log -p /usr/share/omarchy/shell -t 100000 | grep -cFf <(…same…) || true` prints 0. Contingency only if the reaper fires on every attempt (it should not): drop `-K -`, move every non-secret option to argv, source the token with `--variable %OMARIFY_TOKEN --expand-header 'Authorization: Bearer {{OMARIFY_TOKEN}}'` from `Process.environment`, verify with `tr '\0' '\n' < /proc/<pid>/environ` that only that process holds it, and record the deviation in AGENTS.md (environ is 0400 same-user: better than argv, weaker than stdin).

### 4. Reconcile the docs with the settled transport

Files: `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/design.md`, `docs/roadmap.md`, `docs/product.md`, `docs/omarchy-shell-reference.md`.

- `AGENTS.md`: product locks → token abilities per phase (`read` now); curl line → "`curl -q -S -K -`, nothing else in argv; every per-transfer option and the write-out live in each config block; stdin closed with `stdinEnabled = false` after the write"; rate-limit line → the schedule numbers. "Coolify facts that bite" → replace the `GET /projects/{uuid}/{env}` tree line with "`/resources` carries `environment_id`; `GET /projects/{uuid}` gives environments with integer `id`; server membership from `GET /servers/{uuid}/resources`"; add "curl per-transfer options reset at `--next`". Layout → add `bin/record-fixture`. Commands → replace the qmllint line with `bin/check` and the `qs` shim note; add "never run `omarchy refresh shell` (resets shell.json)", "re-enable with `--before <id>` to keep placement", "`omarchy plugin remove` moves the dir to `.<id>.bak.<ts>` (safe rollback)". Omarchy facts → "`x` reaches the panel as `deleteRequested`, Esc as `closeRequested`; never `Keys.onPressed`"; "`bar.barForeground` in the bar strip, `bar.foreground` in panels"; "dev-sync copies because the validator refuses symlinks inside the folder and inotify through a symlinked dir is unverified"; "`Process`/`StdioCollector` have no `parent`; write to ids"; "`tokenCommand` keeps the token off disk, not away from other plugins in the same shell".
- `docs/architecture.md`: HTTP client → argv, per-block options, `TRAILER` with RS/US, `splitResponses` grammar and header whitelist, stdin close, per-kind `max-time`, deadline formula, reaper, per-transfer errors; Polling schedule → the table, batched topology, `topologyIntervalSec`, column composition, 401/403 pause and 60 s probe; Configuration → `tokenCommand` array-only and first element not `-`, `timeout -k 2 30`, unsafe/loose rules, `mkdir -m 700`, directory watch and self-heal; State model → the snapshot shape and panel registry; Security → the thirteen requirements; Testing → fixture list and `bin/record-fixture`.
- `docs/design.md`: Bar icon → the 14-row table and per-state glyphs; U+F015F is `md-cloud` (filled), U+F0163 outline; remove the count caption line; `◐` → `󰪶` U+F1396 everywhere; refresh control → `Button` with `iconSpinning`; grouping toggle → `ButtonGroup`; deployment row secondary → `branch · commit message` with sha7 fallback; server row secondary → `ip · N resources` (proxy status marked "(Phase 2, needs `GET /servers/{uuid}`)"); row height → `Style.spacing.rowPaddingX`; keyboard map → `x` via `deleteRequested`; 401 body → "with the read ability"; deployments section → "active + last 5 terminal"; add the callout element and the copy table; add the missing states; mark the action row, `d`/`x` footer hints, status line, chips and confirm as "(Phase 2)"/"(Phase 4)".
- `docs/roadmap.md` Phase 1: "idle rate measured with `status`' `requestsLastMin`, panel closed, and separately with a deployment running"; "token has `read` only"; Enter on leaf rows inert; proxy status deferred to Phase 2.
- `docs/product.md` Decisions: token abilities per phase; proxy status deferred.
- `README.md`: token permission `read` for now; `poll` keys; the `tokenCommand` caveat.
- `docs/omarchy-shell-reference.md` §8: one line that this project uses `.pragma library` + vm runner, deviating from first-party `module.exports`.

**Verify**: all empty: `grep -n "read:sensitive" AGENTS.md README.md | grep -v Phase`; `grep -n "◐" docs/design.md`; `grep -n 'projects/{uuid}/{env}' AGENTS.md`; `grep -n "read and deploy" docs/design.md`; `grep -n "caption" docs/design.md`. `grep -n "deploymentsSec" docs/architecture.md README.md` shows `4`.

### 5. `Api.js` + `Model.js` in full, with fixtures and tests

Files: `Api.js`, `Model.js`, `tests/run.js`, `tests/fixtures/{version.txt, servers.json, server-resources.json, resources.json, projects.json, project-detail.json, deployments-active.json, deployments-empty.json, deployment-finished.json, deployment-failed.json, error-401.json, error-403-api-disabled.json, error-403-ability.json, error-429.json, headers-2xx.json, batch-stream.txt}`.

Record fixtures with `bin/record-fixture` (read-only token). `error-429.json`, `headers-2xx.json` and `batch-stream.txt` (a three-transfer stdout capture with a failed middle block) may be hand-written when not reproducible; say so in a `_note` key or header comment. Implement every function in Interfaces.

**Verify**: `node tests/run.js` prints one `ok` per test in "Tests to add" and exits 0; `bin/check --no-shell` prints `ok`.

### 6. Config load, watch, stat, `tokenCommand`

Files: `Service.qml` (replaces the step-3 temporary loader).

Both `FileView`s, `mkdirProc`, `statProc` with the pending re-arm, `tokenCmd`, `Model.normaliseConfig`, error kinds `noconfig/configerror/unsafe/tokencmd/waitingtoken`, warnings `permissions/plaintext`, token cache keyed by the `tokenCommand` JSON, self-heal on `refresh`.

**Verify**: `mv ~/.config/omarify/config.json{,.bak}` → `status.error.kind` is `noconfig`, icon `󰅜` dimmed, no restart; `mv` back → recovers within 2 s. `rm -rf ~/.config/omarify` → `noconfig`; recreate dir and file → recovers after `omarchy-shell io.github.danjonesio.omarify refresh` at the latest. `chmod 644` → `status.configState` shows the warning, polling continues. `chmod 666` → `error.kind` `unsafe`, `perKind.deployments.lastAt` stops advancing. `tokenCommand: ["cat","/path/to/tokenfile"]` → works; `["false"]` → `tokencmd` with exit 1; `["sleep","60"]` → `waitingtoken` then `tokencmd` after ~30 s; `"op read …"` (string) and `["-x"]` → `configerror`. `ps` grep (step 3 form) prints 0 throughout. `stat -c %a ~/.config/omarify` is `700` after a fresh start.

### 7. Scheduler, store, error mapping, budget instrumentation

Files: `Service.qml`, `Model.js` (`errorFor`, `retryAfterSec`, joins, `diffActive`, `topologyIntervalSec`).

All `Req`s, four timers, `primeAll`, `startupRamp`, two-stage topology, terminal one-shot queue with immediate drain, pause/backoff, panel registry, ring buffer, `status` JSON with reap counters, `Component.onDestruction` stopping everything.

**Verify**:
- Idle: panel closed 3 min, `for i in $(seq 12); do omarchy-shell io.github.danjonesio.omarify status | jq -c '{requestsLastMin, rateLimitRemaining}'; sleep 10; done` never exceeds 20.
- Deploying: trigger a deploy in Coolify's UI, repeat the loop while `status.counts.deployments > 0`; never exceeds 60.
- Counts: `date +%s; omarchy plugin enable …; sleep 10; status | jq .counts` matches `curl … /resources | jq length` and `/servers | jq length` (curl with the read-only token via `-K -` from `printf`).
- Terminal: note the second Coolify marks a deployment finished; `status.counts.recent` increments within 5 s.
- Revoke the token → `error.kind` `auth` within 5 s, last snapshot still shown, `status` shows one probe per 60 s; restore → recovers on the next probe.
- Offline: set `url` to `https://127.0.0.1:9` → `offline` (exit 7), `backoffUntil` set; `https://10.255.255.1` → `offline` (exit 28); restore url → recovers. `nmcli networking off` is optional and run last.
- Reaps: `status | jq '[.perKind[].reaps] | add'` is 0 after 10 min idle.
- Orphans: `for i in $(seq 20); do bin/dev-sync; sleep 0.5; done; pgrep -fa 'curl -q' | wc -l` is 0; `omarchy plugin disable io.github.danjonesio.omarify; sleep 2; pgrep -fa 'curl -q' | wc -l` is 0; re-enable with `--before omarchy.tray` (or the neighbour Dan prefers).
- Log: `quickshell log -p /usr/share/omarchy/shell -t 100000 | grep -cFf <(jq -r '.instances[0].token // empty' ~/.config/omarify/config.json | cut -c1-12) || true` prints 0 after a fresh `omarchy restart shell` followed by the revoke and offline runs.

### 8. Bar icon states and tooltip

Files: `Model.js` (`barState`, `GLYPHS`), `BarWidget.qml`.

**Verify**: walk states 1, 2, 3, 5, 7, 9, 12, 14 by hand (no config; bad JSON; `["false"]`; wrong token; `127.0.0.1:9`; fresh start; deploy from Coolify's UI; idle) reading `status.error.kind` and the icon; states 10 and 11 by deploying a deliberately broken commit and stopping a test server. Time from Coolify's "queued" to icon active ≤ 5 s. Opening any panel clears state 10; a failure arriving while a panel is open never sets it.

### 9. Panel: hero, callout, rows, keyboard, footer

Files: `Panel.qml`, `Model.js` (`panelRows`, `sameRows`, `indexOfKey`, `nextSelectable`, `firstSelectableInSection`, `footerHints`, `callout`, hero copy, formatting).

**Verify**: manual matrix: click, `r`, `g`, `j/k` across all three sections and folds, Enter on a fold, `k` from the first row to the hero (refresh button shows the cursor ring; Enter refreshes), Esc, Tab to a neighbouring panel and back, `omarchy-shell shell toggle io.github.danjonesio.omarify`, cursor stays on the same row when a deployment row is inserted above it, scroll position survives two polls with the cursor off-screen, no delegate churn on an in-progress deployment (`updated_at` ticking), `g` moves the cursor to RESOURCES, disable/enable, `omarchy restart shell`, unplug/replug a monitor with the panel open then `status.openPanels` is 0 after all panels close, config deleted mid-run, token revoked mid-run, offline. `bin/check` gates pass.

### 10. Theme check and the acceptance run

Files: none new. `cp ~/.config/omarchy/shell.toml{,.omarify-bak}` first; restore after. Themes: `catppuccin-latte` (light), `vantablack` (high contrast), and a temporary `shell.toml` with a non-zero corner radius and `[font] base-size = 14` (the default radius is already 0).

**Verify**: nothing clips or overflows in any of the three (the one inherently visual check); `bin/check` prints `ok`; every line of `docs/roadmap.md:26-38` ticked with the commands from steps 3, 7, 8; `README.md` install steps followed from scratch on a copy of the config; `shell.toml` restored (`diff` clean).

## Verification

```sh
bin/check                                   # tests, symlink scan, fixture secrets, PlainText + font gates, token grep, validate staged copy, qmllint with qs shim
bin/check --no-shell                        # CI subset
omarchy-shell io.github.danjonesio.omarify status | jq
needle() { jq -r '.instances[0].token // empty' ~/.config/omarify/config.json | cut -c1-12; }
ps -eww -o args= | grep -cFf <(needle) || true                                             # 0
quickshell log -p /usr/share/omarchy/shell -t 100000 | grep -cFf <(needle) || true        # 0
```

Done end to end: the Phase 1 acceptance list in `docs/roadmap.md` passes with the commands in steps 7, 8, 10; the plugin is enabled on all three monitors; every `bin/check` gate has been observed to fail once; the docs match the code.

## Tests to add

`tests/run.js`, one `test()` each:

- `Api.quote`: `a"b`, `a\nurl = "http://evil"`, `a\\b`, tab/CR/VT → single escaped line (SR1).
- `Api.config` with a hostile env name and a hostile url: exactly one `url` and one `write-out` line per block (SR1).
- `Api.seg`: `a/../servers`, `prod?x=1`, unicode → percent-encoded, no raw `/` (SR1).
- `Api.argv`: equals `["curl","-q","-S","-K","-"]` (SR2).
- `Api.config` with three descriptors: three `url`, three `write-out`, three `max-time`, three `max-filesize`, three `proto`, six `header` lines, two `next` lines; the write-out contains the raw 0x1E and 0x1F bytes (SR3).
- `Model.splitResponses`: single 200 with headers; body lacking trailing newline; `000` empty body with exit 7 and errmsg; body whose last line is three digits; body containing a stray 0x1E; `batch-stream.txt` → three results in order with the middle one `exit 7`; garbage → `[]`; returned `headers` has only the three whitelisted keys, as ints or null (SR4).
- `Model.parseVersion`: `4.3.17`, `v4.3.17\n`, never `JSON.parse`.
- `Model.parseStatus`: all nine documented strings; bare `exited` equals `exited:unhealthy`; unknown string.
- `Model.normaliseDeployments`: uuid from `deployment_uuid`; `restart_only`/`force_rebuild` mapping.
- `Model.joinBranch`: match → app `git_branch`; miss → sha7.
- `Model.normaliseServers`: reachability from top level and `settings`; `force_disabled` → `disabled`.
- `Model.normaliseResources`: `standalone-postgresql` → `database`/`postgres`; service; application with `git_branch`.
- `Model.buildTree` + `applyJoins`: env join by `environment_id`; a resource with no env lands in `Ungrouped`; `byServer` fills `serverUuid`; `resourceCounts`.
- `Model.errorFor`: every error fixture → kind and meta; `success: true` in the 403 body is ignored; exit 6/7/28 → offline; 63 → toolarge; other exit → http with errmsg detail.
- `Model.retryAfterSec`: `30` → 30; `2147483647` → 300; `abc` and an HTTP-date → ladder 30, 60, 60.
- `Model.redact`: `67|abc…`, `Bearer <43 opaque chars>`, `postgres://u:p@h`, `set-cookie: …` → redacted; uuids untouched (SR8).
- `Model.elide`: 139 chars unchanged; 141 → 140 with `…`; whitespace collapsed.
- `Model.normaliseConfig`: valid; `tokenCommand` string → error; `["-x"]` → error; missing `url`; `ftp://` → error; `http://` → `plaintext`; `poll` defaults and clamp.
- `Model.configUnsafe`/`configLoose`: `600` ok; `644` loose; `664`/`666` unsafe; foreign owner unsafe (SR7).
- `Model.topologyIntervalSec`: (600, 3, 3) → 600; (600, 40, 5) → 960.
- `Model.diffActive`: added, vanished, eight vanishing in one poll queued once each, a uuid vanishing twice queued once.
- `Model.barState`: all 14 rows, failed→acknowledged→idle, failed arriving with `openPanels > 0` never sets state 10, the `+N more` tooltip.
- `Model.heroMeta`: every condition string; no `0 deploying`; empty account.
- `Model.callout`: every `error.kind` and `warning.kind` returns a non-empty body; healthy → null; staleness suffix appended when `staleSince` set.
- `Model.panelRows`: section order with separators, stable keys, fold open/closed, groupBy project vs server, note rows for empty sections, active + newest 5 recent only; `nextSelectable` skips section/separator/note at both ends and returns -1 when none; `indexOfKey` on a removed key returns -1; `firstSelectableInSection`.
- `Model.sameRows`: identical → true; status change → false; `updatedAt` change only → true; reorder → false.
- `Model.elapsed`/`age`: `45s`, `1m 20s`, `2h 03m`, `Just now`, `4m ago`, `3h ago`, `2d ago`.
- `Model.GLYPHS`: every glyph any `Model` function can emit is in the allowlist; the allowlist contains no `◐`.
- `Model.footerHints`: hero, fold, leaf.

## Risks and open questions

Risks accepted:
- `stdinEnabled = false` closing the write channel is established from the binary, not from a running plugin; step 3 is the live proof and the contingency (env-var token, no `-K -`) is written down but not built.
- The idle budget is ≈ 17.2/min at P=3, S=3 and the topology term is capped at 3/min by `topologyIntervalSec`, so it stays under 20 at any account size; a very large account gets a slower topology refresh, which only affects grouping labels.
- Coolify refreshes stored statuses about once a minute, so a resource row can lag 60 s. The callout never claims liveness.
- The directory `FileView` watch can go silent (Bar.qml's own warning); the `refresh` IPC and the servers-tick re-stat are the backstop.
- `X-RateLimit-*` on Cloud is unverified; `rateLimitRemaining` may stay null and the fixed ladder applies.
- Any plugin in the same shell can read `_token` through `serviceFor`; no in-process boundary exists. Documented in AGENTS.md and README.
- `unqualified` qmllint warnings are not gated; type/import resolution and hard errors are.

Open questions (each with the default the builder takes):
1. **Per-state bar glyphs** (design.md said "the glyph stays the cloud"). Default: adopt the 14-row table; the bar has one accent colour so glyphs are the only way to tell states apart.
2. **Enter on a leaf row**: nothing, or open in browser. Default: nothing until Phase 2's `o`.
3. **`groupBy` persistence** across shell restarts via `shell.json`. Default: session-only.
4. **Config writable by others**: refuse to poll (default) or warn only.
5. **Token command timeout**: 30 s with no retry (default), or one automatic retry on timeout for vault prompts.
6. **Second, read-only Coolify token** for Phase 1 and fixture recording. This changes the Phase 0 lock (`AGENTS.md:19`). Default: yes; create it before step 3.
7. **Theme trio** for step 10. Default: catppuccin-latte, vantablack, custom radius + base-size 14.

## Out of scope

Actions and IPC action handlers; notifications; `recent.json`; deployment/container logs; deployment history; instance chips and middle-click cycling; tag deploy; SSH/Sentinel; overlay; marketplace; the bar count caption (dropped); server proxy status and `unreachable_count` (Phase 2); `Mark.qml` (only if `󰅟` reads badly in step 8); `pragma ComponentBehavior: Bound`.

## Panel record

| member | model | wave | findings | accepted | rejected (reason) |
|---|---|---|---|---|---|
| architect | opus | 1 | 13 (4 crit, 8 warn, 1 nit) | 11 | tree via `/projects/{uuid}/{env}` (perf: `/resources` carries `environment_id`; env endpoint omits keydb/dragonfly); nit 13 fixed ladder (superseded by whitelisted `Retry-After` + ladder fallback) |
| reuse-scout | opus | 1 | 9 (1 crit, 7 warn, 1 nit) | 9 | — |
| security-analyst | opus | 1 | 12 (3 crit, 8 warn, 1 nit) | 11 | F5 closure-hidden token: no in-process boundary exists; recorded as a documented risk with the corrected rationale |
| ux-api-designer | opus | 1 | 13 (4 crit, 6 warn, 3 nit) | 12 | F7 glyph-swap refresh: `Button.iconSpinning` exists (reuse F4); F3(b) `GET /servers/{uuid}` accepted in v1, then dropped in v2 (skeptic: no acceptance line needs it; staleness issue) |
| ops-analyst | opus | 1 | 12 (3 crit, 8 warn, 1 nit) | 12 | — |
| perf-analyst | opus | 1 | 15 (4 crit, 9 warn, 2 nit) | 15 | F9 modified: snapshot in service, rows flattened in the panel only while open |
| code-reviewer | opus | 2 | 12 (3 crit, 7 warn, 2 nit) | 12 | — |
| skeptic | opus | 2 | 10 (1 crit, 6 warn, 3 nit) | 9 | F7.2 batch slow kinds: different cadences and per-kind attribution; F2 "delete the fallback": kept as a written contingency, not built |
| security-analyst | opus | 2 | 10 (2 crit, 7 warn, 1 nit) | 10 | — |
| reuse-scout | opus | 2 | 5 (1 crit, 3 warn, 1 nit) | 5 | `pragma ComponentBehavior: Bound` (open question raised) not adopted: deviates from every first-party file |
| ux-api-designer | opus | 2 | 8 (0 crit, 5 warn, 3 nit) | 8 | F4 resolved by dropping the detail fetch rather than moving it |
| ops-analyst | opus | 2 | 13 (2 crit, 7 warn, 4 nit) | 13 | — |
| perf-analyst | opus | 2 | 8 (0 crit, 5 warn, 3 nit) | 8 | F2's `deploymentsSec` relief replaced by the `topologyIntervalSec` auto-clamp it also proposed |

Deviations: `data-analyst` skipped (no persistence in Phase 1). Panel model Opus (user's choice). Wave-2 members read draft v1 from the plan file rather than receiving it inline (same content). No third loop: wave-2 criticals were step-level (per-block curl options, collector ids, fail-closed gates, `timeout` argv), not design-level.
