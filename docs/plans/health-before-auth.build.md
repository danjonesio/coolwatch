# Build record: Health check before auth

Plan: `docs/plans/health-before-auth.md` (the approved plan, copied from `~/.claude/plans/stateful-conjuring-ripple.md`). Branch `health-before-auth` from base `dd44109` (origin/develop); head is the build-record commit that follows `8ea0993`. PR into `develop`; Dan merges. Commit subjects were reworded once by a message-only rebase (tree identical) so the first commit carries the user-visible sentence the release checklist reads from `git log`; every SHA below is post-rebase.

## Questions resolved

| question | answer | source |
|---|---|---|
| Edit config button on the `down` bodies that name the file? | no; the body names the file, the footer cog opens it | default |
| Swap the probe-mode probe to `reqVersion`? | not here | default |
| Does an API-disabled self-hosted Coolify still answer `/api/v1/health`? | irrelevant: `apidisabled` is never overridden, and since the review it is never probed either | default |
| Is `/api/v1/health` on the 1000/min limiter? | assumed the 200/min bucket; charged by `_noteRequest`, headers never write `rateLimitRemaining` | default |
| Panel model for the review | `opus` (the tool's closest alias to "opus 5.5") | user |

## Audit

`git status --porcelain` empty on `backlog`; switched to `health-before-auth` from `origin/develop` (dd44109). Every path in Changes exists; `docs/development.md` (not `AGENTS.md`) and `CHANGELOG.md` present as the plan's builder note says; line anchors held (code identical to the panel's checkout apart from comment text). Baseline `node tests/run.js`: 136 passed. PR #10 (the roadmap backlog) still open, so the roadmap edit is skipped as the plan says.

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| 0 | `_dispatch` returns a boolean and `anyOk` follows it | c063653 | `bin/check`; `sed 's#//.*##' Service.qml \| grep -c 'if (ctx._dispatch('` / `'anyOk = true'` | ok, 136 passed; 1 / 1. Live: see Verification (both sessions) |
| 1 | `reqHealth` and the one unauthenticated block | f854583 | `node tests/run.js`; `grep -c Authorization Api.js` | 138 passed; 1 |
| 2 | `parseHealth`, `healthResult`, `healthWanted`, `errorWithHealth` | 9948d73 | `node tests/run.js` | 142 passed |
| 3 | the `down` kind, copy, bar row, chip word | 6e23da0 | `node tests/run.js`; `bin/check --no-shell` | 143 passed; ok |
| 4 | `healthReq`, the probe gate, the render-time verdict | 7acfb93 | `bin/check`; live session 1 | ok; see Verification |
| 5 | SR40 gate in `bin/check` | 6ee4da0 | `bin/check --no-shell`; the gate grep on a widened literal | ok; 0. Note: a widened copy under `COOLWATCH_ROOT` fails at `node tests/run.js` first (three Api tests), so the SR40 message itself was shown by mutation of the conditional line instead (security review: "found 0") |
| 6 | `bin/record-fixture` text branch | 51e34e7 | `shellcheck`; `bin/record-fixture health-ok /health` | clean; wrote `OK\n`, identical to the hand-written file |
| 7 | `tests/fixtures/health-ok.txt` | 9948d73 (in step 2) | `bin/check --no-shell` | ok |
| 8 | `docs/architecture.md` | fc87900 | `grep -n down`; `grep -n SR40` | 12 sites; register item 42 |
| 9 | `docs/design.md` | 2ab3777 | read back; `bin/check --no-shell` | ok |
| 10 | `docs/development.md` (roadmap skipped) | b09e412 | `bin/check --no-shell`; `git diff --stat` | ok; only module-map files |

## Tests

| case | covers | file | commit |
|---|---|---|---|
| health block byte-identical minus Authorization, token-independent, no Bearer, no token text, no location, non-GET null | SR 1, 2, 11 | `tests/run.js` "Api.reqHealth block…" | f854583 |
| five-for-six header count; extended descriptor list (five Phase 4 GETs) | SR 2 | "Api.config: every poll descriptor…" and the byte-identical test | f854583 |
| `parseHealth`: OK, fixture, 2 MB HTML capped, null | SR 3 | "Model.parseHealth…" | 9948d73 |
| `healthResult`: twelve record shapes, numbers only | SR 5 | "Model.healthResult…" | 9948d73 |
| `healthWanted` over every META kind, exit 0 and 7, not-JSON 200 | SR 5 | "Model.healthWanted…" | 9948d73 |
| `errorWithHealth` matrix, absent asymmetry, fields copied, stale OK (40 s) vs inside the floor (20 s), not-JSON pairs, nulls | SR 5 | "Model.errorWithHealth…" | 9948d73, 8ea0993 |
| scenarios: proxy 502, proxy 401, path typo 302, non-Coolify 404 and HTML, HTML login page beside a 401, revoked token, API disabled, older Coolify, health timeout, partial http, `http`+ok built by `errorFor` with and without a message, not-JSON+ok, stale vs in-floor OK, staleness after rewrite | SR 5, 6, 7 | "Model: the health scenarios end to end…" | 6e23da0, f88cd44, 8ea0993 |
| `barState` down row (with/without code), 16 rows, dimmed loop over META | SR 6 | "Model.barState: all 16 rows…", scenarios test | 6e23da0 |
| `instanceTroubleOf("down")`, `instanceTrouble` suffix | SR 6 | scenarios test | 6e23da0 |
| `calloutEditable` false for down; not-editable list as complement of `EDITABLE_ERRORS`; heroMeta and callout lists from META | SR 6, 7 | "Model.heroMeta…", "Model.callout: every…", scenarios test | 6e23da0 |
| every down health state has a body (15 code/exit pairs incl. codeless and 2xx); offline body names the host, generic word without a url | SR 3 | scenarios test | 6e23da0, f88cd44 |

