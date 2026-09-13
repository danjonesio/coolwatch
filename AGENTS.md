# AGENTS.md

Operating notes for anyone (human or agent) working in this repo.

Coolwatch is a native Omarchy shell plugin for **Coolify** (Cloud and self-hosted). One
bar icon, one panel: servers, projects, resources and their status, running and queued
deployments, and the actions to deploy, redeploy, restart, stop, start and cancel.
Notifications when deployments queue, build, finish or fail. It is a Quickshell plugin
that runs inside `omarchy-shell`; there is no daemon and no second process.

Status: **Phases 1 ("see"), 2 ("act"), 3 ("notify") and 4 (depth: build logs, container
logs, history, tag deploy; instances: one `InstanceCtx` per configured Coolify, chips,
per-instance state files) all merged (PRs #6–#8 on 2026-09-12); manifest 0.6.0.**
Read `docs/roadmap.md` before writing code.

## Product locks

- Plugin id: `io.github.danjonesio.coolwatch`. Repo: `git@github.com:danjonesio/coolwatch.git`.
  (Was `io.github.danjonesio.omarify` in the `omarify` repo until 2026-09-12. The rename is
  a **hard cut**: nothing reads `~/.config/omarify/` or `~/.local/state/omarify/`, and the old
  plugin dir must be removed by hand. The older omasnitch id used `danjones`; the GitHub
  handle is `danjonesio`.)
- REST API only, no SSH. Anything the plugin shows comes from the REST API. Sentinel
  metrics over SSH were dropped from the roadmap on 2026-09-13 (Dan): no SSH client,
  agent, host key or tunnel inside the shell process. If Coolify ever exposes metrics
  over the REST API, that is a normal read endpoint and feature-detected like any other.
- Token abilities are per phase. **Phase 2: `read` + `deploy`.** Coolify's UI has no
  edit-abilities flow, so a new token is swapped in, not edited.
  `read:sensitive` is added in Phase 4 for the log viewer; it also makes
  `GET /deployments` carry every deployment's full build log on every poll, so do not
  hold it before then; the two log-bearing kinds run with `max-time` 12 and a 4 MB
  `maxBytes` per descriptor so a verbose build cannot take the deployments poll into
  backoff. `write` is optional and only gates "Validate server".
- Failed deployment and unreachable server notify at `critical`; everything else
  `low`/`normal`. The shell shows a toast through Do Not Disturb only when its app name
  is `omarchy-action` (`plugins/notifications/NotificationLogic.js:118-122`); a plugin-id
  sender at `critical` is silenced to history. So every toast carries the plugin id
  **except** a critical event while DND is on, which is sent as `omarchy-action` (Dan,
  2026-09-07; it shows as that sender in history). `Model.notifyPlan` decides it from a
  boolean the service read from the notifications service, never from Coolify data.
- Phase 4 views (build log, container log, service picker, history, tags) are one-shot,
  panel-driven fetches on their own `Req`s (`logReq`, `historyReq`, `serviceReq`), settled
  by `_viewDone` from the same three sites as `_drainDone`. Their failure is a message in
  the view and nothing else: never `_fail`, `_error`, `_backoff`, `_probeMode` or
  `consecutiveFailures`, and a success never lifts probe mode; only a 429 pauses (SR29).
  The active build's log is read off the deployments poll that already carries it and the
  terminal body off the drain: **no log poller**. Log text lives in the service's view
  slices (`views`, beside `snapshot`) and the panel's overlay model only; it never enters
  `snapshot`, `_status()`, `recent.json`, a `console.*` line or a toast (SR26).
- Config accepts `token` and `tokenCommand`; `tokenCommand` wins when both are set.
- Edit config (Phase 5 prep): the callout's button and `e` call the service's
  `editConfig()`, the one place the service writes the config file, and only when none
  exists (umask 077, `Model.SAMPLE_CONFIG_FILE` with a placeholder token); then
  `omarchy-launch-config-editor` through `Util.execArgv`. Shown only on the callouts the
  file can fix (`Model.calloutEditable`: noconfig, configerror, unsafe, tokencmd, auth,
  the permissions warning). No settings UI: polling and toggles stay in the file.
- `instances[]` may hold several Coolifys (Phase 4). Each `id` is one path segment
  (`[A-Za-z0-9_-]{1,32}`, unique) because it names a state file and an IPC argument; a
  URL with credentials is a config error; the same origin twice is a warning, not an
  error (toasts arrive twice). Every store, timer, request, ledger, baseline, pending
  map, notify state and state file is per instance (`Service.qml`'s `InstanceCtx`); the
  root keeps the config file, the panel registry, the per-shell toast budget and the
  reaper. `snapshot`, `bar`, `views`, `pending` and the action surface mirror the
  **active** instance; the bar icon follows it and its tooltip names another instance's
  trouble. Switch with the chips, `h`/`l` on the hero, a middle-click on the icon or
  `omarchy-shell … instance <id>`; a switch pops every view. IPC verbs resolve against
  the active instance only; the confirm dialog carries the instance it was opened on and
  the service refuses with "Instance changed; nothing sent" on a mismatch;
  `status.lastAction.instance` names it. `instances[0]` keeps `recent.json`; every
  further instance writes `recent-<id>.json`; every file written now carries `id` and a
  file with an `id` is rejected by any other instance. Reordering `instances[]` moves
  which file the first entry reads. A second entry on the same account is the test
  configuration, not a product one.
- Kinds: `service` + `bar-widget`, `keepLoaded: true`. The service owns polling, state,
  actions and notifications. The bar widget owns the icon and loads `Panel.qml`. No
  `panel`/`overlay` kind unless Phase 5 says so.
- Data comes from the Coolify REST API only (`/api/v1`, Bearer token). No CLI, no MCP,
  no webhooks, no WebSocket, no SSH.
- **The API has no CPU/memory/disk numbers.** Do not invent utilisation. Phase 1 shows
  none and says why. Sentinel-over-SSH was dropped on 2026-09-13; there is no plan to
  read metrics from anywhere but the REST API.
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
  per kind:uuid:event), critical-first ordering, â¤ 3 resource toasts per flush plus one
  summary, â¤ 12 non-critical per minute; critical is never capped. A `notify`-only
  config edit applies live with no store reset; a malformed toggle warns and keeps its
  default. `recent.json` is written from the deployment arms only (the drain when a
  terminal record lands; the deployments poll after a dismiss, via `_recentDirty`), never
  from a property change, a click or `_resetStore`; the state dir is created and chmod'ed
  0700 before the first write. Dismiss (`x` or the strip on a terminal deployment row) is
  local and an acknowledge: `Model.dismissRecent` flags that entry **and every older one**
  (a promotion of the next build looks like nothing happened; Dan, 2026-09-13), the panel
  hides them at any age, `hasTerminal` still sees them, and `act()` refuses the verb as
  `nav`. Every terminal row shows a `×` (`G.dismiss`) that does the same on one click. The
  deployments section never goes blank while an undismissed terminal entry exists: the
  newest stays past the hour window. Row names pass `Model.appLabel` (resources and
  deployments), so the panel and the toasts agree.
- Toast click (Phase 4b): a failed build's toast tail is `--exec omarchy-shell <plugin id>
  log <uuid>` (still last, the uuid through `UUID_RE` and `notifySafe`, built only in
  `Model.notifyPlan`; `bin/check` SR16 pins the shape), unless the context's `_sensitive`
  is `no`, when the browser tail stays (`ctx.logClick`). The `log` IPC verb is the one verb
  that looks past the active instance: it switches to the context holding the uuid, parks
  `root.viewRequest` and summons the bar widget through the scoped shell (never a payload:
  a bar-widget summon drops it; never a panel reference on the service). The open panel
  takes the request once (`takeViewRequest`, stale after 5 s) and routes
  `Model.logRequestRow` through `openLogsFor`.
- Row polish (Phase 4b): a running resource's status words are its health word alone
  (`Model.statusWords`; the dot carries the state); a name that still elides shows a
  `PanelToolTip` on the cursor row (resources and deployments), bound to `Text.truncated`
  and `rowDelegate.selected`, never `containsMouse`. `Model.countsLine` appends `· N stopped`
  (exited, paused) and `· N unhealthy` (running:unhealthy, degraded) so the hero meta and
  the bar tooltip agree.
- Type-to-filter (Phase 4b): `/` opens a field whose text narrows resources and deployments
  (`Model.panelRows` `filter`, `Model.filterTerms` / `rowMatches`: space-separated terms all
  match, case-insensitive, against name, status, kind and caption words). Folds with a match
  are forced open without touching the persisted flag, folds without one hide, tags hide,
  servers are untouched, an emptied section shows "No match.". Panel-local, per monitor,
  cleared on close, never in `ui.json`.
- Grouping and folds are the service's, not the panel's (Phase 4b): `root.ui` keyed by
  instance id, mirrored by every monitor's panel through `activeUi`, persisted to
  `~/.local/state/coolwatch/ui.json` (one file for all instances; `Model.parseUi` /
  `serialiseUi`; a rejected file yields the defaults and the next gesture replaces it). A
  gesture (`g`, the toggle, a fold row) calls `setUiGroupBy` / `toggleUiFold`, which mark the
  map dirty; `uiFlush` writes it one second after the last gesture, never the click itself,
  never `_resetStore`, never before the load settled. Entries for ids no longer configured
  are pruned on write; a re-pointed id keeps its grouping and drops its folds (origin check).
- HTTP is `curl -q -S -K -` in a `Quickshell.Io.Process` with the config on **stdin**;
  nothing else is in argv (`-q` first ignores `~/.curlrc`). Every per-transfer option
  (`max-time`, `max-filesize`, `proto`, headers, `write-out`) lives in every config
  block because curl resets them at each `next`. stdin is closed with
  `stdinEnabled = false` right after the write, which is what makes curl start. The
  token never goes in argv, never in logs, never in state files.
- Config lives in `~/.config/coolwatch/config.json` (0600), not in `shell.json`.
  `token` or `tokenCommand`. Watched live.
- Status strings have colons (`running:healthy`). Prefix-match the state; treat bare
  `exited` and `exited:unhealthy` as the same. Deployment terminal states are
  `finished`, `failed`, `cancelled-by-user`.
- Lifecycle endpoints are POST only. Restart of an application is itself a deployment
  (`restart_only: true`) and will appear in the deployments list.
- Stop, Rebuild-without-cache (`D`, keyboard only), Cancel and tag deploy (`d` or Enter on
  a tag row resolves to `deployTag`, never the per-application deploy) confirm (in the
  panel). Deploy, Redeploy, Restart, Start, Validate do not. CLI verbs never confirm: typing the
  verb is the confirmation.
- One deploy button follows the state: Deploy on a stopped application, Redeploy on a
  running one (both `POST /deploy`; `d` and IPC `deploy` resolve the same way). Only
  applications get it (`POST /deploy` accepts services and databases but that is Start
  under another name). A left click on a row opens its strip; the buttons are clickable. A strip of more than four
  buttons folds: the lifecycle verbs plus **More** on the first line, Logs · History · Open beneath once More is open
  (`Model.stripFor`; More is panel state, never a verb; text keys reach a folded button). The ListView model is a
  `ListModel` patched in place by key (`Model.listPatch`), never reassigned: a swap resets the scroll. Open targets the resource's
  Coolify page, built from the instance origin; never `fqdn`. No page â no Open button.
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
- Rate limit is 200 req/min per token. Idle polling is ≈11/min (deployments 8 s with
  every panel closed and nothing deploying, `deploymentsSec` = 4 s with a panel open, the
  byte-stepped 2 s cadence while a build runs; the 17/min figures below predate the 8 s
  idle of 2026-09-13; `Model.IDLE_DEPLOYMENTS_SEC`),
  resources 60 s, servers 120 s, topology one block per 40 s from a â¥600 s cycle, or one
  per 10 s while a panel is open and the first drain has not completed; the 65 s
  `/projects` kick is skipped once it has), â36/min
  with a deployment; no 60 s window may reach 20 with the panel closed once the service
  has settled (the first minute after a shell restart holds the startup burst of four
  kinds at token-ready plus the 65 s `/projects` kick and reached 20 once, measured
  2026-09-12; the closed-panel ceiling applies once no panel has been open for 60 s, and timer
  jitter can put a sixteenth deployments poll into a window, so a lone 20 is not a defect; â 20 with a panel
  open, â 24 during the first topology drain with a panel open, measured). See the schedule in `docs/architecture.md`.
  Phase 4: while a build runs the deployments interval is byte-stepped (2 s under 256 KB
  of body, then 4 / 8 / 15 s at 256 KB / 1 MB / 4 MB; `Model.deploymentsInterval`); the
  views are user-driven one-shot fetches (`L`, `r`, History pages, the picker), throttled to
  one launch per second, and `/tags` runs once per panel open at most once a minute. Measured
  2026-09-12 with all of that: 19 closed, 22 open during the first drain, 29 with a build
  running and the log view open. With several instances the gate is **per instance**
  (the 200/min limit is per token): each `status.instances[].requestsLastMin` stays under
  20 with the panel closed once settled, with the same allowances as above (a panel open
  primes and drains every context at once: ≤ 24 per instance in the window after it
  opens), and `requestsTotalLastMin` is reported alongside (measured 2026-09-12 with two
  entries on one account from a quiet start: 17–19 each, 35–38 total; 24 each in the
  window after a panel opened).

## Layout

```
manifest.json      plugin manifest (service + bar-widget)
Service.qml        polling, state store, actions, diff â notifications, config watch, IPC
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

Installed plugin: `~/.config/omarchy/plugins/io.github.danjonesio.coolwatch/`
Config: `~/.config/coolwatch/config.json`
State: `~/.local/state/coolwatch/recent.json`, `ui.json`
Shell source (read only, never edit): `/usr/share/omarchy/shell`

Files that ship into the plugin dir: `manifest.json LICENSE README.md Service.qml
BarWidget.qml Panel.qml Model.js Api.js` (+ `Mark.qml`, `preview.png` when they exist).
`docs/`, `tests/`, `bin/` stay in the repo.

## Commands

```sh
# tests and static checks
node tests/run.js
bin/check                        # tests, fixture-secret and PlainText gates, shellcheck over bin/ (skipped with a note when not installed; required in CI), validate of a staged copy, qmllint
bin/check --no-shell             # the CI-able subset (no omarchy, no Qt); GitHub Actions runs it on every push to master and every PR (.github/workflows/check.yml)
# qmllint only resolves `import qs.Ui` from an import root that contains qs/; bin/check
# builds one in a temp dir (qs -> /usr/share/omarchy/shell). `-I /usr/share/omarchy/shell`
# alone resolves nothing and exits 0.
bin/record-fixture servers /servers   # record a scrubbed GET fixture (POST bodies are pasted by hand through the same scrubber)
# gate self-test (Phase 3 step 8 shape): cp -r the repo into $(mktemp -d), drop a probe under its tests/fixtures/, then COOLWATCH_ROOT=<copy> bin/check --no-shell
# build-log fixtures are hand-written entry arrays under "entries" and container text under "text": no fixture ever holds a "logs" value (bin/check SR31)

# dev loop (validator refuses symlinks, so copy)
bin/dev-sync                     # Panel/Bar QML hot-reload sometimes; Service.qml and Panel.qml changes need `omarchy restart shell`
bin/dev-watch                    # keep syncing on save
omarchy plugin enable io.github.danjonesio.coolwatch right   # first time
omarchy-shell shell rescanPlugins                          # if not picked up
omarchy plugin enable io.github.danjonesio.coolwatch --before omarchy.tray   # re-enable keeping placement
omarchy plugin remove io.github.danjonesio.coolwatch         # safe rollback: moves the dir to .<id>.bak.<ts>
# never `omarchy refresh shell`: it resets shell.json to defaults and drops every third-party widget

# drive it
omarchy-shell shell toggle io.github.danjonesio.coolwatch
omarchy-shell io.github.danjonesio.coolwatch refresh
omarchy-shell io.github.danjonesio.coolwatch status
omarchy-shell io.github.danjonesio.coolwatch status | jq '{baseline, notify, recentPersisted, recentRejected, terminalQueue, drainRetries}'   # Phase 3 fields
omarchy-shell io.github.danjonesio.coolwatch status | jq .ui   # Phase 4b: {loaded, rejected, entries, dirty} for ui.json; the log says "coolwatch ui loaded N" or "coolwatch ui rejected"
omarchy-shell io.github.danjonesio.coolwatch status | jq '{logView, buildLogsHeld, history, tags, sensitive, dep: (.perKind.deployments | {lastBytes, bytesLastMin, skipped})}'   # Phase 4 fields, counts only
quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E 'coolwatch (notify|recent|drain|logview) '   # unanchored: the log prefixes "DEBUG qml:"
quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E 'coolwatch [A-Za-z0-9_-]+/(buildlog|containerlog|service|history|tags) '   # the view fetches ("<instance id>/<kind>" since Phase 4); a failure logs "<id>/<kind> view failed: <kind> http=<n>"
omarchy-shell io.github.danjonesio.coolwatch deploy|restart|stop|start <uuid>   # -> "queued <verb> <uuid>" | "unknown uuid <uuid>" | "not applicable <verb> <uuid>" | "already pending <uuid>" | "busy" | ...; no confirm; read the outcome from `status | jq .lastAction`; resolves against the active instance only
omarchy-shell io.github.danjonesio.coolwatch instances                          # -> "cloud (active), homelab"
omarchy-shell io.github.danjonesio.coolwatch instance homelab                   # -> "active homelab" | "unknown instance homelab"
omarchy-shell io.github.danjonesio.coolwatch log <deployment uuid>             # -> "log <uuid8>" | "invalid uuid": opens the panel on that build's log (a failed toast's click); the log says "coolwatch ipc log <uuid8> -> summoned|open|no panel <instance id>"
omarchy-shell io.github.danjonesio.coolwatch status | jq '{activeInstance, requestsTotalLastMin, instances: [.instances[]|{id, configState, requestsLastMin, sensitive, paused, error}]}'   # Phase 4 instances; top-level keys mirror the active one
omarchy-shell io.github.danjonesio.coolwatch status | jq '[.instances[]|{id, requestsLastMin}]'   # the rate gate, per token
quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E 'coolwatch [A-Za-z0-9_-]+/(deployments|resources|servers) '   # per-request, failure and reaper lines carry "<instance id>/<kind>" since Phase 4 (ids may hold capitals); "coolwatch notify|recent|drain|logview|action " lines do not

# rollback of a Phase 4 instances build to the depth build (a second instances[] entry is validated and ignored by the depth build;
# recent-<id>.json files are ignored; recent.json's optional id field is ignored by the older parseRecent)
git checkout 2f2c4c2 -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js tests/run.js && bin/dev-sync && omarchy restart shell
# rollback of a Phase 4 depth build to the read:sensitive hotfix (placement in shell.json survives; recent.json is unchanged in format;
# bin/check and bin/record-fixture stay at Phase 4 and are green against these files; tests/run.js goes back too)
git checkout e64f1fa -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js tests/run.js && bin/dev-sync && omarchy restart shell
# rollback of a Phase 3 build (a notify{} block and recent.json are ignored by Phase 2)
# every commit at or below d194b86 predates the coolwatch rename: files restored from there carry the old id, config/state paths and `omarify …` log prefixes, and bin/dev-sync refuses the target; re-run the rename sweep on anything checked out from before dac3dff
git checkout b38379c -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js tests/run.js && bin/dev-sync && omarchy restart shell

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
tok=$(jq -r '.instances[0].token' ~/.config/coolwatch/config.json)
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
- Container log endpoints return **404 `Container not found.`** when the container is not
  running (the docs say 400; verified on 4.3.19). Service logs need `sub_service_name`
  equal to `applications[].name` or `databases[].name` from `GET /services/{uuid}`;
  without it the answer is 400 `Sub service name is required.`.
- A build log's first entry has no `order` key (the rest run `2..n`): the array index is
  the identity. `POST /deploy?tag=` answers `{details: [{resource_uuid,
  deployment_uuid}], message: [..]}`, not the documented `deployments` array. `GET /tags`
  carries no membership and only `/applications` takes `?tag=`, so a tag's fan-out cannot
  be listed before deploying. The servers list's `proxy` holds only `redirect_enabled`.
- `403` means one of three things: API disabled (self-hosted), IP not allowed, or a
  missing ability. Read `message`.
- `deployment_url` is a relative path; `POST /deploy` reports a full queue (`queue_full`)
  inside a 200; validate and a service/database restart have no observable end state;
  a lifecycle POST block carries `request = "POST"`, a JSON `Content-Type` and
  `data-raw = "{}"` (never `data`, which reads a file for a leading `@`); never `location`.
- Coolify refreshes stored statuses about once a minute. After an action, show
  "pending" and wait; do not poll the resource faster to compensate.
- Cloud (`https://app.coolify.io`) has the API always on and no IP allowlist.
  Self-hosted must enable it in Settings â Advanced.
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
  `Util.execArgv` is a login shell: â 115 ms per toast.
- `FileView` has no mode API and its atomic write is a rename, so the directory is the
  permission control; `mkdir -m` is create-only, so an existing directory needs `chmod`.
  `onLoaded` can fire twice at start; without an `onLoadFailed` branch a missing file
  is never created. `Req.arg` is the Api descriptor list `_finish`/`_dispatch` index;
  per-request bookkeeping goes on its own property (`deploymentReq.inflight`).
- The quickshell log prefixes every line with `DEBUG qml:`; grep `coolwatch notify `
  unanchored. `_notifyLog`, `_actionLog` and `_requestLog` are filter-push-reassign
  rings of bare timestamps.
- `Util.execArgv` for anything containing data; `bar.run` only for literal strings.
- `PanelKeyCatcher` owns keys: `x` reaches the panel as `deleteRequested`, Esc as
  `closeRequested`, `h`/`l` as `moveRequested(Â±1, 0)`; Return fires both
  `returnRequested` and `activateRequested`. Never add a `Keys.onPressed` to the panel. The
  one exception is the shell's own inline-editor contract: the filter `TextField` (Phase 4b)
  has its own `Keys.onPressed` for Esc, Enter, Tab and Down and the catcher is
  `blocked: filterField.activeFocus` while it holds focus, exactly as the weather panel's
  location search does.
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
- Don't route a view fetch (`buildlog`, `containerlog`, `service`, `history`, `tags`)
  through `_fail` either: `_viewFail` sets the view's message and nothing else (SR29).
- Don't put log text in `snapshot`, `_status()`, a console line, a state file or a
  toast; `Model.logViewStatus` emits counts and a digits-only rev (SR26, `bin/check`).
- Don't add a log poller: the deployments poll and the drain already carry the log.
- Don't let the panel or a reviewer run `bin/dev-sync` or any `--delete` tool against a
  real path; staging is `COOLWATCH_DEST=$(mktemp -d)/plugin`.

## Docs

- `docs/product.md` â what, for whom, feature map, what the API cannot do, open questions
- `docs/architecture.md` â runtime contract, config, HTTP client, polling, state, notifications, actions, security
- `docs/design.md` â bar icon states, panel anatomy, keyboard map, states, notification copy
- `docs/roadmap.md` â phases with acceptance criteria
- `docs/coolify-api.md` â API reference distilled from docs + openapi + source (2026-09-06)
- `docs/omarchy-shell-reference.md` â plugin runtime and `qs.Ui` component catalogue (Omarchy 4.0.0.alpha)
- `docs/reference/coolify-openapi-v4.3.17.yaml` â the authoritative endpoint list
