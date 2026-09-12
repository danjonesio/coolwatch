# Build record: Coolwatch Phase 4 — "depth" (build logs, container logs, history, tags)

Plan: `docs/plans/phase-4-depth.md` (the approved plan, copied in step 0; it also covers the `read:sensitive` hotfix and the later `phase-4-instances` branch). Hotfix branch `fix/read-sensitive-caps` from `master` at `0e6bd60`, one commit `e64f1fa`. Depth branch `phase-4-depth` from `e64f1fa`; head `06d95e1` when the review panel ran, `5918642` after its fixes, `add2a09` after the re-check round, plus this record. Dan merges, in order: the hotfix, then this branch. Built with `/deej-stack:d-implement` on 2026-09-12; panel model `opus` (named in the ask). Commits carry no attribution trailers (Dan's standing preference, 2026-09-07).

## Questions resolved

| question | answer | source |
|---|---|---|
| 1. A self-hosted Coolify for acceptance 2 | not asked in this branch (acceptance 2 belongs to `phase-4-instances`); default: a read-only second Cloud entry, self-hosted needs-human | default |
| 2. Bar icon when instances disagree | current instance with a tooltip suffix (instances branch) | default |
| 3. Tag deploy: attach a tag so the fan-out can run live | **yes**: Dan applied `production-landing` to the landing application ("I've applied production-landing to the landing resource"); the fold ships and step 7 ran live against it. Dan first asked "what is canary?": the account's other tag, attached to nothing | user |
| 4. Fail a api build once for the acceptance 1 timing | no; needs-human with Dan's 2026-09-08 recipe (rendering verified from the two recorded failures) | default |
| 5. Optional per-instance `sensitiveToken` | no for Phase 4; recorded as a 4.1 candidate | default |
| 6. Container logs on services | the picker | default |
| 7. Idle rate gate with N instances | **per instance < 20**, aggregate reported alongside. Put to Dan in the Phase A question round as a two-option choice; he selected "Per instance < 20 (Recommended)" | user |
| 8. Re-scrub five Phase 1–3 fixtures in step 0 | yes | default |
| Panel model for the review | opus (named in the ask) | user |

## Audit

Tree clean at `0e6bd60` (`git status --porcelain` empty). Every path in **Changes** exists. Anchors re-checked against the tree before building: `Service.qml:326,377,387` (`instances[0]`), `:701` and `:960` (the two log-bearing launches at `max-time` 6; the review found a third, the probe-mode launch, fixed in `5918642`), `Api.js:12` (`MAX_FILESIZE`), `Model.js:40` (`UUID_RE`), `:246` (`OFFLINE_EXITS`), `:600` (`NOTIFY_PER_MIN`), `:1309` (`SELECTABLE`), `:1352` (`HINT_ORDER`), `Panel.qml:500` (`reuseItems: false`), `bin/check:14`. The live tag changed after the plan was written: `GET /tags` now returns `canary` and `production-landing`, and `GET /applications?tag=production-landing` returns landing (`qkyqt4xzvclreyhdutkrib9p`); step 7 uses that tag. No mismatch changed **Design**.

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| hotfix | `read:sensitive` caps: per-descriptor `maxBytes` (4 MB on `deployments`/`deployment`), `max-time` 12 | `e64f1fa` | `node tests/run.js`; `bin/check`; `bin/dev-sync && omarchy restart shell`; the Risk 1 probe | 88 passed; `ok`; a live build's row on `GET /deployments` grew 35 611 → 50 264 B over 30 s at 2 s cadence then 2 B when it finished (presence and growth: Risk 1 resolved, no log poller needed); `requestsLastMin` < 20 idle, 35 while deploying |
| 0 | plan copy, fixture gates, re-scrub | `9753b4d` | `bin/check --no-shell`; `bin/check`; gate self-test on `cp -r` copies with `COOLWATCH_ROOT` | `ok`; `ok`; `«scrubbed»` passes, a doubly-escaped 400-char log body fails, a webhook secret fails, `null` passes; five fixtures re-scrubbed, 88 tests unchanged (the recorder's walk turned nulls into `«scrubbed»`; redone null-preserving in `5918642`) |
| 1 | descriptors and pure parsers; fixtures | `7f72e6c` | `node tests/run.js`; `bin/check` | 108 passed; `ok` |
| 2 | rows, actions, hints, tables | `7ec9169` | `node tests/run.js`; `bin/check` | 113 passed (17 expectations updated for the new strip order); `ok` |
| 3 | capture, view Reqs, exemptions, cadence, sensitivity, tag pending | `8134b63` | `bin/check`; `bin/dev-sync && omarchy restart shell`; a live redeploy of api via IPC with the panel closed; idle status | `ok`; `buildLogsHeld` 0 → 1, `logview list n=1..19` then `drain n=21` in the same dispatch as the terminal record, `sensitive` unknown → yes, `deployments.skipped` 0, `error` null, `requestsLastMin` ≤ 28 while building; idle `logView` null, `history` null, `tags {0}`, `sensitive unknown`. The pinned-target `logView` needs the panel: verified in step 4 |
| 4 | the overlay, keys, breadcrumb | `edc8a14` | `bin/check`; installed; `wtype` + `grim`: j j L, k×5, H, b, Esc, Esc | `ok` (qmllint clean, PlainText 31/31 at that commit; 34/34 at head); the build log opened at the newest line with `status.logView {cnzzlqyb, 86 entries, fetch, terminal}`; k×5 scrolled to the top; H showed hidden steps in dim; Esc returned to the list with the cursor on the row and `logView` null; Esc closed (`openPanels 0`); no binding loop or TypeError (three runs: the first drew the overlay over the list because a `var` property assigned the same object emits no change; fixed by `_fresh` copies of map and record, and `listView.visible: false` under a view) |
| 5 | container logs end to end | `a75b16b` | live: L on a running app, r, L on a service, Enter, r | last 200 lines in ~2 s (200, 1086 ms, 7617 B), `r` refetched, footer `j/k scroll · r refetch · h back`; the stopped WordPress service offers no Logs; the picker listed uptime-kuma, dockerproxy, mariadb; Enter on umami fetched its tail; `status.error` null; `requestsLastMin` back to idle within 60 s. Two live defects fixed in the step (deviations 12, 13). Stopping a resource in the Coolify UI for the 404 copy: needs-human (fixture-tested) |
| 6 | history end to end | `11f2c94` | live: History on api, Enter on the failed row, h, Show more | `‹ … · 40 deployments`, ten rows newest first, both failed rows urgent (history 200, 120 927 B); Enter on `n8xtkv4knokhlufztvww0dkc` → `$ docker exec … docker compose … pull'`, `failed to resolve reference "ghcr.io/example/api:edgeyboy": not found` and the `Deployment failed` lines in urgent with `showHidden` false (acceptance 1, rendering half); h → history with the cursor on that row; Show more → 20 rows, `status.history {rows 20, count 40, skip 10, pages 2}`; `recentPersisted` unchanged during the step; `sensitive yes`. Three live defects fixed in the step (deviations 14–16) |
| 7 | tags fold and tag deploy | `118a0fa` | live: TAGS fold, d on `production-landing`, confirm | the section and fold after RESOURCES (count 2); Enter opened it; d → "Deploy everything tagged production-landing? Coolify decides what that is; the API cannot list it." with Cancel preselected; Deploy → POST 200 in 309 ms, `lastAction {deployTag, iksq1umf, ok}`, `pending` 1 until the landing deployment appeared 8 s later, the "Building landing" toast, the build finished in 29 s. The status line read "0 queued" on that run: the response is `{details: [...], message: [...]}`, not the documented `deployments`; fixed from a captured body (deviation 11). These numbers come from the run's terminal output and were not reproduced; the response shape is pinned by the fixture |
| 8 | rate, bytes and leak checks | — (no files; the samples are in **Measurement samples** below) | 12 × 10 s status loops closed and open; a api build; needle-file leak checks | closed: max 19, min 17, `deployments.skipped` 0; open: max 22 (the first topology drain plus one `/tags` fetch on open; allowance 24), 17–19 otherwise; during a build: max 29 requests, `perKind.deployments.bytesLastMin` 26 780 (first run) and 28 460 (second run, the whole build inside the window: ten 2 s polls of a log growing to 6 408 B), `deployments.skipped` 0; `perKind.resources.skipped` reads 3 on the live instance from the panel-open prime colliding with an in-flight poll (documented, not starvation); needle in 209 651 `ps` samples: 0, in `quickshell log -t 100000`: 0, in `recent*.json`: 0; no `"logs"` key in any state file |
| 9 | docs, manifest 0.5.0 | `73307bb` | `bin/check` | `ok`; the staged validate passes with 0.5.0 |
| tests | history join, recent serialisation | `06d95e1` | `node tests/run.js`; `bin/check --no-shell` | 115 passed; `ok` (the first attempt was committed with one failing case because a pipeline masked the exit code; amended before anything else was built) |
| review | the panel's findings (see Review) | `5918642` | `node tests/run.js`; `bin/check`; `bin/dev-sync && omarchy restart shell` | 118 passed; `ok`; installed manifest matches 0.5.0. The post-fix keyboard smoke test was abandoned: Dan was using the machine and the synthetic keys landed in his browser window instead of the panel (the panel was closed again by IPC). The review fixes to the overlay (`r` keeping a known status, in-place tail growth, batched append, the single-container picker skip, breadcrumb ages) are node-tested where pure and otherwise **needs human** |
| re-check | the re-check round's findings (see Review): numeric `elapsed`, tail re-render keyed on the previous tail, first-fetch exemption from the throttle, the non-JSON gate's two missing keys, two comments | `add2a09` | `node tests/run.js`; `bin/check`; gate self-test on a copy; `bin/dev-sync && omarchy restart shell`; IPC status | 119 passed; `ok`; a `.txt` probe carrying `last_applied_settings` fails and the clean copy passes; installed files match; the restarted service answers with `error` null and no coolwatch line in the shell log (the three `TypeError`s there are the github plugin's). Keyboard-driven checks of the overlay changes remain **needs human** for the same reason as the row above |

## Tests

| case | covers | file | commit |
|---|---|---|---|
| `Api.block max-filesize is per descriptor` | SR30 | `tests/run.js` | `e64f1fa` |
| `Api.reqContainerLog`: groups, constant lines, seg, hostile kinds | SR28 | `tests/run.js` | `7f72e6c` |
| `Api.reqHistory`: constant take, skip clamped | SR28 | `tests/run.js` | `7f72e6c` |
| `Api.reqDeployTag`: one tag through seg, reqDeploy's block, no body | SR28, SR35 | `tests/run.js` | `7f72e6c` |
| `Api.block never emits insecure` | SR36 | `tests/run.js` | `7f72e6c` |
| `parseBuildLog`: entry 0 without order, index identity | SR27 | `tests/run.js` | `7f72e6c` |
| `parseBuildLog`: double-encoded, malformed, non-array, non-object | SR27 | `tests/run.js` | `7f72e6c` |
| `parseBuildLog`: control chars, caps on output and command | SR27 | `tests/run.js` | `7f72e6c` |
| `parseBuildLog`: 2001 → 2000 tail with dropped; 3.5 MB refused | SR27 | `tests/run.js` | `7f72e6c` |
| `parseBuildLog`: 200 lines per entry, 5000 per log, head entries dropped | SR27 (review: security 1) | `tests/run.js` | `5918642` |
| `buildLogRev`: digits only, empty, changes on append/growth/drop | SR26 | `tests/run.js` | `7f72e6c` |
| `failingEntry`: the hidden stderr command step; null on finished | acceptance 1 | `tests/run.js` | `7f72e6c` |
| `buildLogLines`: failing command rendered with showHidden false, one row per physical line, stderr never urgent alone, `pull'` tail kept | acceptance 1, SR27 | `tests/run.js` | `7f72e6c` |
| `viewRow`: one key set across every builder; type mirrors rowType; j reaches Show more and a container | ListModel roles | `tests/run.js` | `7f72e6c`, `11f2c94` |
| `viewRow`: typed coercion of every field, unknown keys dropped | ListModel roles (review: security 3) | `tests/run.js` | `5918642` |
| `parseContainerLog`: split, no trailing newline, empty, missing, cap, control bytes | SR27 | `tests/run.js` | `7f72e6c` |
| `normaliseHistory`: count/rows, newest first, no logs; `historyRow` never HEAD; `moreRow` | SR26 | `tests/run.js` | `7f72e6c` |
| `fetchOutcome`: not-running, picker, 404s, toolarge, 429, offline, ability, null | SR29 | `tests/run.js` | `7f72e6c` |
| `errorText` is the single copy table | SR10 | `tests/run.js` | `7f72e6c` |
| `sensitiveState`: yes / no (terminal only) / unknown | SR37 | `tests/run.js` | `7f72e6c` |
| `deploymentsInterval` table | SR30 | `tests/run.js` | `7f72e6c` |
| `normaliseTags` / `tagRow` | SR28 | `tests/run.js` | `7f72e6c` |
| `logViewStatus`: counts and a digits-only rev, no text | SR26 | `tests/run.js` | `7f72e6c` |
| `actionsFor` / `actionFor`: Logs first, Logs on running rows, History on apps, Deploy on tags, L | SR3 | `tests/run.js` | `7ec9169` |
| `actionRequest`: nav verbs refused; tag arm keyed by uuid; hostile names | SR28, SR35 | `tests/run.js` | `7ec9169` |
| `actionOutcome deployTag`: per-item counts, both response shapes | SR35 | `tests/run.js` | `7ec9169`, `118a0fa` |
| `panelRows` TAGS fold both paths; selectable; pending through withPending; glyph allowlist | rowRev, GLYPHS | `tests/run.js` | `7ec9169` |
| `withPending` on a tag row reads `deploying…`; `G.tag` in the allowlist | design (review: ux 2, 8) | `tests/run.js` | `5918642` |
| `footerHints` view lines | design | `tests/run.js` | `7ec9169`, `5918642` |
| 17 updated expectations (`footerHints`, `actionsFor`, `panelRows`, `actionRequest`) | new strip order | `tests/run.js` | `7ec9169` |
| history rows through `joinBranch` | drain precedent | `tests/run.js` | `06d95e1` |
| `serialiseRecent` emits no logs key or text | SR26 | `tests/run.js` | `06d95e1` |
| `elapsed`/`age` accept a numeric timestamp | breadcrumb (re-check: ux 4) | `tests/run.js` | `add2a09` |

Not written in this branch: the instances-PR cases (`normaliseConfig` ids/origin/userinfo, `errorFor` exit 60, `barState`/`calloutBody` for `tls`, `instanceChips`, `parseRecent` with an `id`), which belong to `phase-4-instances`.

## Verification

| check | command or action | result |
|---|---|---|
| node tests | `node tests/run.js` | 119 passed, 0 failed |
| full check | `bin/check` | `ok` at every commit (qmllint clean; PlainText 34/34 in Panel.qml at head; `bin/check --no-shell` green at all twelve commits via `git archive` + `COOLWATCH_ROOT`, per the ops reviewer; run again at `add2a09`) |
| CI subset | `bin/check --no-shell` | `ok` |
| acceptance 1, rendering | step 6 live: History → the recorded failed build | the failing step, its reference error and the "Deployment failed" lines in urgent with hidden steps off |
| acceptance 1, timing ("within one poll of failure") | the marker lands in the same dispatch as the Failed toast (the drain arm captures the terminal body: step 3 log lines `list n=19` then `drain n=21`) | needs human: fail one api build deliberately (bad image tag in the Coolify UI, then revert) with the panel open on its row's log and confirm the marker appears with the Failed toast |
| acceptance 2 | `phase-4-instances` | not this branch |
| rate, closed | 12 × 10 s `status \| jq .requestsLastMin` | max 19 (samples below) |
| rate, open | same, panel open, first topology drain and the `/tags` fetch inside the window | max 22 (allowance 24), 17–19 after (samples below) |
| rate and bytes, build | 30 × 2 s (first run, log view open) and 45 × 2 s (second run, IPC only, the whole build inside the window) | max 29 requests (limit 36); `perKind.deployments.bytesLastMin` 26 780 and 28 460; `deployments.skipped` 0 (samples below) |
| token leak | needle file → `ps -eww -o args=` sampled at 200 ms across the build, `quickshell log -t 100000`, `recent*.json`, all through `grep -cFf`; needle shredded, the capture deleted with it | 0, 0, 0 over 209 651 ps samples (1174 curl argv lines). The capture files were deleted together with the needle by design (they would hold every curl argv line of the run), so this count has no surviving artefact and cannot be re-derived; re-running the recipe is the only way to reproduce it |
| log text in state | `grep -l '"logs"' ~/.local/state/coolwatch/*` | nothing |
| container log 404 copy | fixture `container-log-404.json` → "`<name>` is not running." | node; live needs human (stop a resource in the Coolify UI, then L) |
| services picker | live: L on uptime-kuma-prod | three containers listed; Enter fetched the second's tail |
| single-container service skips the picker | review fix in `5918642`; no single-container service exists on this account | needs human on an account that has one |
| notify-only config edit | not re-run in this branch (no config change) | needs human if desired; the config path is untouched |

## Measurement samples

Kept from the runs (`status | jq -c …`, one line per sample; `req` = `requestsLastMin`, `bpm` = `perKind.deployments.bytesLastMin`).

Closed, 12 × 10 s (`t` is Unix seconds):

```
{"t":1789203916,"req":17,"bpm":30,"skipped":0,"topo":false}
{"t":1789203926,"req":17,"bpm":30,"skipped":0,"topo":false}
{"t":1789203936,"req":17,"bpm":30,"skipped":0,"topo":false}
{"t":1789203946,"req":17,"bpm":30,"skipped":0,"topo":false}
{"t":1789203957,"req":18,"bpm":30,"skipped":0,"topo":false}
{"t":1789203967,"req":19,"bpm":30,"skipped":0,"topo":false}
{"t":1789203977,"req":18,"bpm":30,"skipped":0,"topo":false}
{"t":1789203987,"req":18,"bpm":30,"skipped":0,"topo":false}
{"t":1789203997,"req":19,"bpm":30,"skipped":0,"topo":false}
{"t":1789204007,"req":19,"bpm":30,"skipped":0,"topo":false}
{"t":1789204017,"req":18,"bpm":30,"skipped":0,"topo":false}
{"t":1789204027,"req":17,"bpm":30,"skipped":0,"topo":false}
```

Open, 12 × 10 s (the panel opened at the first sample; `topo` flips when the first drain completes):

```
{"t":1789204050,"req":19,"topo":false,"open":1}
{"t":1789204060,"req":20,"topo":false,"open":1}
{"t":1789204070,"req":21,"topo":true,"open":1}
{"t":1789204080,"req":22,"topo":true,"open":1}
{"t":1789204090,"req":21,"topo":true,"open":1}
{"t":1789204100,"req":21,"topo":true,"open":1}
{"t":1789204110,"req":20,"topo":true,"open":1}
{"t":1789204120,"req":19,"topo":true,"open":1}
{"t":1789204130,"req":18,"topo":true,"open":1}
{"t":1789204140,"req":18,"topo":true,"open":1}
{"t":1789204150,"req":17,"topo":true,"open":1}
{"t":1789204161,"req":17,"topo":true,"open":1}
```

Build, second run, 45 × 2 s from the first sample with an active row (a 20 s api build; the `lastBytes` column is the deployments body):

```
{"t":1789205833,"active":1,"bpm":933,"lastBytes":909,"skipped":0,"req":23}
{"t":1789205835,"active":1,"bpm":2055,"lastBytes":1122,"skipped":0,"req":24}
{"t":1789205837,"active":1,"bpm":3396,"lastBytes":1341,"skipped":0,"req":25}
{"t":1789205840,"active":1,"bpm":5232,"lastBytes":1836,"skipped":0,"req":26}
{"t":1789205842,"active":1,"bpm":7605,"lastBytes":2373,"skipped":0,"req":27}
{"t":1789205844,"active":1,"bpm":9978,"lastBytes":2373,"skipped":0,"req":28}
{"t":1789205846,"active":1,"bpm":12893,"lastBytes":2917,"skipped":0,"req":25}
{"t":1789205848,"active":1,"bpm":16353,"lastBytes":3460,"skipped":0,"req":26}
{"t":1789205850,"active":1,"bpm":22052,"lastBytes":5701,"skipped":0,"req":24}
{"t":1789205852,"active":1,"bpm":28460,"lastBytes":6408,"skipped":0,"req":25}
{"t":1789205854,"active":0,"bpm":28460,"lastBytes":2,"skipped":0,"req":26}
… (bpm holds 28460 for the rest of the minute, then decays to 30 by t=1789205911; req 19–27 throughout)
```

The first build run (log view open, 30 × 2 s) peaked at `req` 29 and `bpm` 26 780 with the build ending at its eighth sample.

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | hotfix | a PR on `master` merged before the depth branch | the depth branch was created from the hotfix commit `e64f1fa` on the unmerged branch | Dan merges; the branch relationship is the same once both are merged in order |
| 2 | 0 | a line regex on `"logs"` values ≥ 200 chars | a jq walk over every JSON fixture (a `logs`/`configuration_snapshot` value must be null or `«scrubbed»`; the secret-key family must be scrubbed), plus a literal grep over the non-JSON fixtures | a one-line fixture ends in `}`, and no line regex matches a doubly-escaped log; the walk is exact regardless of formatting |
| 3 | 1 | `Model.moreRow(page)` | `moreRow(page, take)`; `Panel.qml` imports `Api.js` for `HISTORY_TAKE` | the panel must not duplicate Api's constant |
| 4 | 1 | `logViewStatus` includes `following` | `terminal` instead of `following` | `following` is panel state the service does not hold |
| 5 | 2 | `HINT_KEY.history = "enter history"` | no `history` hint | History is reached through the strip, which "enter actions" already names; a second "enter …" hint would mislead |
| 6 | 3 | `_status().logView` | plus `buildLogsHeld` (count of held build logs) | the step-3 verify needs a counter before the panel exists |
| 7 | 3, 7 | tags fetched on fold open | fetched on panel open, at most once a minute, `_tagsAt` stamped at launch | a fold that only exists once tags are known cannot bootstrap itself |
| 8 | 4 | hoist `deploymentComp`/`noteComp` to the Panel root and share them with the overlay (plan Interfaces, Panel.qml delegate map) | the overlay declares its own compact delegates (line, note, history, more, pick) in its delegate scope | the main list's components resolve the `rowDelegate` id from their declaring scope; duplicating ~60 lines was safer than an id-scope experiment on the hot path |
| 9 | 4 | `r` refetches container logs only | `r` also refetches a non-active build log, history and the picker; every refetch key is throttled to one launch per second | one key, same meaning in every view; an active build log ignores it; `PanelKeyCatcher` has no auto-repeat filter |
| 10 | 4 | a `── internal steps ──` marker when hidden entries are shown (plan step 4 copy list) | no marker; hidden entries render dim | the tone already distinguishes them and a marker per hidden run would interleave badly |
| 11 | 7 | `actionOutcome` reads `deployments[]` | reads `details[]` first, then `deployments[]` | live 4.3.19 answers `{details, message}`; captured and fixture-tested |
| 12 | 5 | `viewRow` fills the union of keys with null (plan Data shapes) | typed placeholders ("", -1, false, 0); every field coerced to its placeholder's type; unknown keys dropped | a `ListModel` fixes a role's type on the first append; nulls froze `name` and dropped every later string (the picker rendered blank rows and sent no `sub_service_name`) |
| 13 | 5 | — | `activateView` copies the picked row's fields before swapping the view | the swap clears the model the row lives in |
| 14 | 6 | the action strip stays a `Row` (`docs/design.md` action row) | a `Flow` | a running application now offers six buttons, which overflowed the card |
| 15 | 6 | — | the history cursor key survives a nested log push and pop | popping a log reset the cursor to the top |
| 16 | 6 | — | `viewRow` sets `type` = `rowType` | `SELECTABLE`/`nextSelectable` key on `type`; Show more and picker rows were unreachable |
| 17 | 7 | `folded["fold:tags"]` like every fold | for this one fold the flag means "opened" | it is closed by default and `toggleFold` flips undefined to true |
| 18 | 4 | `views` writes are mutate-then-self-assign | every writer assigns a fresh shallow copy of the map and the record (`_fresh`) | a `var` property assigned the same object emits no change |
| 19 | 4 | the overlay floats over the list (plan Interfaces: `z: 9`, `visible`) | `listView.visible: false` while a view is open; the overlay's blocking `MouseArea` only covers its own head and foot notes | the list showed through the overlay's transparent background |
| 20 | 9 | `docs/design.md:238` (`j`/`k` through chips) updated | left for the instances branch | chips do not exist yet |
| 21 | 4 | head trim `viewModel.remove(0, rec.dropped - seenDropped)` | a per-row loop removing rows whose absolute entry index is below `dropped` | rows are physical lines, not entries; the plan's count was wrong |
| 22 | 5, review | "one container → fetch; several → pick" done in the service | the service fetches at once; the panel's `syncView` swaps the picker view for the container log when the pick record holds exactly one name | the service cannot change the panel's view |
| 23 | 4, review | breadcrumb `‹ api · failed · 12m ago` (the plan did not say whose age) | a build log shows the deployment's own age (or elapsed time while building); a container log shows its fetch age in seconds | the fetch age read as "failed just now" on a days-old build |
| 24 | 3, review | `skipped` counts dropped ticks (SR30) | a lifetime counter that a panel-open prime colliding with an in-flight poll also increments; documented, not windowed | windowing it would not change its meaning; `deployments.skipped` during a build is the starvation signal |
| 25 | review, re-check | every refetch entry point throttled to one launch per second (deviation 9) | a target's first fetch (no record yet, a new container name, a new history page) is exempt; the service arm's single-container continuation bypasses the throttle | a dropped first fetch left the view on its loading note with nothing to refetch, and the continuation raced its own picker request |
| 26 | 4, re-check | the tail re-render compares the newest entry with the one seen last sync | it looks up the entry that was newest last sync by index and re-renders from it, so growth in the same poll a newer entry landed is not lost; head trim and tail removal are single `remove(index, count)` calls | one 2 s poll can both grow step N and append step N+1 |

Design lines the shipped code supersedes (the record carries the reconciliation; the committed plan file keeps its original text): the Panel.qml delegate map naming hoisted components (deviation 8); the union-of-nulls rule (12); the overlay "floats" framing (19); the internal-steps marker (10); the action `Row` (14); the head-trim count (21); the service-side single-container skip (22). The three invariants hold: the overlay owns its own model, log text never leaves the view slices and the overlay model, the log source is the deployments poll and the drain with no poller.

## Review

Panel model `opus`; the three always-on reviewers plus the four situational analysts the plan's panel record ran. All seven were spawned fresh against `06d95e1` (they read the plan and this record from disk). Every critical and warning was fixed in `5918642`; re-checks were sent to all seven. The re-check round confirmed 39 of the 44 dispositions and raised five new items, all fixed in `add2a09`: ux 4's fix had produced an empty container-log age (`Model.elapsed` had no numeric branch; critical), code-reviewer 2's fix still lost a tail entry's growth when a newer entry landed in the same poll (warning), security 2's throttle dropped a view's first fetch and raced the single-container skip (warning), ops 2's non-JSON grep omitted two keys of the family (warning), data 5's header comment contradicted its guard (nit), plus the perf residual on `skipped`'s lifetime and the batched removes. One re-check round only: skeptic 7 asked that the record say the leak capture was deleted by design (done above); nothing else is open.

| member | model | critical | warning | nit | fixed (commits) | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 0 | 3 | 0 | 3 (`5918642`: physical-line budget, refetch throttle, strict `viewRow`); re-check: 2 resolved, 1 warning on the throttle → `add2a09` | — |
| code-reviewer | opus | 1 | 2 | 3 | 6 (`5918642`: `r` keeps a known status, in-place tail growth re-rendered, `consumed` from the last index, comment, 3 MB copy, `b newest` everywhere it works); re-check: 5 resolved, 1 warning on the tail re-render → `add2a09` | — |
| skeptic | opus | 0 | 2 | 6 | 7 (this record: the superseded Design lines listed, `skipped` qualified, 88 and 34/34, Space row in `docs/design.md`, `/tags` in the open-panel row, question 7's source quoted, the record committed) | 1 nit partly: step 7's numbers are from the run's terminal output and are marked as not reproduced; step 8 was re-run and its samples kept. Re-check: 6 resolved, the leak-check artefact note added to Verification, the record committed |
| ux-api-designer | opus | 2 | 4 | 2 | 8 (`5918642`: single-container skip, `deploying…`, breadcrumb ages, `paused` from the snapshot, Space row, copy drift in `docs/design.md`, `#` tag bullet); re-check: 7 resolved, 1 critical (empty container age) → `add2a09` with a node case | — |
| perf-analyst | opus | 0 | 5 | 2 | 6 (`5918642`: probe-mode launch at 12, `_markPoll` before `_deployments`, `_tagsAt` at launch, doc kinds, batched append; the byte sample re-taken with the whole build inside the window) | 1 warning: `skipped` stays a lifetime counter, documented (deviation 24). Re-check: 6 resolved; the two residuals (the lifetime clause, batched removes) → `add2a09` |
| data-analyst | opus | 0 | 1 | 6 | 6 (`5918642`: API-reference corrections, `logdrain_` pattern, null-preserving re-scrub and recorder, gate comment, `_expirePending` comment; the `r` status fix shared with code-reviewer 1) | 1 nit: a tag whose name fails `TAG_RE` (a space, a comma) is dropped from the fold silently; SR28 by design, noted below. Re-check: 6 resolved, one stale header comment → `add2a09` |
| ops-analyst | opus | 0 | 3 | 3 | 6 (`5918642`: non-JSON fixture grep, the rate lock and confirm lock in `AGENTS.md`, `skipped` documented; `bin/dev-sync` re-run; the record's counts and its commit); re-check: 5 resolved, 1 warning (two keys missing from the non-JSON grep) → `add2a09` | — |

## Noticed, not done

- A Coolify tag whose name contains whitespace, a comma or URL structure fails `TAG_RE` and is left out of the fold with no note (data-analyst nit 7).
- `skipped` is a lifetime counter; a windowed variant would need its own ring (perf-analyst warning 4, deviation 24).
- The 15 s rung of `deploymentsInterval` sits above the 4 MB transport cap and cannot fire unless the cap is raised (documented in `docs/architecture.md`).
- The hero refresh button's `onHovered` calls `focusHero()`, a no-op while a view is open; its hover fill still paints.
- The github plugin logs `TypeError: Cannot read property 'name' of undefined` (`io.github.danjonesio.github/Panel.qml:631`) on every shell restart; not this plugin.
- The server row reads "0 resources" until the topology drain completes (pre-existing).
- `G.back` (`‹`) and `G.tag` (`#`) were checked by eye in screenshots, not measured at advance 600.
- The footer advertises `r refetch` only on the container log, though `r` works on every non-active view (documented in `docs/design.md`); the other three footer lines are at their width budget.
- Driving the panel with `wtype` from a session is only safe while nobody is at the keyboard: the post-review smoke test typed into Dan's browser.

## PR body

```
Phase 4 depth: build logs, container logs, deployment history, tag deploy

The panel gains a build-log view (read off the deployments poll that already carries
every active row's log under read:sensitive, and off the terminal drain: no log
poller), a container-log tail with a picker for services, per-application deployment
history with "Show more", and a TAGS fold whose confirm says the API cannot list what
a tag deploys. Every view fetch fails into the view, never into the panel-wide error.
Log text never leaves the service's view slices and the panel's overlay model.

Preceded by fix/read-sensitive-caps (e64f1fa): 4 MB max-filesize and 12 s max-time on
the log-bearing kinds, because the token change made every deployments poll carry the
full build log. Merge that first.

Plan: docs/plans/phase-4-depth.md
Steps: 14 commits: one per plan step (0–9), a tests step, the review fixes, the re-check fixes, this record
Verification: 119 node tests, bin/check green at every commit, live keyboard runs with
screenshots, rate 19/22/29 per minute (closed / open / building), token in 0 of
209 651 ps samples
Needs human: the acceptance-1 timing on a deliberately failed build; the 404
not-running copy on a resource stopped in the Coolify UI; the single-container picker
skip on an account that has one; a re-run of the keyboard smoke test after the review
fixes (j j L, r, k, b, H, Esc)
```