## Verification

| check | command or action | result |
|---|---|---|
| tests | `node tests/run.js` | 143 passed, 0 failed (at head) |
| CI subset | `bin/check --no-shell` | ok |
| full check | `bin/check` (qmllint, validate) | ok (steps 0, 4 and every review commit) |
| installed copy | `bin/dev-sync && omarchy restart shell`; `diff` of Service.qml, Model.js, Api.js against the installed dir | identical to head (synced after 8ea0993) |
| session 1, wrong URL | second entry `bad`, url `https://app.coolify.io/nope`, real token; restart 22:54:12; `status \| jq` at 22:54:22 | bad: error `{down, resources, 302, 0}`, health `{fail, 302, 0}`, probeMode false, backoffUntil set, topologyFetched false; cloud: health unknown, no perKind.health |
| session 1, request count | jq at 22:55:16 | bad 3, cloud 8. This read was at t+64 s: a rolling 60 s window that had already dropped the token-ready burst, so it does not bound the first minute (skeptic 2); see session 2 |
| session 1, revoked token | bad url → real origin, token → garbage; jq at 22:55:32 | error auth 401, health ok 200, probeMode true; log `bad/health ok http=200 exit=0` |
| session 1, recovery | token restored 22:55:52; jq at 22:56:46 and 20 s later | error null, health unknown, probeMode false; `perKind.health.lastAt` unchanged across the two reads |
| session 2, first minute (after the review fixes) | restart 23:13:28 with the `bad` entry; jq at 23:14:18 (t+50 s) | bad requestsLastMin **7** (plan predicted about 7; the pre-fix figure is about 49), error down 302, health fail 302, probeMode false, backoffUntil set, topologyFetched false, `bar {glyph U+F0164, dimmed true, active false}`; cloud 10, bar U+F015F not dimmed |
| session 2, revoked token across probe ticks | garbage token at 23:14:18; jq at t+12 s, t+80 s, t+140 s | t+12: auth, health ok, probeMode true, bar U+F09E0 dimmed. t+80 (one probe tick): auth, health ok, `health.at` advanced to 23:15:19 (the tick's 401 triggered a fresh probe, 81 ms, 2 B). t+140: auth, health ok, `health.at` still 23:15:19: the panel was opened twice in between (log: `tags view failed` and two four-kind bursts), each re-priming every kind and restarting the probe timer, and the 30 s floor refused a re-probe. With the strict rule the annotated body would have dropped there; 8ea0993 tolerates the floor |
| session 2, config restored | 23:16:39 | `.instances` back to `["cloud"]`; healthy instance reads error null, health unknown |
| documented jq lines | the two lines added to `docs/development.md` | run as written after each restore: cloud ok, health unknown |
| health log lines | `quickshell log … \| grep -E 'coolwatch [A-Za-z0-9_-]+/health '` | session 1: 3 fail + 1 ok lines across about 2 minutes; session 2: 2 fail + 2 ok across 3 minutes. The lines carry no timestamp, so the per-minute ceiling is evidenced by `_probeHealth`'s floor and `perKind.health.lastAt`, not by the grep |
| callout bodies in the panel | needs human: with a wrong-URL entry read "app.coolify.io redirected Coolify's health check (302)…" under "Coolify not responding"; with a garbage token read "Coolify is up and rejected this token…" with Edit config visible, and again after a probe tick and a panel open. The strings are asserted in the scenarios test; `status.bar` above shows the glyph and dimming | needs human |
| 502 and proxy-401 rows; reaper arm; a 404 (`absent`) health answer | needs human: no such front door or older Coolify to hand; covered by node tests only | needs human |

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 2 / 7 | fixture written in step 7 | `tests/fixtures/health-ok.txt` committed in step 2 (9948d73), then re-recorded through `bin/record-fixture` in step 6 with identical bytes | step 2's ok test reads it |
| 2 | 10 | edit `docs/roadmap.md` if PR #10 merged | not edited | PR #10 still open at build time |
| 3 | record | build record beside the plan file | plan copied to `docs/plans/health-before-auth.md`, record at `docs/plans/health-before-auth.build.md`, both committed | the plan lived under `~/.claude/plans`; the repo's convention is the committed `docs/plans/<name>.md` + `.build.md` pair, and `docs/development.md` and `tests/run.js` cite the path |
| 4 | 1 | `grep -c Authorization Api.js` is 1 | a comment reworded to "bearer-token header" | the first wording made the count 2 |
| 5 | 0 / 5 | step 0's two greps land in `bin/check` in step 5 | they landed in step 0's commit (c063653) as SR40 part 1; step 5 added part 2 | step 0's Verify line is those greps, so they were written with the change they pin |
| 6 | 2 | `makeError(kind, null, extra)` | `makeError(kind, kind === "down" ? "" : e.detail, extra)` | the plan's own Copy table needs `detail` for the `http`+ok body; an annotated `auth` carries a detail no surface renders |
| 7 | 4 (hook 5) | `probeTimer` adds `ctx._probeHealth()` beside the deployments probe | removed (5dace8b); the probe's own 401 triggers the health check through `_fail` | review: the timer-launched probe answered ~80 ms before the 401, so the strict staleness rule discarded it for the whole minute, and the timer probed for recognised 403s the plan says are never probed. The plan's intent ("never substituted") holds: the deployments probe is untouched |
| 8 | 2 (rule 2) | an OK with `health.at < e.at` is stale | stale only when older than `e.at` by more than `Model.HEALTH_FLOOR_MS` (30 s), the same constant `_probeHealth` floors on (8ea0993) | session 2: a panel open re-primes every kind and re-stamps the failure inside the floor, where a re-probe is refused, so the strict rule dropped the headline body. This changes a Design rule; see "Design changes for Dan" |

## Design changes for Dan

Two review fixes moved settled lines of the plan's Design, both under `Service.qml` / `Model.js` and both covered by tests and session 2. They ship on this branch unless Dan wants the plan amended first:

- **Hook 5** (deviation 7): `probeTimer` no longer launches a health probe beside the deployments probe. The probe's own 401 triggers it through `_fail`, after the failure is stamped. Every other part of hook 5 holds: the deployments probe is untouched and remains the only way out of probe mode.
- **Rule 2** (deviation 8): an OK is stale only when it is older than the failure by more than `Model.HEALTH_FLOOR_MS` (30 s), the same constant `_probeHealth` floors on, instead of any OK older than the failure. Session 2 showed a panel open re-stamps the 401 inside the floor, where a re-probe is refused by design, so the strict rule dropped the headline body for up to a minute.

## Review

| member | model | critical | warning | nit | fixed (commits) | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 0 | 1 | 0 | 5dace8b, 8ea0993 | — |
| code-reviewer | opus | 0 | 3 | 2 | 5dace8b (1, 2, 4, 5); the commit reword (3) | — |
| skeptic | opus | 0 | 3 | 2 | 5dace8b + 8ea0993 (1); session 2 and this record (2, 5); the record commit (3); deviation rows 5 and 6 (4) | — |
| ux-api-designer | opus | 0 | 3 | 1 | 5dace8b (1), f88cd44 (2, 3, 4) | — |
| perf-analyst | opus | 1 | 2 | 2 | 5dace8b (1, 2), session 2 and this record (3), 5dace8b (4: view kinds never set the flag), b09e412's paragraph extended in 5dace8b (5) | — |

Default panel plus the two situational members the plan's panel record ran. One re-check round follows this record.

## Noticed, not done

- A view fetch whose 200 body is not JSON still sets the panel-wide `_error` through `_dispatch`'s not-JSON branch (pre-existing; `Service.qml` `_dispatch`). The health flag is now guarded against view kinds, but the latched error itself is an SR29 gap for its own change.
- `docs/architecture.md`'s polling table still lists `/version` as "on config load" and has no row for the health diagnostic; the paragraph under the table covers it.
- The plan's budget note predicted about 7 for the wrong-URL first minute; session 2 measured 7 inside the window (session 1's 3 was a rolling window that had dropped the startup burst).

