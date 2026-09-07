# Build record: Omarify Phase 2 — "act"

Plan: `docs/plans/phase-2-act.md` (copy of `/home/danjones/.claude/plans/greedy-sprouting-quiche.md`, the Phase 2 plan; the Phase 1 plan and record keep the `greedy-sprouting-quiche` basename). Branch `phase-2-act` from base `29f3a76`. Dan merges.

## Questions resolved

| question | answer | source |
|---|---|---|
| 1. Which resource may the runbook deploy, restart, stop and start? | `api`: the application `xyhpwdxqu33omjgwuo6c7cjp` (project api, environment dev, dockerimage build pack) | user |
| 2. Which application builds slowly enough to cancel mid-build? | the same; a dockerimage deploy stayed cancellable long enough (cancel took 2.7 s server-side and returned `cancelled-by-user`) | user |
| 3. Old token after the swap | moot: Dan had replaced the token with a `read` + `deploy` one before the run ("the key has been updated for this") | user |
| 4. Is Dan's Cloud user an admin/owner? | yes in effect: every call succeeds with the `deploy` token | default (observed) |
| 5. Validate on a token without `write` | shown; demonstrated as "Token lacks the write permission" (real 403 body `{"message":"Missing required permissions: write"}`) | user ("read and deploy") |
| 6. Roadmap acceptance line 1 wording | reworded to "one status sweep plus one resources interval (≤ 90 s with the panel open)"; the still-unverified parts are named beside it | default |
| 7. Server proxy status / `unreachable_count` | deferred to Phase 4; `docs/product.md`, `docs/design.md`, `docs/roadmap.md` amended | default |
| 8. Status-line 2.2 s / 6 s; pending 150 s / 300 s | as stated; docs updated | default |
| 9. Paste one service and one database UI URL before Change 2 | skipped; the server shape was verified live, the application/service/database rows were not clicked (needs human) | user |
| Panel model for the review | opus (named in the ask) | user |

## Audit

