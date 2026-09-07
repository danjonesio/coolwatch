# Omarify Phase 2 — "act" (actions, confirm, pending, status line, keyboard map, IPC verbs)

Repo `/home/danjones/Projects/omarify`, base `master` at `29f3a76`, branch `phase-2-act`. Dan merges. Build with `/deej-stack:d-implement`.

## Context

Phase 1 ("see") shipped a read-only bar icon and panel (PR #1, merged 2026-09-07). `docs/roadmap.md` Phase 2 turns the panel into the control surface: Deploy, Redeploy without cache, Restart, Stop, Start on a resource; Cancel on an active deployment; Validate on a server; Open in the browser on any row; a confirm dialog for the destructive ones; an optimistic pending verb on the row until Coolify's status sweep catches up; a status line for the outcome; the full keyboard map; and IPC verbs `deploy|restart|stop|start <uuid>`.

The planning panel found that `docs/design.md`'s Phase 2 text is not buildable as written on three points: `Ui/Button` has no `hoverColor`; `ConfirmDialog.handleKey` cannot "run first in the key catcher" because `PanelKeyCatcher` has no pre-hook and its only escape (`blocked`) emits nothing; and the dialog opens with the destructive button preselected and moves that selection on hover. It found that routing an action's failure through the Phase 1 `_fail` path (or even its 429 arm) leaves a permanent callout, because an action's error never matches a polled kind and `_succeeded` never clears it, and can stop all polling on a 401. It found that optimistic state written into `_resources`/`_deployments` is erased by the next poll; that `deployment_url` is a **relative** path; that `POST /deploy` reports a full queue inside a 200; that the API returns no observable end state for Validate or for a service/database Restart, so "clear pending when the status changes" never fires for them; and that the 90 s pending note is shorter than the latency the service's own intervals produce (Coolify's ≤ 60 s sweep plus a 60 s resources interval with the panel closed). This plan fixes each with evidence and reconciles the docs.

**Outcome.** With the panel open on any monitor, `j` to a resource row and Enter shows an action strip; `h`/`l` pick, Enter runs. `d` deploys immediately; `D` asks "Rebuild api without cache?"; `s` stops (after "Stop api?") or starts; `t` restarts; `x` on an active deployment asks "Cancel the deployment of api?"; `v` on a server validates; `o` or right-click opens the row's Coolify page. The row's caption becomes "stopping…" in the accent colour the moment the key is pressed and returns to Coolify's words when the next poll shows the change (or, for verbs with no visible end state, on the first poll after the action landed). A one-line status under the hero says "Stop requested" (2.2 s) or "Token lacks the deploy permission" (6 s). The bar icon and the callout never change because of an action outcome. `omarchy-shell io.github.danjonesio.omarify stop <uuid>` prints `queued stop <uuid>`. `bin/check` is green; the live runbook in Change 5 ticks every Phase 2 acceptance line and closes five of Phase 1's "needs human" items.

## Brief

**Ask (user's words):** "phase 2, opus 5 sub agents".

**Assumptions (stated, not asked):**
- Single instance (`instances[0]`) as in Phase 1. Chips are Phase 4.
- Pending state and the status line are in memory only. `recent.json` is Phase 3.
- Dan's current token is `read`-only. Change 0 proves it with a non-mutating probe **before any code that can fire an action is installed**; if the probe does not prove it, the run stops and a `read`-only token is created first.
- Dan creates a `read` + `deploy` token during Change 5 (ops reports Coolify's UI has no edit-abilities flow; unverified, and irrelevant to the recipe, which swaps a whole token either way).
- Cancel confirms (design.md's keyboard map). `docs/product.md` and `AGENTS.md`, which list only Stop and Redeploy, are corrected in Change 6.
- Validate is shown on server rows even when the token lacks `write`; its 403 becomes the status line "Token lacks the write permission". No ability is requested speculatively, so on Dan's token Validate is demonstrated only as that 403 (open question 5).
- Deploy and Redeploy appear only on applications. `POST /deploy` accepts services and databases but answers "Service X started…", which is Start under another name; those kinds get Start/Stop/Restart.
- Open targets the resource's **Coolify page**, never its `fqdn` (all five fixture resources have `fqdn: null`, and it is a user-typed string). Where no page URL can be built, the Open button is absent, the footer does not offer `o`, and `o` does nothing.
- The IPC surface is exactly `refresh status deploy restart stop start`. No `cancel`, `validate` or `redeploy` verb. CLI verbs do not confirm: typing the verb is the confirmation.
- No compensating polls after an action (AGENTS.md lock). The deployments poll runs at its 4 s / 2 s cadence; servers at 120 s.

**Out of scope:** notifications and `recent.json` (Phase 3); logs, history, chips, tag deploy, `read:sensitive` (Phase 4); SSH/Sentinel, overlay, marketplace (Phase 5); create/delete/env-var endpoints; server proxy status and `unreachable_count` (open question 7, default defer and amend the three docs that promise it); a CI workflow; any new `config.json` key; any new shipped file; an action queue.

## Findings from exploration

Verified by the panel against the repo at `29f3a76`, `/usr/share/omarchy/shell`, and curl experiments (curl 8.21.0 against a local listener).

- `Api.block` (`Api.js:37-47`) emits nine fixed lines per block and no method line, so every block is a GET. `Api.config` is called from exactly one place, `Service.qml:356`. A GET to a lifecycle route returns a "POST required" error (`docs/coolify-api.md:66`). `Api.js:3` states it never imports `Model.js`; `tests/run.js:13-19` loads each file into its own `vm` context so a cross-dependency fails in tests as it would in QML; `Model.js` contains no `Api.` reference.
- Measured: a stdin config of `GET / next / POST (request = "POST", Content-Type, data-raw = "{}") / next / GET` produced `GET /a` (no body), `POST /b` with `Content-Length: 2` and body `{}`, `GET /c` (no body). Method and body reset at `next`. `--data-raw`'s help text is "HTTP POST data, '@' allowed" (the `@` is literal). `data = "@file"` would read a local file.
- `Service.qml:363-365` `_finish` opens with `root._syncBusy()` then `if (p.liveSeq !== p.seq) return`; `Req.kill()` (`:329`) bumps `seq` so a reaped request's late `onExited` is a no-op. `:366-371` guards an empty curl stream with `curlExit: code || 1`. `_finish` routes every non-null `errorFor` result to `_fail` except the deployment 404.
- `_fail` (`Service.qml:537-559`) assigns `root._error = e` for every kind (`:543`), increments `consecutiveFailures` (`:539`), enters probe mode on `auth`/`apidisabled`/`ipblocked` (`:544-546`; `_timersOn` at `:82` stops every timer), pauses on `ratelimited` (`:547-553`: `_backoff.ratelimited`, `_backoffSec`, `_paused`, `pauseTimer`), and skips backoff only for `ability` (`:554`). `_succeeded(kind)` (`:522-527`) clears `_error` only when `_error.request === kind`; `Model.errorFor` sets `request: r.request || ""` (`Model.js:229`), and a `splitResponses` record has no `request`. `pauseTimer` clears `_paused`, never `_error`. `Model.callout` (`Model.js:585-600`) titles an `ability` error "Error" (`META.ability === ""`); `Model.isPartial` (`:462`) turns any `http` error with data present into "<kind> unavailable · showing last known".
- `_rejoin()` (`Service.qml:460-466`) rebuilds `root._resources` wholesale on every resources, servers and topology response; the deployments dispatch assigns `root._deployments = norm` (`:411`) and `root._activeUuids` (`:409`, the only writer). `_markPoll` (`:452-453`) maintains `_lastPollAt[kind]`. Anything written into the store is gone within one poll.
- `_launch` (`Service.qml:348-361`) refuses when `p.running || p.stopping` and checks nothing else; `p.arg = list` (`:353`); `_noteRequest(kind, list.length)` (`:358`) is the only place requests are counted. `_noteRequest`/`_requestsLastMin` (`:569-579`) filter an array of **bare timestamps** with `now - t < 60000` in two places; object entries would make both `NaN` and zero the counter forever. `_record` (`:529-535`) assigns `_rateLimitRemaining` when `r.headers.rateLimitRemaining !== null`, so a fallback record must carry the full `pickHeaders` shape.
- The reaper (`Service.qml:647-673`) runs every 5 s unconditionally, kills any `Req` past its deadline, writes `_backoff[kind]` and `consecutiveFailures`, and expires dead panels with a `changed` flag (`:668-670`). `_maxBackoffUntil()` (`:562`) reads every `_backoff` key. `Component.onDestruction` (`:677-686`) stops nine timers by id and kills `_reqs`. `_resetStore` (`:234-247`) runs on every differing config text (`:203-207`; same text is a fast path) and kills every `Req` in `_reqs` (`:245`).
- `_drainTerminal` (`Service.qml:512-519`) checks `_ready`, `_paused`, `_probeMode`, single-flight and backoff before `_launch`. `_lastPrimeAt` (`:597`) is a once-per-2 s refusal.
- `snapshot` (`Service.qml:84-92`) is one object-literal binding; `bar: Model.barState(snapshot)` (`:93`) recomputes per rebuild, per monitor. `Panel.qml:39-43` passes `{groupBy, folded, nowMs: ageMs}` to `Model.panelRows`; `ageMs` is floored to the minute (commit `03d0b0d`).
- `Model.rowRev` (`Model.js:731-735`) hashes `type, glyph|dot, tone, name|title|text, sub|statusWords, open, count, dim, kindHint, terminal, control`. `resourceRow` (`:665-669`) carries `kindHint` but not `kind`/`state`/`url`; `deploymentRow.sub` (`:646`) is `branch · commit message`; `serverRow.sub` (`:653-663`) is `ip · N resources · unreachable`. `SELECTABLE` (`:729`). `panelRows` (`:671-728`) has an early return at `:699` when there are no resources. `footerHints` (`:770`) takes two arguments and has a three-case test at `tests/run.js:588-592`.
- `Model.environmentsOf` (`Model.js:356-359`) keeps `{id, name}` and drops the environment `uuid` that `tests/fixtures/project-detail.json` carries. `tests/fixtures/deployments-active.json` `deployment_url` = `/project/iwo4oo0cw0kc8s4g8s0og88c/environment/vokooc88s8cssgow0ww44ssw/application/h0wxyg40kc0lz727dom9l03i/deployment/vdyasty4cmgyoekplcarxpfh`: relative; the environment segment is the environment uuid. `normaliseDeployment` (`:338`) stores it verbatim as `url`. All five resources in `resources.json` have `fqdn: null`. Topology stage 2 (`environmentUuid`) arrives ≥ 65 s after start and one block per 40 s, and `_resetStore` empties it, so resource-row Open is absent for the first minutes after a start or config change.
- `/usr/bin/omarchy-launch-browser:22` runs `uwsm-app -- "$browser_exec" "${@/--private/$private_flag}"`: the argument reaches the browser as a positional argv element with no `--` guard and no scheme check. `Commons/Util.qml:62` `execArgv(argv)` runs `bash -lc 'exec "$@"' bash <argv…>`: `"$@"` is not re-tokenised or globbed, so a URL stays one element.
- `Ui/PanelKeyCatcher.qml`: `blocked` (`:36`) returns before any signal (`:49`) and forwards raw keys to descendants; no pre-hook. Emit order: Esc → `closeRequested`, Tab → `tabRequested`, j/k → `moveRequested(0,±1)`, l/h → `moveRequested(±1,0)`, Return → `returnRequested` **then** `activateRequested`, Space → `activateRequested`, `x`/`X` → `deleteRequested` from any cursor position, else `textKey(text)`. `isAutoRepeat` is not filtered (`:51`). `Panel.qml:177-180` `onMoveRequested` starts with `if (!root.cursorActive) { root.cursorActive = true; return }`.
- `Ui/ConfirmDialog.qml`: props (`:7-18`); `selectedIndex` defaults to **1** (Confirm) and each button's `MouseArea` sets it `onEntered` (`:121`), so a pointer already over the Confirm cell selects it the moment the dialog appears; signals `canceled()`/`confirmed()` (`:20-21`); `handleKey(event)` (`:23`) needs a raw `KeyEvent`; the scrim `MouseArea` cancels on click but has no `hoverEnabled` (`:41-47`), so row hover handlers keep firing beneath it; button cells are `Style.space(88)` wide with an unelided caption `Text` (`:98,114`), about nine characters. First-party users hand-roll `Keys.onPressed` (`plugins/clipboard/Clipboard.qml:353`, `plugins/menu/Menu.qml:1075`); `Clipboard.qml:400-417` mounts it `anchors.fill: parent; z: 10` as a child of the key-handling item.
- `Ui/KeyboardPanel.qml:63` `default property alias contentItem: contentHolder.children`; `contentHolder` is a plain `Item { anchors.fill: parent }` inside a card sized from `contentWidth`/`contentHeight` (`:404-409`), so a `ConfirmDialog` sibling of the key catcher fills the content with no sizing loop and no `contentHeight` contribution.
- `Ui/Button.qml`: `iconText` (`:24`), `hasCursor` (`:30`), `focusable` default false (`:31`, `activeFocusOnTab: focusable` at `:65`), `bordered` (`:32`), `foreground/background/accent` (`:35-37`), `fontSize` (`:41`), `iconSpinning` (`:44`), signals `clicked/rightClicked/hovered` (`:61-63`), `implicitWidth` content-derived (`:73`), `hot = containsMouse || hasCursor` (`:77`); hover fill `Style.hoverFillFor(root.foreground, root.accent)` (`:114`); label colour `root.foreground` (`:185`). No `hoverColor` (that is `Ui/PanelActionButton.qml:33`, icon-only).
- `Ui/CursorSurface.qml:18` `property bool current` paints `Style.selectedFillFor`. `Ui/WidgetButton.qml:32,98` `signal pressed(int button)` accepts `Qt.RightButton`; `BarWidget.qml:61-63` handles only `Qt.LeftButton`.
- Tailscale: `plugins/panels/tailscale/Service.qml:41` `actionStatus`, `:357-365` `runAction`, `:438-441` `actionStatusTimer { interval: 2200; repeat: false }`, `:537` `restart()`; `Panel.qml:502-509` renders one caption `Text`, urgent for errors; `Service.qml:376` `Quickshell.execDetached(["omarchy-launch-browser", url])`. Bluetooth: `Panel.qml:932-948` row `MouseArea` with both buttons; `Panel.qml:92,366-373` `actionFocused`/`moveCursorH`. No first-party panel expands a row into buttons.
- Coolify API (`docs/coolify-api.md`; openapi v4.3.17, all `post:`): `POST /deploy?uuid=<u>[&force=true]` → `{"deployments":[{message, resource_uuid, deployment_uuid}]}`, `deployment_uuid` null for services/databases, per-item 429/`queue_full` inside a 200; `POST /applications/{u}/start|restart|stop` → `{message[, deployment_uuid]}`; `POST /databases|services/{u}/start|restart|stop` → `{message}`; `POST /deployments/{u}/cancel` → 200 `{message, deployment_uuid, status:"cancelled-by-user"}`, 400 "Deployment cannot be cancelled. Current status: finished"; `POST /servers/{u}/validate` (ability `write`) → 201 `{"message":"Validation started."}`, async, result only via `GET /servers/{uuid}` (out of scope); ability 403 `{"message":"Missing required permissions: deploy"}`; `write` is the whole write API; a non-admin team member's token carrying `deploy` is rejected with 403 on every call (`:50`); rate limit 200/min per **user**.
- Budget: measured idle, panel closed, max 19/min. Derived (never measured): panel open idle ≈ 20/min; deploying with the panel open ≈ 38–40/min (deployments 2 s = 30, resources 15 s = 4, servers 0.5, topology ≤ 3, terminal drains). Headroom under the self-imposed 60/min line is ≈ 20/min; under the API's 200/min it is ≈ 160.
- Latency after an action: Coolify sweep ≤ 60 s plus the resources interval (`Service.qml:79`: `min(cfg 60, deploying ? 15, panelOpen ? 30)`), so up to **120 s** with the panel closed, 90 s open, 75 s while deploying. `_serversSec` (`:80`) is 120 s with no panel or deploying term.
- Live now (read-only `status`): `requestsLastMin: 18`, `rateLimitRemaining: 197`, `counts {servers: 1, resources: 7}`, `error: null`. `~/.config/omarchy/plugins/io.github.dougfour.grok-usage/` exists and is enabled (the Phase 1 build record's "restore grok-usage" row is closed). `$XDG_RUNTIME_DIR` is `/run/user/1000`, mode 0700. `README.md:8` and `AGENTS.md:11` still say "Phase 1 … in progress".
- `bin/dev-sync:24-27,35`, `bin/check:33-46` and `AGENTS.md` all list the ship files; this plan adds none. `bin/check --no-shell` runs the whole of `tests/run.js`; its PlainText/font-parity gates (`bin/check:17-24`) and literal grep (`:26`) cover new `Text` blocks and buttons unchanged. `bin/record-fixture` is GET-only; three fixtures are hand-written with a `_note` key. `node tests/run.js` → 47 passed.

## Design

### Caller's usage first

```qml
// Panel.qml: one funnel for a Button click, a text key, or the confirm's onConfirmed
function runAction(verb, key) {
  var row = root.rowsModel[Model.indexOfKey(root.rowsModel, key)]
  if (!row || !svc) return
  var a = Model.actionFor(row, verb)                  // null when the verb does not apply to this row
  if (!a) return
  if (a.confirm && !root.confirmOpen) { root.openConfirm(a.id, row); return }
  svc.act(a.id, row.uuid)                             // "queued" | "unknown uuid" | "not applicable" | "already pending" | "busy" | …
}
function openRow(row) { if (row.url) Util.execArgv(["omarchy-launch-browser", row.url]) }   // rows carry a ready URL or ""
```

```qml
// Service.qml: one public entry for the panel, both monitors, and the IPC verbs
function act(verb, uuid): string
readonly property var    pending                     // { "<uuid>": { verb, since, stale, … } }  (memory)
readonly property string actionStatus                // "" | one line; cleared by actionStatusTimer
readonly property string actionTone                  // "dim" | "urgent"
```

```sh
omarchy-shell io.github.danjonesio.omarify stop 4kgw0…      # → queued stop 4kgw0…
omarchy-shell io.github.danjonesio.omarify deploy deadbeef  # → unknown uuid deadbeef   (zero requests)
omarchy-shell io.github.danjonesio.omarify status | jq '{lastAction, pending, pendingStale, actionsLastMin, requestsLastMin, inflightAction}'
```

Pending flows back the way every other piece of state does: the panel passes `svc.pending` into `Model.panelRows(s, {groupBy, folded, nowMs, expandedKey, pending})`; the row builders fold it into `statusWords`/`sub` + `tone` + `dot`; `Model.rowRev` (which already hashes those) makes `sameRows` swap the model.

### Data shapes

Action descriptor (`Api.js`, data only; `kind: "action"` is what `_finish` branches on):

```js
{ kind: "action", verb: "stop", target: "<uuid>", path: "/applications/<seg>/stop", method: "POST" }
```

Resolved target (`Model.actionRequest(snapshot, verb, uuid)`; **no `Api` call**, the descriptor is built in `Service.qml`):

```js
{ ok: true,  verb, uuid, name: "api", targetType: "resource"|"deployment"|"server", kind: "application"|"service"|"database"|null, confirm, destructive }
{ ok: false, why: "invalid" | "unknown" | "notapplicable" }
```

Action outcome (`Model.actionOutcome(verb, targetType, rec)`; `rec` is one `splitResponses` record):

```js
{ ok: true,  text: "Stop requested", tone: "dim", deploymentUuid: "…"|null, error: null }
{ ok: false, text: "Token lacks the deploy permission", tone: "urgent", deploymentUuid: null, error: <Model error> }
```

Pending entry, `_pending[uuid]` (service memory; set at launch; reset in `_resetStore`):

```js
{ verb, targetType, since, baseStatus: "running:healthy"|null, deploymentUuid: null|"…", stale: false }
```

In-flight action, `_inflightAction` (service): the resolved target plus `at`; `null` when idle.

Panel-local UI state (never in the model): `expandedKey: ""`, `actionFocus: ""` (an action id such as `"stop"`), `confirmOpen`, `confirmAction` (immutable `{verb, uuid, name}` captured at open), `confirmArmed`, `_lastLadderAt`.

Rows from `Model.panelRows` (new fields):

```js
{ type: "resource",   …, kind, state, health, url, pendingVerb }     // url "" when no page can be built
{ type: "server",     …, url, pendingVerb }
{ type: "deployment", …, url, pendingVerb }                          // url = origin + relative deployment_url, or ""
{ type: "actions",    key: "act:" + parentKey, parentKey, uuid, targetType, name, actions: [ { id, label, destructive, confirm } ] }
```

`actions` is not in `SELECTABLE`. `rowRev` gains `pendingVerb`, `url ? 1 : 0` and `actions.map(a => a.id).join(",")`.

Action applicability (`Model.actionsFor(row)`, pure over the row; the **only** encoding of this table; hidden, never disabled):

| Row | State | Buttons (left → right) |
|---|---|---|
| resource `application` | running / starting / restarting / degraded | Deploy · Redeploy · Restart · Stop · Open |
| resource `application` | exited / paused | Deploy · Redeploy · Start · Open |
| resource `service` / `database` | running / starting / restarting / degraded | Restart · Stop · Open |
| resource `service` / `database` | exited / paused | Start · Open |
| resource, any | unknown state | Open |
| server | any | Validate · Open |
| deployment | queued / in_progress | Cancel · Open |
| deployment | terminal | Open |

Open is present only when `row.url` is non-empty. `redeploy`, `stop`, `cancel` are `destructive: true, confirm: true`.

Confirm copy (`Model.confirmCopy(verb, name)`; every label ≤ 9 characters, both cells are `Style.space(88)`):

| verb | message | cancelText | confirmText |
|---|---|---|---|
| stop | `Stop api?` | `Cancel` | `Stop` |
| redeploy | `Rebuild api without cache?` | `Cancel` | `Rebuild` |
| cancel | `Cancel the deployment of api?` | `Keep it` | `Cancel it` |

Pending verbs (`Model.pendingVerb(verb, stale)`; `tone: "accent"`, `dot: G.half`; **replaces** `statusWords` on resource rows, **appends** ` · <verb>` to `sub` on deployment and server rows so branch/commit and ip/counts stay visible):

| verb | text | stale suffix |
|---|---|---|
| deploy | `deploying…` | (never: clears when the deployment appears) |
| redeploy | `rebuilding…` | (never) |
| restart | `restarting…` | (never) |
| stop | `stopping…` | ` · still pending` at 150 s |
| start | `starting…` | ` · still pending` at 150 s |
| validate | `validating…` | (never: clears on the next servers poll) |
| cancel | `cancelling…` | (never: clears when the uuid leaves the active list) |

Pending clear rules (`_expirePending`, on the 5 s reaper; first match wins; `_pending` is reassigned only when an entry changed):

| verb / target | clears when |
|---|---|
| any | the target uuid is gone from the store, or `now - since >= PENDING_DROP_MS` (300 s) |
| deploy, redeploy, restart with a `deploymentUuid` | that uuid is in `_activeUuids` **or** in `_recent` (the deployment row carries the state from then on) |
| restart on service/database (no `deploymentUuid`), validate | `_lastPollAt.resources` (resp. `.servers`) `> since + 2000` (the first poll that landed after the action) |
| stop, start | the resource's `status` string differs from `baseStatus`; `stale = true` at `PENDING_STALE_MS` (150 s: sweep 60 + panel-closed interval 60 + margin) |
| cancel | the deployment uuid is no longer in `_activeUuids` |

Status line (`Model.actionOutcome` for responses; `_refuse` for local refusals; success and dim refusals 2.2 s, urgent 6 s; every Coolify-supplied string passes `redact` then `elide(…, 110)`):

| Outcome | Line | Tone |
|---|---|---|
| deploy, 2xx | `Deployment queued` | dim |
| redeploy, 2xx | `Rebuild queued` | dim |
| restart, application, 2xx | `Restart queued` | dim |
| restart, service/database, 2xx | `Restart requested` | dim |
| stop, 2xx | `Stop requested` | dim |
| start, 2xx | `Start requested` | dim |
| cancel, 2xx | `Deployment cancelled` | dim |
| validate, 2xx | `Validation started` | dim |
| 403 whose message names an ability (`abilityOf` non-empty) | `Token lacks the <ability> permission` | urgent |
| 403 API disabled | `Coolify's API is disabled on this instance` | urgent |
| 403 IP | `This IP is not allowed by the token` | urgent |
| 401 | `Token rejected` | urgent |
| 404 | `Coolify no longer has that <resource|deployment|server>` | urgent |
| 429 | `Rate limited · try again in <n>s` | urgent |
| per-item `queue_full` inside a 200 `/deploy` | `Coolify's build queue is full` | urgent |
| curl exit 6/7/28/35/60 | `Coolify is unreachable` | urgent |
| curl exit 63 | `Coolify's response was too large` | urgent |
| curl exited with no parseable response | `Coolify returned nothing (curl <exit>)` | urgent |
| other ≥ 400 with a message (incl. a 403 whose ability cannot be parsed) | `Coolify said: <redacted, elided>` | urgent |
| other ≥ 400 without a message | `Coolify returned <code>` | urgent |
| reaped | `Sent, but Coolify did not answer` | urgent |
| refused: target vanished before dispatch | `Coolify no longer has that <resource|deployment|server>` | urgent |
| refused: uuid already pending | `api is already <pending verb gerund>` (from `_pending[uuid].verb`) | dim |
| refused: an action is in flight, or within 1 s of the last launch | `Busy, try again` | dim |
| refused: not configured / config unsafe / rate limited / token rejected | `Not configured` / `Config is unsafe` / `Rate limited · backing off <n>s` / `Token rejected` | urgent |
| refused: IPC ability cool-off | `Token lacks the <ability> permission` (no request sent) | urgent |
| config reload while an action was in flight | `Action interrupted by a config change` | urgent |

Footer hints (`Model.footerHints(focusSection, row, ui)`; `o open` appears only when `row.url`; each line fits one row at `Style.space(380)`):

| Cursor position | Hint |
|---|---|
| hero | `enter refresh · j down · r refresh · esc close` |
| fold row | `j/k move · enter fold · g group · r refresh · esc close` |
| resource row, running, collapsed | `enter actions · d deploy · s stop · t restart · o open` |
| resource row, exited, collapsed | `enter actions · d deploy · s start · o open` |
| service/database row, collapsed | `enter actions · s stop · t restart · o open` (or `s start`) |
| any row expanded, focus on a button | `h/l pick · enter run · esc collapse` |
| server row | `enter actions · v validate · o open` |
| deployment row, active | `enter actions · x cancel · o open` |
| deployment row, terminal | `o open · j/k move` |
| confirm open | `h/l pick · enter confirm · esc cancel` |

Keyboard map (final; `PanelKeyCatcher` signals only, no `Keys.onPressed`):

| Key | Where | Action |
|---|---|---|
| `j`/`k`, arrows | anywhere | move through hero and selectable rows (unchanged; `actions` rows are skipped; while a button is focused, first clears `actionFocus`) |
| Enter, Space | hero | refresh (unchanged) |
| Enter, Space | fold row | expand / collapse the fold (unchanged) |
| Enter, Space | leaf row (resource/server/deployment) with ≥ 1 action | expand (emit the `actions` row, focus its first button); on an expanded row's parent with no button focused: collapse |
| Enter, Space | action button focused | run that action (confirm first if destructive) |
| `l` | collapsed leaf row with ≥ 1 action | expand and focus the first button |
| `l` | button focused | next button (no wrap; no-op at the end) |
| `h` | button focused | previous button; on the first: focus returns to the row (row keeps `current`) |
| `h` | expanded row, no button focused | collapse |
| `h`/`l` | fold row | fold / unfold |
| `h`/`l` | hero | no-op (Phase 4 chips) |
| `d` | resource row (application) | deploy |
| `D` | resource row (application) | redeploy without cache → confirm (the one deliberate case-sensitive pair, commented) |
| `s`/`S` | resource row | stop → confirm, or start, whichever applies |
| `t`/`T` | resource row | restart |
| `x`/`X` | deployment row, queued/in_progress only | cancel → confirm (via `deleteRequested`; any other row: no-op) |
| `o`/`O` | any row with a URL | open in browser |
| `v`/`V` | server row | validate |
| `g`, `r` | anywhere | unchanged |
| Tab / Shift+Tab | anywhere, confirm closed | neighbouring bar panel (swallowed while the confirm is open) |
| Esc | `closeLadder()`: confirm open → cancel it (row stays expanded, focus returns to the button); else row expanded → collapse; else close panel. A second rung is not descended within 250 ms of the previous one (key auto-repeat) |

While the confirm is open: `moveRequested(dx≠0)` toggles `selectedIndex`, `moveRequested(dy)` is swallowed, `activateRequested` resolves by `selectedIndex` only once `confirmArmed` (250 ms after open), `closeRequested` cancels, `textKey`/`deleteRequested`/`tabRequested` are swallowed, `hoverCursor` returns early. `returnRequested` is never handled. Mouse: hover moves the cursor (never colours), click activates, right-click on a row opens it; the scrim click cancels the confirm.

`status` JSON additions (fixed keys, no names, no messages): `lastAction: { verb, uuid8, code, curlExit, ms, at, result }` with `result ∈ queued|ok|ability|http|offline|reaped|refused`, `pending: <int>`, `pendingStale: <int>`, `actionsLastMin: <int>`, `inflightAction: bool`.

### Module map

| path | status | owns |
|---|---|---|
| `Api.js` | edit | `block()` gains `request`/`Content-Type`/`data-raw` lines from a method whitelist; `GROUP`; descriptors `reqDeploy`, `reqLifecycle`, `reqCancel`, `reqValidate` |
| `Model.js` | edit | `environmentsOf` keeps `uuid`; `buildTree`/`applyJoins` carry `environmentUuid`; `openUrl`; row builders gain `kind`/`state`/`health`/`url`; `withPending`; `actionsFor`, `actionFor`, `actionRequest`, `canAct`, `confirmCopy`, `pendingVerb`, `gerund`, `actionOutcome`, `nextAction`; `spliceActions` used on both `panelRows` return paths; `rowRev`; `footerHints(…, ui)` |
| `Service.qml` | edit | `actionReq` (7th `Req`, in `_reqs`), `_pending`, `_inflightAction`, `_lastActionLaunchAt`, `_actionLog`, `_ipcAbilityStreak`, `act()`, `_refuse()`, `_finishAction()`, `_pauseFor()` (extracted from `_fail`), `_setPending()`, `_expirePending()` in the reaper, `_say()`, `actionStatusTimer`, four IPC verbs via `_ipcAct`, `_status()` fields, `_resetStore`/`onDestruction` additions |
| `Panel.qml` | edit | `expandedKey`/`actionFocus`/`confirmOpen`/`confirmAction`/`confirmArmed`; `actionsComp`; `h`/`l`; Esc ladder with debounce; `ConfirmDialog` sibling + `confirmArm` timer; status line `Text`; right-click; `d D s t x o v`; invalidation in `applyRows`/`setGroupBy`; `hoverAction`; `scrollToKey` |
| `BarWidget.qml` | edit | right-click on the bar icon opens `instance.url` |
| `bin/check` | edit | SR9 gate (call-form grep with a floor; `fqdn` absent from `*.qml`) |
| `tests/run.js`, `tests/fixtures/*` | edit/new | tests below; seven hand-written POST fixtures with `_note` |
| `manifest.json` | edit | `version: "0.2.0"` |
| `AGENTS.md`, `README.md`, `docs/{product,architecture,design,roadmap}.md`, `docs/plans/greedy-sprouting-quiche.build.md` | edit | reconciled in Change 6 |

No new QML or JS file, so `bin/dev-sync` and the ship list are untouched.

### Interfaces

`Api.js` (additive; every existing `Api.config` byte stays identical for GET descriptors):

```js
var METHODS = { GET: "GET", POST: "POST" }                              // values are the emitted constants
function block(instance, token, req, maxTimeSec) {
  var s = /* the nine existing lines, unchanged, in order */
  var m = req.method || "GET"
  if (!Object.prototype.hasOwnProperty.call(METHODS, m)) return null    // Model.js:73 idiom; null, never throw
  if (m !== "GET")
    s += "request = \"" + METHODS[m] + "\"\n" +                          // the whitelist's constant, never input
         "header = \"Content-Type: application/json\"\ndata-raw = \"{}\"\n"   // constants; no interpolation, ever
  return s
}
function config(...)                     // unchanged, except: returns null if any block() is null
var GROUP = { application: "applications", service: "services", database: "databases" }
function reqDeploy(uuid, force)          // { kind:"action", verb: force ? "redeploy" : "deploy", target: uuid, method:"POST",
                                         //   path: "/deploy?uuid=" + seg(uuid) + (force ? "&force=true" : "") }
function reqLifecycle(kind, uuid, verb)  // null unless hasOwnProperty(GROUP, kind) and verb ∈ start|stop|restart;
                                         //   path: "/" + GROUP[kind] + "/" + seg(uuid) + "/" + verb
function reqCancel(uuid)                 // path: "/deployments/" + seg(uuid) + "/cancel", verb: "cancel"
function reqValidate(uuid)               // path: "/servers/" + seg(uuid) + "/validate", verb: "validate"
```
No `location`/`proto-redir` line anywhere. `proto = "=https,http"`, both headers, `max-time`, `max-filesize` and `write-out` stay per block.

`Model.js` (pure, no `Api` reference, all tested):

```js
UUID_RE = /^[A-Za-z0-9]{1,64}$/
UI_SEGMENT = { application: "application", service: "service", database: "database" }
PENDING_STALE_MS = 150000; PENDING_DROP_MS = 300000
environmentsOf(projectDetail)                   -> [{ id, name, uuid }]
applyJoins(resources, tree, byServer, servers)  -> resource[] gains environmentUuid
origin(instanceUrl)                             -> url without trailing "/", or ""
openUrl(targetType, obj, originStr)             -> "" | absolute URL   (encodeURIComponent, not Api.seg)
//   deployment: obj.url must match /^\/(?!\/)/ and contain no ":" before the first "/" → origin + obj.url
//   resource:   origin + "/project/" + enc(projectUuid) + "/environment/" + enc(environmentUuid) + "/" + UI_SEGMENT[kind] + "/" + enc(uuid); "" if any part missing
//   server:     origin + "/server/" + enc(uuid)
resourceRow(r, originStr) / serverRow(s, originStr) / deploymentRow(d, originStr)   -> rows carry url
withPending(row, entry)                         -> row: resource → statusWords replaced; deployment/server → sub + " · " + verb; tone "accent"; dot G.half; pendingVerb
actionsFor(row)                                 -> [{ id, label, destructive, confirm }]     // THE table; Open iff row.url
actionFor(row, verb)                            -> entry | null      // lookup over actionsFor; "s" → stop|start; "D" → redeploy
actionRequest(snapshot, verb, uuid)             -> { ok:true, verb, uuid, name, targetType, kind, confirm, destructive } | { ok:false, why }
//   why: "invalid" (UUID_RE), "unknown" (not in resources/deployments/servers), "notapplicable" (actionFor over the built row is null)
canAct(pending, inflight, uuid, nowMs, lastLaunchAt) -> "" | "already pending" | "busy"
//   "already pending": pending[uuid] exists or inflight.uuid === uuid; "busy": inflight non-null or nowMs - lastLaunchAt < 1000
confirmCopy(verb, name)                         -> { message, cancelText, confirmText }
pendingVerb(verb, stale)                        -> "stopping…" | "stopping… · still pending"
gerund(verb)                                    -> "stopping" (shared with the "already <gerund>" line)
actionOutcome(verb, targetType, rec)            -> { ok, text, tone, deploymentUuid, error }
//   errorFor(rec) first; then on 2xx: verb text; deploy inspects body.deployments[0] for queue_full/429 → ok:false; deploymentUuid from the body
//   403 with abilityOf(message) === "" falls through to "Coolify said: …"
nextAction(actions, id, dx)                     -> neighbouring id, clamped; an id absent from actions counts as index 0; "" when dx < 0 on the first
spliceActions(rows, ui)                         -> rows with the actions row after ui.expandedKey's row (if present); applied on BOTH panelRows return paths
panelRows(s, ui)                                -> ui gains expandedKey, pending; rows pass through withPending then spliceActions
rowRev(r)                                       -> adds pendingVerb, url presence, action ids
footerHints(focusSection, row, ui)              -> table above (ui: { expanded, actionFocus, confirmOpen }); the old two-argument test is replaced
```

`Service.qml`:

```qml
Req { id: actionReq }                                     // in _reqs; kind "action"; maxTime 10 → deadline 13 s (seen at the next 5 s reaper tick)
property var    _pending: ({})
property var    _inflightAction: null
property double _lastActionLaunchAt: 0
property var    _actionLog: []                            // bare timestamps, the _requestLog idiom; _requestLog is untouched
property int    _ipcAbilityStreak: 0
readonly property var pending: root._pending
readonly property string actionStatus: root._actionStatus
readonly property string actionTone: root._actionTone
Timer { id: actionStatusTimer; repeat: false; onTriggered: root._actionStatus = "" }   // 2200 dim / 6000 urgent; in onDestruction and _resetStore

function act(verb, uuid, fromIpc) {
  if (!root._ready)   return root._refuse(root._error && root._error.kind === "unsafe" ? "unsafe" : "notconfigured")
  if (root._probeMode) return root._refuse("probe")
  if (root._paused || root._requestsLastMin() >= 120) return root._refuse("ratelimited")
  var a = Model.actionRequest(root.snapshot, verb, uuid)
  if (!a.ok)          return root._refuse(a.why, verb, uuid)          // "unknown" → the "no longer has" line for the panel; IPC gets the bare token
  if (fromIpc && root._ipcAbilityStreak >= 3) return root._refuse("ipcability")
  var why = Model.canAct(root._pending, root._inflightAction, uuid, Date.now(), root._lastActionLaunchAt)
  if (why)            return root._refuse(why, verb, uuid)
  var req = root._descriptorFor(a)                                    // Api.reqDeploy / reqLifecycle / reqCancel / reqValidate; null → "notapplicable"
  if (!req)           return root._refuse("notapplicable", verb, uuid)
  root._inflightAction = { verb: a.verb, uuid: a.uuid, name: a.name, targetType: a.targetType, kind: a.kind, at: Date.now(), fromIpc: !!fromIpc }
  root._setPending(a, null)                                           // optimistic: the row changes on the keystroke
  root._lastActionLaunchAt = Date.now(); root._actionLog.push(Date.now())
  if (!root._launch(actionReq, req, 10)) { root._clearPending(a.uuid); root._inflightAction = null; return root._refuse("busy") }
  return "queued"
}
function _finishAction(p, code, out, err) {               // called from _finish AFTER _syncBusy() and the liveSeq guard
  var a = root._inflightAction; root._inflightAction = null
  if (!a) return
  var rec = Model.splitResponses(out)[0] || { exit: code || 1, code: 0, body: "", timeMs: 0, bytes: 0, errmsg: "",
                                             headers: { retryAfter: null, rateLimitRemaining: null, rateLimitLimit: null } }
  var o = Model.actionOutcome(a.verb, a.targetType, rec)
  root._record("action", rec)                             // per-kind stats + rate-limit headers; never _fail
  if (o.error && o.error.kind === "ratelimited") root._pauseFor(Model.retryAfterSec(rec.headers, 1), rec.headers)   // extracted from _fail: sets _backoff.ratelimited, _backoffSec, _paused, pauseTimer; touches nothing else
  if (o.ok) root._setPending(a, o.deploymentUuid)         // fills deploymentUuid; keeps since
  else if (!(o.error && o.error.kind === "ratelimited")) root._clearPending(a.uuid)
  root._ipcAbilityStreak = (a.fromIpc && o.error && o.error.kind === "ability") ? root._ipcAbilityStreak + 1 : (o.ok ? 0 : root._ipcAbilityStreak)
  root._say(o.text, o.tone); root._lastAction = { verb: a.verb, uuid8: a.uuid.slice(0, 8), code: rec.code, curlExit: rec.exit, ms: rec.timeMs, at: Date.now(), result: … }
  console.log("omarify action " + a.verb + " " + rec.code + " exit=" + rec.exit + " " + rec.timeMs + "ms " + a.uuid.slice(0, 8))
}
```

- `_finish` (`Service.qml:363`): the branch `if (p.kind === "action") { root._finishAction(p, code, stdoutText, stderrText); return }` goes **after** `root._syncBusy()` and `if (p.liveSeq !== p.seq) return`, as the first statement of the surviving body.
- `_pauseFor(sec, headers)`: the body of `_fail`'s `ratelimited` arm (`:547-553`) moved into a helper that `_fail` also calls; it never writes `_error` or `consecutiveFailures`.
- `_setPending(a, depUuid)`: `_pending[uuid] = { verb, targetType, since: existing.since || now, baseStatus: targetType === "resource" ? status : null, deploymentUuid: depUuid, stale: false }` then reassign. `_clearPending(uuid)` deletes and reassigns.
- `_expirePending(now)`: early-return when `_pending` has no keys; apply the clear table; reassign `_pending` only when an entry was dropped or flipped to stale (the `_panels` `changed` idiom at `:668-670`).
- `_refuse(why, verb, uuid)`: maps `why` to the status-line row and tone (the "already pending" line reads `_pending[uuid].verb`), calls `_say`, sets `lastAction.result = "refused"`, returns the IPC token (`unknown uuid <uuid>` / `not applicable <verb> <uuid>` / `already pending <uuid>` / `busy` / `not configured` / `config unsafe` / `rate limited` / `token rejected`).
- Reaper: for `actionReq` past its deadline, `kill()`, `_inflightAction = null`, `_say("Sent, but Coolify did not answer", "urgent")`, `lastAction.result = "reaped"`, **no** `_backoff["action"]`, **no** `consecutiveFailures`, the pending entry stays (the POST may have landed; the clear table resolves it), never retry. `_maxBackoffUntil()` ignores the `action` key.
- `_resetStore` clears `_pending`, `_actionStatus`, `_ipcAbilityStreak`, stops `actionStatusTimer`, and, if `_inflightAction` was set, sets it null and then `_say("Action interrupted by a config change", "urgent")` (the `Req` is killed with the others at `:245`). `Component.onDestruction` stops `actionStatusTimer`; `actionReq` is in `_reqs`.
- `_actionsLastMin()` filters `_actionLog` like `_requestsLastMin`; `_requestLog`/`_noteRequest(kind, n)`/`_requestsLastMin` are **unchanged**.
- `_status()` gains `lastAction`, `pending: Object.keys(_pending).length`, `pendingStale`, `actionsLastMin`, `inflightAction: !!_inflightAction`.
- IPC: `function deploy(uuid: string): string { return root._ipcAct("deploy", uuid) }`, likewise `restart`, `stop`, `start`. `_ipcAct` returns `usage: <verb> <uuid>` when empty, else `act(verb, uuid, true)`'s token mapped to `queued <verb> <uuid>` on success, and logs `omarify ipc <verb> <uuid8> -> <token>`. Exit codes are not part of the contract (`omarchy-shell` exits 0 on dispatch).

`Panel.qml`:

- Root state: `expandedKey`, `actionFocus`, `confirmOpen`, `confirmAction`, `confirmArmed`, `_lastLadderAt`. `rows` binding passes `{groupBy, folded, nowMs: ageMs, expandedKey, pending: svc ? svc.pending : ({})}`.
- `applyRows` (after the model swap) and `setGroupBy`: `if (expandedKey && Model.indexOfKey(next, "act:" + expandedKey) < 0) { expandedKey = ""; actionFocus = "" } else if (actionFocus && !ids.includes(actionFocus)) actionFocus = ids[0]` (mirrors the existing `cursorKey` repair).
- `onOpenedChanged` on close: `confirmOpen = false; confirmAction = null; confirmArmed = false; expandedKey = ""; actionFocus = ""`.
- `expand(row)`: only when `Model.actionsFor(row).length > 0`; `expandedKey = row.key; actionFocus = first id; Qt.callLater(scrollToKey, "act:" + row.key)`. `scrollToKey(key)`: `positionViewAtIndex(parentIndex, Contain)` then `positionViewAtIndex(indexOfKey(key), Contain)`, so the strip is pulled in last and the parent stays visible whenever both fit. `scrollToSelection` is unchanged.
- `activateCursor()`: hero → refresh; fold → toggle (unchanged); leaf → `expand`; expanded parent, no focus → collapse; button focused → `runAction(actionFocus, expandedKey)`.
- `moveCursor(dx, dy)` with `dx !== 0`: per the keyboard map (fold rows fold/unfold; hero no-op). `dy` while a button is focused clears `actionFocus` first.
- `openConfirm(verb, row)`: `confirmAction = { verb, uuid: row.uuid, name: row.name }`; copy from `Model.confirmCopy`; `confirm.selectedIndex = 0`; `confirmOpen = true`; `confirmArmed = false`; `confirmArm.restart()` (250 ms one-shot → `confirmArmed = true; confirm.selectedIndex = 0` again, defeating an `onEntered` fired by the dialog appearing under the pointer). `onConfirmed`: `var c = confirmAction; confirmAction = null; confirmOpen = false; if (c) svc.act(c.verb, c.uuid)` (idempotent). `onCanceled`: `confirmOpen = false; confirmAction = null`.
- Key catcher handlers: `onMoveRequested` checks `confirmOpen` **before** the existing `cursorActive` early return; every handler starts with the confirm route; `activateRequested` while open resolves only if `confirmArmed`.
- `onDeleteRequested`: `if (confirmOpen || focusSection !== "list" || !currentRow || currentRow.type !== "deployment") return; runAction("cancel", currentRow.key)`.
- `onTextKey(t)`: `r/R`, `g/G` unchanged; `d`, `D`, `s/S`, `t/T`, `v/V`, `o/O` per the map; a key that does not apply is a no-op.
- `closeLadder()`: `var now = Date.now(); if (now - _lastLadderAt < 250) return; _lastLadderAt = now; if (confirmOpen) { confirm.canceled(); return } if (expandedKey) { collapse(); return } close()`. Esc routes through `closeLadder` only.
- `hoverCursor` gains `if (root.confirmOpen) return` beside the `reflowing` check. `hoverAction(parentKey, id)`: `if (root.reflowing || root.confirmOpen) return; hoverCursor(parentKey); actionFocus = id`.
- `ConfirmDialog { id: confirm; anchors.fill: parent; z: 10; opened: root.confirmOpen; colours/font/radius bound from root's properties and Style tokens }` mounted as a **sibling** of `keyCatcher` inside the `KeyboardPanel` (fills the content; see Findings), with a comment saying the sibling placement is deliberate.
- Status line: a caption `Text` inside the `header` Column between `hero` and `calloutBox`; `text: svc ? svc.actionStatus : ""`, `visible: text !== ""`, `wrapMode: Text.WordWrap`, `maximumLineCount: 2`, `elide: Text.ElideRight`, `color: svc.actionTone === "urgent" ? root.urgent : root.dim`, `textFormat: Text.PlainText`, `font.family: root.fontFamily`, `font.pixelSize: Style.font.caption`.
- `actionsComp`: `Row { spacing: Style.spacing.sm }` of `Button { bordered: true; focusable: false; fontSize: Style.font.bodySmall; text: label; foreground: destructive ? root.urgent : root.foreground; hasCursor: root.expandedKey === parentKey && root.actionFocus === id; onHovered: function(on) { if (on) root.hoverAction(parentKey, id) }; onClicked: root.runAction(id, parentKey) }`, indented to the parent's text column; content-derived widths (design.md's "equal cell width" is rescinded in Change 6).
- Leaf rows: `CursorSurface { hasCursor: selected && root.actionFocus === ""; current: selected && root.actionFocus !== "" }`; row `MouseArea { acceptedButtons: Qt.LeftButton | Qt.RightButton; onClicked: function(m) { if (m.button === Qt.RightButton) root.openRow(modelData); else root.setCursor(modelData.key) } }`; the `HoverHandler` stays.
- `BarWidget.qml`: `onPressed`: `Qt.RightButton` → `Util.execArgv(["omarchy-launch-browser", Model.origin(svc.snapshot.instance.url)])` when non-empty.

### Rejected alternatives

- **An action queue with a cap and a kick timer.** With single-flight, per-uuid dedupe and 1 s spacing, the queue could hold at most one entry and the kick was unreachable (three reviewers). Chosen: `act()` refuses with "Busy, try again" while an action is in flight or within 1 s of the last launch.
- **One `Req` per verb; `blocked: true` on the key catcher while the confirm is open.** Seven processes for one keystroke at a time; `blocked` forwards raw keys to descendants with no `Keys` handler. Chosen: one `actionReq`; the catcher's signals routed into the dialog.
- **Expansion as a panel-only `expandedKey` binding** (no model change). The button set depends on `url`, which arrives from topology minutes later without touching any `rowRev` field, so the strip would miss Open until an unrelated change. Chosen: a non-selectable `actions` row with ids and url presence in `rowRev`.
- **Writing optimistic state into `_resources`/`_deployments`** (as `docs/architecture.md:219,287` describe). Erased by the next poll. Chosen: a service-owned `_pending` map applied at render.
- **Pending only after a 2xx.** The row would show nothing between the keystroke and the answer (up to 13 s on a reap), and the second press would be refused as "busy" instead of "already pending". Chosen: pending at launch, cleared on non-2xx except rate limit and reap.
- **One "status changed" clear rule for every verb, 90 s stale.** Never fires for validate or a service/database restart; fires falsely for deploy on any build over the threshold; 90 s is below the panel-closed worst case. Chosen: the per-verb clear table, stale only for stop/start at 150 s, drop at 300 s.
- **A deployments kick and a servers kick after an action.** Compensating polls, which AGENTS.md locks out; the deployments cadence already shows a queued row within 4 s; the per-verb table clears validate on the next regular servers poll. Rejected.
- **Escalating an action 429 through `_fail`.** `_fail` writes `_error` before its kind switch, so the callout would be permanent. Chosen: `_pauseFor`, extracted from `_fail`'s 429 arm.
- **`Model.actionRequest` returning an `Api` descriptor.** `Model.js` may not import `Api.js`. Chosen: `Model` decides whether and which family; `Service.qml` (which imports both) builds the descriptor.
- **`Deploy` on services and databases.** Semantically Start. Chosen: hidden on non-applications.
- **Opening `fqdn`.** Absent on every fixture resource and user-typed. Chosen: the Coolify page or nothing.
- **A `--post` mode for `bin/record-fixture`.** A script whose job is firing deploys and stops at production resources. Rejected; POST fixtures are hand-written with `_note`, real bodies pasted through the same scrubber with `_recorded`.
- **`pending`/`actionStatus` inside `snapshot`; per-uuid pending timers.** `snapshot` changes recompute `barState` per monitor; the 5 s reaper already sweeps. Chosen: separate service properties; reaper sweep.
- **A per-action `Req` property for the resolved action.** `Req` has no such property and `_launch` owns `arg`. Chosen: `_inflightAction` on the service, which also feeds dedupe and `status`.
- **Adding `write` to the token so Validate succeeds once.** `write` is the whole write API on a token reachable by any local process over IPC and by any co-loaded plugin; AGENTS.md makes it optional. Chosen: not held; Validate demonstrated as its 403 (open question 5).

## Reuse

- `Service.qml:311-335` `component Req` + `:344` `_reqs` + `:348-361` `_launch` — the seventh `Req` inherits stdin config write, seq/kill/escalate, the deadline, `_syncBusy` (hero spinner), `_noteRequest` and shutdown; `Api.config` keeps its single call site (Change 3).
- `Service.qml:349` `p.running || p.stopping` — the single-flight primitive `act()` leans on instead of a queue (Change 3).
- `Service.qml:363-371` `_finish`'s `_syncBusy` / `liveSeq` guard / `curlExit: code || 1` — the branch point and the empty-stream fallback shape (Change 3).
- `Service.qml:547-553` the 429 arm of `_fail` — extracted into `_pauseFor` and called from both (Change 3).
- `Service.qml:512-519` `_drainTerminal`'s guard list (`_ready`, `_paused`, `_probeMode`) — copied verbatim into `act()` (Change 3).
- `Service.qml:569-579` `_requestLog` idiom — `_actionLog` is a second bare-timestamp array; the request log is untouched (Change 3).
- `Service.qml:647-673` reaper + `:668-670` `changed` flag — `_expirePending` runs on its tick and reassigns only on change (Change 3).
- `Service.qml:441,445` "copy, mutate, reassign" for a map property — `_setPending`/`_clearPending` (Change 3).
- `Service.qml:452-453` `_markPoll`/`_lastPollAt` — the "first poll after `since`" clear rule needs no new bookkeeping (Change 3).
- `Service.qml:529-535` `_record`, `:564-567` `_perKindEntry` — actions through `_launch` populate `perKind.action` and `requestsLastMin` for free (Change 3).
- `Service.qml:405-420, 513-519` deployment reap path — a cancelled deployment vanishes from `/deployments`, is fetched once and lands in `recent` as `cancelled-by-user`; `Model.deploymentGlyph` (`Model.js:616`) already renders it (Change 3).
- `Model.js:210-246` `makeError`/`messageOf`/`errorFor` + `:573` `abilityOf` — `actionOutcome` classifies with these and changes only the sink; `:169-182` `redact`/`elide` (Change 2). `Model.js:73` `hasOwnProperty.call` idiom (Change 1). `Model.js:559` `calloutBody`'s `unsafe` wording (Change 3).
- `Model.js:671-674` `panelRows(s, ui)` with `folded` — `expandedKey` and `pending` ride the same argument (Change 2). `:731-749` `rowRev`/`sameRows` (Change 2). `:646, :653-663` the `sub` builders pending appends to (Change 2).
- `Panel.qml:82-97` `applyRows` cursor repair, `:101-106` `setGroupBy` — the seam for `expandedKey`/`actionFocus` invalidation (Change 4). `:113-116` `hoverCursor`'s `reflowing` guard — the shape of `hoverAction` and the `confirmOpen` guard (Change 4). `:124-126, 144-149, 158-159, 186` — the four Phase 1 seams (Change 4). `:320` `selected` by key — `actionFocus` keyed by id (Change 4).
- `Ui/ConfirmDialog.qml` — rendering, scrim, mouse; driven by catcher signals; placed like `plugins/clipboard/Clipboard.qml:400-417` but as a sibling (Change 4). `Ui/Button.qml` — `foreground: root.urgent` yields an urgent label and hover fill via `:114,185`; `focusable` stays false (Change 4). `Ui/CursorSurface.qml:18` `current` (Change 4).
- `plugins/panels/tailscale/Service.qml:41,357-365,438-441,537` + `Panel.qml:502-509` — `actionStatus` + timer + dim/urgent line (Changes 3, 4). `plugins/panels/bluetooth/Panel.qml:932-948` row `MouseArea`; `:92,366-373` `actionFocused`/`moveCursorH` shape (Change 4).
- `Commons/Util.qml:62` `execArgv` (Change 4). `Ui/WidgetButton.qml:32,98` bar right-click (Change 4).
- `tests/run.js:25-79` `fixture`/`fx`/`trailer`/`snap`/`loadedSnap` — `trailer` turns a hand-written body into a `splitResponses` record for `actionOutcome` (Change 2). `tests/fixtures/error-403-ability.json` reused verbatim; the `_note` convention (Change 2).
- `bin/check:17-24` count-with-floor gate style and `:26` repo-wide `*.qml` grep — the SR9 gate copies them (Change 4). `bin/record-fixture:17` `deny` string and `:23-24` `jq walk` scrubber — reused for pasted bodies (Change 5).
- `docs/plans/greedy-sprouting-quiche.build.md` Questions row 2 — the `jq --rawfile` token write (Change 5).

Not reused, with reason: `Ui/PanelActionButton` (icon-only); `ConfirmDialog.handleKey` (needs a raw `KeyEvent`); `Quickshell.execDetached` directly (equivalent; AGENTS names `Util.execArgv` for data); `plugins/panels/bluetooth/Model.js:129-139` pending helpers (shape only; `_setPending` follows `Service.qml:441,445`).

## Security requirements

1. **POST body is a literal.** `Api.block` emits `data-raw = "{}"` and the `Content-Type` header as constants; `request` is the whitelist's own constant (`hasOwnProperty` guard; unknown method → `null`, never a throw); every other value passes `Api.quote`; uuids pass `Api.seg` in paths and query strings. Tests: hostile uuid → exactly one `url`, `request`, `data-raw`, `write-out` per block; `data-raw` byte-identical; `method: "toString"`/`"constructor"`/`"DELETE"` → `null`. Change 1.
2. **No redirects.** No `location`/`proto-redir` in any block; `proto = "=https,http"` in every block. Test asserts it. Change 1.
3. **Single gate for panel and IPC.** `Model.actionRequest` validates the uuid (`UUID_RE`), requires it in the store, derives `targetType`/`kind`, and applies the applicability table through `actionsFor` (the only encoding); `Service._descriptorFor` maps to `Api` constructors, which return `null` for an unknown family; `act()` is the only path to `_launch` for actions and the IPC verbs call it. Tests: `../`, `%2e%2e`, unknown uuid, database + deploy, running + start, finished deployment + cancel → `ok:false` with the right `why`. Change 2, 3.
4. **Actions never poison polling.** `_finishAction` never writes `_error`, `_backoff`, `_probeMode`, `consecutiveFailures`; the only escalation is `_pauseFor` on a 429; the reaper's action branch writes no backoff. `status` shows `error: null`, `probeMode: false` after an ability 403 and after a 429 the callout is absent once the pause ends. Change 3, 5.
5. **State gating.** `act()` refuses on `!_ready` (distinguishing `unsafe`), `_probeMode`, `_paused`, `_requestsLastMin() >= 120`; every deferred path that can reach `_launch` repeats the gate (there are none: no queue, no kicks). Change 3.
6. **Rate bound.** Single-flight; per-uuid dedupe against `_pending` and `_inflightAction` (pending is set at launch); 1 s spacing; IPC-originated actions refused after 3 consecutive ability failures until a 2xx or a config change. A held key costs one request. Tests: `Model.canAct`. Change 2, 3.
7. **Pending is honest.** Set at launch; cleared on any non-2xx except a rate limit or a reap (the POST may have landed); never overrides a polled status that changed; per-verb clear rules so no successful action shows a false "still pending". Change 3.
8. **Confirm is real.** `selectedIndex = 0` on open and again when armed; `activateRequested` resolves only once `confirmArmed` (250 ms) and only that signal (never `returnRequested`); `confirmAction` captured immutably and cleared before dispatch; all other catcher handlers return early while open; `hoverCursor` ignores hover while open; the dialog fills the `KeyboardPanel` content above every row `MouseArea`; panel close resets it; the Esc ladder descends one rung per 250 ms. Manual: with "Stop api?" open, `d`, `x`, `r`, `g`, Tab, a held Return and a row click behind the scrim do nothing but cancel. Change 4, 5.
9. **Browser URL rule.** Every URL is `origin + path` from `Model.openUrl`; a `deployment_url` with a scheme, `//`, or no leading `/` is rejected; server/resource paths are built from `encodeURIComponent(uuid)` and topology uuids, never from a returned string other than `deployment_url`; `fqdn` is never opened; the launcher receives exactly one argv element via `Util.execArgv`. Tests: `javascript:alert(1)`, `--app=https://evil`, `file:///etc/passwd`, `https://evil.example/x`, `//evil.example/x`, `project/x` → `""`. `bin/check` gate (in the `--no-shell` subset): `grep -ho 'omarchy-launch-browser' *.qml | wc -l` ≥ 1 (floor), every such line matches `Util\.execArgv(\["omarchy-launch-browser", ` (fail otherwise), and `grep -n fqdn *.qml` is empty. Change 2, 4.
10. **No echo.** The status line shows `elide(redact(messageOf(body)), 110)` at most; the action log line is `omarify action <verb> <code> exit=<n> <ms>ms <uuid8>`; `status.lastAction` is `{verb, uuid8, code, curlExit, ms, at, result}`; no name, `fqdn`, `deployment_url` or message reaches the log or IPC. Change 3, 5.
11. **Token path unchanged.** Actions go through `_launch`; `Api.config`'s single call site, the stdin write and `p.cfg` clearing are untouched; nothing new in argv. The runbook samples `ps` in a loop during an action (a one-shot `ps` cannot land inside a 300 ms POST). Change 3, 5.
12. **Ability scope.** The token is `read` + `deploy`; `write` is never requested; Validate surfaces its 403. IPC verbs are exactly `deploy restart stop start`, logged, and documented as a no-confirm destructive surface beside the `tokenCommand` caveat. Change 6.
13. **Fixtures.** POST fixtures are hand-written with `_note`; pasted real bodies pass through `bin/record-fixture`'s scrubber and carry `_recorded`; `bin/record-fixture` gains no POST mode. Change 2, 5.
14. **Verification hygiene and the hard gate.** Change 0's probe must return a 403 whose message matches `/permission/i` before Change 3 or 4 is installed; otherwise the run stops and a `read`-only token is swapped in first. The token is written with `jq --rawfile`, never `--arg`. No builder or reviewer runs `bin/dev-sync` or any `--delete` tool against a real path (staging only via `OMARIFY_DEST=$(mktemp -d)/plugin`). Change 0, 5.

## Changes

### 0. Baselines and the token ability probe (no code; a hard gate)

Files: none. Record every output in the build record.

- Idle, panel closed: `for i in $(seq 12); do omarchy-shell io.github.danjonesio.omarify status | jq -c '{requestsLastMin, rateLimitRemaining}'; sleep 10; done` → max. Then idle, panel open (`omarchy-shell shell summon io.github.danjonesio.omarify`, the loop, `hide`) → max.
- Prove the current token is `read`-only with a request that cannot mutate anything (the target is not a well-formed Coolify uuid, so it fails structurally even if the ability check passes):
  ```sh
  url=$(jq -r '.instances[0].url' ~/.config/omarify/config.json); tok=$(jq -r '.instances[0].token // empty' ~/.config/omarify/config.json)
  printf 'url = "%s/api/v1/deployments/not-a-uuid-not-a-uuid-not-a-uuid-not-a-uuid/cancel"\nrequest = "POST"\nsilent\nconnect-timeout = "5"\nmax-time = "10"\nwrite-out = "\\n%%{http_code}\\n"\nheader = "Authorization: Bearer %s"\nheader = "Accept: application/json"\n' "${url%/}" "$tok" | curl -q -S -K -
  ```
  (`printf` is a builtin, so the token never enters argv; `\\n` reaches curl as its `\n` escape.)
- **Gate:** only `403` with a body matching `/permission/i` proves read-only. Any other outcome (404/400 = the token has `deploy`; another 403 = API disabled or IP; 429 = inconclusive) means **STOP**: create a `read`-only token in Coolify → Security → API Tokens, swap it in with the `--rawfile` recipe from Change 5 step 2, re-run the probe, and only then continue. Changes 3 and 4 install code that fires real actions at real uuids; their Verify blocks repeat this precondition.

**Verify**: three numbers and one HTTP code with the matching message written into the build record; the gate line ticked.

### 1. `Api.js`: POST blocks and action descriptors

Files: `Api.js`, `tests/run.js`.

Implement `METHODS`, the `block()` extension (returning `null` on an unknown method; `config()` returns `null` if any block is null), `GROUP`, `reqDeploy`, `reqLifecycle`, `reqCancel`, `reqValidate` exactly as in Interfaces. GET output is byte-identical to today.

**Verify**: `node tests/run.js` passes the three existing `Api.config` tests unchanged plus: a GET block has no `request`/`data-raw`/`Content-Type` line; an action block has exactly one each of `request = "POST"`, `data-raw = "{}"`, `header = "Content-Type: application/json"`, `url`, `write-out`, `max-time`, `proto`; a three-block config with two GETs around one POST has `request` once; `reqDeploy("a/../b?x=1", true)` yields one `url` line containing `uuid=a%2F..%2Fb%3Fx%3D1&force=true`; `reqLifecycle("unknown", u, "stop")`, `reqLifecycle("constructor", u, "stop")` and `reqLifecycle("application", u, "delete")` are null; `block()` with `method` `"DELETE"`, `"toString"`, `"constructor"` returns null and `config()` then returns null; no block contains `location` or `proto-redir`.

### 2. `Model.js`: joins, URLs, applicability, copy, pending, outcomes, rows; fixtures

Files: `Model.js`, `tests/run.js`, `tests/fixtures/{action-deploy-ok.json, action-deploy-queue-full.json, action-stop-ok.json, action-restart-ok.json, action-service-restart-ok.json, action-cancel-ok.json, action-cancel-400.json, action-validate-201.json}` (hand-written, each with `_note: "hand-written from docs/coolify-api.md:<line>"`).

Implement every `Model.js` signature in Interfaces. Row builders take `originStr` (from `s.instance.url` inside `panelRows`) and carry `url`; `withPending` replaces on resource rows and appends on deployment/server rows; `spliceActions` is applied on both `panelRows` return paths (the `:699` early return included); `rowRev` gains the three fields; `SELECTABLE` unchanged; `footerHints` gains `ui` and its old three-case test is rewritten to the new table.

**Verify**: `node tests/run.js` passes every case under "Tests to add" tagged Change 2; `bin/check --no-shell` prints `ok` (the new fixtures pass the secret grep).

### 3. `Service.qml`: the action path

Files: `Service.qml`.

Precondition: Change 0's gate is ticked. Everything under `Service.qml` in Interfaces, including the `_finish` branch placement, `_pauseFor` extracted from `_fail`, `_descriptorFor`, the reaper's action branch, `_maxBackoffUntil` ignoring `action`, the `_resetStore` and `onDestruction` additions, `_actionsLastMin`, `_status()` fields and `_ipcAct`.

**Verify**: `bin/check` prints `ok`; `bin/dev-sync && omarchy restart shell`; `status | jq .requestsLastMin` is non-zero on the idle service (the request log is intact) and within 2 of the Change 0 baseline. With the **read-only** token: `omarchy-shell io.github.danjonesio.omarify stop <uuid-of-a-running-resource>` prints `queued stop <uuid>`; within 2 s `status | jq '{lastAction, error, probeMode, paused, pending, actionsLastMin, bar}'` shows `lastAction.result == "ability"`, `lastAction.code == 403`, `error == null`, `probeMode == false`, `pending == 0`, `actionsLastMin == 1`, `bar` unchanged; `perKind.deployments.lastAt` keeps advancing; `… stop deadbeef` → `unknown uuid deadbeef`, `… start <uuid-of-a-running-app>` → `not applicable start <uuid>`, both with `requestsLastMin` unchanged; `… stop` → `usage: stop <uuid>`; a third `stop <uuid>` after two ability 403s → the IPC cool-off token with `requestsLastMin` unchanged. Argv: `( for i in $(seq 100); do ps -eww -o args=; sleep 0.2; done ) > "$SCRATCH/ps.log" & omarchy-shell io.github.danjonesio.omarify restart <uuid>; wait` then `grep -c 'curl -q -S -K -' "$SCRATCH/ps.log"` ≥ 1, `grep -cFf <(needle) "$SCRATCH/ps.log" || true` → 0, `grep -cE 'curl .*(POST|deployments|applications|servers)' "$SCRATCH/ps.log" || true` → 0.

### 4. `Panel.qml` + `BarWidget.qml` + `bin/check`: expansion, action strip, keys, confirm, status line, open

Files: `Panel.qml`, `BarWidget.qml`, `bin/check`.

Precondition: Change 0's gate is ticked. Everything under `Panel.qml` in Interfaces; `BarWidget.qml` right-click; the SR9 gate in `bin/check` (before the `--no-shell` exit).

**Verify**: `bin/check` prints `ok` (PlainText and font parity count the new `Text` blocks; the literal grep passes; the SR9 gate passes; qmllint passes) and, once, fails when a scratch copy of `Panel.qml` gains a line `Util.execArgv(["omarchy-launch-browser", modelData.fqdn])`. `bin/dev-sync && omarchy restart shell`. Scripted on the read-only token: `omarchy-shell shell summon io.github.danjonesio.omarify`; `wtype -k Down` to a running application row; `wtype -k Return` (strip appears, first button ringed, row painted `current`); `wtype l` ×3 then `wtype h` ×4 (focus walks and returns to the row); `wtype -k Return` on Stop → "Stop api?" with **Cancel** ringed; `wtype -k Return` twice 50 ms apart on Stop from the row (open + auto-repeat) leaves the dialog open with Cancel ringed; `wtype d`, `wtype x`, `wtype r`, `wtype g`, `wtype -k Tab` → nothing changes (`status | jq .requestsLastMin` unchanged, panel open, dialog up); `wtype -k Escape` → dialog gone, row still expanded; `wtype -k Escape` → collapsed; `wtype -k Escape` → panel closed; holding Escape for 150 ms from the dialog state cancels only the dialog. Re-open, expand, `wtype l`, `wtype -k Return` on Stop, `wtype l`, `wtype -k Return` → the row reads `stopping…` for the ~300 ms of the request, then the status line reads exactly `Token lacks the deploy permission` in urgent for ~6 s, the row returns to its status words, bar glyph unchanged (`status | jq .bar`), `error == null`. `grim -g "<panel geometry>"` screenshots of the strip, the dialog and the status line into the scratch dir. Right-click the bar icon → browser opens `https://app.coolify.io`.

### 5. Live acceptance runbook (Coolify Cloud)

Files: none new; fixtures may be replaced by recorded bodies (scrubbed, `_recorded`). Needs Dan's answers to open questions 1 and 2. **Preconditions:** one installed build for the whole runbook (no `bin/dev-sync`, no `omarchy restart shell`, no config edit between steps except where a step says so: a restart or config change wipes `_pending` and forces a re-baseline); steps 4–9 run with the panel summoned and left open on one monitor while a terminal runs the sampling loop (`_resourcesSec` is 30 s only while a panel is open; closed, a successful Stop can take 120 s to clear).

1. **Ability 403 from the panel** on the read-only token (Change 4's Verify): also `s` and `x`; `status | jq '{error, probeMode, paused, bar, requestsLastMin, lastAction}'` → `error null`, `probeMode false`, `bar` identical to Change 0, `lastAction.result "ability"`.
2. **Token swap + real revoke.** In Coolify → Security → API Tokens create `omarify-act` with `read` + `deploy` only (**not** `write`). Delete the old token → bar shows the alert cloud and hero "TOKEN REJECTED" within 5 s, `status | jq .probeMode` true (closes Phase 1's "real token revoke"). Write the new token without it ever touching argv:
   ```sh
   umask 077; d=${XDG_RUNTIME_DIR:?}
   cat > "$d/tok"                                      # paste the token, Ctrl-D
   jq --rawfile t "$d/tok" '.instances[0].token = ($t | rtrimstr("\n"))' ~/.config/omarify/config.json > "$d/c.json"
   install -m 600 "$d/c.json" ~/.config/omarify/config.json; rm -f "$d/tok" "$d/c.json"
   ```
   → `configState "ok"`, `perKind.version.lastAt` advances within 5 s, no shell restart. **Wait** until `status | jq '{probeMode, error, configState, counts}'` reads `false / null / "ok"` with the full counts before the next step.
3. **`write` 403.** `v` on the server row → `Token lacks the write permission`; polling unaffected. (This is how Validate is demonstrated on this token; recorded as a deviation from "every action works".)
4. **Deploy from the keyboard** on the nominated application: `d`. Immediately run `for i in $(seq 18); do omarchy-shell io.github.danjonesio.omarify status | jq -c '{t: now|floor, requestsLastMin, actionsLastMin, pending, pendingStale, d: .counts.deployments, r: .counts.recent, bar: .bar.glyph, la: .lastAction.result}'; sleep 10; done`. Assert: the row reads `deploying…` on the keystroke; `d` 0 → 1 within 5 s (closes Phase 1 "row within 5 s of queuing") and `pending` drops to 0 at that moment (the deployment row now carries the state); `max(requestsLastMin) < 60` (closes Phase 1 "< 60/min with a deployment"; record the max as the deploying baseline, noting it includes one action); `r` increments within 5 s of Coolify finishing; `bar` becomes the progress glyph while building (closes Phase 1 bar state 12). Screenshot the row mid-window.
5. **Restart** (`t`) on a healthy application: `Restart queued`, `restarting…`, a `restart_only` deployment appears and pending clears when it does; the deployment finishes into recent; `pendingStale` stays 0.
6. **Stop then Start** (mouse): click Stop → confirm with the mouse → `Stop requested` → `stopping…` → `exited` on the sweep with `pending` back to 0 no later than the first resources poll after Coolify's status changed (`perKind.resources.lastAt` advanced between the action and the clear; closes acceptance line 1's "within one status sweep" as reworded in open question 6); click Start → `Start requested` → `starting…` → `running:healthy`. Hover moves the cursor without colouring (closes Phase 1 "mouse hover moves the cursor"). Run the 10 s sampling loop across this step and record `actionsLastMin` beside `requestsLastMin`.
7. **Service restart** (`t` on a service or database): `Restart requested`, `restarting…`, and pending clears on the first resources poll after the action (≤ 30 s with the panel open), never reaching stale.
8. **Stale note, deterministically, with the panel closed and no config edit mid-observation.** Edit `poll.resourcesSec` to `3600` (a config change: wait for `baselineDone true`, `configState "ok"`), close the panel (`hide`), then from the CLI: `omarchy-shell io.github.danjonesio.omarify stop <uuid>` → `queued stop <uuid>`; watch `status | jq '{pending, pendingStale}'` read `1, 0`, then `1, 1` at 150 s, then `0, 0` at 300 s (`PENDING_DROP_MS`) with no other change; then `… start <uuid>`; then restore `60` (itself a reset). Note in the record: any config edit while a pending entry is live wipes it, and a config edit during an in-flight action shows "Action interrupted by a config change".
9. **Cancel**: `d` on the slow application; while `counts.deployments == 1`, `x` on the deployment row → "Cancel the deployment of api?" → confirm → `Deployment cancelled`, the row's caption gains ` · cancelling…`, then it vanishes from active and appears in recent with the cancelled glyph. Truth from the API: `printf 'url = "%s/api/v1/deployments/<uuid>"\nsilent\nheader = "Authorization: Bearer %s"\nheader = "Accept: application/json"\n' "${url%/}" "$tok" | curl -q -S -K - | jq -r .status` → `cancelled-by-user`. Then `d` again and `x` while still `queued`: record whether it lands in recent or vanishes (either is honest; the outcome goes into `docs/design.md`). `x` on a terminal deployment row → nothing; via IPC there is no cancel.
10. **IPC**: `restart <uuid>` → `queued restart <uuid>` and `status.lastAction` matches; `stop` on the same uuid immediately → `already pending <uuid>`; `deploy deadbeef` → `unknown uuid deadbeef` with `requestsLastMin` unchanged; `start <uuid-of-a-running-app>` → `not applicable start <uuid>`.
11. **Open** (only once `status | jq .topologyFetched` is true): `o` on a deployment row, a resource row, a service row, a database row and the server row; record which of the inferred URL shapes land on the right Coolify page. A wrong shape means `UI_SEGMENT` loses that kind (its Open button and `o open` hint disappear), recorded as a deviation, not a guess.
12. **Hygiene**: `quickshell log -p /usr/share/omarchy/shell -t 100000 | grep -cFf <(needle) || true` → 0; the same log grepped for the resource names in `resources.json` → 0; the `ps` sampling loop from Change 3 during a panel action → no token, no verb/path/uuid in argv.
13. **Budget**: the sampling loops' max `requestsLastMin` with a deployment running and the panel open stays < 60 (expected ≈ 40 + the actions of that step).
14. **Record real bodies**: from steps 3, 4, 6, 7 and 9, paste the scrubbed real response bodies over the hand-written fixtures where they differ: `printf '%s' "$body" | jq --arg deny "<the deny string from bin/record-fixture:17>" 'walk(if type=="object" then with_entries(if (.key|test($deny)) then .value="«scrubbed»" else . end) else . end)'`, replacing `_note` with `_recorded: "<endpoint> against Coolify Cloud 2026-09-<dd>, scrubbed"`.

**Verify**: every numbered item ticked in the build record with its command output or screenshot; roadmap acceptance line 2 ← steps 1/3; line 1 ← steps 4/5/6/7 (Validate as the documented deviation); line 3 ← step 9.

Rollback at any point (placement in `shell.json` survives; the config format is unchanged in both directions):
```sh
git checkout 29f3a76 -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js && bin/dev-sync && omarchy restart shell
```

### 6. Reconcile the docs and bump the version

Files: `manifest.json` (`0.2.0`), `AGENTS.md`, `README.md`, `docs/product.md`, `docs/architecture.md`, `docs/design.md`, `docs/roadmap.md`, `docs/plans/greedy-sprouting-quiche.build.md`.

- `AGENTS.md`: `:11` status → Phase 2; token lock → "`read` + `deploy`; `write` optional, gates Validate only; swap in a new token"; confirm lock → "Stop, Redeploy-without-cache and Cancel confirm. Deploy, Restart, Start, Validate do not. CLI verbs never confirm"; Commands → `refresh status deploy restart stop start` with the stdout contract and the rollback line; Omarchy facts → "`ConfirmDialog` is driven from `PanelKeyCatcher` signals (`handleKey` needs a `Keys.onPressed`); it preselects Confirm and moves selection on hover: reset and arm it; `Button` has no `hoverColor`, use `foreground`"; Coolify facts → "`deployment_url` is relative; `POST /deploy` reports `queue_full` inside a 200; validate and service/database restart have no observable end state; lifecycle POST blocks carry `request`, `Content-Type` and `data-raw = "{}"`; never `location`"; Don't → "Don't route an action result through `_fail` (not even its 429 arm)"; "Don't store objects in `_requestLog`".
- `README.md`: `:8` status → Phase 2; token paragraph (new token with `read` + `deploy`; `write` only for Validate); the IPC verbs and their no-confirm nature beside the `tokenCommand` caveat; the status line.
- `docs/product.md` Phase 2: Cancel confirms; Deploy/Redeploy applications only; Open = Coolify page; proxy status per open question 7.
- `docs/architecture.md` Actions: the table with `request`/`data-raw`; pending as a service map applied at render (not a resource field, not a deployment status write); the per-verb clear table and the 150/300 s constants; "actions never enter `_fail`"; `_pauseFor`; `status` additions; IPC contract; "no compensating polls". Security: items 1–14 above (renumbered after Phase 1's).
- `docs/design.md`: `:150` and `:189` drop `hoverColor` (`foreground: root.urgent`); `:187` rescind "equal cell width"; `:194` the signal-routing contract, Cancel preselected, armed; `:198-200` placement between hero and callout, 2.2 s / 6 s; `:164` proxy status per open question 7; `:179` the pending table with replace/append; the action-set table; `h`/`l` rows; Esc ladder with debounce; `:255` split "403 ability from a poll → callout; from an action → status line"; the footer table (`o open` only with a URL); `:236` right-click; Open hidden when no URL and late until topology arrives; the queued-cancel outcome from step 9.
- `docs/roadmap.md` Phase 2 acceptance line 1 per open question 6; tick Phase 2 items; note Validate demonstrated as its 403.
- Phase 1 build record: mark "restore grok-usage" done and the five human checks closed by Change 5.

**Verify**: `grep -n "hoverColor\|handleKey\|equal cell width" docs/design.md` empty; `grep -n "Phase 1 registers only" AGENTS.md` empty; `grep -n "Phase 1 (read-only bar icon and panel) in progress" README.md AGENTS.md` empty; `grep -n '"version"' manifest.json` shows `0.2.0`; `grep -n "90 s" docs/architecture.md docs/design.md` empty; `bin/check` prints `ok`.

## Verification

```sh
bin/check                                   # tests, symlink scan, fixture secrets, PlainText + font gates, literal grep, SR9 gate, staged validate, qmllint
bin/check --no-shell                        # CI subset (runs the whole of tests/run.js and the SR9 gate)
omarchy-shell io.github.danjonesio.omarify status | jq '{lastAction, pending, pendingStale, actionsLastMin, requestsLastMin, error, probeMode}'
needle() { jq -r '.instances[0].token // empty' ~/.config/omarify/config.json | cut -c1-12; }
quickshell log -p /usr/share/omarchy/shell -t 100000 | grep -cFf <(needle) || true        # 0
# argv during an action: the ps sampling loop in Change 3's Verify
```

Done end to end: the three Phase 2 acceptance lines in `docs/roadmap.md` pass via Change 5 with outputs in the build record (Validate as the documented deviation); `bin/check` is green; the docs match the code; Phase 1's five closable human checks are marked closed.

## Tests to add

`tests/run.js`, one `test()` each, named by function and the requirement it covers:

- `Api.block` GET unchanged: byte-identical output for every existing descriptor (SR1).
- `Api.block` POST shape: one `request = "POST"`, one `Content-Type` header, one `data-raw = "{}"`, all nine GET lines still present, per block (SR1).
- `Api.block`/`Api.config` unknown or prototype method (`DELETE`, `toString`, `constructor`) → `null`; `reqLifecycle` null for unknown/prototype kind or verb (SR1, SR3).
- `Api.reqDeploy` hostile uuid: percent-encoded in the query; exactly one `url` line; `force` only when true (SR1).
- `Api.config` no `location`/`proto-redir` in any block (SR2).
- `Model.environmentsOf` keeps `uuid`; `applyJoins` sets `environmentUuid` from `project-detail.json` + `resources.json`.
- `Model.openUrl`: deployment relative path → `https://app.coolify.io/project/…`; resource with topology → the application shape; service and database shapes; server shape; missing `projectUuid`/`environmentUuid` → `""`; instance url with trailing `/` → single slash; hostile `deployment_url` values `javascript:alert(1)`, `--app=https://evil`, `file:///etc/passwd`, `https://evil.example/x`, `//evil.example/x`, `project/x` → `""` (SR9).
- `Model.actionsFor` × 8 table rows; Open absent when `row.url` is `""`.
- `Model.actionFor(row, "s")` → stop on running, start on exited; `"D"` → redeploy; unknown verb → null.
- `Model.actionRequest`: `../x`, `%2e%2e` → `why "invalid"`; unknown uuid → `"unknown"`; database + deploy, running + start, exited + stop, finished deployment + cancel → `"notapplicable"`; application + stop → `ok` with `targetType "resource"`, `kind "application"`, `confirm true`; deployment + cancel; server + validate (SR3).
- `Model.canAct`: pending[uuid] → "already pending"; inflight.uuid === uuid → "already pending"; inflight non-null for another uuid → "busy"; within 1 s of the last launch → "busy"; otherwise "" (SR6).
- `Model.confirmCopy` × 3; every `cancelText`/`confirmText` ≤ 9 characters (SR8).
- `Model.pendingVerb` × 7 with and without stale; `Model.gerund` × 7.
- `Model.withPending`: resource → `statusWords` replaced, tone `accent`, dot `G.half`; deployment → `sub` keeps branch/commit and gains ` · cancelling…`; server → `sub` keeps ip/counts and gains ` · validating…`; `rowRev` differs pending vs not; `sameRows` false across the transition (SR7).
- `Model.actionOutcome`: each of the eight fixtures → the exact line and tone; `error-403-ability.json` → `Token lacks the deploy permission` and `error.kind === "ability"`; a 403 naming `write`; a 403 whose message has no parseable ability → `Coolify said: …`; `error-401.json` → `Token rejected`; `error-429.json` → `Rate limited · try again in <n>s` and `error.kind === "ratelimited"`; exit 7 → unreachable; exit 63 → too large; the empty-stream fallback record (`exit 1`, `code 0`) → `Coolify returned nothing (curl 1)`; 404 → the three `no longer has` variants; `queue_full` inside a 200 → `ok:false`; a 500 whose message contains a Bearer token → redacted and elided to ≤ 110 (SR4, SR10). Records are built with `trailer(...)` + `splitResponses` from the fixture bodies.
- `Model.panelRows` with `expandedKey`: the `actions` row follows its parent, key `"act:" + parentKey`, not selectable (`nextSelectable` skips it), absent when the parent is gone; present for an expanded server row when `resources` is empty (the early-return path); `rowRev` changes when the action id list or url presence changes.
- `Model.nextAction`: clamps at both ends; `""` on `h` from the first; an id absent from the list counts as index 0 (`nextAction([deploy,start,open], "stop", 1) === "start"`).
- `Model.footerHints` × 10 table rows plus a resource row without a URL (no `o open`).
- `Model.GLYPHS` still contains every glyph the pending dot can emit.

## Risks and open questions

Risks accepted:
- The Coolify UI path for service, database and server rows is inferred, not returned by the API. Change 5 step 11 verifies each; a wrong shape removes that kind from `UI_SEGMENT` (Open and its hint vanish for it) rather than guessing.
- A reaped POST may have landed; the plan leaves pending set and never retries, so the worst case is one honest "did not answer" line and the poll resolving the row.
- Stop/Start pending can take up to 120 s to clear with the panel closed (60 s sweep + 60 s interval); the stale note fires at 150 s. Validate shows `validating…` until the next 120 s servers poll; its real outcome is not observable in Phase 2 (`GET /servers/{uuid}` is out of scope).
- `write` is never held, so Validate always yields the ability line on Dan's account; the button stays because abilities are not queryable.
- Actions and polling share the 200/min per-user budget; a human is bounded to ≤ 60 actions/min by the 1 s spacing; an IPC loop on a token without `deploy` is cut off after 3 failures; `actionsLastMin` makes any abuse visible.
- Any co-loaded plugin can call `act()` through `serviceFor`, and any local process can call the IPC verbs; no in-process boundary exists. Documented next to the `tokenCommand` caveat.
- A config edit while an action is in flight kills the request (`_resetStore`) and shows one line; the POST may still have landed.
- Resource-row Open is absent until topology stage 2 arrives (≥ 65 s after a start or config change).

Open questions (each with the default the builder takes):
1. **Which Coolify Cloud resource may the runbook deploy, restart, stop (for up to five minutes in step 8) and start?** The fixtures show production-looking names. Default: the builder stops at Change 5 step 4 and asks; nothing destructive runs unnamed.
2. **Which application builds slowly enough to cancel mid-build?** Default: the same resource as 1 if its build exceeds ~30 s; else ask.
3. **Old token after the swap: delete (closes Phase 1's revoke check) or keep?** Default: delete; the rate limit is per user anyway.
4. **Is Dan's Cloud user an admin/owner of the team?** A non-admin member's `deploy` token is rejected on every call. Default: assume yes; Change 5 step 2 detects the failure mode immediately.
5. **Validate on a token without `write`: shown and demonstrated only as its 403 (default), or add `write` to the new token so it succeeds once?** Default: no `write`; roadmap acceptance line 1 records Validate as a deviation.
6. **Roadmap acceptance line 1 wording.** "within one status sweep (≤ 60 s)" is not reachable with a 30 s resources interval. Default: reword to "within one status sweep plus one resources interval (≤ 90 s with the panel open)"; the alternative (a faster resources poll while pending) breaches the AGENTS.md lock.
7. **Server proxy status and `unreachable_count`.** Three docs promise them "with Validate in Phase 2"; they need `GET /servers/{uuid}` per server (0.5 req/min per server at the 120 s cadence). Default: defer to Phase 4 and amend `docs/product.md`, `docs/design.md:164`, `docs/roadmap.md:22` in Change 6.
8. **Status-line durations 2.2 s / 6 s** and **pending constants 150 s / 300 s** (docs said 2.2 s and 90 s). Default: as stated; Change 6 updates the docs.
9. **Can Dan paste one service URL and one database URL from the Coolify UI before Change 2**, so `UI_SEGMENT` is fact when the tests are written? Default: build on the inference and verify in step 11.

## Out of scope

Notifications, `recent.json` (Phase 3); logs, deployment history, instance chips, tag deploy, `read:sensitive`, proxy status (Phase 4, per open question 7); SSH/Sentinel, overlay, marketplace (Phase 5); `cancel`/`validate`/`redeploy` IPC verbs; opening `fqdn`; `Deploy`/`Redeploy` on services and databases; an action queue; compensating polls; a `--post` fixture recorder; a CI workflow; new `config.json` keys; new shipped files; per-user or per-action confirm toggles; `pragma ComponentBehavior: Bound`.

## Panel record

| member | model | wave | findings | accepted | rejected (reason) |
|---|---|---|---|---|---|
| architect | opus | 1 | 12 (4 crit, 7 warn, 1 nit) | 11 | "allow actions during probe mode" (a certain 401/403 spends a request; the poll leaves probe within 60 s) |
| reuse-scout | opus | 1 | 11 (4 crit, 5 warn, 2 nit) | 10 | F4 panel-only expansion (the button set depends on `url`, which arrives from topology without touching any `rowRev` field; the scout accepted this reasoning in wave 2) |
| security-analyst | opus | 1 | 16 (9 crit, 6 warn, 1 nit) | 16 | — (F15 narrowed: Validate shown, its 403 surfaced, since abilities are not queryable) |
| ux-api-designer | opus | 1 | 15 (4 crit, 10 warn, 1 nit) | 15 | — (F11's servers primes dropped entirely in v2: compensating polls are locked out) |
| ops-analyst | opus | 1 | 14 (3 crit, 8 warn, 3 nit) | 14 | — |
| perf-analyst | opus | 1 | 12 (3 crit, 6 warn, 3 nit) | 11 | F6's panel-wide ability cool-off (blocks the runbook's `d`/`s`/`x` sequence); adopted for IPC only in wave 2 |
| code-reviewer | opus | 2 | 16 (5 crit, 7 warn, 4 nit) | 16 | — |
| skeptic | opus | 2 | 18 (5 crit, 9 warn, 4 nit) | 17 | F16's "the 120 req/min guard buys nothing" (kept at 120: it is the only brake on a scripted IPC loop with a valid token; `_requestLog` is now untouched so it works) |
| security-analyst | opus | 2 | 9 (3 crit, 4 warn, 2 nit) | 9 | — |
| reuse-scout | opus | 2 | 8 (1 crit, 4 warn, 3 nit) | 8 | — (F2 resolved by dropping the queue, the option it offered) |
| ux-api-designer | opus | 2 | 12 (0 crit, 9 warn, 3 nit) | 12 | — |
| ops-analyst | opus | 2 | 11 (3 crit, 5 warn, 3 nit) | 11 | — |
| perf-analyst | opus | 2 | 7 (1 crit, 4 warn, 2 nit) | 7 | — (F5's cool-off adopted for IPC; F1's "clear deploy pending when the deployment appears" adopted as the product default, open question none: the deployment row carries the state) |

Deviations: `data-analyst` skipped (no persistence in Phase 2). Panel model Opus (user's choice). Wave-2 members read draft v1 from the plan file rather than receiving it inline (same content). No third loop: every wave-2 critical was step-level (branch placement, log shape, pause extraction, module boundary, confirm arming, clear rules, runbook commands), not a design change.