## PR body

```
Health check before auth: the callout tells Coolify not responding from a rejected token

When a poll fails with an HTTP answer (401, 3xx, 404, 5xx, or a body that is not JSON), the
service sends one unauthenticated GET /api/v1/health on its own Req and combines the two
answers at render time. A proxy answering 502, a path typo answering 302 or a host that is
not Coolify now read "Coolify not responding" with the host and the code; a revoked token
reads "Coolify is up and rejected this token" and keeps Edit config. Health never runs while
healthy, never lifts probe mode, never backs off, never notifies; at most two a minute.
Also fixes a pre-existing bug: a 2xx whose body did not parse was failed and then cleared as
a success on the same pass, which pinned the hero at Loading and cost ~49 requests in the
first minute on a wrong URL (now 7).

Plan: docs/plans/health-before-auth.md; record: docs/plans/health-before-auth.build.md
Steps: 10 step commits (step 7's fixture rides in step 2), 3 review commits, 1 record commit
Verification: node tests 143 passed; bin/check ok; two live sessions (wrong URL, garbage token across probe ticks, recovery)
Needs human: read the two callout bodies in the panel; the 502 and proxy-401 rows are node-tested only;
two review fixes moved plan Design lines (hook 5 removed, rule 2 given the 30 s floor's tolerance), see
the record's "Design changes for Dan"
```