Tree at `29f3a76`, `git status --porcelain` empty. Every path in **Changes** exists. Two plan citations were off by a line and corrected in the plan file during planning (`Model.js:73` `hasOwnProperty`, `bin/record-fixture:17` deny string). Found while building: `Model.rowRev`'s join separator is a raw U+0001 byte, so that edit was applied by line number; a `Timer` cannot be declared inside `KeyboardPanel`'s content list (`Cannot assign object of type "QQmlTimer" to list property "contentItem"`), so the confirm-arm timer lives at the Panel root. No mismatch changed **Design**.

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| 0 | Baselines and the token ability probe | (no code) | idle loops 12 × 10 s; probe `POST /deployments/not-a-uuid…/cancel` | panel closed max `requestsLastMin` 18 (`baseline-closed.log`; one sample shows `openPanels 1`, a panel was opened by hand during the loop); panel open max 20 (`baseline-open.log`); probe → `404 {"message":"Deployment not found."}` = the token has `deploy`. The plan's STOP branch was overridden by Dan's answer (deviation 1). `api` resolved to `xyhpwdxqu33omjgwuo6c7cjp` via `GET /resources`, `/projects`, `/projects/{uuid}` |
| 1 | `Api.js` POST blocks and action descriptors | `7075d7f` | `node tests/run.js` | 53 passed, 0 failed (6 new Api cases; the three Phase 1 `Api.config` cases unchanged) |
| 2 | `Model.js` joins, URLs, applicability, copy, pending, outcomes, actions row; 8 fixtures | `43035c9` | `node tests/run.js`; `bin/check --no-shell` | 67 passed, 0 failed; `ok` |
| 3 | `Service.qml` action path | `4be53b7` | `bin/check`; `bin/dev-sync && omarchy restart shell`; IPC on api; 200 ms `ps` sampler | `ok`; `requestsLastMin` 10 at baseline (log intact); `restart` → `queued restart <uuid>` (200, 218 ms, `result queued`), `stop` same uuid → `already pending <uuid>`, `start` running app → `not applicable start <uuid>`, `stop deadbeef` → `unknown uuid deadbeef` (no request), `stop` (no uuid) → rejected by `omarchy-shell` itself; pending 1 → 0 when the deployment appeared; bar `U+F0996` while deploying; `error null`, `probeMode false`, `actionsLastMin 1`; `ps.log`: 15 curl argv lines, every one `/usr/bin/curl -q -S -K -`, token 0, verb/path/uuid 0 |
| 4 | `Panel.qml` expansion, strip, keys, confirm, status line, open; `BarWidget.qml` right-click; `bin/check` SR9 gate | `d42f87a` | `bin/check`; gate self-test; `bin/dev-sync && omarchy restart shell`; scripted `wtype` sequence with `grim` screenshots | `ok`; the gate fails closed on a probe line passing `r.fqdn` to the launcher (the `fqdn` arm); Return → strip Deploy · Redeploy · Restart · Stop, first button ringed, row painted `current`; `l`×3 → Stop ringed (`p6.png`); `h`×4 → focus back on the row, footer "l pick · enter collapse · esc collapse" (`q2.png`, after the review fix); Return → "Stop <name>?" with Cancel selected (`p7.png`); `d x r g Tab` → nothing (`requestsLastMin` 17 → 17, dialog up, `p8.png`); Esc → dialog gone, row expanded; Esc → collapsed (`p10.png`); Esc → closed (`openPanels 0`); a 150 ms held Escape from the dialog cancels only the dialog (`q4.png`); two Returns 50 ms apart on Stop leave the dialog open (pending 0, actionsLastMin 0, `p11.png`); real Stop → "Stop requested", `stopping…` with the half glyph (`p12.png`; accent colour on the caption only after review fix `520c097`, `q5.png`), 200 in 163 ms, pending cleared at +30 s on the resources poll; `s` → "Start requested", 200 in 226 ms, `result queued`, cleared at +50 s when its deployment appeared; `requestsLastMin` max 26. Bar-icon right-click: not exercised (needs human; `wtype` has no mouse) |
| 5 | Live acceptance runbook | `c55bc81` (recorded restart fixture) | the 14 runbook items | see Verification; the recorded `POST /applications/{uuid}/restart` body replaced the hand-written `action-restart-ok.json` through `bin/record-fixture`'s scrubber (`_recorded`); the GLYPHS test case rode along in this commit's `tests/run.js` add |
| 6 | Reconcile the docs; version 0.2.0 | `2fd90f1` | the six greps; `bin/check --no-shell` | all empty (two negated mentions of the old property names reworded so the literal grep is clean); `0.2.0`; `ok`. The footer table and two Actions-table rows were missed and landed in the review commit `5aa075a` |
| — | plan copy | `c74f0e4` | — | `docs/plans/phase-2-act.md` |

## Tests

