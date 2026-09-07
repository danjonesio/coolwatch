# Build record: Omarify Phase 2 — "act"

Plan: `docs/plans/phase-2-act.md` (copy of `/home/danjones/.claude/plans/greedy-sprouting-quiche.md`, the Phase 2 plan; the Phase 1 plan and record keep the `greedy-sprouting-quiche` basename). Branch `phase-2-act` from base `29f3a76`, head `c74f0e4` at the time of the review. Dan merges.

## Questions resolved

| question | answer | source |
|---|---|---|
| 1. Which resource may the runbook deploy, restart, stop and start? | `api`: the application `xyhpwdxqu33omjgwuo6c7cjp` (project api, environment dev, dockerimage build pack) | user |
| 2. Which application builds slowly enough to cancel mid-build? | the same; a dockerimage deploy queued long enough to cancel (cancel took 2.7 s server-side and returned `cancelled-by-user`) | user |
| 3. Old token after the swap | moot: Dan had already replaced the token with a `read` + `deploy` one before the run ("the key has been updated for this") | user |
| 4. Is Dan's Cloud user an admin/owner? | yes in effect: every call succeeds with the `deploy` token | default (observed) |
| 5. Validate on a token without `write` | shown; demonstrated as "Token lacks the write permission" (real 403 body `{"message":"Missing required permissions: write"}`) | user ("read and deploy") |
| 6. Roadmap acceptance line 1 wording | reworded to "one status sweep plus one resources interval (≤ 90 s with the panel open)" | default |
| 7. Server proxy status / `unreachable_count` | deferred to Phase 4; `docs/product.md`, `docs/design.md`, `docs/roadmap.md` amended | default |
| 8. Status-line 2.2 s / 6 s; pending 150 s / 300 s | as stated; docs updated | default |
| 9. Paste one service and one database UI URL before Change 2 | skipped; verify live in step 11 (server shape verified, application row not clicked: needs human) | user |
| Panel model for the review | opus (named in the ask) | user |

## Audit

Tree at `29f3a76`, `git status --porcelain` empty. Every path in **Changes** exists (`Api.js`, `Model.js`, `Service.qml`, `Panel.qml`, `BarWidget.qml`, `bin/check`, `tests/run.js`, `tests/fixtures/`, `manifest.json`, the six docs, `docs/plans/greedy-sprouting-quiche.build.md`). Two plan citations were off by a line and corrected in the plan file during planning (`Model.js:73` `hasOwnProperty`, `bin/record-fixture:17` deny string). One mismatch found while building: `Model.rowRev`'s join separator is a raw U+0001 byte, not `""`, so the edit was applied by line number. One harness fact: a `Timer` cannot be declared inside `KeyboardPanel`'s content list (`Cannot assign object of type "QQmlTimer" to list property "contentItem"`); the confirm-arm timer lives at the Panel root. No mismatch changed **Design**.

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| 0 | Baselines and the token ability probe | (no code) | idle loops 12 × 10 s; probe `POST /deployments/not-a-uuid…/cancel` | panel closed max `requestsLastMin` 18 (`baseline-closed.log`); panel open max 20 (`baseline-open.log`); probe → `404 {"message":"Deployment not found."}` = the token has `deploy` (Dan confirmed he updated it); the plan's STOP branch was replaced by Dan's answer; `api` resolved to `xyhpwdxqu33omjgwuo6c7cjp` via `GET /resources`, `/projects`, `/projects/{uuid}` |
| 1 | `Api.js` POST blocks and action descriptors | `7075d7f` | `node tests/run.js` | 53 passed, 0 failed (6 new Api cases; the three Phase 1 `Api.config` cases unchanged) |
| 2 | `Model.js` joins, URLs, applicability, copy, pending, outcomes, actions row; 8 fixtures | `43035c9` | `node tests/run.js`; `bin/check --no-shell` | 67 passed, 0 failed; `ok` |
| 3 | `Service.qml` action path | `4be53b7` | `bin/check`; `bin/dev-sync && omarchy restart shell`; IPC on api; `ps` sampler | `ok`; `requestsLastMin` 10 at baseline (log intact); `restart` → `queued restart <uuid>` (200, 218 ms, `result queued`), `stop` same uuid → `already pending <uuid>`, `start` running app → `not applicable start <uuid>`, `stop deadbeef` → `unknown uuid deadbeef` (no request), `stop` (no uuid) → rejected by `omarchy-shell` itself; pending 1 → 0 when the deployment appeared; bar `U+F0996` while deploying; `error null`, `probeMode false`, `actionsLastMin 1`; 200 ms `ps` sampler caught no curl (POST 218 ms; see step 5 for the 50 ms sampler) |
| 4 | `Panel.qml` expansion, strip, keys, confirm, status line, open; `BarWidget.qml` right-click; `bin/check` SR9 gate | `d42f87a` | `bin/check`; gate self-test; `bin/dev-sync && omarchy restart shell`; scripted `wtype` sequence with `grim` screenshots | `ok`; the gate fails closed on a probe line passing `r.fqdn` to the launcher; Return → strip Deploy · Redeploy · Restart · Stop with the first button ringed and the row painted `current`; `l`×3 → Stop ringed; Return → "Stop <name>?" with Cancel selected; `d x r g Tab` → nothing (`requestsLastMin` 17 → 17, dialog up); Esc → dialog gone, row expanded; Esc → collapsed; Esc → closed (`openPanels 0`); two Returns 50 ms apart on Stop leave the dialog open (pending 0, actionsLastMin 0); real Stop → "Stop requested", `stopping…` in accent with the half glyph, 200 in 163 ms, pending cleared at +30 s on the resources poll; `s` → "Start requested", 200 in 226 ms, `result queued`, cleared at +50 s when its deployment appeared; `requestsLastMin` max 26 (screenshots `p6 p7 p8 p10 p11 p12` in the scratch dir) |
| 5 | Live acceptance runbook | `c55bc81` (recorded restart fixture) | the 14 runbook items | see Verification; the recorded `POST /applications/{uuid}/restart` body replaced the hand-written `action-restart-ok.json` through `bin/record-fixture`'s scrubber (`_recorded`); the GLYPHS test case rode along in this commit's `tests/run.js` add |
| 6 | Reconcile the docs; version 0.2.0 | `2fd90f1` | the six greps; `bin/check --no-shell` | all empty (two negated mentions of the old property names reworded so the literal grep is clean); `0.2.0`; `ok` |
| — | plan copy | `c74f0e4` | — | `docs/plans/phase-2-act.md` |

