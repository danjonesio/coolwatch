# Build record: Omarify Phase 3 — "notify"

Plan: `docs/plans/phase-3-notify.md` (copy of `~/.claude/plans/greedy-sprouting-quiche.md` as approved). Branch `phase-3-notify` from base `b38379c`; head `1afb9fb` when the panel ran, `7210e7c` after the review fixes (the record commit follows). Dan merges.

## Questions resolved

| question | answer | source |
|---|---|---|
| 1. Do Not Disturb mechanism | hybrid: plugin id everywhere, `omarchy-action` only for a critical event while DND is on | user |
| 2. Health-only transitions as a seventh toggle | no | default |
| 3. `RECENT_MAX_AGE_MS` | stays 1 h | user |
| 4. How to stop api from outside the plugin | Coolify UI (the run used a direct `POST /applications/{uuid}/stop` with the same token, identical from the plugin's viewpoint: no `_pending`, no `_actionAt`) | user |
| 5. May the runbook break a api build once | no; the failed path is fixture- and node-tested, live is needs-human | user |
| 6. Self-initiated cancel toast | suppressed for 300 s | default |
| 7. Server-outage story | `<server> unreachable · N resources down` | default |
| Panel model for the review | opus (named in the ask) | user |

## Audit

Tree clean at `b38379c` (`git status --porcelain` empty). Every path in **Changes** exists; the three new fixtures were marked new. Every line anchor cited in **Findings** matched the tree (`Service.qml:12` `property var shell`, `:176-184` `mkdirProc`, `:223` `_configText`, `:254` `_resetStore`, `:321` `_tokenReady`, `:388` `_finish`, `:421-479` `_dispatch`, `:542` `_drainTerminal`, `:725` `_setPending`, `:861` reaper, `:913` `_status`; `Model.js:56` `normaliseConfig`, `:460` `diffActive`, `:665-691` `origin`/`openUrl`, `:1023` `elapsed`; `bin/check:4` `root=`, `:33-38` SR9). No mismatch changed **Design**.

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| — | plan copy | `3f1159a` | — | — |
| 1 | `Model.js` config `notify{}`, `configSansNotify`, `origin` userinfo | `4d27488` | `node tests/run.js` | 72 passed, 0 failed |
| 2 | `Model.js` diffs and event builders | `df0ac20` | `node tests/run.js` | 77 passed, 0 failed (one expectation corrected: `elide` cuts at 31 + ellipsis) |
| 3 | `Model.js` copy, sanitiser, plan, recent (de)serialiser; fixtures | `84f49c9` | `node tests/run.js`; `bin/check --no-shell` | 87 passed, 0 failed; `ok` (deviation 1: the 10 000-entry case hits the size bound first) |
| 4 | `Service.qml` config live-apply, notify warning | `5ce27f2` | `bin/check`; `bin/dev-sync && omarchy restart shell`; three config edits through `jq` + `install -m 600` | `ok`; `configState ok`, `baselineDone true`, counts `{1,7,0,0}` and `inflightAction false` unchanged across `false`, `"false"`, removed; `warning notify` only on the quoted value; `requestsLastMin` 10–11; zero "Action interrupted" lines (deviation 2) |
| 5 | `Service.qml` diff hooks, queue/flush, DND read, action ledger, prunes, status | `68544f3` | `bin/check`; restart; 60 s baseline; IPC deploy | `ok`; no component error, icon present; baseline flags all true, `sentLastMin 0`, `suppressed {}`, `dnd "off"`, 0 notify lines; deploy → `omarify notify started xokso8d7`, `omarify notify finished xokso8d7`, 2 history files (`app` plugin id, urgency 0/1, `execArgv[1]` the deployment page), `sentLastMin 2`, `counts.recent 1`, `requestsLastMin` max 27 (deviation 3: unanchored log grep) |
| 6 | `Service.qml` terminal-drain retry | `3bd5a5e` | `bin/check`; restart; IPC deploy | `ok`; `terminalQueue` 0 throughout, `counts.recent` 0 → 1, exactly one terminal toast (`f5ffvcy7`), `drainRetries 0`, `requestsLastMin` max 26; the forced-failure path is needs-human |
| 7 | `Service.qml` `recent.json` | `365f114` | `bin/check`; dir pre-created 0755; restart; deploy; 2 idle min; restart; corrupt file; restart; deploy; poll edit | `ok`; dir `700 danjones` after start; `omarify recent loaded 0`; file `{version 1, instance https://app.coolify.io, 1 entry}`, 0 token-shaped strings; mtime unchanged over 12 × 10 s idle; `recentPersisted 1` at +2 s after restart, 0 notify lines, `omarify recent loaded 1`; corrupt → `recentPersisted 0`, `recentRejected true`, `omarify recent rejected`, `error null`, 0 crash lines; next deploy rewrote `{version 1, n 1}`; `poll.resourcesSec` edit (a reset) → `recentPersisted 1` re-read |
| 8 | `bin/check` root override + SR16 gates | `4676128` | `bin/check --no-shell`; self-tests on `cp -r` copies with `OMARIFY_ROOT` | `ok`; notifier in `Service.qml` → fails (c); second launcher in `Model.js` → fails (a); second notifier in `Model.js` → fails (b); `Model.js` **and `tests/run.js`** rolled back to `b38379c` → `ok` (deviation 6: the six-file rollback alone leaves the Phase 3 tests red, so the AGENTS.md rollback line now checks out `tests/run.js` too); after the review, a same-line second notifier → fails (b) (the gates count occurrences, `99b408a`) |
| 9 | docs and version | `519e61c` | greps; `bin/check` | `bypasses Do Not Disturb` absent from AGENTS/architecture/product; manifest `0.3.0`; `click to open logs` absent; `ok` |
| 10 | live acceptance runbook | (no code) | see Verification | 12 of 14 steps ran; 7, 13 and 14 needs-human; steps 4/5/6/7 Verify lines re-run on the final build after the review fixes (the re-verification rows below) |

## Tests

All in `tests/run.js`, all in `84f49c9` unless noted; 87 tests, 0 failed.

| case | covers | commit |
|---|---|---|
| `normaliseConfig` notify: defaults, one false, `"false"` → default + warning, unknown key, `notify: false`, `notify: "false"`, `true`/`null` | SR22 | `4d27488` |
| `configSansNotify` equal/unequal | Change 1 | `4d27488` |
| `origin`/`openUrl` reject userinfo; `normaliseConfig` still accepts | SR19 | `4d27488` |
| `diffDeployments`: vanished carried, first → none, queued/started/restarting, O(N) 2 000 under 50 ms | Change 2 | `df0ac20` |
| `terminalEvent` × 5 incl. `in_progress → null`; `hasTerminal` × 3 | Change 2 | `df0ac20` |
| `resourceEvents` × 11 transitions incl. `recovered`, health-only silent, absent-from-prev | Change 2 | `df0ac20` |
| `serverEvents` × 5 | Change 2 | `df0ac20` |
| `appLabel` × 6, `uuid8` newline | Change 2 | `df0ac20` |
| `notifySafe`: 5 option-shaped strings, NUL/ESC, `Émilie`, CJK, ordinary headline, redact-before-elide, `""`, 72 cap | SR15 | `84f49c9` |
| `notifyBody`: `<a href>`, `&`, escape after cut, headline leaves `<` | SR15 | `84f49c9` |
| `notifyCopy`: 13 rows over `loadedSnap()`, glyphs ∈ `GLYPHS`, urgency, toggle, 7 fallbacks | Change 3 | `84f49c9` |
| `notifyPlan` resolves the joined object; raw event gets URL + server; absent → fallback | wave-2 critical | `84f49c9` |
| `notifyPlan` argv: argv[0], `--exec` last with one URL, absent without a page, body omitted, app-name rule under dnd true/false/null | SR16, SR17, SR23 | `84f49c9` |
| `notifyPlan` 8 drops, each with inside/outside windows; rule 7 both branches; rule 8 deployment repeat; `recovered` pairing; per-rule counts | Change 3 | `84f49c9` |
| `notifyPlan` bounds: 20 flips → 3 + summary; 4 low + 1 failed with budget spent → the failed at critical; ordering; 200 resources / 20 flushes ≤ 12; flap 3/10 min; `notified` keys | SR21 | `84f49c9` |
| `notifyPlan` log lines: event + uuid8 only; hostile uuid | SR15 | `84f49c9` |
| `parseRecent`/`serialiseRecent`/`mergeRecent`: round-trip, corrupt, `null`/`""`/`undefined`, empty key, wrong key, version, non-array, `[]`, `null`, 5 MB, 10 000 entries rejected by size + 2 000 → 20, null/25 h/non-terminal/bad-uuid/duplicate entries, 5 hostile urls, redact, key ignores `savedAt`, only terminal persisted, merge dedupe + order + cap | SR18, SR19 | `84f49c9` |
| recorded cancelled fixture: status + `terminalEvent` + `finished_at` present | Change 3 | `84f49c9` |
| `GLYPHS` contains every `NOTIFY_ROWS` glyph | Change 3 | `84f49c9` |
| `notifyPlan` 2 000 events under 50 ms; a critical burst charges no minute budget and a non-critical toast right after it is emitted | Change 3 Verify, SR21 (perf F1, F2) | `91a50af` |
| `notifyPlan` mixed overflow: 2 stopped + 3 recovered + 2 stopped → 3 toasts + "1 more resources stopped" (recoveries never counted as stops) | code-reviewer F1 | `99b408a` |
| prototype keys: a resource named `toString`, a deployment `appName` `constructor`, a `status` `constructor`, uuids `valueOf`/`constructor` through `notifyPlan`/`hasTerminal`/`mergeRecent`/`parseRecent` | security F2, code-reviewer F5 | `99b408a` |
| `appLabel`: the generated `<uuid>-<digits>` name → its first 8; a short uuid never masks a real name | ux F1 | `99b408a` |

## Verification

Preconditions held: one installed build (`519e61c`'s ship files, manifest `0.3.0` confirmed in the plugin dir) for the whole runbook; every panel closed except where a step opens one; DND off; `SCRATCH` = the session scratchpad; the needle guard passed (inline token). Evidence: the `omarify notify|recent|drain` log lines (unanchored), history files under `~/.local/state/omarchy/notifications/history/` diffed per step, live popup files in `~/.local/state/omarchy/notifications/`, `status` samples.

| check | command or action | result |
|---|---|---|
| `bin/check` | full | `ok` (87 tests, fixture-secret gate on 3 new fixtures, PlainText/font gates, SR9, SR16, staged validate, qmllint with `qs.Commons` resolved) |
| `bin/check --no-shell` | CI subset | `ok` |
| `status` fields | `jq '{baseline, notify, recentPersisted, recentRejected, terminalQueue, drainRetries, requestsLastMin}'` | present throughout; final `baseline` all true, `notify.dnd "off"`, `drainRetries 0` |
| token needle | `ps -eww -o args=` at 200 ms across a final-build deploy (115 594 lines, kept as `$SCRATCH/step-11.log`; the notifier process itself, ≈115 ms, was not caught by a 200 ms sampler: the 700 lines matching its name are the sampler's own script text, so the argv content is read from the history files instead), `quickshell log -t 100000`, `recent.json` | 0, 0, 0 (an earlier 114 917-line capture during runbook 9 also read 0 but was not kept; deviation 7) |
| state dir | `stat -c '%a %U' ~/.local/state/omarify` | `700 danjones` (after a deliberate 0755 pre-creation) |
| runbook 1: silent baseline | restart + 12 × 10 s loop (`step-1-12.log`) | all four baseline flags true at the first sample; 0 notify lines; 0 new history files; `dnd "off"` |
| runbook 12: idle budget | `jq -s 'map(.requestsLastMin) | max'` over the same loop, panel closed | **18** (Phase 2 measured 18); during the step 5 deploy max 27, step 6 max 26 |
| runbook 2: one deploy | IPC deploy on the final build (`ozqinwum`, after the review fixes; the same shape was seen on the step 5 build `xokso8d7` and the runbook-9 build `4ttbgrbc`) | `started` + `finished` (`queued` skipped: the first poll already saw `in_progress`, which the roadmap's "optional" covers); 2 history files, plugin id, urgency 0/1, `execArgv[1]` the deployment page; summaries "Building xyhpwdxq" / "Deployed xyhpwdxq · 20s · main" (the generated-name label after ux F1); `toast-deployed.png` (runbook-9 build) shows the pre-fix 32-char label with the check glyph; the click itself is **needs human** (no pointer) |
| runbook 3: restart mid-deployment | IPC `restart` then `omarchy restart shell` at +2 s | first branch held: `counts.deployments 1` after the restart; log after the restart `recent loaded 1`, then exactly one `restarted sqlnbhef` at +20 s and no `restarting`; a second restart after it finished → `recent loaded 2` and nothing else |
| runbook 4: deploy-caused restart is silent | IPC `restart`, 180 s watch | only `restarting zd5ssgx1` and `restarted zd5ssgx1`; 0 `stopped` lines; no resources poll observed a flip, so rules 5/6 have **no live evidence** (the step was silent for want of an input; node-tested only) |
| runbook 5: user action is silent | IPC `stop`, 150 s; IPC `start`, 150 s | 0 `stopped`/`recovered` lines; `suppressed.pending 1` (the flip was observed and dropped); the Start produced its own deployment toasts (`started`/`finished e42jotme`: Coolify starts an application through a deployment) and one `recovered` dropped by `cooldown` (no prior stopped toast) |
| runbook 6: unexpected stop and recovery | direct `POST …/stop` (200), then `POST …/start` (200) | exactly one `stopped xyhpwdxq` at +31 s, history "xyhpwdxqu33omjgwuo6c7cjp-200537… stopped / hetzner-1 · exited", urgency 1, `execArgv[1]` the resource page (`topologyLoaded true`); 0 further `stopped` over the next 60 s; after the start: `started`/`finished vtdxpdix` (the start's deployment) and exactly one `recovered xyhpwdxq` ("… running / hetzner-1 · running", low) |
| runbook 7: failed deployment | declined (question 5) | **needs human**: temporarily break api's build command in the Coolify UI, deploy, revert; expect one `failed` line, a critical toast "Deployment failed: <label> · <dur> · click to open in Coolify", the bar alert, the toast persisting until dismissed and replayed by the notifications plugin after a shell restart |
| runbook 8: DND | `toggleDnd`; deploy; `toggleDnd` | `dndState on`, `status.notify.dnd "on"`; deploy → `started`/`finished b0qwmca5`, 2 history files, **0 live popup files** across 45 s (max of 9 samples); back to `off`/`"off"`. The critical-under-DND half is **needs human** (needs step 7): expect a popup whose history entry has `app: "omarchy-action"` |
| runbook 9: toggle | `deploymentQueued: false` via `jq` + `install -m 600`; deploy; restore | `enabled.deploymentQueued false` at +5 s, `baselineDone true`, `inflightAction false`, `configState ok`; deploy → `started`/`finished 4ttbgrbc` only; restored → `true`; config mode 600. api never shows a `queued` poll, so this step proves the live apply only; the toggle's suppression is node-tested |
| Change 4 callout (re-run) | quoted `"deploymentQueued": "false"`, summon, `grim` | `callout-notify.png`: "Notify setting ignored / notify.deploymentQueued must be a boolean; using the default"; `status.warning "notify"`, `status.notify.warning` the same text, `enabled.deploymentQueued true`; restored → both null |
| re-verification on `7210e7c` | `bin/dev-sync && omarchy restart shell`; baseline; deploy under the sampler; state file | installed ship files identical to the tree, manifest `0.3.0`; baseline all true, `sentLastMin 0`, `suppressed` the ten rules at 0, `dnd "off"`, `recent loaded 8`, dir `700 danjones`; deploy → `started`/`finished ozqinwum`, `terminalQueue 0`, `drainRetries 0`, `requestsLastMin` max 19; `recent.json` `{version 1, 9 entries}` rewritten once |
| runbook 10: persistence | restart; summon; `grim` | `recentPersisted 7` at +2 s; `panel-recent.png` shows five Recent rows (1m … 14m ago) under DEPLOYMENTS |
| runbook 11: argv hygiene | the 200 ms `ps` sampler across step 9's deploy | needle 0 in `ps`, log and `recent.json`; the notifier process itself (≈115 ms) was not caught by a 200 ms sampler, so its argv content was read from the history files instead (label, branch, URL, as expected) |
| runbook 13: queued cancel | IPC deploy, summon at +1.2 s, `Down x l Return` | **needs human**: the deployment was already `in_progress` 1.2 s after queuing (`GET /deployments`), so a queued cancel is not reachable on api, and the scripted keys did not dispatch a cancel (`lastAction` stayed the deploy: the first `Down` only activates the cursor). The Phase 2 question is answered by the recorded fixture instead: `af8defdknx8t5kb0kron1oaw` (cancelled 6 s after creation) is returned by `GET /deployments/{uuid}` with `status cancelled-by-user` and `finished_at` set, so it lands in Recent |
| runbook 14: dedupe | — | **needs human** (not forceable without a network fault); `hasTerminal` and rule 8 are node-tested |
| drain retry (Change 6) | — | **needs human** (not forceable): the re-queue logic is reviewed, not observed |
| machine state | panel hidden, DND off, config restored (no `notify` block, `poll.resourcesSec` removed, mode 600), api running, `recent.json` valid | done |

Acceptance mapping: roadmap line 1 ← runbook 2 and 3 (no-replay proven on the surviving-build branch); line 2 ← 5 and 6 (runbook 4 was vacuous: no flip was observed, so the active-deployment and grace rules rest on the node tests); line 3 ← 8's non-critical half, the critical half (failed deployment or unreachable server under DND) needs-human; the persistence line ← 7 and 10.

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 3 (tests) | "10 000 entries → 20" | the 10 000-entry file is asserted **rejected** (it exceeds the 262 144-char bound before the array cap) and a 2 000-entry file (under the bound) caps at 20 | the two bounds collide on that input; the size bound is SR18's stronger guarantee |
| 2 | 4 | files: `Service.qml` | `Model.js` `callout()` also gains a title fallback (`w.title \|\| "Warning"`) | the `notify` warning kind needed a title; one expression |
| 3 | 5, 7, 10 | log greps anchored `^omarify …` | unanchored `omarify (notify\|recent\|drain) ` | the quickshell log prefixes every line with `DEBUG qml:`; documented in AGENTS.md |
| 4 | 6 | "the deployment arm's `delete _drainTries[uuid]`" | `_drainDone(ok, gone)` clears it on success and on 404 | one settle site instead of two; same effect |
| 5 | 10 (runbook 6) | stop from the Coolify UI (question 4) | a direct `POST /applications/{uuid}/stop` and `/start` with the token on stdin | identical from the plugin's viewpoint (no pending entry, no action ledger); no browser scripting |
| 6 | 8, 9 | rollback line: the six ship files, "`bin/check` stays green" | the rollback line also checks out `tests/run.js` | the Phase 3 tests reference functions a Phase 2 `Model.js` lacks (18 failures without it); the SR16 gates themselves are rollback-safe |
| 7 | 10 (runbook 11) | the `ps` capture is kept as evidence | the runbook-9 capture (114 917 lines, needle 0) was deleted after reading; the re-verification capture on the final build is kept as `step-11.log` | the first capture was named `step-9-11` in the draft record but never existed on disk (ops F4) |
| 8 | 9 | `docs/plans/phase-2-act.build.md` edited in step 9 | edited in the record commit `1afb9fb`, then corrected in `7210e7c` | the row was first closed on the strength of an in-progress cancel; the queued cancel is still open (skeptic F1) |

## Review

| member | model | critical | warning | nit | fixed (commits) | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 0 | 2 | 1 | F1 SR16 counts occurrences + same-line probe `99b408a`; F2 prototype-free maps (`bare()`, `hasOwnProperty` on `TERMINAL`) + tests `99b408a`; F3 threat-model note in architecture `99b408a` | — |
| code-reviewer | opus | 0 | 3 | 3 | F1 summary counts stops only + mixed test `99b408a`; F2 suppressed seeded with the ten rules `99b408a`; F3 `notifyPlan` timing test `91a50af`; F4 `_drainTries` counted only when a retry is queued `99b408a`; F5 `TERMINAL` lookups `99b408a`; F6 prune early returns `91a50af`, the Phase 2 record commit noted (deviation 8) | — |
| skeptic | opus | 0 | 3 | 2 | F1 Phase 2 row reopened `7210e7c`; F2 suppressed seeded `99b408a`; F3 callout re-run with `callout-notify.png`; F4 roadmap DND caveat widened `7210e7c`; F5 acceptance mapping restated in this record | — |
| data-analyst | opus | 0 | 1 | 1 | F1 drain settles on dispatch success (`_drainDispatched`) + architecture sentence `fc3d9db` | F2 `refresh` after a config error repopulating Recent under a stale `_instance` (presentation-only; clearing `_instance` on a config error would blank the hero's last-known instance, a Phase 1 behaviour; Noticed) |
| ux-api-designer | opus | 0 | 4 | 2 | F1 `appLabel` generated-name case → `uuid8` `99b408a`; F2 roadmap Recent clause `7210e7c`; F3 degraded glyph U+F1396 `7210e7c`; F4 README qualified + `status.notify.warning` `99b408a`/`7210e7c`; F5 design caveat on the join `7210e7c`; F6 suppressed seeded `99b408a` | — |
| ops-analyst | opus | 0 | 4 | 2 | F1 rollback line + deviation 6 `7210e7c`; F2 runbook row 2 re-pointed to the final build; F3 `_stateDirReady = code === 0` + warn line `99b408a`; F4 `step-11.log` kept (deviation 7); F5 scratch config copies deleted; F6 `recentPersisted` clause `7210e7c` | — |
| perf-analyst | opus | 0 | 2 | 2 | F1 timing test `91a50af`; F2 minute ring counts non-critical only (`notifyPlan.nonCritical`) + test `91a50af`; F3 prune early returns `91a50af`; F4 budget provenance stated (this record: deploying max measured on the step 5/6 builds, 27/26, and 19 on the final build; no request-issuing change after step 6) | — |

Panel: the three minimum reviewers plus the four situational analysts the plan ran. Panel model Opus (named in the ask). The plan and the record were read from the repo rather than pasted (70 KB). Re-check round: see the final record commit.

## Noticed, not done

- Coolify starts an application through a deployment, so a plugin `start` (and an external one) yields "Building"/"Deployed" toasts for what the operator asked to be a start; a `started`/`finished` deployment whose `restart_only` is false and whose application was `exited` could read "Started"/"Running" instead (`Model.js` `notifyCopy`; a copy decision).
- The panel's Recent rows still show the raw decorated name while toasts show `appLabel`; applying `appLabel` to `deploymentRow`/`resourceRow` is out of scope (`Model.js:693`).
- Runbook step 13's key sequence needs two `Down`s (the first only activates the cursor); the Phase 2 runbook used the same first-`Down` behaviour.
- `refresh` (IPC or panel) after a `configerror`/`noconfig` re-arms the state file under the previous `_instance` and repopulates Recent beside the error callout (data-analyst F2); presentation-only, no write can follow.
- `status.recentPersisted` is the count accepted at load (documented); a `recentOnDisk` counter would need a read-back after every save.
- `status.notify.suppressed` is cumulative since the last config change; a reviewer diffing two samples reads a delta.

## PR body

```
Phase 3: notifications, per-event toggles, recent.json

Every real transition is one toast: deployment queued/building/deployed/failed/cancelled (restart-only deployments read "Restarting"/"Restarted"), a resource stopped or degraded outside a deployment or a user action and its recovery, a server unreachable or back. Each diff runs inside its poll arm from the previous store value and is gated on that kind's own baseline flag; the terminal fetch is retried twice on a transport failure and its result is deduped through `recent`. Suppression, ordering and caps live in Model.notifyPlan (node-tested): self-cancel, pending, a 180 s action window, active and just-finished deployments, server-down correlation, a 300 s cooldown per event, critical first, 3 resource toasts per flush plus a summary, 12 non-critical per minute. Every positional passes Model.notifySafe (the shell's notifier parses options after the headline; a commit message could otherwise set the sender). notify{} toggles apply live with no store reset and a malformed value warns instead of stopping the plugin. Recent terminal deployments persist to ~/.local/state/omarify/recent.json (0700 dir, written from the terminal-fetch arm only, validated on load) so the Recent section is back within 2 s of a shell restart. Do Not Disturb: the shell only shows omarchy-action through DND, so a critical event while DND is on is sent under that name; everything else keeps the plugin id. bin/check gains SR16 (the notifier and launcher shapes in Model.js, the notifier banned from QML) and an OMARIFY_ROOT override for gate self-tests.

Plan: docs/plans/phase-3-notify.md
Steps: 9 step commits, one per plan step, plus the plan copy and this record
Verification: bin/check green (87 tests); live on Coolify Cloud against api: silent baseline, one deploy → Building + Deployed with click targets, restart mid-deployment → one terminal toast and no replay, restart deployment silent, plugin Stop/Start silent, external stop → one "stopped" at +31 s and one "recovered", DND → history only with zero popups, toggle applied live, recent.json 700-dir with 7 entries reloaded in 2 s, idle budget max 18/min, token needle 0 in ps/log/state
Needs human: a deliberately failed build or a server outage (the critical toast, its omarchy-action path under DND, the bar alert), a genuinely queued cancel (api is in progress within 1 s; the Phase 2 row stays open), a forced terminal-fetch failure (retry), a drained-twice uuid (dedupe), the toast click with a pointer
```