| case | covers | file | commit |
|---|---|---|---|
| Api.block GET output byte-identical for every Phase 1 descriptor (whole-block compare after `79ed183`) | SR1 | `tests/run.js` | `7075d7f`, `79ed183` |
| Api.block POST shape: one request, one Content-Type, one constant data-raw, all nine GET lines | SR1 | `tests/run.js` | `7075d7f` |
| Api.config: two GETs around one POST carry request once; no location anywhere | SR1, SR2 | `tests/run.js` | `7075d7f` |
| Api.block / Api.config reject unknown and prototype methods with null | SR1 | `tests/run.js` | `7075d7f` |
| Api.reqDeploy hostile uuid percent-encoded; force only when true; one url line | SR1 | `tests/run.js` | `7075d7f` |
| Api.reqLifecycle / reqCancel / reqValidate families and verbs; unknown or prototype kind and verb null | SR3 | `tests/run.js` | `7075d7f` |
| Model.environmentsOf keeps uuid; applyJoins carries environmentUuid | joins | `tests/run.js` | `43035c9` |
| Model.openUrl deployment joins the relative deployment_url; hostile values yield empty; a path prefix is kept; query/fragment rejected | SR9 | `tests/run.js` | `43035c9`, `79ed183` |
| Model.openUrl resource shape, server shape, missing parts yield empty | SR9 | `tests/run.js` | `43035c9` |
| Model.actionsFor: the applicability table; Open only with a url | table | `tests/run.js` | `43035c9` |
| Model.actionFor: s → stop/start, D → redeploy, unknown null | keys | `tests/run.js` | `43035c9` |
| Model.actionRequest: invalid, unknown, not applicable, the ok shape | SR3 | `tests/run.js` | `43035c9` |
| Model.canAct: pending and inflight dedupe; inflight or 1 s spacing is busy | SR6 | `tests/run.js` | `43035c9` |
| Model.confirmCopy: three verbs; labels fit the cell | SR8 | `tests/run.js` | `43035c9` |
| Model.pendingVerb / gerund: seven verbs with and without stale | pending | `tests/run.js` | `43035c9` |
| Model.withPending: replace vs append; rowRev and sameRows notice | SR7 | `tests/run.js` | `43035c9` |
| Model.actionOutcome: every fixture maps to its exact line and tone | SR4, SR10 | `tests/run.js` | `43035c9`, `c55bc81` |
| Model.actionOutcome: abilities, auth, rate limit, transport, 404, redaction | SR4, SR10 | `tests/run.js` | `43035c9` |
| Model.panelRows with expandedKey: actions row placement, not selectable, vanishes, empty-resources path, rowRev on id list and url presence | actions row | `tests/run.js` | `43035c9` |
| Model.nextAction clamps; h from the first returns; a vanished id counts as the first | focus | `tests/run.js` | `43035c9` |
| Model.footerHints: every cursor position incl. an expanded row with focus back on it; no o open without a url | footer | `tests/run.js` | `43035c9`, `79ed183` |
| Model.GLYPHS: the pending dot and every glyph a pending row can emit are in the allowlist | glyphs | `tests/run.js` | `c55bc81` |

`node tests/run.js` → 68 passed, 0 failed. `Service._expirePending`, `act()`, `_refuse` and the panel state machine are QML and have no node coverage; they are exercised only by the live rows below.

## Verification