## Tests

| case | covers | file | commit |
|---|---|---|---|
| Api.block GET output byte-identical for every Phase 1 descriptor | SR1 | `tests/run.js` | `7075d7f` |
| Api.block POST shape: one request, one Content-Type, one constant data-raw, all nine GET lines | SR1 | `tests/run.js` | `7075d7f` |
| Api.config: two GETs around one POST carry request once; no location anywhere | SR1, SR2 | `tests/run.js` | `7075d7f` |
| Api.block / Api.config reject unknown and prototype methods with null | SR1 | `tests/run.js` | `7075d7f` |
| Api.reqDeploy hostile uuid percent-encoded; force only when true; one url line | SR1 | `tests/run.js` | `7075d7f` |
| Api.reqLifecycle / reqCancel / reqValidate families and verbs; unknown or prototype kind and verb null | SR3 | `tests/run.js` | `7075d7f` |
| Model.environmentsOf keeps uuid; applyJoins carries environmentUuid | joins | `tests/run.js` | `43035c9` |
| Model.openUrl deployment joins the relative deployment_url; hostile values yield empty | SR9 | `tests/run.js` | `43035c9` |
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
| Model.footerHints: every cursor position; no o open without a url | footer | `tests/run.js` | `43035c9` |
| Model.GLYPHS: the pending dot and every glyph a pending row can emit are in the allowlist | glyphs | `tests/run.js` | `c55bc81` |

`node tests/run.js` → 68 passed, 0 failed (47 Phase 1 cases untouched except the rewritten two-argument `footerHints` case).

## Verification

