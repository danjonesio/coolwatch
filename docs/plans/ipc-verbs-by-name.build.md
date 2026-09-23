# Build record: IPC verbs by name

Plan: `docs/plans/ipc-verbs-by-name.md` (copied from `~/.claude/plans/stateful-conjuring-ripple.md`). Branch `ipc-verbs-by-name` from base `13303b9` (`develop`), head `3d51817` (the record commit follows it). PR into `develop`; Dan merges.

## Questions resolved

| question | answer | source |
|---|---|---|
| `unknown uuid` for a uuid-shaped miss, `unknown name` otherwise? | yes, as designed (`UUID_SHAPED_RE`) | default |
| list candidate uuids on `ambiguous name`? | no, bare token | default |
| servers by name? | no, resources only | default |
| do two resources on Dan's Coolify share a label? | not the one used: `xyhpwdxq` resolved on the first try | live check 4(a) |

## Audit

Run against `13303b9` (the tree the plan was written against, unchanged). Every path in Changes exists; every cited line matched (`Service.qml:517-524`, `:1586-1587`, `:1603`, `:1629`, `:1647`, `:560-563`; `Model.js:1566`; `tests/run.js:1522`; README `:170`, `:179-181`; `docs/architecture.md:39-47`, `:539`, `:566`, `:622-624`, `:701`; `docs/design.md:356`; `docs/development.md:174`, `:285`, `:19-20`). PR #16 (`roadmap-duration-done`) was still open at build time (`gh pr view 16` → OPEN), so step 5 was skipped per the plan's note. `git status --porcelain` empty before the branch.

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| 0 | plan copy first | 0b9cf1a | `ls docs/plans/ipc-verbs-by-name.md`; `bin/check --no-shell` | present; ok |
| 1 | `Model.js` resolver + test table | 1b9fb6a | `node tests/run.js`; `git diff -U0 Model.js \| grep -c '^@@'`; `grep -ac resolveActionTarget tests/run.js` | 146 passed, 0 failed; 1; 2 |
| 2 | `Service.qml` one unit | 33c3c81 | `bin/check`; one `resolveActionTarget` call (`:1594`); awk gate-order → 1; `"queued"` grep; `unknown name\|ambiguous name` grep; `_ipcAct` `slice(0, 8)` count; handler signatures | ok; one call; 1; `:704`, `:1682` plus `:523` (see deviation 1); both only in `_refuse`; 0; four `target: string`, `log(uuid: string)` |
| 3 | docs | 57f8614 | token grep → 3 files; `more than one resource` → 1 line; `resolveActionTarget` in architecture.md ≥ 2; `bin/check --no-shell`; `git diff --stat develop` | 3; 1; 3; ok; the eight named files, nothing else |
| 4 | live check | (no commit) | see Verification | (a)–(f) pass; panel-pending row needs human |
| 5 | roadmap | skipped | `gh pr view 16` → OPEN | not done per the plan's note; `docs/roadmap.md` untouched |

## Tests

All cases live in one `test("Model.resolveActionTarget: …")` at `tests/run.js` after the `actionRequest` gate test (commit 1b9fb6a); each group's comment names the requirement.

| case | covers | file | commit |
|---|---|---|---|
| label / case / whitespace (`storefront`, `STOREFRONT`, `  storefront `, `Storefront  Prod  WP`, `storefront prod wp`) | design | tests/run.js | 1b9fb6a |
| generated and decorated raw names (`xyhpwdxq`, raw generated name, `storefront:main-<uuid>`) | design | tests/run.js | 1b9fb6a |
| 41-char name by full text; 31-char collision → `ambiguousname` | risk (decision) | tests/run.js | 1b9fb6a |
| uuid-first: a resource named `APP` beside the real `APP` | requirement 3 | tests/run.js | 1b9fb6a |
| uuid pass over resources, deployments, servers, tags | design | tests/run.js | 1b9fb6a |
| resources only: `storefront` not ambiguous while building; `worker`, `hetzner-1`, `production-landing`, `canary` → `unknownname` | requirements 4, 5 (SR35) | tests/run.js | 1b9fb6a |
| no prefix (`storefron`, `h0wx`, `xyhpwdx`) | design | tests/run.js | 1b9fb6a |
| uuid-shaped miss → `unknown`; `storefrnt` → `unknownname` | requirement 9 | tests/run.js | 1b9fb6a |
| ambiguity: two branches; `api`/`API`/`Api`; duplicate row → one hit | requirement 6 | tests/run.js | 1b9fb6a |
| hostile uuid row (the load-bearing case: fails if the row guard is dropped) | requirement 2 (SR15) | tests/run.js | 1b9fb6a |
| null and numeric uuid rows are invisible | requirement 2 (review: security-analyst 3) | tests/run.js | b52990b |
| empty row + `":x-" + 20 a`; `""` → `unknownname` (bounds; not load-bearing for requirement 2) | requirement 7 | tests/run.js | 1b9fb6a |
| a resource named after an unheld uuid → `unknown`; a 25-lowercase-letter label → `unknown`; its own uuid → `by: "uuid"` | requirement 9 (review: security-analyst 2; decision) | tests/run.js | b52990b |
| `" "`, 65 chars, `undefined` snapshot, `snap()` without tags, `[null]` row | requirement 7 | tests/run.js | 1b9fb6a |
| key shapes `ok,uuid,by` / `ok,why` | requirement 1 | tests/run.js | 1b9fb6a |
| unchanged: `actionRequest` gate, nav/tag arm, `appLabel` | requirement 10 | tests/run.js (`:1499-1522`, `:2119-2133`, `:597-605`, unedited) | — |