| check | command or action | result |
|---|---|---|
| `bin/check` | full | `ok` (68 tests, symlink scan, fixture secrets, PlainText and font parity, literal grep, SR9 gate, staged validate, qmllint) |
| `bin/check --no-shell` | CI subset | `ok` |
| `status` shape | `omarchy-shell … status \| jq '{lastAction, pending, pendingStale, actionsLastMin, requestsLastMin, error, probeMode}'` | `{"lastAction":{"verb":"start","uuid8":"xyhpwdxq","code":200,"curlExit":0,"ms":237,"at":…,"result":"queued"},"pending":0,"pendingStale":0,"actionsLastMin":0,"requestsLastMin":26,"error":null,"probeMode":false}` |
| token never in the log | `quickshell log … \| grep -cFf <(needle)` | 0 |
| resource names and Coolify messages never in the log | `grep -ciE 'storefront\|umami-prod\|uptime-kuma\|authentik\|api'`; `grep -ciE 'Deployment request queued\|stopping request\|Missing required'` | 0; 0 |
| argv during a POST | 200 ms sampler around the IPC restart (`ps.log`) and 50 ms sampler around a manual restart (`ps2.log`) | 15 and 26 curl argv lines, all `/usr/bin/curl -q -S -K -`; token 0; verb/path/uuid 0 |
| runbook 1: ability 403 on a token without `deploy` | — | **needs human** (the run used a `deploy` token): create a `read`-only token, write it with `umask 077; cat > "$XDG_RUNTIME_DIR/tok"; jq --rawfile t "$XDG_RUNTIME_DIR/tok" '.instances[0].token = ($t \| rtrimstr("\n"))' ~/.config/omarify/config.json > "$XDG_RUNTIME_DIR/c.json"; install -m 600 "$XDG_RUNTIME_DIR/c.json" ~/.config/omarify/config.json; rm -f "$XDG_RUNTIME_DIR/tok" "$XDG_RUNTIME_DIR/c.json"`, then: (a) `d` on any application → the status line reads exactly "Token lacks the deploy permission", `status` shows `error null`, `probeMode false`, `bar` unchanged; (b) `s` and `x` likewise; (c) `status.lastAction.result` is `ability` for a deploy verb; (d) three `omarchy-shell io.github.danjonesio.omarify stop <uuid>` in a row → the third prints `refused: token lacks the deploy permission` with `requestsLastMin` unchanged (the IPC cool-off, `Service.qml` `_ipcAbilityStreak`, has no coverage of any kind). SR4's "an ability 403 never poisons polling" is already proven by the `write` 403 below |
| runbook 2: token swap + real revoke | — | **needs human** (Dan swapped the token before the run): delete a token in Coolify and watch "TOKEN REJECTED" within 5 s, then write the new one with the recipe above |
| runbook 3: `write` 403 | `v` on the server row | pass: "Token lacks the write permission" (403, 131 ms), `error null`, `probeMode false`, bar unchanged (`p18.png`) |
| runbook 4: deploy from the keyboard + 18-sample loop | `d` on api | pass: "Deployment queued" (`p23.png`); `deploying…` on the keystroke; `counts.deployments` 0 → 1 between the t=0 and t=11 s samples; pending 1 → 0 at that moment; bar `U+F0996` while building; `counts.recent` incremented by the t=21 s sample; max `requestsLastMin` 31 across a deployment that lived ~10–20 s (so ~8 of those requests were at the 2 s cadence; the sustained deploying rate is the derived ≈ 35/min, not measured) |
| runbook 5: restart | IPC `restart` (step 3), a manual restart (step 5), `t` from the panel (`q5.png`) | pass: "Restart queued", `restarting…` in accent, a `restart_only` deployment appeared within 6 s and pending cleared when it did |
| runbook 6: stop then start | keyboard (step 4) | pass for the keyboard path; the **mouse path** (click Stop, click Confirm, hover moving the cursor, right-click on a row) needs human |
| runbook 7: service restart | — | **needs human**: `t` on a service or database Dan nominates (only api, an application, was nominated) |
| runbook 8: stale note | v1: `resourcesSec 3600`, IPC `stop` (`stale.log`); v2: both intervals 3600 (`stale2.log`) | **not observed**. v1 cleared at +46 s after a resources poll landed 41 s into the window; v2 shows `openPanels 1` at its reload. Both are explained by a panel being open on a monitor during the wait: `_resourcesSec` is `min(cfg, deploying ? 15, panelOpen ? 30)` (`Service.qml:97`) and `_catchUp` polls immediately when the interval drops. The 150 s / 300 s transitions rest on `_expirePending`'s code and the `pendingVerb` unit test. **Needs human**: with no panel open on any monitor and no deployment active for the whole window, `resourcesSec` and `serversSec` at 3600, `omarchy-shell io.github.danjonesio.omarify stop <uuid>` and watch `status \| jq '{pending, pendingStale, openPanels}'` read `1,0,0` → `1,1,0` at 150 s → `0,0,0` at 300 s; then `start` it and restore the config (each config write resets the store) |
| runbook 9: cancel | `d` then `x` on the deployment row → confirm | pass: "Cancel the deployment of <name>?", cancel 200 in 2689 ms, row "· cancelling…" with the cancelled glyph (`p21.png`), `GET /deployments/applications/<uuid>?take=1` → `cancelled-by-user`. **Needs human**: cancel a still-`queued` deployment and record whether it lands in recent or vanishes (goes into `docs/design.md`) |
| runbook 10: IPC | step 3's sequence | pass |
| runbook 11: Open | `o` on the server row | pass for servers: Brave opened "hetzner-1 \| Server \| Coolify"; deployment rows carry Coolify's own relative path. **Needs human**: one `o` each on an application, a service and a database row with `status.topologyFetched` true (the `/application/`, `/service/`, `/database/` segments are inferred); and a right-click on the bar icon → the instance root |
| runbook 12: hygiene | the rows above | pass |
| runbook 13: budget | the sampling loops | max 31 with a short deployment and the panel open; sustained deploying ≈ 35/min derived from the cadences (2 s deployments, 15 s resources, 120 s servers, ≤ 3 topology); the 60 line holds either way |
| runbook 14: recorded bodies | manual restart and validate | restart body recorded (`action-restart-ok.json`, `_recorded`); the validate 403 body matches the ability regex. **Needs human**: deploy, stop and cancel bodies were not captured (their shapes are proven by the 200s and the API's `cancelled-by-user`) |
| rollback line | `git checkout 29f3a76 -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js && bin/dev-sync && omarchy restart shell` | documented in AGENTS.md; not exercised |
| machine state at the end | `jq .poll config.json`; `stat -c %a`; installed dir vs HEAD; `status.openPanels` | `{4,60,120,600}`; `600`; synced from `520c097`-era files then restarted (the docs-only commits after that do not ship); panel closed (`openPanels 0`). After merge: `bin/dev-sync && omarchy restart shell` once more so the installed copy matches `master` |

Phase 1 human checks touched by this run: "< 60/min with a deployment" closed (max 31); "row within 5 s of queuing / finished within 5 s" observed only at 10 s sampling (≤ 11 s / ≤ 21 s), so the Phase 1 row now states the measured bound rather than a pass; "bar state 12 deploying" closed (`U+F0996` observed). Still open from Phase 1: a real token revoke, mouse hover, multi-monitor, monitor unplug, long-name elision, install from the git URL.

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 0 | STOP if the probe does not prove a `read`-only token | proceeded on Dan's answer that the token already carries `deploy`; the read-only checks became needs-human (runbook 1 a–d) | the user made the call before the run; the destructive Verify steps ran only against the resource he nominated |
| 2 | 2 | `rowRev` edit by anchor | edit by line number | the join separator is a raw U+0001 byte the anchor could not carry |
| 3 | 2 | `actionOutcome(verb, targetType, rec)` | also treats a missing/shape-less `rec` as curl exit 1 | a test helper passed `code 0`, which the trailer grammar rejects; a missing record must never read as success |
| 4 | 3 | Verify with a read-only token: `stop` → ability 403 | `restart` on api → `queued`; `already pending` / `not applicable` / `unknown uuid` as planned; the IPC cool-off not reached | deploy-capable token (deviation 1); restart is the least disruptive verb |
| 5 | 3 | `usage: <verb> <uuid>` for an empty argument | unreachable from the CLI | `omarchy-shell` rejects a missing argument itself ("Too few arguments provided") |
| 6 | 3 | 200 ms `ps` sampler | it did catch the POST: 15 argv lines, all `/usr/bin/curl -q -S -K -` | the first count anchored on `^curl` while `ps -o args=` prints the full path; the record's earlier "caught nothing" was wrong (skeptic F3) |
| 7 | 4 | `Timer { id: confirmArm }` beside the `ConfirmDialog` inside the `KeyboardPanel` | at the Panel root | `KeyboardPanel.contentItem` accepts Items only; the Timer broke Panel.qml's load |
| 8 | 4 | panel Verify ends with "Token lacks the deploy permission" | a real Stop then Start on api | deviation 1 |
| 9 | 5 | stale test via `resourcesSec 3600` | not observed in two runs; needs human with the preconditions stated in runbook 8 | in both runs a panel was open on a monitor for part of the window, which drops the resources interval to 30 s and polls at once (`_catchUp`); the record's first explanation (a `_selfHeal` re-prime every 120 s) was wrong: `_selfHeal` costs one `mkdir` and one `stat` and no request (ops F1, skeptic F4, perf F1) |
| 10 | 5 | Tests-to-add committed as `<slug> tests:` | the last case rode along in the step 5 commit | `git add tests/run.js` in step 5 picked it up |
| 11 | 6 | design.md greps for `hoverColor`/`handleKey` empty | two negated sentences reworded | the plan's grep is literal |
| 12 | record | `docs/plans/<plan basename>.build.md` | `docs/plans/phase-2-act.md` + `.build.md` | the Phase 2 plan file shares the Phase 1 basename; overwriting the Phase 1 record was not an option |
| 13 | isolate | `EnterWorktree` | `git switch -c phase-2-act` in place | `bin/dev-sync` and the dev loop point at this checkout, as in Phase 1 |
| 14 | 3 | clear table: deploy/redeploy/restart with a `deploymentUuid` clear when it is seen | plus: before the response names it, an application entry clears on an active deployment **created for the action** (`createdAt >= since - 5 s`); and once two deployments polls have run since the action without listing the uuid (a deployment shorter than the poll interval) | the first was built broader ("any active deployment of the app") and narrowed after review (security F6, code-reviewer F4, skeptic F5, perf F2a); the second closes the 300 s strand perf F2b found |
| 15 | 3 | stop/start clear when the status **string** changes | the status **state** (prefix) changes | the AGENTS.md status lock; a health blip must not clear a stop (perf F2c) |
| 16 | 3 | a 429 keeps the pending entry | a 429 clears it; only a reap keeps it | Coolify's limiter answers before the action runs (ux F6) |
| 17 | 4 | arm the confirm for `activateRequested` only | a click on Confirm is also gated by the 250 ms arm | a click within 250 ms of the dialog appearing under the pointer is the same accident the arm exists for; a fast deliberate click is dropped silently (code-reviewer F8, kept) |
| 18 | 2 | `origin(url)` = url without a trailing slash | scheme + host + optional path prefix; no query or fragment | built first as bare-host only, relaxed after review (code-reviewer F3) so a self-hosted instance under a path keeps Open |
| 19 | 3 | status-line table | adds "Nothing to <verb>" (a verb that does not apply to the target; reachable from the CLI) and "Too many requests · try again shortly" (the request guard, distinct from a real 429 pause) | ux F3, ux F10; both documented in `docs/design.md` |
| 20 | 4 | "every `omarchy-launch-browser` occurrence … contains `openUrl(` or `instance.url`" | the gate ignores comment lines and requires `Util.execArgv(["omarchy-launch-browser", <one identifier>])` | security F3 (a comment could satisfy the floor; a second argv element passed); a launcher replaced by another binary is outside a grep's reach and is carried by the `fqdn` arm and the `Model.openUrl` tests |

## Review

| member | model | critical | warning | nit | fixed (commits) | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 0 | 5 | 1 | F1 `520c097`; F2 `520c097`; F3 `f2da298`; F4 `1d27db8`; F6 `1d27db8` + deviation 14 | F5: the read-only ability path is needs-human (runbook 1), stated in the PR body |
| code-reviewer | opus | 0 | 6 | 2 | F1 `520c097`; F2 `1d27db8`; F3 `79ed183`; F4 `1d27db8` + deviation 14; F5 `5aa075a`; F6 `5aa075a`; F7 `79ed183` | F8: the click arm is deliberate (deviation 17) |
| skeptic | opus | 0 | 8 | 2 | F1 `5aa075a`; F2 `5aa075a`; F3 record (deviation 6, step 3); F4 record (deviation 9, Noticed); F5 record (deviation 14) + `1d27db8`; F6 `h`×4 and held Escape run live (`q2.png`, `q4.png`), bar right-click needs human; F7 Phase 1 record row restated; F8 `5aa075a`; F10 `5aa075a` | F9: recorded as is (the self-test covered the `fqdn` arm; the call-form arm was tested in the review round) |
| ux-api-designer | opus | 1 | 4 | 5 | F1 `520c097` (`q5.png`); F2 `1d27db8`; F3 `1d27db8` + `5aa075a`; F4 `5aa075a`; F5 `79ed183` + `5aa075a`; F6 `1d27db8`; F8 `520c097`; F9 deviation 14; F10 `1d27db8` | F7: the status line reserving its height is a design change (a permanent blank line under the hero); noted for the next plan |
| ops-analyst | opus | 0 | 4 | 3 | F1 record (deviation 9, runbook 8 preconditions, Noticed); F2 `5aa075a`; F3 Phase 1 record row restated; F4 runbook 1 consolidated (a–d); F5 needs-human rows for the queued cancel and the missing bodies; F6 machine-state row; F7 panel closed, recipe inlined in runbook 1 | — |
| perf-analyst | opus | 0 | 3 | 1 | F1 record (deviation 9, Noticed); F2 `1d27db8` + deviations 14–15; F3 runbook 4/13 wording; F4 `5aa075a` | — |

Panel as in the plan's record (six members; `data-analyst` skipped, no persistence). Reviewers read the plan and the record from the repo rather than inline (same content). Re-check round: pending at the time of writing; the table is updated below the line if anything changes.

## Noticed, not done

- A panel open on any monitor drops the resources interval to 30 s and `_catchUp` polls at once; a deployment drops it to 15 s. Both are documented cadences, but they make any live test of the 150 s / 300 s pending transitions need every monitor's panel closed and no deployment anywhere for five minutes (`Service.qml:97`).
- `omarchy-shell <id> stop` with no argument fails in `omarchy-shell` before the handler; the `usage:` token in `_ipcAct` is dead from the CLI (`Service.qml`).
- `Model.confirmCopy`'s message uses the full resource name; auto-generated application names (`xyhpwdxqu33omjgwuo6c7cjp-200537415987`) make the dialog wide (`p7.png`). A shortened display name is a design question.
- The status line changes the card height for 2.2 s / 6 s per action (`Panel.qml` header `Column`); reserving the line's height would keep the list still (ux F7).
- The `/application/`, `/service/` and `/database/` UI path segments (`Model.js` `UI_SEGMENT`) are inferred; one click each settles them.
- `Service._expirePending`, `act()`, `_refuse` and the panel state machine have no node coverage; a QML test runner would be the next step for the clear rules.

## PR body

```
Phase 2 ("act"): actions, confirm, pending, status line, keyboard map, IPC verbs

Deploy, redeploy without cache, restart, stop, start, cancel, validate and open from the panel, by keyboard or mouse, with a confirm dialog for the destructive ones, an optimistic pending verb that clears per verb, a status line for the outcome, the full keyboard map, and `omarchy-shell io.github.danjonesio.omarify deploy|restart|stop|start <uuid>`. Actions go through the same curl-over-stdin client as polling, never touch the poll error state, and every browser URL is built from the instance origin. Token is now `read` + `deploy` (`write` optional for Validate).

Plan: docs/plans/phase-2-act.md
Steps: 6 step commits, 5 review-fix commits, the plan copy and this record
Verification: bin/check green (68 tests, validate, qmllint); live on Coolify Cloud against api: restart, stop, start, deploy, cancel (cancelled-by-user), validate 403, IPC verbs, server Open, held-Escape and held-Return guards; max 31 req/min with a deployment and the panel open; no token, name or message in the log or argv
Needs human: a read-only token for the "Token lacks the deploy permission" line and the IPC cool-off (no coverage of any kind); a real revoke; the mouse path; a service restart; Open on an application, a service and a database row; the bar-icon right-click; the 150 s / 300 s pending transitions with every panel closed; a queued-deployment cancel; then `bin/dev-sync && omarchy restart shell` so the installed copy matches master
```
