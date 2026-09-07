# AGENTS.md

Operating notes for anyone (human or agent) working in this repo.

Omarify is a native Omarchy shell plugin for **Coolify** (Cloud and self-hosted). One
bar icon, one panel: servers, projects, resources and their status, running and queued
deployments, and the actions to deploy, redeploy, restart, stop, start and cancel.
Notifications when deployments queue, build, finish or fail. It is a Quickshell plugin
that runs inside `omarchy-shell`; there is no daemon and no second process.

Status: **Phase 3 ("notify") built on branch `phase-3-notify`; Phases 1 ("see") and 2
("act") merged.** Read `docs/roadmap.md` before writing code.

## Product locks

- Plugin id: `io.github.danjonesio.omarify`. Repo: `git@github.com:danjonesio/omarify.git`.
  (The older omasnitch id used `danjones`; the GitHub handle is `danjonesio`.)
- API first, SSH last. Anything the REST API can answer comes from the REST API. SSH
  is only for Sentinel metrics, Phase 5, opt-in per server.
- Token abilities are per phase. **Phase 2: `read` + `deploy`.** Coolify's UI has no
  edit-abilities flow, so a new token is swapped in, not edited.
  `read:sensitive` is added in Phase 4 for the log viewer; it also makes
  `GET /deployments` carry every deployment's full build log on every poll, so do not
  hold it before then. `write` is optional and only gates "Validate server".
- Failed deployment and unreachable server notify at `critical`; everything else
  `low`/`normal`. The shell shows a toast through Do Not Disturb only when its app name
  is `omarchy-action` (`plugins/notifications/NotificationLogic.js:118-122`); a plugin-id
  sender at `critical` is silenced to history. So every toast carries the plugin id
  **except** a critical event while DND is on, which is sent as `omarchy-action` (Dan,
  2026-09-07; it shows as that sender in history). `Model.notifyPlan` decides it from a
  boolean the service read from the notifications service, never from Coolify data.
- Config accepts `token` and `tokenCommand`; `tokenCommand` wins when both are set.
- Kinds: `service` + `bar-widget`, `keepLoaded: true`. The service owns polling, state,
  actions and notifications. The bar widget owns the icon and loads `Panel.qml`. No
  `panel`/`overlay` kind unless Phase 5 says so.
- Data comes from the Coolify REST API only (`/api/v1`, Bearer token). No CLI, no MCP,
  no webhooks, no WebSocket.
- **The API has no CPU/memory/disk numbers.** Do not invent utilisation. Phase 1 shows
  none and says why. Sentinel-over-SSH is Phase 5 and opt-in.
- **No push channel exists.** Every notification comes from polling and diffing.
  `GET /deployments` lists only `queued` + `in_progress`; a finished deployment vanishes
  from it, so track uuids and fetch `GET /deployments/{uuid}` when one disappears.
- The first poll after start or config change is a baseline. It raises no notification.
  The gate is each kind's own `_baseline[kind]` flag, never `_baselineDone` (one broken
  kind must not silence everything). No replay after a restart comes from the active-only
  list plus that baseline; `recent` (persisted to `recent.json`) is the intra-session
  terminal dedupe and the panel's memory, not the replay guard.
- Every toast is built by `Model.notifyPlan` from the joined snapshot at the end of
  `_finish`: toggles, the eight per-event drops (self-cancel 300 s, pending, action
  window 180 s, active deployment, post-deploy grace 120 s, server down, cooldown 300 s
  per kind:uuid:event), critical-first ordering, ≤ 3 resource toasts per flush plus one
  summary, ≤ 12 non-critical per minute; critical is never capped. A `notify`-only
  config edit applies live with no store reset; a malformed toggle warns and keeps its
  default. `recent.json` is written from the deployment arm only, never from a property
  change or `_resetStore`; the state dir is created and chmod'ed 0700 before the first write.
- HTTP is `curl -q -S -K -` in a `Quickshell.Io.Process` with the config on **stdin**;
  nothing else is in argv (`-q` first ignores `~/.curlrc`). Every per-transfer option
  (`max-time`, `max-filesize`, `proto`, headers, `write-out`) lives in every config
  block because curl resets them at each `next`. stdin is closed with
  `stdinEnabled = false` right after the write, which is what makes curl start. The
  token never goes in argv, never in logs, never in state files.
- Config lives in `~/.config/omarify/config.json` (0600), not in `shell.json`.
  `token` or `tokenCommand`. Watched live.
- Status strings have colons (`running:healthy`). Prefix-match the state; treat bare
  `exited` and `exited:unhealthy` as the same. Deployment terminal states are
  `finished`, `failed`, `cancelled-by-user`.
