# Coolwatch Phase 4 — "depth" (build logs, container logs, history, tags) and "instances"

Repo `/home/danjones/Projects/coolwatch`, base `master` at `0e6bd60`. Dan merges. Build with `/deej-stack:d-implement`. Three deliveries in order: a hotfix PR on `master` (`fix/read-sensitive-caps`, manifest stays 0.4.x), then branch `phase-4-depth` (manifest `0.5.0`, acceptance 1), then branch `phase-4-instances` from the merged depth branch (manifest `0.6.0`, acceptance 2). Each is installable and demonstrable on its own (`docs/roadmap.md:3`).

## Context

Phases 1–3 see, act and notify. Phase 4 (`docs/roadmap.md:94-110`) adds depth: the build log inside the panel, a container log tail, per-application deployment history, instance chips for a second Coolify, and tag deploy. Dan swapped in a token with `read:sensitive` on 2026-09-12, which is what makes build logs visible. It also changed the plugin's steady state before any Phase 4 code exists: every deployment row on every `GET /deployments` poll (2 s during a build) now carries that deployment's full, growing build log (`docs/coolify-api.md:184`, from Coolify source: `logs` is emitted on all three deployment GETs; `:278`: the blob grows during the build), and `GET /resources` (60 s) grew from 65 KB to 100 KB and carries webhook secrets, compose bodies and `sentinel_token` that the normalisers whitelist out but that a re-recorded fixture would commit. There is no API parameter to opt out (`docs/reference/coolify-openapi-v4.3.17.yaml:6054-6077`). The single 8 MB `max-filesize` and 6 s `max-time` on the deployments poll therefore sit under a body Coolify sizes, and a verbose build can take the deployments kind, and with it every notification, into a 30/60 s backoff. That regression is live on Dan's machine today, so its fix goes to `master` first.

The panel verified, read-only against Cloud 4.3.19, that four brief assumptions were wrong: the first log entry of every deployment has no `order` key; on both real failed builds every entry carrying a `command` is `hidden: true`; a stopped container returns **404 "Container not found."**, not 400; and the servers list carries no `proxy.status`. It found that `bin/check` bans the literal `"logs"` in any fixture while `bin/record-fixture` keeps that key, so no Phase 4 fixture can be committed until the gate changes; that five committed fixtures already carry a raw Traefik proxy config the new secret gate would reject; and that api's history already holds two failed builds (`n8xtkv4knokhlufztvww0dkc`, `yqkypstf6leyhtjhfmblpj1k`), so the rendering half of acceptance 1 needs no broken build.

**Outcome.** After the depth PR: with the panel open during a api build, `L` (or Enter, Enter) on its deployment row opens a monospace log view inside the panel that fills in from the deployments poll already running, sticks to the bottom until `k` or the wheel moves up, and on a failed build shows `$ docker exec … docker compose … pull` and `failed to resolve reference "ghcr.io/example/api:edgeyboy"` under a failure marker in the same dispatch as the Failed toast. `L` on a running application or database row shows the last 200 container lines; on a service row it first lists the service's containers. **History** in an application row's strip lists its deployments newest first, ten at a time, `Show 10 more (10 of 39)`, and Enter on a history row opens that deployment's log. A **TAGS** fold exists only if Open question 3 is answered yes. After the instances PR: with two entries in `instances[]`, chips appear under the hero; `h`/`l` on the hero and middle-click on the bar icon switch instance; each instance polls, errors, backs off and remembers Recent on its own; `status | jq '[.instances[]|{id, requestsLastMin}]'` reads each under 20 with the panel closed.

## Brief