| check | command or action | result |
|---|---|---|
| `bin/check` | full | `ok` (68 tests, symlink scan, fixture secrets, PlainText and font parity, literal grep, SR9 gate, staged validate, qmllint) |
| `bin/check --no-shell` | CI subset | `ok` |
| `status` shape | `omarchy-shell … status \| jq '{lastAction, pending, pendingStale, actionsLastMin, requestsLastMin, error, probeMode}'` | `{"lastAction":{"verb":"start","uuid8":"xyhpwdxq","code":200,"curlExit":0,"ms":237,"at":…,"result":"queued"},"pending":0,"pendingStale":0,"actionsLastMin":0,"requestsLastMin":26,"error":null,"probeMode":false}` |
| token never in the log | `quickshell log … \| grep -cFf <(needle)` | 0 |
| resource names and Coolify messages never in the log | `grep -ciE 'storefront\|umami-prod\|uptime-kuma\|authentik\|api'`; `grep -ciE 'Deployment request queued\|stopping request\|Missing required'` | 0; 0 |
| argv during a POST | 50 ms `ps` sampler around a manual `POST …/restart` | 6 curl lines, all `curl -q -S -K -`; token 0; verb/path/uuid 0 |
| runbook 1: ability 403 from the panel on a read-only token | — | needs human: create a `read`-only token, swap it in with the `--rawfile` recipe, press `d` on any application: the status line must read exactly "Token lacks the deploy permission" and `status` must show `error null`, `probeMode false`; also `s` and `x`; three IPC `stop`s then read `refused: token lacks the deploy permission` with `requestsLastMin` unchanged |
| runbook 2: token swap + real revoke | — | needs human (Dan swapped the token before the run): delete a token in Coolify and watch "TOKEN REJECTED" within 5 s, then write the new one with the `--rawfile` recipe |
| runbook 3: `write` 403 | `v` on the server row | pass: "Token lacks the write permission" (403, 131 ms), `error null`, `probeMode false`, bar unchanged (`p18.png`) |
| runbook 4: deploy from the keyboard + 18-sample loop | `d` on api | pass: "Deployment queued"; `deploying…` on the keystroke; `counts.deployments` 0 → 1 between the t=0 and t=11 s samples; pending 1 → 0 at that moment; bar `U+F0996` while building; `counts.recent` incremented by the t=21 s sample; max `requestsLastMin` 31 (`p23.png`) |
| runbook 5: restart | IPC `restart` (step 3) and a manual restart (step 5) | pass: "queued restart", a `restart_only` deployment appeared, pending cleared when it did |
| runbook 6: stop then start | keyboard (step 4) | pass for the keyboard path (see step 4); the mouse path (click Stop, click Confirm, hover moving the cursor) needs human |
| runbook 7: service restart | — | needs human: `t` on a service or database Dan nominates (only api, an application, was nominated) |
| runbook 8: stale note | v1: `resourcesSec 3600`, panel closed, IPC `stop` | not observed: pending cleared at +46 s because the servers tick's `_selfHeal` calls `_prime("all")` every 120 s (Phase 1 behaviour), so the panel-closed resources interval is really ≤ 120 s; v2 with `serversSec 3600` too (`stale2.log`): a panel was opened during the wait (`openPanels 1`; `panelOpened` primes a resources poll), pending cleared at +30 s; the 150 s / 300 s transitions remain unobserved live and rest on `_expirePending`'s code and the `pendingVerb` unit test. Needs human: with the panel closed and both intervals at 3600, `stop` a nominated resource over IPC and watch `status \| jq '{pending, pendingStale}'` read `1,1` at 150 s and `0,0` at 300 s |
| runbook 9: cancel | `d` then `x` on the deployment row → confirm | pass: "Cancel the deployment of <name>?", cancel 200 in 2689 ms, row "· cancelling…" with the cancelled glyph (`p21.png`), `GET /deployments/applications/<uuid>?take=1` → `cancelled-by-user`; a cancel on a still-`queued` deployment was not exercised (dockerimage deploys leave the queue in seconds) |
| runbook 10: IPC | step 3's sequence | pass |
| runbook 11: Open | `o` on the server row | pass for servers: Brave opened "hetzner-1 \| Server \| Coolify"; deployment rows carry Coolify's own relative path; the application, service and database page shapes need human (one `o` each, with `status.topologyFetched` true) |
| runbook 12: hygiene | see the rows above | pass |
| runbook 13: budget | the sampling loops | max `requestsLastMin` 31 with a deployment running and the panel open (< 60) |
| runbook 14: recorded bodies | manual restart and validate | restart body recorded (`action-restart-ok.json`, `_recorded`); the validate 403 body matches the ability regex; the deploy/stop/cancel bodies were not captured (their shapes are proven by the 200s and the API's `cancelled-by-user`) |
| rollback line | `git checkout 29f3a76 -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js && bin/dev-sync && omarchy restart shell` | documented in AGENTS.md; not exercised |

Phase 1 human checks closed by this run: "< 60/min with a deployment; row within ~10 s of queuing; finished into recent" (marked in the Phase 1 record); "bar state 12 deploying" (`U+F0996` observed). Still open from Phase 1: a real token revoke, mouse hover, multi-monitor, monitor unplug, long-name elision, install from the git URL.

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 0 | STOP if the probe does not prove a `read`-only token | proceeded on Dan's answer that the token already carries `deploy`; the read-only checks became needs-human | the user made the call; the destructive Verify steps were run against the resource he nominated |
| 2 | 2 | `rowRev` edit by anchor | edit by line number | the join separator is a raw U+0001 byte the anchor could not carry |
| 3 | 2 | `actionOutcome(verb, targetType, rec)` | also treats a missing/shape-less `rec` as curl exit 1 | a test helper passed `code 0`, which the trailer grammar rejects; a missing record must never read as success |
| 4 | 3 | Verify with a read-only token: `stop` → ability 403 | `restart` on api → `queued`; `already pending` / `not applicable` / `unknown uuid` as planned; the IPC cool-off not reached | deploy-capable token (deviation 1); restart is the least disruptive verb |
| 5 | 3 | `usage: <verb> <uuid>` for an empty argument | unreachable from the CLI | `omarchy-shell` rejects a missing argument itself ("Too few arguments provided") |
| 6 | 3 | 200 ms `ps` sampler | the 200 ms sampler caught nothing (POST 218 ms); a 50 ms sampler in step 5 caught six lines | timing |
| 7 | 4 | `Timer { id: confirmArm }` beside the `ConfirmDialog` inside the `KeyboardPanel` | at the Panel root | `KeyboardPanel.contentItem` accepts Items only; the Timer broke Panel.qml's load |
| 8 | 4 | panel Verify ends with "Token lacks the deploy permission" | a real Stop then Start on api | deviation 1 |
| 9 | 5 | stale test via `resourcesSec 3600` | v1 not observable (`_selfHeal` re-primes every 120 s); v2 with `serversSec 3600` was interrupted by a panel open; the stale note stays needs-human | Phase 1's self-heal and panel-open primes were not in the plan's arithmetic |
| 10 | 5 | Tests-to-add committed as `<slug> tests:` | the last case rode along in the step 5 commit | `git add tests/run.js` in step 5 picked it up; no separate commit was possible without an empty diff |
| 11 | 6 | design.md greps for `hoverColor`/`handleKey` empty | two negated sentences reworded | the plan's grep is literal |
| 12 | record | `docs/plans/<plan basename>.build.md` | `docs/plans/phase-2-act.md` + `.build.md` | the Phase 2 plan file shares the Phase 1 basename; overwriting the Phase 1 record was not an option |
| 13 | isolate | `EnterWorktree` | `git switch -c phase-2-act` in place | `bin/dev-sync` and the dev loop point at this checkout, as in Phase 1 |

## Review

(pending: security-analyst, code-reviewer, skeptic, ux-api-designer, ops-analyst, perf-analyst on opus)

## Noticed, not done

- `Service.qml` `_applyStat` ends with `_prime("all")`, and `_selfHeal` runs it on every servers tick, so every kind is polled at least every 120 s regardless of its configured interval; the budget still holds, but the documented cadences are upper bounds only.
- `omarchy-shell <id> stop` with no argument fails in `omarchy-shell` before the handler; the `usage:` token in `_ipcAct` is dead from the CLI (`Service.qml`).
- `Model.confirmCopy`'s message uses the full resource name; auto-generated application names (`xyhpwdxqu33omjgwuo6c7cjp-200537415987`) make the dialog wide (`p7.png`). A shortened display name for such names is a design question.
- The resource-row Open for applications, services and databases is inferred and unverified (`Model.js` `UI_SEGMENT`); one click each with topology fetched settles it.

## PR body

```
Phase 2 ("act"): actions, confirm, pending, status line, keyboard map, IPC verbs

Deploy, redeploy without cache, restart, stop, start, cancel, validate and open from the panel, by keyboard or mouse, with a confirm dialog for the destructive ones, an optimistic pending verb that clears per verb, a status line for the outcome, the full keyboard map, and `omarchy-shell io.github.danjonesio.omarify deploy|restart|stop|start <uuid>`. Actions go through the same curl-over-stdin client as polling, never touch the poll error state, and every browser URL is built from the instance origin. Token is now `read` + `deploy` (`write` optional for Validate).

Plan: docs/plans/phase-2-act.md
Steps: 6 step commits plus the plan copy and this record
Verification: bin/check green (68 tests, validate, qmllint); live on Coolify Cloud against api: restart, stop, start, deploy, cancel (cancelled-by-user), validate 403, IPC verbs, server Open; max 31 req/min with a deployment and the panel open; no token, name or message in the log or argv
Needs human: a read-only token for the "Token lacks the deploy permission" line and the IPC cool-off; a real revoke; the mouse path; a service restart; Open on an application, a service and a database row; the stale note (see the record)
```