- Lifecycle endpoints are POST only. Restart of an application is itself a deployment
  (`restart_only: true`) and will appear in the deployments list.
- Stop, Rebuild-without-cache (`D`, keyboard only) and Cancel confirm (in the panel).
  Deploy, Redeploy, Restart, Start, Validate do not. CLI verbs never confirm: typing the
  verb is the confirmation.
- One deploy button follows the state: Deploy on a stopped application, Redeploy on a
  running one (both `POST /deploy`; `d` and IPC `deploy` resolve the same way). Only
  applications get it (`POST /deploy` accepts services and databases but that is Start
  under another name). A left click on a row opens its strip; the buttons are clickable. Open targets the resource's
  Coolify page, built from the instance origin; never `fqdn`. No page → no Open button.
- No compensating polls after an action. Pending is a service-owned map applied at
  render time and cleared per verb (deploy/redeploy/restart: the created deployment
  appears, or two deployments polls pass without it; stop/start: the status *state*
  changes, "still pending" at 150 s; validate and a service/database restart: the first
  poll after the action; everything: dropped at 300 s). Any non-2xx clears it; only a
  reap keeps it. An action's outcome is the status line and nothing else: never `_fail`, not
  even its 429 arm (`_pauseFor` is the one escalation).
- Look native or do not ship: only `qs.Ui` + `qs.Commons`, no hardcoded colours, sizes,
  radii or font families. `docs/design.md` is the spec, `docs/omarchy-shell-reference.md`
  the component reference.
- Rate limit is 200 req/min per token. Idle polling is ≈17/min (deployments 4 s,
  resources 60 s, servers 120 s, topology one block per 40 s from a ≥600 s cycle, or one
  per 10 s while a panel is open and the first drain has not completed; the 65 s
  `/projects` kick is skipped once it has), ≈36/min
  with a deployment; no 60 s window may reach 20 with the panel closed (≈ 20 with a panel
  open, ≈ 24 during the first topology drain with a panel open, measured). See the schedule in `docs/architecture.md`.

## Layout

```
manifest.json      plugin manifest (service + bar-widget)
Service.qml        polling, state store, actions, diff → notifications, config watch, IPC
BarWidget.qml      bar icon states + Panel loader (serviceFor lookup)
Panel.qml          KeyboardPanel: hero, chips, deployments, servers, resources, actions
Model.js           pure: parse/normalise/diff/group/label/format (.pragma library)
Api.js             pure: curl config text per endpoint, response splitting
Mark.qml           (later) Coolify mark as a Shape, if the glyph reads badly
tests/run.js       node vm runner for Model.js + Api.js
tests/fixtures/    recorded API responses, secrets replaced, uuids kept
bin/check          node tests + omarchy plugin validate + qmllint
bin/dev-sync       copy plugin files into ~/.config/omarchy/plugins/<id>/
bin/dev-watch      inotify loop around dev-sync (runs tests on a .js save)
bin/record-fixture curl one endpoint into tests/fixtures/ with secret values scrubbed
docs/              product, architecture, design, roadmap, API + shell references
```

Installed plugin: `~/.config/omarchy/plugins/io.github.danjonesio.omarify/`
Config: `~/.config/omarify/config.json`
State: `~/.local/state/omarify/recent.json`
Shell source (read only, never edit): `/usr/share/omarchy/shell`

Files that ship into the plugin dir: `manifest.json LICENSE README.md Service.qml
BarWidget.qml Panel.qml Model.js Api.js` (+ `Mark.qml`, `preview.png` when they exist).
`docs/`, `tests/`, `bin/` stay in the repo.

## Commands