**Ask (user's words):** "phase 4 opus 5 sub agents" (after: "ive done the api key change").

**Done predicate (`docs/roadmap.md:106-110`).** (1) A failed deployment's log is readable in the panel within one poll of failure, with the failing command visible: stated as a chain in Verification. (2) Two instances switch cleanly with independent polling and error states. Plus: `bin/check` green, the idle rate gate (per instance; aggregate reported: Open question 7), `_status()` exposes the new state, docs reconciled.

**Facts verified read-only on 2026-09-12 (Cloud 4.3.19):** one tag `canary` attached to nothing (`/applications?tag=canary` → `[]`; no endpoint lists a tag's members; only `/applications` takes `?tag=`); 3 applications, 4 services, api `xyhpwdxqu33omjgwuo6c7cjp` with 39 deployments of 23–34 s; history `take=10` = 131 900 B of which 92 % is `logs`; `GET /deployments/{uuid}` = 51 982 B (adds an 8 706 B `application` object); container logs `lines=200` = 47 198 B at ~1.1 s latency regardless of size, `lines=100000` = 2.3 MB with no server clamp; `GET /servers/{uuid}` = 5 675 B including a 2 366 B Traefik config and `settings.sentinel_token`; throughput to Cloud 0.19–2.9 MB/s; log entries: `order` absent on entry 0 then `2..n` monotonic, `batch` non-monotonic, `hidden` true on 40–63 %, `type` stderr on most lines of a *successful* build, `output` up to 672 chars with embedded newlines, no ANSI; the failing command on both failed builds is exactly 162 chars and ends in `pull'`; the failed build's 19 hidden entries include 11 lines of PHP stack trace; `JSON.parse` of a 130 KB page costs 0.09 ms in V8. Baseline: 87 node tests pass, full `bin/check` ok, live idle `requestsLastMin` 16, `perKind.deployments.lastBytes` 2 at idle.

**Assumptions (stated, not asked):**
- The active deployment's log is read off the `GET /deployments` poll that already carries it: **no log poller**. A terminal deployment's log comes from the terminal drain's `GET /deployments/{uuid}` (already fetched once) or from one on-demand fetch when the view is opened on a uuid neither active nor just drained (from history or Recent). The hotfix's probe confirms presence and growth before the depth branch starts.
- The failing entry of a `failed` deployment is always rendered under a failure marker; other hidden entries are off by default and `H` toggles them.
- Container logs: one-shot, `lines` is the constant 200, `r` refetches. Services: `GET /services/{uuid}` on press; one container → fetch; several → pick (Open question 6).
- History: one-shot on the **History** strip button, `take` constant 10, "show more" adds `skip += 10`; rows live in their own store slice and never touch `recent`.
- Tag deploy ships only if the tag is attached to something so the fan-out can run live (Open question 3, default: cut).
- Multi-instance: `instances[]` is the source; every store, timer, `Req`, ledger, baseline, pending map, notify state and state file is per instance; the selected instance is service-global; IPC verbs and the confirm dialog resolve against the instance they were opened on; the bar icon follows the **current** instance and its tooltip names another instance's trouble; toasts name the instance in the body when there are two or more.
- Acceptance 2's second instance: a second `instances[]` entry at the same Cloud origin with a `read`-only token, run with notifications off (two contexts on one account double-toast by design); a self-hosted box is needs-human (Open question 1).

**Out of scope:** Phase 5, webhooks, editing anything, log streaming/search, downloading a log, copying a log line, container logs for a stopped container beyond the not-running message, rollback images, preview deploys, a config UI, a new `panel`/`overlay` kind, per-instance `poll`/`notify`, cross-instance notification dedupe, proxy status (Risk 7), version-based feature detection (a 404 on a Phase 4 endpoint shows a note), a second sensitive-only token per instance (Open question 5), Home/End/PgUp/PgDn (`PanelKeyCatcher` does not emit them; `Keys.onPressed` is forbidden), `G` (bound to grouping), editing `/usr/share/omarchy`.

## Findings from exploration

Verified by the panel against `0e6bd60`, `/usr/share/omarchy/shell` (Omarchy 4.0.3, Quickshell 0.3.1, Qt 6.11.2) and live read-only calls.

- **The store already drops logs.** `Model.normaliseDeployment` (`Model.js:361-383`) builds a fixed-shape object with no `logs` (`branch: null` at `:365`, filled only by `joinBranch` `:453-467`, which the drain arm applies at `Service.qml:588`), and `RECENT_STRING_FIELDS` (`:771`) is a whitelist. A log view must capture the raw string in the `_dispatch` arm before normalise.
- **One `max-filesize`, one `max-time`.** `Api.js:12` `MAX_FILESIZE = 8388608`, emitted per block at `:52`; `tests/run.js:138-141` hardcodes that string for `reqDeployments`/`reqDeployment` and `:146` asserts nine lines per GET block. Deployments poll `max-time` 6 (`Service.qml:960`), drain 6 (`:701`); the reaper deadline is `maxTime + 3` (`:462`). Exit 63 → `toolarge` (`Model.js:270`) → `_fail` (`Service.qml:488-495`, `:740-757`). `_launch` (`:459`) drops a tick while the previous poll runs without `_noteRequest`. At 0.19 MB/s a 12 s `max-time` delivers 2.3 MB, so a cap above ~4 MB is unreachable and the reap (30/60 s backoff) fires instead.
- **`_fail` is unconditional for every non-action kind** in three places: the empty-stream branch (`Service.qml:478-481`), the per-result branch (`:488-495`), and the reaper (`:1044-1061`, which also adds `_backoff[kind]`; `p === actionReq` is exempt at `:1048`). `_fail` sets `_error` (`:746`) and `_probeMode` on 401/403 (`:747-749`), which stops every timer (`:133`).
- **`_record` runs inside `_finish`'s loop and self-assigns `_perKind`** (`:734-737`); `deploymentsTimer.onIntervalChanged` calls `_catchUp` (`:987-993`), which compares against `_lastPollAt`, updated by `_markPoll` only in `_dispatch` (`:633-638`). A `_deploymentsSec` binding on `_perKind` would re-enter `_launch` from inside `_finish`. `_perKind` entries are created lazily (`:773-776`).
- **`deploymentReq` is single-flight and load-bearing.** `_drainTerminal`/`_drainDone` (`:694-724`) are the only source of the Deployed/Failed toast and `recent` writes (`:591-595`); `_drainDone` is called from three places (`:480`, `:501`, `:1062`) because a reaped request never reaches `_dispatch`. `Req.arg` is assigned in `_launch` (`:463`) and is the descriptor list; `deploymentReq.inflight` (`:447`) is the bookkeeping precedent. A new `Req` must be in `_reqs` (`:454`) or the reaper, `_syncBusy` (`:456`) and `_resetStore`'s kill loop (`:352`) never see it.
- **`act()` reads `a.why`** (`Service.qml:806-807`; `_refuse` `:838-866`, `default:` at `:858`); `actionRequest` gates `UUID_RE` at `Model.js:1145` before resolving; `verb: "open"` returns `why: "notapplicable"` (`:1153`); `_setPending` keys on `a.uuid` (`:899-905`); `_expirePending` computes `gone` before any per-verb arm (`:923-927`: a fourth target type falls into `!dep` and is dropped at the first 5 s tick). `runAction(verb, key)` re-resolves the row by key (`Panel.qml:306-316`; the `open` special case at `:248`).
- **Only `instances[0]` exists.** `Service.qml:326`, `:377`, `:387`; one `tokenCmd` (`:397-406`); one `_requestLog` (`:70`, `:778-793`); one each of `_backoff`, `_paused`, `_probeMode`, `_rateLimitRemaining`, `_error`, `_warning`, `_baseline`, `_pending`, `_lastNotified`, `_actionAt`, `_perKind`, `_inflightAction`, `_actionStatus`, `_lastAction`, `_terminalQueue`, `_drainTries`, `_activeUuids`, `_topologyQueue`, `_topologyLoaded`, `_envsByProject`, `_byServer`, `_tree`, `_recentLoaded`, `_recentKey`, `_lastRecentKey`, `_busy`; `grep -c 'root\._' Service.qml` → 419. `_configText` (`:295-334`) reassigns `_cfg` to a fresh object on the notify-only path (`:304-308`) without `_resetStore`. `Model.normaliseConfig` (`Model.js:60-151`) walks every entry (`id` `:70`, url `:69` accepts userinfo, `hostOf` `:123-126`), no charset or uniqueness check.
- **`Instantiator` is first-party**: `shell.qml:1322-1345` (QtObject delegates), `plugins/agents/Main.qml:46-74` (delegates owning `FileView`s, model = a **string id list** assigned only when `JSON.stringify` differs, with the comment "reassigning the model would tear down every FileView just to build identical ones", `objectAt(i)` rebuild in `onObjectAdded`/`onObjectRemoved`), `plugins/services/media/Service.qml:440-448`. `objectAt()` is a method, not a property: a binding through it is not reactive.
- **`recent.json` is single-instance by construction.** One `recentPath` (`Service.qml:25`), key `Model.origin(url)` (`:240`), `_armRecent`/`_saveRecent` gate on `root._stateDirReady` (`:239`, `:252`), `parseRecent` rejects only on `v.instance !== instanceKey` (`Model.js:786`) and ignores unknown top-level keys. Live file `{version:1, instance:"https://app.coolify.io", n:7}`.
- **Notifications:** `ctx.origin` from `root._instance` (`:527-530`); `notifyPlan` resolves by uuid alone (`Model.js:694`, `:709`); `NOTIFY_PER_MIN` is `Model.js:600`, read against `root._notifyLog` (`Service.qml:109`, `:526`, `:535`); `acknowledgeFailures()` on `panelOpened` (`:157`).
- **The panel:** `ConfirmDialog` is a sibling of `PanelKeyCatcher` filling the card at `z: 10` (`Panel.qml:322-332`); `header` (`:369`), `footer` (`:473`) and `listView` (`:487-501`, `reuseItems: false` at `:500`) are **children of the catcher**, so anything anchoring to them must live inside it. `applyRows` (`:96-123`, callLater at `:110`); `onOpenedChanged` (`:61-62`) clears confirm/expansion only; `onMoveRequested` has the `cursorActive` guard first (`:336-340`); `onTextKey` handles `r` and `g`/`G` (`:354-357`) **before** the `focusSection !== "list"` guard (`:358`); the hero `h`/`l` stub is `:159`; the hero refresh button owns `hasCursor` (`:406`) and `onHovered` calls `focusHero()` (`:408`); row delegates carry `HoverHandler` + `MouseArea` with left and right buttons (`:622`, `:679-684`, `:750-755`, `:810-815`; the confirm scrim comment at `:258` says right clicks reach the rows); `noteComp` and `deploymentComp` are declared inside the delegate scope (`:504-866`); `deploymentComp` is the one delegate reading `nowMs` ("rows carry timestamps, not strings", `:730`); `closeLadder` (`:284-291`) debounces at 250 ms; `contentHeight` at `:315`; `BarWidget.qml` `bare bar` is the shell bar (`:29`, `:55`), the service state is `root.svc.bar` (`:56-60`).
- **Keys:** `PanelKeyCatcher.qml:47-77` consumes `h j k l` and arrows at `Keys.BeforeItem`, matches lowercase only (`:64-71`), takes `x`/`X` (`:76`), forwards other single chars (`:79-81`), fires `activateRequested` on Space (`:73-75`); no Home/End/PgUp/PgDn. `g`/`G` → grouping (`Panel.qml:357`).
- **`Model` tables:** `SELECTABLE` (`Model.js:1309`) has no `tag`; `nextSelectable` (`:1332-1341`) skips others; `rowRev` (`:1311-1315`) reads `pendingVerb`, not `pending`; `withPending` (`:1074-1092`) and `pend()` (`:1254`) key on `row.uuid`; `footerHints` filters `HINT_ORDER` (`:1365`), single-action shortcut at `:1366`; `targetTypeOf` (`:1139`); `M.GLYPHS` is asserted in five tests (`tests/run.js:635, 930, 1000, 1012-1013, 1253`, one walks `panelRows` output; use `grep -a`); the `footerHints` test (`:1258-1272`) has 14 exact strings, 13 of which change. A new error kind touches `META`, `errorFor`, `OFFLINE_EXITS` (`:246`: exit 60 is there today), `barState` (`:867-907`, unmatched kind falls to "starting"), `calloutBody` (`:918-935`).
- **Whitelists are `Object.prototype.hasOwnProperty.call`** (`Api.js:47`, `:98`, `Model.js:690`; hostile kinds tested at `tests/run.js:196-199`); `Api.block` emits a constant `data-raw = "{}"` (`:57-61`) and ignores any `body` field. `Model.js` is `.pragma library`: `node -e require()` fails; `tests/run.js:13-19` is the only loader.
- **`bin/check` gates.** `:14` bans the literal `"logs"`/`"configuration_snapshot"`, `NN|…` tokens, PRIVATE KEY, creds-in-URL, with `rc=$?` captured; it cannot see a bare 40-char `manual_webhook_secret_github` (live on all three apps) or `last_saved_proxy_configuration` (raw in `resources.json`, `deployments-active.json`, `deployment-failed.json`, `deployment-finished.json`, `deployment-cancelled.json`). `:17-24` counters loop over `Panel.qml BarWidget.qml` and count `Text {` only. `:26-28`, SR9 `:30-38`, SR16 `:40-57` glob every `*.qml`. A regex of the form `"logs"\s*:\s*"[^«"]{200,}` matches **no** real log body (the value is doubly-escaped JSON with a `"` at offset 3). `bin/record-fixture:17` scrubs values, keeps keys, supports a query string, and lacks `manual_webhook_secret_*`, `logdrain_*`, `sentinel_custom_url`, `last_saved_proxy_configuration`, `last_applied_settings`, `last_saved_settings`, `validation_logs`. `COOLWATCH_ROOT` self-tests need a `cp -r` of the repo (`bin/check:9`, `:13` exit first otherwise; Phase 3 build record step 8 did it that way). `ps | grep <needle>` self-matches; the Phase 3 record's needle-file + captured-log recipe (`docs/architecture.md:519`) is the working form. `_status()` drifts every poll (`perKind.*.lastAt/lastMs`, `rateLimitRemaining`).
- **Shell precedents:** `plugins/agents/Panel.qml:461-494` chips (`selected`, `bordered`, `Style.font.bodySmall`), `:346` middle-click, `:370-375` `onMoveRequested` dx/dy; `Ui/WidgetButton.qml:98` forwards `Qt.MiddleButton`; `plugins/panels/tailscale/Panel.qml:432-441` scrolling text; `Commons/Style.qml:269` `fontFamily: "monospace"` (`Panel.qml:27` binds it; `bin/check:26` bans a literal family); `Commons/Util.qml:10` `clamp`; `plugins/menu/Menu.qml:65,690-703` view stack + Esc pops.
- **`omarchy-shell` IPC has fixed arity**: `deploy` with no argument prints "Too few arguments" and exits 0; `_ipcAct`'s empty-uuid branch (`Service.qml:1132`) is the usage precedent. `docs/plans/` pairs `<slug>.md` + `<slug>.build.md`; Phases 2 and 3 committed the plan copy first.
- Rollback: `0e6bd60` is after the rename `dac3dff`; `AGENTS.md:11` status line is stale; the rate lock is `:94`; the Phase 3 jq line `:150`; the rollback block `:154-156`.

## Design

### Caller's usage first

`config.json` (0600) after the instances PR; the existing single-entry file stays valid unchanged:

```json
{ "version": 1,
  "instances": [
    { "id": "cloud",   "name": "Coolify Cloud", "url": "https://app.coolify.io", "token": "67|…" },
    { "id": "homelab", "name": "Homelab", "url": "http://10.0.0.5:8000",
      "tokenCommand": ["op", "read", "op://Private/Coolify Homelab/credential"] }
  ],
  "poll": { "deploymentsSec": 4, "resourcesSec": 60, "serversSec": 120, "topologySec": 600 },
  "notify": { "deploymentFailed": true } }
```

Keyboard, panel open (additions only; `docs/design.md:248-280` otherwise unchanged):

```
L            deployment row → build log view;  running application/database row → container log;
             service row → container picker (one container skips the picker)
Enter Enter  deployment row: expand, then Logs (the first strip button)
Enter        application row strip → History; history row → that deployment's log; "Show 10 more" → next page; picker row → that container's log
  in a view: j/k  scroll one line (log) or move the cursor (history/picker); k above the end releases the follow
             b    jump to the newest line and follow again (log views only)
             H    show/hide internal (hidden) steps (build log only; the failing entry is always shown on a failed build)
             r    refetch (container log only)      o  open the view's page (only when it has one)
             h / Esc  back one view through closeLadder (250 ms rungs)      l, Space, g, x  no-op in a view
h / l        hero, ≥ 2 instances: previous / next instance     middle-click on the bar icon: next instance
d / Enter    tag row → confirm → POST /deploy?tag=<name>          (only if the TAGS fold ships)
```

IPC:

```
omarchy-shell io.github.danjonesio.coolwatch instances             # -> "cloud (active), homelab"
omarchy-shell io.github.danjonesio.coolwatch instance homelab      # -> "active homelab" | "unknown instance homelab"
omarchy-shell io.github.danjonesio.coolwatch deploy <uuid>         # resolves against the active instance only; the outcome names it in status.lastAction.instance
omarchy-shell io.github.danjonesio.coolwatch status | jq '{activeInstance, requestsTotalLastMin, instances: [.instances[]|{id, configState, requestsLastMin, sensitive, paused, error}]}'
omarchy-shell io.github.danjonesio.coolwatch status | jq '{logView, history, tags}'
omarchy-shell io.github.danjonesio.coolwatch status | jq '[.instances[]|{id, requestsLastMin}]'    # the acceptance number, per token
omarchy-shell io.github.danjonesio.coolwatch status | jq '.perKind.deployments | {lastBytes, bytesLastMin, lastMs, skipped}'
```

Top-level `status` keys keep mirroring the **active** instance, so every command in `AGENTS.md` and the Phase 1–3 records keeps working.

### Data shapes

```js
// Model.parseBuildLog(logsString) -> { entries: [logEntry], dropped: int, truncated: bool, refused: bool, bytes: int }
//   bytes = logsString.length (raw input, before anything); refused = bytes > LOG_MAX_CHARS (nothing parsed, note row);
//   else parse the whole string (parseJson twice), keep the last LOG_MAX_ENTRIES entries, dropped = how many fell off the head; never throws
logEntry   = { i: int, seq: int,            // i = absolute array index (identity); seq = order || i+1 (display only)
               hidden: bool, stream: "stdout"|"stderr",
               command: string|null,       // control chars stripped, middle-elided to LOG_MAX_COMMAND (320)
               output: string,             // control chars stripped except \n and \t, capped at LOG_MAX_OUTPUT (4000)
               at: string|null }           // raw ISO timestamp, never rendered raw into _status()
logLine    = { rowType: "line", key: "<uuid>:<i>:<n>", i: int, text: string, tone: "fg"|"dim"|"urgent", hidden: bool, ...UNION_NULLS }
             // one per PHYSICAL line: a "$ " + command line when command != null, then one per "\n" chunk of output
buildLog   = { uuid, entries, dropped, rev: string, status, terminal: bool, source: "list"|"drain"|"fetch",
               truncated, refused, bytes, fetchedAt: double, message: string|null }        // service-side, never in snapshot
             // rev = entries.length + ":" + (Date.parse(last.at) || 0) + ":" + last.output.length + ":" + dropped   (digits and colons only); "" for no entries
containerLog = { uuid, kind: "application"|"database"|"service", sub: string|null, lines: [string], truncated, fetchedAt, message }
servicePick  = { uuid, names: [string], message }
historyPage  = { appUuid, count: int, rows: [deployment], skip: int, loading: bool, message: string|null }   // rows = joinBranch(normaliseHistory(json).rows, _resources)
historyRow   = deploymentRow(d, origin) + { type: "history", rowType: "history", key: "hist:"+uuid, appUuid, sub }   // sub: restartOnly ? "restart" : (branch && branch !== "HEAD" ? branch : "deploy"); createdAt/finishedAt carried, age formatted in the delegate from nowMs
moreRow      = { type: "more", rowType: "more", key: "more:"+appUuid, shown, total, loading }
pickRow      = { type: "pick", rowType: "pick", key: "pick:"+uuid+":"+name, uuid, name }
noteRow      = { rowType: "note", key, text }
tag          = { uuid, name }                                     // GET /tags; no membership exists
tagRow       = { type: "tag", key: "tag:"+uuid, uuid, name, ...withPending fields (pendingVerb, tone, dot) }
instanceChip = { id, label, selected, trouble: bool }
view         = { kind: "buildlog"|"containerlog"|"servicepick"|"history", instanceId, uuid, name, appUuid }   // status/terminal are read live from the store, never from this object
```

Every overlay row object carries the **union** of the keys above with `null` for the absent ones (`Model.viewRow(kind, fields)` fills them), because a `ListModel` fixes its roles on the first append. New store slices (single-instance in the depth PR, per-context in the instances PR): `_buildLogs` (uuid → buildLog, LRU 3), `_containerLogs` (LRU 3), `_servicePicks`, `_history` (appUuid → historyPage, LRU 3), `_tags`, `_logTargets` (panelId → uuid; retention only), `_sensitive: "unknown"|"yes"|"no"`, `_deploymentsBytes` (written by `Qt.callLater` after `_finish`), `_bytesLog` (bare numbers ring).

### Module map

| Path | Hotfix | Depth PR | Instances PR |
|---|---|---|---|
| `Api.js` | `block()` reads `req.maxBytes`; `MAX_FILESIZE_LOG = 4194304`; `reqDeployments`/`reqDeployment` carry it | `reqBuildLog`, `reqHistory`, `reqContainerLog`, `reqService`, `reqTags`, `reqDeployTag`; constants | — |
| `Model.js` | — | `LOG_*`, `parseBuildLog`, `buildLogLines`, `failingEntry`, `parseContainerLog`, `normaliseHistory`, `historyRow`, `moreRow`, `pickRow`, `viewRow`, `normaliseTags`, `tagRow`, `sensitiveState`, `fetchOutcome`/`errorText`, `deploymentsInterval`, `actionsFor`, `NAV_VERBS`, `actionRequest` tag arm, `actionOutcome`, `confirmCopy`, `panelRows` TAGS, `SELECTABLE`, `targetTypeOf`, `pendKey`, `HINT_KEY`/`HINT_ORDER`, `footerHints`, `G` additions, `logViewStatus` | `normaliseConfig` id/origin/userinfo rules, `errorFor` exit 60 → `tls` (+ `META`, `OFFLINE_EXITS`, `barState`, `calloutBody`), `instanceChips`, `instanceTrouble` |
| `Service.qml` | `max-time` 12 on `deploymentsReq`/`deploymentReq` | new `Req`s `logReq`, `historyReq`, `serviceReq`; capture; `_dispatch` arms; `_viewFail`/`_viewDone` and the three exemptions; cadence guard; `skipped`; `_bytesLog`; `_logTargets`; sensitivity; `_resetStore` extended; `_status()` fields; tag pending | `component InstanceCtx`, `Instantiator` on `_instanceIds`, `_ctxs`, root router, per-instance everything, `_status().instances[]`, IPC `instances`/`instance`, confirm/pending/lastAction carry the instance |
| `Panel.qml` | — | overlay inside the catcher with its own `ListView` + `ListModel`; view stack; keys; hoisted `deploymentComp`/`noteComp`; pinned height | chip row; hero `h`/`l`; view cleared on instance switch; confirm carries `instanceId` |
| `BarWidget.qml` | — | — | middle-click; tooltip suffix (`root.svc.bar`) |
| `bin/check`, `bin/record-fixture` | — | Step 0 gates and deny list | — |
| `tests/run.js`, `tests/fixtures/` | `:138-141` literal | new sections, fixtures, five re-scrubs | config/instances tests |
| `manifest.json` | — | `0.5.0` | `0.6.0` |
| `docs/plans/phase-4-depth.md` + `.build.md`, `docs/plans/phase-4-instances.md` + `.build.md` | — | plan copy first commit; record last | same |
| `README.md`, `AGENTS.md`, `docs/*.md` | one line each | depth docs | instances docs |

### Interfaces

**Api.js**

```js
var MAX_FILESIZE = 8388608, MAX_FILESIZE_LOG = 4194304;      // 8 MB default; 4 MB for log-bearing GETs (reachable inside max-time 12 at 0.35 MB/s)
var HISTORY_TAKE = 10, CONTAINER_LINES = 200;
var CONTAINER_GROUP = { application: "applications", database: "databases", service: "services" };
// block(): 'max-filesize = "' + (req.maxBytes || MAX_FILESIZE) + '"\n'   (the only change; still nine lines per GET)
function reqDeployments()       { return { kind: "deployments", path: "/deployments", maxBytes: MAX_FILESIZE_LOG }; }
function reqDeployment(uuid)    { return { kind: "deployment", path: "/deployments/" + seg(uuid), arg: uuid, maxBytes: MAX_FILESIZE_LOG }; }
function reqBuildLog(uuid)      { return { kind: "buildlog", path: "/deployments/" + seg(uuid), arg: uuid, maxBytes: MAX_FILESIZE_LOG }; }
function reqHistory(uuid, skip) { return { kind: "history", path: "/deployments/applications/" + seg(uuid) + "?skip=" + Math.max(0, skip | 0) + "&take=" + HISTORY_TAKE, arg: uuid, maxBytes: MAX_FILESIZE_LOG }; }
function reqContainerLog(kind, uuid, sub) {
  if (!Object.prototype.hasOwnProperty.call(CONTAINER_GROUP, kind)) return null;
  var q = "?lines=" + CONTAINER_LINES + "&show_timestamps=false" + (kind === "service" ? "&sub_service_name=" + seg(sub) : "");
  return { kind: "containerlog", path: "/" + CONTAINER_GROUP[kind] + "/" + seg(uuid) + "/logs" + q, arg: uuid }; }
function reqService(uuid)       { return { kind: "service", path: "/services/" + seg(uuid), arg: uuid }; }
function reqTags()              { return { kind: "tags", path: "/tags" }; }
function reqDeployTag(name)     { return { kind: "action", verb: "deployTag", target: name, method: "POST", path: "/deploy?tag=" + seg(name) }; }   // same block shape as reqDeploy (Api.js:93-95); no body field (block() emits the constant data-raw)
```

**Model.js**

```js
var ID_RE = /^[A-Za-z0-9_-]{1,32}$/, TAG_RE = /^[^\s\/?#&=,]{1,64}$/;       // id: state-file safe; tag: one query value, comma excluded (Coolify's multi-tag separator)
var LOG_CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;                          // derived from notifySafe's class (Model.js:625-629) minus \t \n; comment at both sites
var LOG_MAX_ENTRIES = 2000, LOG_MAX_OUTPUT = 4000, LOG_MAX_COMMAND = 320, LOG_MAX_CHARS = 3145728;
var NAV_VERBS = { open: true, logs: true, history: true };                   // never reach act()
parseBuildLog(logsString)                -> buildLog fields (see Data shapes)
buildLogRev(entries, dropped)            -> string                            // "" when entries is empty
buildLogLines(entries, { showHidden, failing, uuid }) -> [logLine]          // physical lines; failing entry (and its output) always emitted with tone "urgent"; other hidden entries only when showHidden; "Deployment failed" output lines urgent; command lines "$ …" dim
failingEntry(entries, status)            -> logEntry|null                     // status === "failed": last entry with command != null && stream === "stderr" before the first output starting "Deployment failed"; else null
elideMiddle(s, max)                      -> string                            // keeps head and tail; used for command
parseContainerLog(json)                  -> { lines, truncated }              // json.logs string split on \n, control chars stripped, LOG_MAX_ENTRIES tail; non-string -> []
normaliseHistory(json)                   -> { count, rows: [normaliseDeployment(d)] }   // {count, deployments[]}
historyRow(d, appUuid, origin)           -> historyRow                        // deploymentRow(d, origin) + overrides; reads d.restartOnly
moreRow(page) -> moreRow|null; pickRow(uuid, name) -> pickRow; viewRow(kind, fields) -> union-filled row
normaliseTags(arr) -> [tag]; tagRow(tag) -> tagRow (run through withPending by panelRows' pend(), keyed by tag.uuid)
sensitiveState(rawRow)                   -> "yes"|"no"|"unknown"              // "yes" iff typeof logs === "string"; "no" iff status is TERMINAL and logs is undefined/null; else "unknown"
instanceChips(instances, activeId) -> [instanceChip]; instanceTrouble(instances) -> string
fetchOutcome(rec)                        -> { text, tone }                    // 404 + /Container not found/ -> "<name> is not running."; 400 + /Sub service name/ -> "Pick a container."; 404 on history -> "Coolify no longer has that application."; 404 on buildlog -> "Coolify no longer has that deployment."; toolarge -> "This build log is larger than 4 MB. Open it in Coolify."; 429 -> "Rate limited · backing off Ns."; else errorText(e)
errorText(e)                              // extracted from actionOutcome (Model.js:1188-1202); used by both
deploymentsInterval(deploying, cfgSec, lastBytes) -> int                     // !deploying: cfgSec; else lastBytes > 4 MB: 15, > 1 MB: 8, > 256 KB: 4, else 2
actionsFor(row)        // deployment rows [Logs, Cancel?, Open]; application rows + History; running app/db/service rows + Logs; tag rows [Deploy (confirm)]
actionRequest(s, verb, uuid)             // NAV_VERBS -> { ok: false, why: "nav" }; tag arm BEFORE the UUID_RE gate: verb "deployTag" && s.tags has uuid -> { ok: true, verb, uuid: tag.uuid, name: tag.name, targetType: "tag" }
targetTypeOf(row)      // + "tag";  pendKey(row) -> row.uuid (tags included: pending is keyed by the tag uuid)
actionOutcome(...)     // + deploymentUuids [], queued n, refused m from deployments[] (queue_full counts as refused)
confirmCopy(row, verb) // tag: "Deploy everything tagged <name>? Coolify decides what that is; the API cannot list it."
panelRows(s, ui)       // + TAGS fold after RESOURCES when s.tags.length > 0 (before both spliceActions returns, :1276 and :1306); SELECTABLE gains tag, history, more, pick
footerHints(ctx)       // + HINT_ORDER entries: logs (after cancel), history (after deploy); view lines: "log · following · j/k scroll · b newest · H steps · o open · h back" (o only with a URL), "log · held · …", "log · paused · …" (429), history, picker, tag
logViewStatus(view, rec)                 -> { kind, uuid8, entries, dropped, rev, bytes, source, following }   // counts and the digits-only rev; never text
```

**Service.qml (depth PR, single instance)**

```qml
Req { id: logReq; property var target: null }  Req { id: historyReq; property var target: null }  Req { id: serviceReq; property var target: null }   // in _reqs
readonly property var views: ({ buildLogs: _buildLogs, containerLogs: _containerLogs, picks: _servicePicks, history: _history })   // beside snapshot (the pending precedent); every write is mutate-then-self-assign (root._buildLogs = root._buildLogs)
function openBuildLog(panelId, uuid)   // sets _logTargets[panelId]; if _buildLogs[uuid] exists: nothing else; else if uuid is active: wait for the next list poll; else _launch(logReq, [Api.reqBuildLog(uuid)], 12)
function closeView(panelId)            // delete _logTargets[panelId]
function fetchContainerLog(kind, uuid) / fetchContainerLogSub(uuid, sub) / fetchHistory(appUuid, skip) / fetchTags()
function _captureLog(uuid, raw, status, source)   // ALWAYS updates status/terminal/source/fetchedAt; parses only when raw.length !== rec.bytes; LRU 3
function _viewFail(kind, target, e)    // sets the record's message via Model.fetchOutcome; never _error/_backoff/_probeMode/_failedUnacked; 429 -> _pauseFor
function _viewDone(req)                // clears req.target; called from the empty-stream branch (:480), the end of _finish (:501) and the reaper (:1062), like _drainDone
```

- **Capture** happens opportunistically for **every** active row in the `deployments` arm (LRU 3, skip when `raw.length === rec.bytes`) so `L` renders immediately; `_logTargets` only pins entries against eviction. The `deployment` (drain) arm captures for every drained uuid with `source: "drain"` (a just-failed deployment's log is present in the same dispatch as the Failed toast). The `buildlog` arm captures with `source: "fetch"`. `sensitiveState` runs on every raw row in the `deployments`, `deployment`, `buildlog` and `history` arms; the latch is one-way toward `"yes"`, and `"no"` is written only while `"unknown"`.
- **Three exemptions for view kinds** (`buildlog`, `containerlog`, `service`, `history`, `tags`): the empty-stream branch (`:478-481`), the per-result branch (`:488-495`) and the reaper (`:1044-1061`, next to the `actionReq` exemption at `:1048`) all route to `_viewFail`; the reaper also skips `consecutiveFailures`/`_backoff` for them. A successful view fetch does not call `_succeeded` (it must not lift `_probeMode`).
- **Cadence guard**: `_deploymentsSec: Model.deploymentsInterval(root._deploying, cfgSec, root._deploymentsBytes)`. `_deploymentsBytes` is written by `Qt.callLater` after the `_finish` loop, never inside it (re-entrancy through `_catchUp`), and reset to 0 when `_deploying` goes false. `max-time` 12 for `deployments`/`deployment`/`buildlog`/`history`/`containerlog`. `_launch`'s early return increments `_perKindEntry(reqs[0].kind).skipped`. `_bytesLog` is a bare-number ring pushed in `_record` and exported as `perKind[kind].bytesLastMin`.
- **`_expirePending`**: `targetType === "tag"` is exempt from the `gone` test at `:926`; its arm clears when any `deploymentUuids` entry appears in `_activeUuids` or `_recent`, else after two deployments polls, else the 300 s drop. `_descriptorFor("deployTag")` builds `Api.reqDeployTag(a.name)`; pending is keyed by the tag uuid.
- **`_resetStore`** clears `_buildLogs`, `_containerLogs`, `_servicePicks`, `_history`, `_tags`, `_logTargets`, `_sensitive`, `_deploymentsBytes` and the three `.target`s.
- `_status()` gains `logView` (the newest `_logTargets` entry, via `logViewStatus`), `history {uuid8, pages, rows, count}`, `tags {count, fetchedAt}`, `sensitive`, `perKind[kind].skipped/bytesLastMin`. Log lines: `console.log("coolwatch logview …")` with uuid8, source, counts, bytes only.

**Service.qml (instances PR)**

```qml
property var _instanceIds: []                       // assigned in _configText only when JSON.stringify differs (agents/Main.qml:46-49 idiom); the notify-only path never touches it
Instantiator { model: root._instanceIds; delegate: InstanceCtx { instId: modelData }
               onObjectAdded: root._ctxs = …; onObjectRemoved: root._ctxs = … }
property var _ctxs: []; property string _activeId: ""
readonly property var _active: … from _ctxs and _activeId …             // real dependencies, never objectAt()
component InstanceCtx: Item {
  property string instId; readonly property var inst: (root._cfg.instances.filter(i => i.id === instId)[0] || null)
  property string token: ""                                              // written only by _tokenReady, read only by _launch
  // every property from Service.qml:47-125 plus the depth slices, the ten Reqs (in its own _reqs), the timers, tokenCmd, recentFile, _resetStore, its own Component.onDestruction (timers, tokenCmd, recentFile, _reqs)
  readonly property var snapshot / bar / views
  function act(verb, uuid, fromIpc, hint, instanceId)   // refuses "wrong instance" when instanceId !== instId
}
// root keeps: _cfg, the config FileViews, statProc, mkdirProc, _stateDirReady, _panels/_openPanels and their prune (fanned out to every context's closeView), _notifyLog + _chargeNotify(n) (read and charge in one call), _dnd, the reaper driver, the public surface
readonly property var snapshot: _active ? _active.snapshot : null;  views; bar (current instance; tooltip suffix from Model.instanceTrouble(_ctxs))
function selectInstance(id) / cycleInstance(dx)   // panels pop every view on activeId change
IpcHandler { function instances(): string; function instance(id: string): string; deploy/restart/stop/start resolve against _active only; lastAction.instance }
```

- `_configText` compares each instance entry by id: a new id → a new context; a removed id → that context's `_resetStore()` (kill loop, `token = ""`) then the delegate is released; a changed entry → that context's `_resetStore()`; unchanged entries keep their stores. A `notify`-only edit changes nothing in the contexts.
- State files: `instances[0]` keeps `recent.json`; every further instance gets `recent-<id>.json`. Every file written by this version carries `id`; `parseRecent` rejects on `id` mismatch **when the field is present** (Phase 3 files have none and are accepted for `instances[0]`; Phase 3's `parseRecent` ignores unknown keys, so rollback reads a Phase 4 file). `_armRecent` re-arms when a context's index or id changes. Reordering `instances[]` is a history-moving edit and is documented as such.
- `_flushNotify` runs per context with that context's snapshot and origin; `notifyBody` appends ` · <instance name>` when `_ctxs.length > 1`; the minute budget is charged through the root's `_chargeNotify` before the next context plans. `acknowledgeFailures()` acks the active context. The `views` property is readable through `shell.serviceFor()` like `_token` and `snapshot`; `docs/architecture.md` records it under the `serviceFor` note.
- Per-request log line becomes `coolwatch <id>/<kind> <code> exit=<n> <ms>ms <bytes>B`.

**Panel.qml**

```qml
property var viewStack: []; readonly property var view: viewStack.length ? viewStack[viewStack.length - 1] : null
property bool following: true; property bool showHidden: false; property string viewCursorKey: ""; property int consumed: 0; property int seenDropped: 0
readonly property var liveRec: view ? (view.kind === "buildlog" ? svc.views.buildLogs[view.uuid] : …) : null
readonly property string myRev: liveRec ? liveRec.rev : ""        // onMyRevChanged drives sync(); early return when !panel.opened
// focusSection gains "view"; while view !== null: chips hidden, breadcrumb row in the header Column (Panel.qml:369),
// contentHeight: fittedContentHeight(header + 14 + Style.space(480) + 10 + footer, Style.space(640)); footer strings one line
Item { id: overlay; z: 9; visible: root.view !== null; parent: the PanelKeyCatcher (sibling of header/footer/listView); anchors.top: header.bottom; anchors.bottom: footer.top
  MouseArea { anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.AllButtons; onWheel: { root.following = false; wheel.accepted = false } }   // nothing beneath sees pointer input
  ListView { id: viewList; model: ListModel { id: viewModel }; clip: true; ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
    onMovementStarted: root.following = false; onFlickStarted: root.following = false           // the hold is driven by user input only, never by contentY
    delegate: Loader on model.rowType -> lineComp | deploymentComp (hoisted to the Panel root, shared with the main list) | moreComp | pickComp | noteComp (hoisted) }
  function sync() { // build log: if rec.dropped > seenDropped: viewModel.remove(0, rec.dropped - seenDropped); seenDropped = rec.dropped
                    // append Model.buildLogLines(rec.entries.slice(consumed - rec.dropped), …) rows; consumed = rec.dropped + rec.entries.length
                    // showHidden toggle or a status change to "failed": clear + refill; history/picker: clear + refill (≤ 40 rows)
                    if (root.following) viewList.positionViewAtEnd() } }
onMoveRequested: if (root.view) { if (dx < 0) { root.closeLadder(); return }  if (dx > 0) return                       // BEFORE the cursorActive guard (:336-340)
                                  if (view.kind is a log) { viewList.contentY = Util.clamp(viewList.contentY + dy * lineStep, 0, max); if (dy < 0) root.following = false; if (dy > 0 && viewList.atYEnd) root.following = true }
                                  else { viewCursorKey = Model.nextSelectable(viewRows, viewCursorKey, dy); viewList.positionViewAtIndex(Model.indexOfKey(viewRows, viewCursorKey), ListView.Contain) } return }
                 if (root.focusSection === "hero" && dx !== 0 && svc.instances.length > 1) { svc.cycleInstance(dx); return }   // fills the :159 stub (instances PR)
onActivateRequested: if (root.view) { history/pick rows: activateView(); more row: fetch next; log views: no-op; return }
onTextKey: if (root.view) { "L"|"H"|"b"|"r"|"o" dispatched to the view functions; everything else no-op; return }       // FIRST statement, above the r/g cases at :354-357
           "L" on a deployment row / running row -> openLogsFor(currentRow)
closeLadder(): if (confirmOpen) …; else if (viewStack.length) { popView(); svc.closeView(panelId) }; else if (expandedKey) collapse(); else close   // 250 ms rungs as today
runAction(verb, key): if (Model.NAV_VERBS[verb]) { navigate by verb } else svc.act(...)     // extends the open case at :248; tag rows pass row.uuid as today
onOpenedChanged: if (!opened) { viewStack = []; svc.closeView(panelId) }; onTabRequested: pop everything first; on svc.activeId change: viewStack = []
applyRows(): skip the Qt.callLater(scrollToSelection) while root.view !== null
focusHero(): no-op while root.view !== null
panelAlive(id, viewUuid) every second re-asserts the watched uuid (so a candidate panel never loses it)
```

Chips (instances PR): `Row` under the hero, `Repeater` over `Model.instanceChips(svc.instances, svc.activeId)`, `Button { selected; bordered: true; fontSize: Style.font.bodySmall; text: label + (trouble ? " ·" : "") }`, **no `hasCursor`**, `visible: chips.length > 1 && !root.view`. Breadcrumb row: `‹ api · failed · 12m ago` / `‹ api · last 200 lines · 12s ago` / `‹ api · 39 deployments` / `‹ wordpress · pick a container`; left click pops. `‹` goes through the JetBrainsMono check and into `G` (the `GLYPHS` tests walk every emitted glyph); fallback `<`. Confirm: `confirmAction` gains `instanceId`; `resolveConfirm` closes with a status line and sends nothing when `svc.activeId !== c.instanceId`.

**BarWidget.qml** (instances PR): `onPressed` `Qt.MiddleButton` → `svc.cycleInstance(1)`; tooltip `root.svc.bar.tooltip + (root.svc.trouble ? " · " + root.svc.trouble : "")`.

### Rejected alternatives

- **One branch for depth and instances.** Multi-instance rewrites ~700 lines and 419 `root._` references; queued behind it, nothing user-visible would ship until the sixth step, and a regression there blocks five steps. Two PRs each carry one acceptance criterion and are each installable.
- **Log lines as row types inside the existing `ListView`.** `reuseItems: false` (`Panel.qml:500`) over a wholesale-reassigned array rebuilds every delegate per append, per monitor, every 2 s; `rowRev` has no field for a log tail; `applyRows`'s `scrollToSelection` fights the follow. The overlay keeps its own `ListModel`, appends by absolute index, and removes from the head when the tail cap drops entries.
- **A dedicated `GET /deployments/{uuid}` poll while the log view is open.** 36 + 30 = 66 req/min, over the "under 60 with one deployment" gate, downloading bytes the list poll already carries. Kept only as Risk 1's fallback.
- **Capping the raw log string before the parse.** A cut mid-array throws, the "never throw" rule turns it into an empty log, and the tail promised by SR27 never exists. The whole string is parsed and then bounded; above `LOG_MAX_CHARS` the parse is refused with a note row.
- **A 24 MB `max-filesize`.** Unreachable inside `max-time` 12 at the measured 0.19 MB/s floor; the reap and its 30/60 s backoff would fire instead and the "too large" copy would be dead. 4 MB is the largest cap the timeout can deliver.
- **A single v2 map-shaped `recent.json`.** A Phase 3 rollback would read it as corrupt. Per-instance files with `recent.json` unchanged for `instances[0]` cost one filename and an optional `id` field.
- **Per-instance `poll`/`notify`**; **cross-instance notification dedupe** (independent notification state *is* acceptance 2; two contexts on one account is the test configuration, not a product one).

## Reuse

- `Api.js:39-63` `block()`, `:65-74` `config()`, `:93-95` `reqDeploy` (query-string precedent), `:47`/`:98` `hasOwnProperty.call`, `:19-33` `quote`/`seg`, `:57-61` constant `data-raw`.
- `Model.js:160-185` `splitResponses`, `:202` `parseJson`, `:230-236` `redact`, `:263-283` `errorFor` + `META` + `calloutBody` (`:918-935`) + `barState` (`:867-907`) + `OFFLINE_EXITS` (`:246`), `:361-383` `normaliseDeployment`, `:453-467` `joinBranch` (applied as at `Service.qml:588`), `:972-983` `deploymentGlyph`, `:1044-1052` `deploymentRow`, `:1074-1092` `withPending` + `:1254` `pend()`, `:1374-1396` `elapsed`/`age` with `ui.nowMs` (`:1247`), `:1023-1042` `openUrl`, `:1102-1125` `actionsFor`, `:1143-1158` `actionRequest`, `:1168-1176` `confirmCopy`, `:1188-1202` the error switch, `:1233-1243` `spliceActions`, `:1245-1307` `panelRows`, `:1309` `SELECTABLE`, `:1311-1349` `rowRev`/`sameRows`/`indexOfKey`/`nextSelectable` (pure over any `[{type,key}]` array; reused inside the overlay), `:1351-1368` `HINT_*`/`footerHints`, `:476-480` `topologyIntervalSec` (the shape of `deploymentsInterval`), `:625-629` `notifySafe`'s class, `:577` `uuid8`, `:781-819` `parseRecent`/`serialiseRecent`, `:118-122` `configSansNotify`.
- `Service.qml:420-454` `Req` + `_reqs`, `:458-509` `_launch`/`_finish`, `:558-631` `_dispatch`, `:694-724` `_drainTerminal`/`_drainDone` (the three-site settler shape for `_viewDone`), `:476-477` + `:867-895` the action exemption and `_say`, `:1048` the reaper's `actionReq` exemption, `:154-184` panel registry, `:898-953` pending table, `:732-738` `_record`, `:778-793` bare-number rings, `:225-257` `recentFile` + `:208-223` `mkdirProc`, `:295-334` `_configText` (`:300` identical-text short-circuit is the compare-then-assign precedent), `:1088-1134` `_status()`, `:1132` `_ipcAct` usage arm.
- `Panel.qml:322-332` `ConfirmDialog` shape, `:263-281` `openConfirm`/`resolveConfirm` (immutable capture at open), `:284-291` `closeLadder`, `:242-253` `runAction`, `:514-526` delegate Loader, `:615-668` `foldComp`, `:531-559` `actionsComp`, `:601-612` `noteComp` and `:671-739` `deploymentComp` (hoisted), `:293-304` `scrollToKey`, `:89-94` `toneColor`, `:159` the hero stub, `:27` `fontFamily`, `:69-74` the 1 s `nowMs`/`panelAlive` timer (drives the breadcrumb age).
- Shell: `plugins/agents/Main.qml:46-74` (`Instantiator` guard + `objectAt` rebuild), `plugins/agents/Panel.qml:461-494` chips, `:346` middle-click, `:370-375` dx/dy; `Ui/WidgetButton.qml:98`; `plugins/panels/tailscale/Panel.qml:432-441`; `plugins/menu/Menu.qml:65,690-703`; `Commons/Util.qml:10` `clamp`; `Commons/Style.qml:269`.
- `tests/run.js:13-79` helpers; `docs/plans/phase-3-notify.build.md` procedures: 12 × 10 s status loop + `jq -s … max`, `jq` + `install -m 600` config edit, needle-file + captured-log leak check, `cp -r` + `COOLWATCH_ROOT` gate self-test.

## Security requirements

Numbering continues the architecture doc (item 26 = plan SR24).

- **SR25 — no rich text.** Every `Text`, `TextEdit`, `TextArea` in every `.qml` is PlainText; `Text.RichText|StyledText|MarkdownText|AutoText` never appears. `bin/check` over every `*.qml`. Step 0.
- **SR26 — log text is view-only.** Build/container log text never enters `snapshot`, `_status()`, `recent*.json`, a `console.*` line, an error `detail`, or a notification argv; `logViewStatus` emits counts and a digits-only `rev`; the `views` property is the one in-process surface and is recorded in the threat model beside `_token` (readable through `serviceFor`). Node test (`rev` matches `/^[0-9:]*$/`; status object has no `text`/`lines`/`entries` array) + `bin/check` grep. Steps 1, 3, 9; instances docs.
- **SR27 — sanitised, bounded log entries.** Each parsed entry validated as an object; `output`/`command` strings with C0/C1 stripped (`\n`, `\t` kept), capped at 4000/320 (command middle-elided); at most 2000 entries (tail, with `dropped`); a string above 3 MB is refused (note row) rather than parsed; non-array or malformed → `entries: []`, never a throw. Step 1.
- **SR28 — query values through `Api.seg`, integers from constants.** `sub_service_name` and `tag` through `seg`; `lines`/`take` constants; `skip` clamped; `kind` through `CONTAINER_GROUP` (`.call` form); one tag per request (`TAG_RE` excludes `,`). Tests assert the emitted config for `& # / .. " \n , é`. Step 1.
- **SR29 — view fetches never poison global state.** All three failure paths (empty stream, per-result, reaper) route view kinds to `_viewFail`; never `_error`, `_backoff`, `_probeMode`, `_failedUnacked`, `consecutiveFailures`; a success never calls `_succeeded`; only 429 reaches `_pauseFor`. AGENTS.md "Don't" gains the rule. Step 3.
- **SR30 — per-descriptor `max-filesize`, byte-aware cadence, observable starvation.** Log-bearing kinds cap at 4 MB (reachable inside `max-time` 12); the deployments interval steps at 256 KB/1 MB/4 MB; the byte input is written after `_finish` and reset when no build runs; `skipped` and `bytesLastMin` are exported; a non-zero `skipped` during a build is a finding. Hotfix + Step 3.
- **SR31 — fixtures cannot carry a real log or a new-ability secret.** `bin/check` fails on any `"logs"`/`"configuration_snapshot"` key whose value is not `null` or `"«scrubbed»"`, and on any key matching `manual_webhook_secret_|sentinel_token|sentinel_custom_url|logdrain_[a-z_]*(key|config|url)|last_saved_proxy_configuration|last_applied_settings|last_saved_settings|validation_logs` with a non-scrubbed value; five existing fixtures are re-scrubbed; the deny list gains those keys; build-log fixtures are hand-authored entry arrays under `entries`; the container-log fixture keeps its text under `text` and the test wraps it. Step 0.
- **SR32 — instance `id` is a safe filename.** `ID_RE` and uniqueness are config errors before any path is built. Instances PR Step 10.
- **SR33 — no userinfo in an instance URL** (config error); chips render `name` only. Step 10.
- **SR34 — tokens in one place per context**; no new surface; outgoing contexts are reset (kill loop, `token = ""`) before release; `docs/architecture.md` states exposure scales with instance count. Step 11.
- **SR35 — tag deploy blast radius stated**; per-item outcome "n queued, m refused"; the confirm captures `instanceId` and is refused on mismatch; one tag per request. Step 7 (conditional) + Step 12.
- **SR36 — TLS failures are named.** Exit 60 is `tls` (four sites: `META`, `errorFor`/`OFFLINE_EXITS`, `barState`, `calloutBody`), retried like any transport error (curl aborts before any request, so the Bearer header was never sent); `insecure`/`-k`/`proto-default` never emitted (node test). Step 10.
- **SR37 — missing `read:sensitive` is detected, not silent.** `sensitiveState` (terminal rows only, one-way latch) fed from the deployments, drain, buildlog and history arms; the view shows the swap-the-token sentence; `_status().sensitive` reports it. Step 3.
- **SR38 — actions bind to the instance they were opened on.** IPC verbs resolve against the active instance only; the confirm and every pending entry carry the instance; `lastAction.instance` names it. Step 12.

## Changes

### Hotfix PR `fix/read-sensitive-caps` (on `master`, before the depth branch)
Files: `Api.js`, `Service.qml`, `tests/run.js`, `docs/architecture.md` (HTTP client: one paragraph), `AGENTS.md` (product lock: one sentence).
- `Api.block` reads `req.maxBytes || MAX_FILESIZE`; `MAX_FILESIZE_LOG = 4194304`; `reqDeployments`/`reqDeployment` carry it. `tests/run.js:138-141`: `want` derives `max-filesize` from `r.maxBytes || A.MAX_FILESIZE`; `:146` nine-lines assertion unchanged; new case asserts `"4194304"` for both and `"8388608"` for `reqResources`.
- `Service.qml:960` and `:701`: `max-time` 12 (the reaper deadline follows, `:462`).
- **Risk 1 probe** (needs no watcher): `omarchy-shell io.github.danjonesio.coolwatch deploy xyhpwdxqu33omjgwuo6c7cjp`, then `for i in $(seq 45); do omarchy-shell io.github.danjonesio.coolwatch status | jq -c '.perKind.deployments|{lastBytes,lastMs}'; sleep 1; done > $SCRATCH/probe.log`. Pass: `lastBytes` rises well above 2 KB during the build **and** grows between samples (presence and growth). Record the max in the PR description. If it stays ~2 KB with an active deployment, stop: the depth branch takes Risk 1's fallback before Step 3.
**Verify**: `node tests/run.js`; `bin/check`; `bin/dev-sync && omarchy restart shell`; the probe log; `requestsLastMin` < 20 over 12 × 10 s with the panel closed. Merge → `<hotfix-sha>`; the depth branch and its rollback line use it.

### Depth PR `phase-4-depth` (from `<hotfix-sha>`)

#### 0. Plan copy, gates, re-scrub
Files: `docs/plans/phase-4-depth.md` (first commit: this plan), `bin/check`, `bin/record-fixture`, the five fixtures, `AGENTS.md` (Commands block).
- `bin/record-fixture:17` deny list gains `manual_webhook_secret_github|manual_webhook_secret_gitlab|manual_webhook_secret_gitea|manual_webhook_secret_bitbucket|logdrain_[a-z_]+|sentinel_custom_url|last_saved_proxy_configuration|last_applied_settings|last_saved_settings|validation_logs`.
- Re-scrub in place (`jq` walk as the recorder does, same keys → `"«scrubbed»"`): `resources.json`, `deployments-active.json`, `deployment-failed.json`, `deployment-finished.json`, `deployment-cancelled.json`. No test reads those keys.
- `bin/check:14`: replace the `"logs"`/`"configuration_snapshot"` alternatives with a whitelist pair: `grep -rEn '"(logs|configuration_snapshot)"[[:space:]]*:' tests/fixtures | grep -vE ':[[:space:]]*(null|"«scrubbed»")[[:space:]]*,?[[:space:]]*$'` must be empty (own `rc` capture); second grep for the secret-key family with a non-scrubbed value (own `rc`). `export LC_ALL=C.UTF-8` at the top.
- `bin/check:17-24`: loop over `"$root"/*.qml`; count `(Text|TextEdit|TextArea) {` against `textFormat: Text(Edit)?\.PlainText`; keep the Panel floor. SR25 grep. SR26 grep: no `console\.(log|warn|error)\(` line in `Service.qml` containing `.output`, `.entries`, `.lines`, `.text` or `logs`.
- Self-test: `cp -r` the repo into `$(mktemp -d)`, drop a probe into its `tests/fixtures/`, `COOLWATCH_ROOT=$copy bin/check --no-shell`, three runs: `{"logs": "«scrubbed»"}` passes; `{"logs":"[{\"command\":null,\"output\":\"<400 a's>\"}]"}` (doubly-escaped, the real shape) fails; `{"manual_webhook_secret_github": "abc"}` fails.
**Verify**: `bin/check --no-shell` → `ok` after the re-scrub; `git diff --stat` touches only the plan copy, the two scripts, the five fixtures and AGENTS.md; `node tests/run.js` → 87 passed.

#### 1. `Api.js` + `Model.js`: descriptors and pure parsers
Files: `Api.js`, `Model.js`, `tests/run.js`, `tests/fixtures/` (new: `deployment-log-failed.json`, `deployment-log-finished.json` (hand-authored `{ "_note", "status", "entries": [...] }`; the failed one carries a hidden stderr entry with a 250-char command ending in `pull'`, an entry-0 without `order`, a multi-line output, non-monotonic `batch`, 11 stack-trace-like hidden lines), `container-log.json` (hand-authored `{ "_note", "text": "line1\nline2\nline3" }`), `container-log-404.json`, `container-log-400.json`, `service-detail.json` (recorded, trimmed), `history-page.json` (recorded via `bin/record-fixture history-page '/deployments/applications/xyhpwdxqu33omjgwuo6c7cjp?skip=0&take=10'`, trimmed to 3 rows, `count: 39`), `history-empty.json`, `history-404.json`, `tags.json`, `tags-empty.json`, `action-deploy-tag-ok.json` (hand-pasted through the scrubber: two items, one `queue_full`)).
- Descriptors and constants per Interfaces (SR28). `LOG_CTRL_RE` (comment at both sites), `parseBuildLog`, `buildLogRev`, `buildLogLines`, `failingEntry`, `elideMiddle`, `parseContainerLog`, `normaliseHistory`, `historyRow`, `moreRow`, `pickRow`, `viewRow`, `normaliseTags`, `tagRow`, `sensitiveState`, `fetchOutcome`/`errorText`, `deploymentsInterval`, `logViewStatus`.
- Parser tests feed `JSON.stringify(JSON.stringify(fx("deployment-log-failed").entries))`; container-log cap/tail cases are built in-test (`"x\n".repeat(2100)`).
**Verify**: `node tests/run.js` green with this step's Tests-to-add; `bin/check --no-shell` → `ok`.

#### 2. `Model.js`: rows, actions, hints, tables
Files: `Model.js`, `tests/run.js`.
- `actionsFor`, `NAV_VERBS` (`why: "nav"`), `actionRequest` tag arm before `UUID_RE`, `targetTypeOf` + `pendKey`, `actionOutcome`, `confirmCopy`, `panelRows` TAGS fold, `SELECTABLE` + `tag/history/more/pick`, `HINT_KEY` + `HINT_ORDER`, `footerHints` view lines, `G` additions (`‹` or `<`, tag glyph) with the JetBrainsMono check, `rowRev` unchanged (tags carry `pendingVerb` through `withPending`).
- `tests/run.js:1258-1272`: the 13 changed `footerHints` strings updated deliberately; `GLYPHS` tests stay green.
**Verify**: `node tests/run.js` green; the `actionRequest` nav/tag cases are node tests (no `node -e`: `Model.js` is `.pragma library`).

#### 3. `Service.qml`: capture, view Reqs, exemptions, cadence, sensitivity, pending
Files: `Service.qml`.
- Everything under "Service.qml (depth PR)" in Interfaces: slices, `views` (self-assign idiom), `logReq`/`historyReq`/`serviceReq` in `_reqs` with `.target`, opportunistic capture in the `deployments` arm, drain/fetch capture, `_viewFail`, `_viewDone` from the three sites, the three exemptions, no `_succeeded` on view success, `_captureLog` semantics (`bytes` = raw length; status/terminal/source always updated), `sensitiveState` from four arms with the one-way latch, cadence guard via `_deploymentsBytes` (`Qt.callLater`, reset when idle), `max-time` 12 on view kinds, `skipped` from `reqs[0].kind`, `_bytesLog` ring + `bytesLastMin`, `_expirePending` tag exemption + arm, `_descriptorFor("deployTag")`, `_refuse` `nav` arm, `_resetStore` extended, `panelClosed`/prune → `closeView`, `panelAlive(id, viewUuid)`, `_status()` fields, `coolwatch logview` lines (counts only).
**Verify**: `bin/check`; `bin/dev-sync && omarchy restart shell`; `status | jq '{logView, history, tags, sensitive, perKind: (.perKind.deployments|{skipped, bytesLastMin})}'` at idle → nulls/`unknown`/0; `omarchy-shell … deploy xyhpwdxqu33omjgwuo6c7cjp` with the panel open on its row: a 1 s status loop shows `logView.source` `list` with `entries` rising, then `drain` with `terminal` true in the same sample that `lastAction`/Recent flips; `skipped` 0; `status.error` null after a `containerlog` 404; `install -m 600` a config with a mangled token while a view is open → `status.logView` null and the view empties.

#### 4. `Panel.qml`: overlay, keys, breadcrumb, hoisted components
Files: `Panel.qml`.
- Everything under "Panel.qml" in Interfaces (minus chips and instance switching). States/copy as note rows in the overlay: `Loading log…`, `Queued. Coolify has not started this build yet.`, `Starting…`, `Coolify no longer has that deployment.`, `Offline · retrying. Showing the log as of <age>.`, `This build log is larger than 4 MB. Open it in Coolify.`, `… N earlier lines not shown. Open it in Coolify for the full log.` (head row when `dropped > 0`), `Rate limited · backing off Ns.` (footer reads `paused`), `<name> is not running.`, `The container has written nothing.`, `Fetching the last 200 lines…`, `Pick a container.`, `This service has no containers.`, `No container in <name> is running.`, `Loading history…`, `No deployments recorded for this application.`, `Coolify no longer has that application.`, the SR37 sentence. Line rows: `Text { textFormat: Text.PlainText; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall; wrapMode: Text.WrapAnywhere }`; `── failure ──` and `── internal steps ──` marker rows; every new `Text` paired for the gate.
**Verify**: `bin/check` (qmllint, counters, SR25); `bin/dev-sync && omarchy restart shell`; panel open → `j` to api's Recent row → `L` → `‹ api · finished · …`; `k` ×5 → footer `held`; `b` → `following`; `H` → internal steps; mouse over the card moves no ring and a right click opens no browser; `g` and `r` change nothing; Esc → back to the list with the cursor on the row; `status | jq .logView` null after Esc; Tab with a view open pops it first.

#### 5. Container logs end to end
**Verify**: `L` on `storefront` → ~200 lines within ~2 s, breadcrumb `‹ storefront · last 200 lines · 1s ago`, `r` refetches (`fetchedAt` changes); `L` on a service → picker or straight to the log; stop a resource in the Coolify UI, `L` → `<name> is not running.` and `status.error` null; `requestsLastMin` returns to its idle value within 60 s.

#### 6. History end to end
**Verify**: expand api → Enter on **History** → 10 rows newest first, `‹ api · 39 deployments`, `Show 10 more (10 of 39)`; Enter → 20 rows; Enter on `n8xtkv4knokhlufztvww0dkc` → its log with the failure marker showing `$ docker exec … docker compose … pull` (tail un-elided) and `failed to resolve reference "ghcr.io/example/api:edgeyboy"` in urgent with `showHidden` false (acceptance 1, rendering half); a restart row reads `restart`; `h` → history, `h` → list; `status | jq .history` → `{uuid8, pages: 2, rows: 20, count: 39}`; `recentPersisted` unchanged; `sensitive` reads `yes` after the first page (SR37 fed from history).

#### 7. Tags fold and tag deploy — only if Open question 3 is answered yes
Files: `Service.qml`, `Panel.qml`, `Model.js` (wired in 1–3; this step enables the TAGS fold in `panelRows` and the `tags` fetch on fold open). If the answer is no, the TAGS section stays disabled behind `s.tags.length > 0` never being fetched, the tag code paths remain node-tested only, and `docs/product.md` records "the account does not use tags (roadmap:104); tag deploy is built but not enabled".
**Verify** (yes): open TAGS → `canary` row reachable by `j`; `d` → the SR35 confirm; Confirm → status line `1 queued`, the row shows `deploying…` for at least one reaper tick and clears when the deployment appears; `status.pending` empty within 300 s.

#### 8. Rate, bytes and leak checks
**Verify**: 12 × 10 s status loop with the panel closed: max `requestsLastMin` < 20; panel open ≤ 20; first drain ≤ 24; during one api build with the log view open: `requestsLastMin` ≤ 36 and `perKind.deployments.bytesLastMin` ≤ 2 MB, `skipped` 0. Leak check per the Phase 3 recipe: needle file (`[ -s $SCRATCH/needle ]`), `ps -eww -o args=` sampled every 200 ms across a deploy into a file, `quickshell log -t 100000` into a file, `grep -cFf $SCRATCH/needle` on each file and on `~/.local/state/coolwatch/recent*.json` → 0, `shred -u` the needle; `grep -l '"logs"' ~/.local/state/coolwatch/*` → nothing.

#### 9. Docs, manifest, record
Files: `manifest.json` (`0.5.0`), `README.md` (token paragraph with `read:sensitive`; `L`/`H`/`b` keys), `AGENTS.md` (`:11` status line; product locks: view kinds never `_fail`, log text view-only, the caps and cadence guard; Commands: the new jq/grep lines replacing `:150`; the depth rollback block replacing `:154-156` without the rename caveat; "Don't": SR29 and SR26 rules), `docs/architecture.md` (new kinds and their `max-time`/`max-filesize`, cadence guard, view-error rule, log store bounds, `views` property, SR25–SR31 + SR37 appended), `docs/design.md` (`:145-148` strip order Logs first; `:150` Logs entry + `L`; new Log view section: breadcrumb, physical lines, wrap, failure marker, `H`, follow/hold, pinned 480 body, states; History view; picker; TAGS fold + confirm copy (if enabled); footer rows incl. the terminal-deployment hint change at `:244`; keyboard delta with `G`/Home/End/PgUp/PgDn unavailable; `:238` `j`/`k` no longer lists chips; state table rows), `docs/coolify-api.md` (`order` absent on entry 0; `finished_at` exists; stopped container is 404; servers list `proxy` has only `redirect_enabled`; `read:sensitive` widens `/resources` and `/servers`), `docs/product.md` (tags cannot be enumerated), `docs/roadmap.md` (Phase 4 depth record with needs-human rows), `docs/plans/phase-4-depth.build.md`.
**Verify**: `bin/check` green; `git diff --stat` touches only the files above; the staged validate passes with `0.5.0`.

Rollback (for AGENTS.md):

```sh
# rollback of a Phase 4 depth build (placement in shell.json survives; recent.json is unchanged in format;
# bin/check and bin/record-fixture stay at Phase 4 and are green against these files)
git checkout <hotfix-sha> -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js tests/run.js && bin/dev-sync && omarchy restart shell
```

### Instances PR `phase-4-instances` (from the merged depth branch, `<depth-sha>`)

#### 10. `Model.js`: config rules, `tls`, chips
Files: `Model.js`, `tests/run.js`, `tests/fixtures/config-two-instances.json` (hand-written; run the fixture gate on it).
- `normaliseConfig`: `ID_RE`, unique `id` (error), duplicate origin (warning `instances`), `@` in authority (error); `SAMPLE_CONFIG` gains a commented second entry. `errorFor` exit 60 → `tls` at the four sites; no-`insecure` test. `instanceChips`, `instanceTrouble`.
**Verify**: `node tests/run.js` green; `bin/check --no-shell`.

#### 11. `Service.qml`: `InstanceCtx` as a verified no-op refactor
Files: `Service.qml`, `docs/plans/phase-4-instances.build.md` (the inventory).
- First artifact: a generated inventory of every `root._` identifier in `Service.qml` (`grep -on 'root\._[A-Za-z0-9_]*' Service.qml | sort -u`) with its destination (context / root), committed to the build record. A mechanical check after the move: no context-owned identifier is still read as `root.` (the same grep, filtered by the inventory) → empty.
- Everything under "Service.qml (instances PR)" in Interfaces: `_instanceIds` + `Instantiator` + `_ctxs` + `_active`; `InstanceCtx` with every per-instance property, the depth slices, its `_reqs`, timers, `tokenCmd`, `recentFile` (index 0 → `recent.json`, else `recent-<id>.json`; `id` written, checked when present), its `_resetStore`, its `Component.onDestruction`; root keeps `_stateDirReady` (contexts read `root._stateDirReady`), `_panels` + prune fanned out to `closeView`, `_armRecent` fanned out, `_notifyLog` + `_chargeNotify`, `_dnd`; per-id `_configText` reconciliation (add/remove/change); outgoing context reset before release; per-context `_flushNotify` with the instance suffix; `acknowledgeFailures` per active context; per-request log prefix; `_status()` top level = active context + `instances[]`, `activeInstance`, `requestsTotalLastMin`.
**Verify** (single-instance config unchanged): `node tests/run.js` and `bin/check` green; `DEL='del(.requestsLastMin, .rateLimitRemaining, .backoffUntil, .perKind, .lastAction, .actionsLastMin, .notify.sentLastMin, .notify.lastEvent)'`; `status | jq -S "$DEL" > pre.json` before `bin/dev-sync && omarchy restart shell`, the same after all four baseline flags are true → `diff pre.json post.json` empty; `perKind` key set identical; `status | jq '.instances | length'` → 1; `ls ~/.local/state/coolwatch/` shows only `recent.json`; 12 × 10 s loop max < 20 closed; a `notify`-only edit (`jq` + `install -m 600`) leaves `instances[0].baseline` all true, `perKind.deployments.lastAt` continuous, `recentPersisted` unchanged, `inflightAction false`; `quickshell log … | grep -c 'Action interrupted'` → 0.

#### 12. Chips, middle-click, IPC, instance-bound actions
Files: `Panel.qml`, `BarWidget.qml`, `Service.qml`.
- Chip row (no `hasCursor`), hero `h`/`l` at `:159`, views popped on `activeId` change, `confirmAction.instanceId` + refusal on mismatch, `BarWidget` middle-click and tooltip (`root.svc.bar`), `IpcHandler.instances()`/`instance(id)`, IPC verbs against the active context, `lastAction.instance`, `act` refuses `wrong instance`.
**Verify**: `bin/check`; two chips with `config-two-instances`-shaped config; `l` on the hero switches; middle-click switches; `status | jq .activeInstance` follows; open the tag or Stop confirm, middle-click the icon, Confirm → status line "Instance changed; nothing sent" and `lastAction` unchanged; `omarchy-shell … instances` prints both; `omarchy-shell … deploy <uuid-only-on-the-inactive-instance>` → `unknown uuid <uuid>`.

#### 13. Two instances live
Config: second entry `{ "id": "readonly", "name": "Cloud read-only", "url": "https://app.coolify.io", "token": "<read-only token, no read:sensitive>" }` and `"notify": false` for the window (two contexts on one account double-toast by design; recorded as a limitation), via `jq` + `install -m 600`. The duplicate-origin warning callout is expected and its text is recorded.
**Verify**: two chips; `status | jq '[.instances[]|{id, requestsLastMin, counts, error, sensitive, recentPersisted}]'` shows both polling with **different** `sensitive` (`yes` vs `no` after History on each) and each `requestsLastMin` < 20 over the 12 × 10 s loop with the panel closed (per token; `requestsTotalLastMin` recorded); History on `readonly` → the SR37 sentence, not a spinner; `d` on api while `readonly` is active → the `deploy` ability message and `instances[1].error` still null; mangle the second token → `instances[1].error.kind == "auth"` while `instances[0]` keeps polling and the icon stays healthy with the tooltip suffix; `ls ~/.local/state/coolwatch/` → `recent.json recent-readonly.json`, each carrying its `id`; swap the two entries' order → each context still reads its own rows or reports `recentRejected: true` (never the other's rows); remove the second entry → one chip, `pgrep -a curl` empty 10 s later, `quickshell log` has no reaped-request warning, `recent-readonly.json` left in place; restore `notify` and confirm a toast body ends in ` · Coolify Cloud` with a single-instance config plus one dummy unreachable entry.

#### 14. Docs, manifest, record
Files: `manifest.json` (`0.6.0`), `README.md` (config sample with a second entry), `AGENTS.md` (status line; product locks: per-instance rate gate wording at `:94`, IPC resolves against the active instance, the confirm binding; the instances rollback block; the `instances` jq lines), `docs/architecture.md` (config `instances[]` rules, per-instance state and schedule, state files and the `id` field, notification suffix, `serviceFor` exposure of `views` and N tokens, SR32–SR36 + SR38), `docs/design.md` (`:137-141` chips ring rule and trouble dot; `:36-57` bar icon = current instance + tooltip; notifications body suffix), `docs/roadmap.md` (Phase 4 instances record with the needs-human rows), `docs/product.md` (decision 4 proxy re-deferred, dated), `docs/plans/phase-4-instances.build.md`.
**Verify**: `bin/check` green; `git diff --stat` touches only the files above; staged validate passes with `0.6.0`.

Rollback (for AGENTS.md):

```sh
# rollback of a Phase 4 instances build (a second instances[] entry is validated and ignored by the depth build;
# recent-<id>.json files are ignored; recent.json's optional id field is ignored)
git checkout <depth-sha> -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js tests/run.js && bin/dev-sync && omarchy restart shell
```

## Verification

- `node tests/run.js`; `bin/check` (full) after every step; `bin/check --no-shell` is the CI subset and stays runnable at every step.
- **Acceptance 1, stated as a chain.** Coolify marks `failed` → the row leaves the active list → the next `GET /deployments` (2 s during a build) sees `diff.vanished` → `_drainTerminal()` in the same arm → `GET /deployments/{uuid}` → the `deployment` arm fires the Failed toast and `_captureLog(…, "drain")` in the same dispatch. So the failure marker appears in the same dispatch as the toast, ≤ one deployments interval plus one drain round trip after Coolify drops the row. It does not hold while `deploymentReq` is busy with another uuid or the `deployment` kind is in backoff; the view shows the last list-poll log with `Loading…` until the drain runs. Rendering half: Step 6 on the recorded failure. Timing half: **needs-human** with Dan's 2026-09-08 recipe (bad image tag on api in the Coolify UI, then revert), or Open question 4.
- **Acceptance 2:** Step 13. Needs-human: a genuinely different Coolify (self-hosted: plain-http warning, `tls` kind, API-disabled path, older-version 404 note) and **cross-instance data isolation** against two different accounts (a same-origin pair cannot reveal a bleed).
- Budget and secrets: Step 8, Step 11, Step 13.

## Tests to add (`tests/run.js`)

- `Api.block`: `max-filesize` per descriptor (hotfix); nine lines per GET; `reqContainerLog` per group, null for an unknown or hostile kind (`"hasOwnProperty"`, `"constructor"`); `reqHistory` clamps a negative/NaN skip; emitted config for `sub_service_name`/tag containing `& # / .. " \n , é` (SR28); no block contains `insecure` (SR36); `reqDeployTag` block equals `reqDeploy`'s shape and has no `body`.
- `parseBuildLog`: double parse; entry 0 without `order` → `seq 1`, kept; malformed inner JSON / non-array / non-object entry → skipped or `entries []`; control chars stripped, `\n`/`\t` kept; output capped 4000; command middle-elided to 320 with head and tail preserved; 2001 entries → 2000 kept, `dropped 1`, `truncated`; 3.5 MB string → `refused`, `entries []`, `bytes` = raw length (SR27); `bytes` equals `logsString.length` in every case.
- `buildLogRev`: digits/colons only; `""` on empty; changes on append, on a longer last output, on `dropped`; unchanged on a re-parse of the same string.
- `failingEntry` on `deployment-log-failed` → the hidden stderr command entry; null on `deployment-log-finished`; `buildLogLines` with `showHidden: false` on the failed fixture emits the `$ …` line **ending with the un-elided `pull'` tail** and the reference line in urgent, one row per physical line, no plain stderr line urgent; hidden entries excluded unless `showHidden`; every emitted row has the union key set.
- `parseContainerLog`: split, no trailing newline, empty → `[]`, missing `logs` → `[]`, 2100-line tail cap.
- `normaliseHistory` + `joinBranch`: `{count, rows}`, newest first, no `logs`; `historyRow` sub for `restartOnly`, for `commit: "HEAD"` (never renders `HEAD`), for a joined branch; no `age` field; `moreRow` null at the end; `fetchOutcome` for history 404, buildlog 404, "Container not found.", "Sub service name is required.", toolarge, 429.
- `sensitiveState`: `yes` with a string; `no` with undefined on a terminal row; `unknown` on `in_progress` and `queued`.
- `deploymentsInterval` table (SR30). `logViewStatus`: no text keys, `rev` digits-only (SR26).
- `normaliseTags`/`tagRow`; `panelRows` inserts TAGS after RESOURCES only when tags exist, before both `spliceActions` points; a tag row carries `pendingVerb` while `_pending[tag.uuid]` exists; `nextSelectable` reaches a tag row; `targetTypeOf` → `tag`; `actionRequest` tag arm accepts `canary`, rejects `a b`, `a,b`, `../x`, and returns `why: "nav"` for `logs`/`history`/`open`; `actionOutcome` on `action-deploy-tag-ok` → `queued 1, refused 1`; `confirmCopy` tag text (SR35).
- `actionsFor`: terminal deployment `[Logs, Open]`, active `[Logs, Cancel, Open]`; `History` only on `kind === "application"`; `Logs` only on running rows. `footerHints`: the 13 updated strings plus following/held/paused/history/picker/tag lines, `o open` only with a URL; `GLYPHS` allowlist tests stay green with the new glyphs.
- Instances PR: `normaliseConfig` two instances ok; duplicate `id` error; `id` `../x` error; duplicate origin warning; `https://u:p@host` error; single-entry file unchanged; `configSansNotify` unaffected (SR32, SR33). `errorFor` exit 60 → `tls`; `barState` and `calloutBody` for `tls` (SR36). `instanceChips` empty for one instance; `instanceTrouble` names the non-active instance's error. `parseRecent`: accepts a v1 file without `id`; rejects on `id` mismatch; `serialiseRecent` emits `id` and no `logs` key.

## Risks and open questions

**Risks**
1. **`GET /deployments` may not carry `logs` for active rows.** `docs/coolify-api.md:184` and `:278` say it does, from Coolify source; the hotfix probe confirms presence and growth before the depth branch starts. Fallback, decided now: `openBuildLog` on an active uuid launches `logReq` every 4 s while a target is set and `deploymentsInterval` holds 4 s while any target is set (36/min), at the cost of doubling the Building/Deployed toast latency during a watched build.
2. **A verbose build outruns the caps.** 4 MB / 12 s bound a poll; the cadence steps bound bytes/min at 4 MB × 4/min = 16 MB/min in the worst case; beyond 4 MB the deployments kind fails one poll (`toolarge`) and recovers as today; `bytesLastMin` and `skipped` make it observable. Dan's largest observed log is 40 KB, so the guard is dormant here and is exercised only by its table test (recorded in the build record).
3. **Two rings in the hero.** Chips never take `hasCursor`; `focusHero()` is a no-op while a view is open.
4. **`applyRows` vs follow.** The `scrollToSelection` callLater is skipped while a view is open; the hold is driven by user input only.
5. **A config with an `@` URL or a non-conforming `id` becomes a config error on upgrade.** Deliberate; the callout names the field.
6. **History pages are 130 KB each**, parse in < 0.2 ms, three cached per instance. Accepted.
7. **Proxy status stays deferred.** The list carries no `proxy.status`; the detail costs S transfers per topology cycle and ships a Traefik config and `sentinel_token` we discard. `docs/product.md` decision 4 gets a new date.
8. **Tags cannot be enumerated**; the account's one tag matches nothing; Step 7 is conditional.
9. **`Instantiator` model identity.** The model is a string id list assigned only on real change (the agents precedent); `_ctxs` is maintained from `onObjectAdded`/`onObjectRemoved`, never `objectAt()`.
10. **Two contexts on one account double-toast** and double-drain; that is the acceptance configuration, not a product one; Step 13 runs with `notify` off.
11. **The per-instance rate gate** reads 18 per token and 36 aggregate at idle with two instances; Open question 7 decides which number the record asserts; both are exported.
12. **The `views` property is readable by any co-loaded plugin**, like `_token` today; stated in the threat model rather than discovered.

**Open questions (each with the default the builder takes; 3 and 7 are answered before the depth branch starts)**
1. Is there a self-hosted Coolify reachable from this machine with an API token for acceptance 2? **Default:** the read-only second Cloud entry (Step 13); the self-hosted paths and cross-account isolation are needs-human.
2. Bar icon when instances disagree: current instance with a tooltip suffix (**default**), or worst-wins with the panel switching to the worst instance on open?
3. May the `canary` tag be attached to api in the Coolify UI so tag deploy can run live? **Default: no → Step 7 is skipped**, the TAGS fold stays disabled, the tag code stays node-tested, and `docs/product.md` records that the account does not use tags.
4. May a api build be failed once for the acceptance 1 timing? **Default:** no; needs-human with the 2026-09-08 recipe.
5. Should the config accept an optional per-instance `sensitiveToken`/`sensitiveTokenCommand` so polling uses a `read`+`deploy` token and only log/history fetches carry `read:sensitive`? It removes the SR30 regression entirely (every `/resources` and `/deployments` poll returns to its Phase 3 size and carries no compose bodies, `custom_labels`, webhook secrets or build logs) at the cost of one extra request per 4 s while a log view is open on a build (Risk 1's poller) and `sensitive` keyed by the fetching token. **Default:** no for Phase 4 (single token, as the product lock decided and as Dan has configured); recorded as a Phase 4.1 candidate on that axis.
6. Container logs on services: the picker (**default**) or applications and databases only?
7. The idle rate gate with N instances: per instance (**default**, the 200/min limit is per token; `requestsTotalLastMin` reported alongside), or aggregate ≤ 20 × N?
8. May the five Phase 1–3 fixtures be re-scrubbed in Step 0 (a housekeeping change; no test reads the scrubbed keys)? **Default:** yes.

## Out of scope

Listed in the Brief. Additionally deferred by the panel's findings: proxy status, a v2 `recent.json` format, per-instance `poll`/`notify`, cross-instance notification dedupe, version-based feature detection, a sensitive-only token, copying a log line, Space as page-down, Home/End/PgUp/PgDn, `G`.

## Panel record

Panel model: `opus` (named in the ask). Harness: Claude Code `Agent` tool, `subagent_type: general-purpose`, roster name on the first line of each prompt. Codebase map by one `Explore` agent (very thorough) on opus. Wave-2 members read draft v1 from the plan file rather than receiving it inline (same content, read-only).

| member | model | wave | findings | accepted | rejected (reason) |
|---|---|---|---|---|---|
| architect | opus | 1 | 9 (3 critical, 5 warning, 1 nit) + draft v0 | 9 | overlay accepted with its own `ListModel` rather than a shared row model; per-uuid log poll kept only as Risk 1's fallback; multi-instance-first ordering replaced by the two-PR split (skeptic w2) |
| reuse-scout | opus | 1 | 11 (4c, 6w, 1n) | 11 | — |
| reuse-scout | opus | 2 | 13 (2c, 8w, 3n) | 13 | — |
| security-analyst | opus | 1 | 17 (6c, 10w, 1n) | 16 | #1 option (a) split token → Open question 5 (product lock; scope) |
| security-analyst | opus | 2 | 11 (3c, 7w, 1n) | 11 | — (its `_note`-exemption idea for the fixture gate superseded by the strict whitelist + `text` key) |
| ux-api-designer | opus | 1 | 14 (4c, 8w, 2n) + flows | 13 | view-swap through `panelRows`/`rowsModel` rejected for the perf-analyst's delegate-teardown finding; `c` copy out of scope |
| ux-api-designer | opus | 2 | 11 (3c, 7w, 1n) | 11 | Space page-down: out of scope |
| perf-analyst | opus | 1 | 9 (3c, 4w, 2n) + measurements | 9 | "never store `command`": stored middle-elided to 320 (the failing command must render) |
| perf-analyst | opus | 2 | 12 (3c, 6w, 3n) | 12 | "drop the cadence guard until measured": kept as cheap insurance, recorded as dormant |
| data-analyst | opus | 1 | 15 (5c, 8w, 2n) + shapes | 14 | single v2 map file → per-instance files with `recent.json` unchanged (rollback) |
| data-analyst | opus | 2 | 10 (4c, 4w, 2n) | 10 | — |
| ops-analyst | opus | 1 | 12 (4c, 6w, 2n) + runbook | 12 | rollout order superseded twice: architect's refactor-first in v1, then the two-PR split in v2 |
| ops-analyst | opus | 2 | 11 (3c, 6w, 2n) | 11 | — |
| code-reviewer | opus | 2 | 18 (8c, 7w, 3n) | 18 | — |
| skeptic | opus | 2 | 14 (4c, 8w, 2n) | 13 | "aggregate vs per-instance gate" carried as Open question 7 rather than decided |

Situational members and why: `ux-api-designer` (five panel views, keyboard delta); `perf-analyst` (hard request budget; `read:sensitive` payload growth); `data-analyst` (response shapes, per-instance state file, fixture scrub); `ops-analyst` (config schema, gates, rollback, observability). No member failed; no re-spawns.

Wave-2 criticals that changed the design rather than a step: the `Instantiator` model identity (four members), the fixture gate that matched no real log (three), the two-PR split and the hotfix-first ordering (skeptic), the 4 MB cap (perf), post-parse bounding (security), the overlay's anchoring and pointer capture (code-reviewer, ux). No third loop was needed: every one resolved to a concrete change with no member disagreement.