## Verification

| check | command or action | result |
|---|---|---|
| node tests | `node tests/run.js` | 146 passed, 0 failed |
| CI gate | `bin/check --no-shell` | ok |
| full gate | `bin/check` | ok (qmllint, validate) |
| dev loop | `bin/dev-sync && omarchy restart shell` | shell up; `status` → `{"r":6,"b":true,"i":"cloud"}` on the first poll |
| 4(a) label | `omarchy-shell $ID deploy xyhpwdxq` | `queued deploy xyhpwdxqu33omjgwuo6c7cjp`; `lastAction` `{"verb":"redeploy","uuid8":"xyhpwdxq","code":200,…,"result":"queued","instance":"cloud"}`; `pending: 1` |
| 4(a) panel shows the row pending | open the panel while the deploy runs | needs human (the run did not drive the desktop) |
| 4(b) upper-cased label | `omarchy-shell $ID deploy XYHPWDXQ` | `already pending xyhpwdxqu33omjgwuo6c7cjp` |
| 4(c) name miss | `omarchy-shell $ID deploy no-such-thing-here` | `unknown name no-such-thing-here`; `lastAction.uuid8 ""`, `result "refused"` |
| 4(d) uuid path | `omarchy-shell $ID deploy xyhpwdxqu33omjgwuo6c7cjp` | `queued deploy xyhpwdxqu33omjgwuo6c7cjp` (the first deploy had finished; a second deploy of the test app ran) |
| 4(d) uuid-shaped miss | `omarchy-shell $ID deploy zzzzzzzzzzzzzzzzzzzzzzzz` | `unknown uuid zzzzzzzzzzzzzzzzzzzzzzzz`; `lastAction.uuid8 "zzzzzzzz"` (today's arm) |
| 4(e) usage | `omarchy-shell $ID deploy ""` | `usage: deploy <uuid|name>` (with no argument at all, Quickshell's IPC layer refuses first: "Too few arguments provided"; see deviation 2) |
| 4(f) log | `quickshell log … \| grep 'coolwatch ipc\|coolwatch action refuse'` | the distinct lines seen, one per outcome (every call logs one `ipc` line and, on a refusal, one `action refuse` line): `coolwatch action refuse unknownname deploy -`, `coolwatch ipc deploy - -> unknown`, `coolwatch action refuse unknown deploy zzzzzzzz`, `coolwatch action launch redeploy xyhpwdxq ipc`, `coolwatch ipc deploy xyhpwdxq -> queued`, `coolwatch action refuse already pending redeploy xyhpwdxq`, `coolwatch ipc deploy - -> already`; no label text; no coolwatch `WARN` (two `WARN` lines present are the portal and the `io.github.danjonesio.github` plugin) |
| re-run on the review head (after c4ba42d, b52990b) | `bin/dev-sync && omarchy restart shell`; `deploy no-such-thing-here`; `deploy zzzzzzzzzzzzzzzzzzzzzzzz`; `start XYHPWDXQ` | `unknown name no-such-thing-here` (`uuid8 ""`); `unknown uuid zzzzzzzzzzzzzzzzzzzzzzzz`; `not applicable start xyhpwdxqu33omjgwuo6c7cjp` (`lastAction` `{"verb":"start","uuid8":"xyhpwdxq",…,"result":"refused"}`: a label resolved, then the verb did not apply); log `coolwatch action refuse notapplicable start xyhpwdxq`, `coolwatch ipc start - -> not` |

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 2 | Verify: `grep -n '"queued"' Service.qml` lists only the deployment-status and `lastAction.result` sites | the grep also lists `:523`, `_ipcAct`'s `parts[0] === "queued"` | that comparison is the plan's own Interfaces code; the Verify's intent (no reader of the bare `"queued"` return) holds: `ctx.act` returns `"queued " + a.uuid` and `_ipcAct` splits it |
| 2 | 4(e) | `omarchy-shell $ID deploy` → `usage: deploy <uuid\|name>` | run as `omarchy-shell $ID deploy ""` | Quickshell's `IpcHandler` refuses a missing argument before the plugin runs ("Too few arguments provided (1 required but 0 were provided.)"); the usage line is reachable only with an empty string, as it was before this change |
| 3 | 2 | the `ctx.act` comment reads "…keep winning over unknown name" | "…keep winning over a name miss" | the Verify grep for `unknown name` must find only `_refuse`'s arms |
| 4 | 2 (review) | the five readiness refusals pass `uuid` to `_refuse` | they pass `""` when `fromIpc` (c4ba42d) | requirement 1 in full: an IPC argument is unvouched before resolution, so a gate refusal of a by-name call must not slice the name into `lastAction.uuid8` or the log; `lastAction.uuid8` is now `""` for any IPC refusal before resolution, including a uuid argument (the store was never consulted) |
| 5 | 1 (review) | the name pass runs for every non-held argument; the `UUID_SHAPED_RE` discriminator only picks the miss token | the name pass short-circuits on `UUID_SHAPED_RE` (b52990b) | the plan's prose and README sentence promise `unknown uuid` for a uuid-shaped miss; without the short-circuit a resource named after a deleted uuid would capture a script's by-uuid call. Cost: a label of 20+ lowercase alphanumerics is uuid-only (documented in README and architecture) |
| 6 | 1 (review) | row guard `UUID_RE.test(r.uuid)`; `if (want)` guard | `typeof r.uuid === "string" && UUID_RE.test(r.uuid)`; the `if (want)` guard removed (b52990b) | the regex test coerces non-strings; the `want` guard was dead (mutation-tested by the code-reviewer) |
| 7 | 3 (review) | `README.md:170`'s comment aligned with the block | one space before `#` (column 84; the others sit at 80–81) | `<uuid\|name>` makes the text end at column 83 |

## Review

| member | model | critical | warning | nit | fixed (commits) | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 0 | 3 | 0 | 3 (c4ba42d, b52990b, d0f6291) | — |
| code-reviewer | opus | 1 | 1 | 0 | 2 (c4ba42d, b52990b) | — |
| skeptic | opus | 0 | 1 | 1 | 2 (c4ba42d; the record head filled at commit) | — |
| ux-api-designer | opus | 0 | 0 | 5 | 5 (d0f6291; nit 4 in this record's 4(f) row) | — (nit 1 taken as one space: the old column is unreachable) |
| re-check (all four resumed) | opus | 0 | 0 | 2 | 3d51817 (ux-api-designer 6 and security-analyst's re-check nit: the two `uuid8` sentences over-claimed for a uuid-shaped miss; ux-api-designer 5 restated: IPC paragraph reflowed) | — ; every original finding reported `resolved` |

The critical (code-reviewer 1) was the same gate-refusal slice security-analyst 1 and skeptic 1 reported as warnings. Default panel plus ux-api-designer (the plan's situational member); no trimming.

## Noticed, not done

- `Panel.qml:631` of the sibling plugin `io.github.danjonesio.github` logs `TypeError: Cannot read property 'name' of undefined` on shell start (another repo).
- `_refuse`'s `[\r\n\t]`→space bound does not strip other control characters from the echoed argument (`Service.qml`, pre-existing on `unknown uuid <arg>`; plan Out of scope).
- The `omarchy-shell` wrapper prints Quickshell's own "Too few arguments" text for a bare `deploy`; a README reader may expect the plugin's usage line (pre-existing).
- `UUID_SHAPED_RE` is lowercase-only like `appLabel`'s runs, so `deploy H0WXYG40KC0LZ727DOM9L03I` reads `unknown name`; it matters only if Coolify ever emits a non-lowercase uuid (ux-api-designer).
- A live check of the readiness gates with a by-name argument needs a scratch instance in Dan's real config (plan: rejected); the `unresolved` handoff in `ctx.act` is the evidence.

## PR body

```
IPC verbs by name

`omarchy-shell io.github.danjonesio.coolwatch deploy <name>` now resolves the label the panel shows (an application, service or database on the active instance) and echoes `queued deploy <uuid>`; `restart`, `stop`, `start` likewise. A name nothing has answers `unknown name <name>`, a name two things have answers `ambiguous name <name>`; a uuid-shaped argument the store does not hold still answers `unknown uuid <uuid>`, and a uuid in the store takes exactly today's path. Resolution is a pure `Model.resolveActionTarget` in front of the untouched `actionRequest` gate (uuid first over every list, then the label over resources only, exact then case-folded), called inside `ctx.act` after the readiness gates so `not configured` / `token rejected` / `rate limited` keep winning. No new request, no new state; log lines and `status.lastAction` carry the resolved uuid8 or nothing.

Plan: docs/plans/ipc-verbs-by-name.md
Steps: 4 commits, one per plan step (step 5, the roadmap done-line, waits for PR #16), plus 4 review-fix commits and the record
Verification: node tests 146/146, bin/check ok, live IPC echoes (a)–(f) as the plan prints them, re-run on the review head
Needs human: open the panel during a `deploy <name>` and see the row pending; roadmap done-line once #16 merges
```