```sh
# tests and static checks
node tests/run.js
bin/check                        # tests, fixture-secret and PlainText gates, validate of a staged copy, qmllint
bin/check --no-shell             # the CI-able subset (no omarchy, no Qt)
# qmllint only resolves `import qs.Ui` from an import root that contains qs/; bin/check
# builds one in a temp dir (qs -> /usr/share/omarchy/shell). `-I /usr/share/omarchy/shell`
# alone resolves nothing and exits 0.
bin/record-fixture servers /servers   # record a scrubbed GET fixture (POST bodies are pasted by hand through the same scrubber)

# dev loop (validator refuses symlinks, so copy)
bin/dev-sync                     # Panel/Bar QML hot-reload sometimes; Service.qml and Panel.qml changes need `omarchy restart shell`
bin/dev-watch                    # keep syncing on save
omarchy plugin enable io.github.danjonesio.omarify right   # first time
omarchy-shell shell rescanPlugins                          # if not picked up
omarchy plugin enable io.github.danjonesio.omarify --before omarchy.tray   # re-enable keeping placement
omarchy plugin remove io.github.danjonesio.omarify         # safe rollback: moves the dir to .<id>.bak.<ts>
# never `omarchy refresh shell`: it resets shell.json to defaults and drops every third-party widget

# drive it
omarchy-shell shell toggle io.github.danjonesio.omarify
omarchy-shell io.github.danjonesio.omarify refresh
omarchy-shell io.github.danjonesio.omarify status
omarchy-shell io.github.danjonesio.omarify status | jq '{baseline, notify, recentPersisted, recentRejected, terminalQueue, drainRetries}'   # Phase 3 fields
quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E 'omarify (notify|recent|drain) '   # unanchored: the log prefixes "DEBUG qml:"
omarchy-shell io.github.danjonesio.omarify deploy|restart|stop|start <uuid>   # -> "queued <verb> <uuid>" | "unknown uuid <uuid>" | "not applicable <verb> <uuid>" | "already pending <uuid>" | "busy" | ...; no confirm; read the outcome from `status | jq .lastAction`

# rollback of a Phase 3 build (placement in shell.json survives; a notify{} block and recent.json are ignored by Phase 2; bin/check stays green)
git checkout b38379c -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js && bin/dev-sync && omarchy restart shell

# logs
quickshell log -p /usr/share/omarchy/shell --tail 100
omarchy restart shell            # after Service.qml, Panel.qml or manifest changes (hot reload keeps the old objects)
```

Saving under `~/.config/omarchy/plugins/` triggers a plugin reload, but in practice the
old `Service.qml` and `Panel.qml` objects stay alive (the bar keeps rendering the previous
panel and the previous service keeps polling), so `omarchy restart shell` is required after
changing either. `BarWidget.qml`-only edits sometimes take without it.

Poking the API by hand (token from the config file, never pasted into a shell history):

```sh
# token via the shell builtin printf on stdin: never in argv, never in a temp file
tok=$(jq -r '.instances[0].token' ~/.config/omarify/config.json)
printf 'url = "%s"\nsilent\nheader = "Authorization: Bearer %s"\nheader = "Accept: application/json"\n' \
  https://app.coolify.io/api/v1/deployments "$tok" | curl -q -S -K - | jq .
# or, scrubbed straight into a fixture:
bin/record-fixture deployments-active /deployments
```

## Coolify facts that bite

- Apps carry only integer `environment_id` / `destination_id`, never a project or
  server uuid. `GET /resources` is the flat everything with status and
  `environment_id`; `GET /projects/{uuid}` returns environments with the integer `id`
  that joins them; `GET /servers/{uuid}/resources` gives server membership. Do not use
  `GET /projects/{uuid}/{env}` (it omits keydb/dragonfly/clickhouse and costs one call
  per environment).
- curl resets every per-transfer option at `next`. A batched config repeats `max-time`,
  `max-filesize`, `proto`, both headers and `write-out` in every block, and `-w` in
  argv emits one trailer for the whole batch, not one per transfer.
- `GET /deployments/applications/{uuid}` returns `{count, deployments[]}`; the openapi
  says `Application[]` and is wrong.
- Deployment `logs` need `read:sensitive` and are a JSON string inside JSON; parse twice.
- Container log endpoints return 400 when the container is not running. Service logs
  need `sub_service_name` equal to `applications[].name` from `GET /services/{uuid}`.
- `403` means one of three things: API disabled (self-hosted), IP not allowed, or a
  missing ability. Read `message`.
- `deployment_url` is a relative path; `POST /deploy` reports a full queue (`queue_full`)
  inside a 200; validate and a service/database restart have no observable end state;
  a lifecycle POST block carries `request = "POST"`, a JSON `Content-Type` and
  `data-raw = "{}"` (never `data`, which reads a file for a leading `@`); never `location`.
- Coolify refreshes stored statuses about once a minute. After an action, show
  "pending" and wait; do not poll the resource faster to compensate.
- Cloud (`https://app.coolify.io`) has the API always on and no IP allowlist.
  Self-hosted must enable it in Settings → Advanced.
- No pagination anywhere except app deployment history (`skip`, `take`).

## Omarchy facts that bite

- Bar widgets exist once **per monitor**. State lives in the service; the widget and
  panel only render it. Never put a poller in the widget.
- `settings` from `shell.json` do not include manifest `defaults`. Every read has a
  fallback.
- `omarchy-shell shell summon <id> '<json>'` on a bar-widget-only plugin drops the
  payload. Do not design a feature on it.
- `PanelHero`'s icon loader does not size children; set `width`/`height` to
  `hero.iconSize` (omasnitch lesson).
- JetBrainsMono Nerd Font maps some Material codepoints to the wrong glyph. Check
  every glyph in the bar before committing to it; a `Shape` mark is the fallback.
- Rows never colour from `containsMouse`; hover writes the panel cursor and
  `hasCursor` paints. That is the `CursorSurface` contract.
- ListView models get plain objects from `Model.js`, never live QObjects.
- Notifications go through `omarchy-notification-send --app-name <plugin id>` (see the
  DND lock for the one exception), so they respect Do Not Disturb and land in history.
  Never `notify-send`. The helper keeps parsing options after the headline, so every
  positional passes `Model.notifySafe` (a commit message of `--app-name=omarchy-action`
  would otherwise set the sender). `--exec` must be last and swallows the rest of argv.
  The toast body is `StyledText` (escape `&` and `<`); the summary is PlainText.
  Critical toasts never expire and the notifications plugin replays an open one after a
  shell restart; history keeps the newest 10 across all apps, at 0644, with the argv.
  `Util.execArgv` is a login shell: ≈ 115 ms per toast.
- `FileView` has no mode API and its atomic write is a rename, so the directory is the
  permission control; `mkdir -m` is create-only, so an existing directory needs `chmod`.
  `onLoaded` can fire twice at start; without an `onLoadFailed` branch a missing file
  is never created. `Req.arg` is the Api descriptor list `_finish`/`_dispatch` index;
  per-request bookkeeping goes on its own property (`deploymentReq.inflight`).
- The quickshell log prefixes every line with `DEBUG qml:`; grep `omarify notify `
  unanchored. `_notifyLog`, `_actionLog` and `_requestLog` are filter-push-reassign
  rings of bare timestamps.
- `Util.execArgv` for anything containing data; `bar.run` only for literal strings.
- `PanelKeyCatcher` owns keys: `x` reaches the panel as `deleteRequested`, Esc as
  `closeRequested`, `h`/`l` as `moveRequested(±1, 0)`; Return fires both
  `returnRequested` and `activateRequested`. Never add a `Keys.onPressed`.
- `bar.barForeground` for anything painted in the bar strip, `bar.foreground` in panels.
- `ConfirmDialog` is driven from `PanelKeyCatcher` signals (`handleKey` needs a raw
  `KeyEvent` from a `Keys.onPressed`); it preselects Confirm and moves selection on
  hover, so reset `selectedIndex` on open and arm it 250 ms later. `Button` has no
  `hoverColor`: `foreground: root.urgent` tints the label and the hover fill. A `Timer`
  cannot live in `KeyboardPanel`'s content list (Items only).
- `Process` and `StdioCollector` have no `parent`; write to ids, read `.text` in `onExited`.
- `dev-sync` copies because the validator refuses symlinks *inside* a plugin folder and
  inotify through a symlinked dir is unverified.
- `tokenCommand` keeps the token off disk but not away from other plugins loaded into
  the same shell: `shell.serviceFor()` has no caller check.

## Don't

- Don't add a daemon, a Python collector, or a second Quickshell.
- Don't put the token in argv, `console.*`, state files, or `shell.json`.
- Don't fake metrics, progress percentages or "started" events the API does not give.
- Don't notify on the baseline poll, and don't gate a notification on `_baselineDone`.
- Don't write `recent.json` from a property change or from `_resetStore`.
- Don't put a Coolify string into `omarchy-notification-send`'s argv without
  `Model.notifySafe`, and don't build that argv anywhere but `Model.notifyPlan`
  (`bin/check` SR16).
- Don't put anything but the Api descriptor list in `Req.arg`.
- Don't hardcode a colour, radius, size or font family.
- Don't create your own `PanelWindow` for the bar popup; `KeyboardPanel` exists.
- Don't edit `/usr/share/omarchy`.
- Don't call create/delete/env-var endpoints. Read, deploy, lifecycle, validate only.
- Don't commit fixtures with real tokens; uuids and names are fine.
- Don't route an action result through `_fail` (not even its 429 arm), and don't store
  objects in `_requestLog` (both filters subtract bare timestamps).
- Don't let the panel or a reviewer run `bin/dev-sync` or any `--delete` tool against a
  real path; staging is `OMARIFY_DEST=$(mktemp -d)/plugin`.

## Docs

- `docs/product.md` — what, for whom, feature map, what the API cannot do, open questions
- `docs/architecture.md` — runtime contract, config, HTTP client, polling, state, notifications, actions, security
- `docs/design.md` — bar icon states, panel anatomy, keyboard map, states, notification copy
- `docs/roadmap.md` — phases with acceptance criteria
- `docs/coolify-api.md` — API reference distilled from docs + openapi + source (2026-09-06)
- `docs/omarchy-shell-reference.md` — plugin runtime and `qs.Ui` component catalogue (Omarchy 4.0.0.alpha)
- `docs/reference/coolify-openapi-v4.3.17.yaml` — the authoritative endpoint list
