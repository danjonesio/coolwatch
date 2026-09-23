# Build record: Build duration on terminal and history rows

Plan: `docs/plans/build-duration.md`. Branch `build-duration` from base `a84b3c3` (develop), head `eb4ba9c` (six step commits, seven review-fix commits). PR into `develop`; Dan merges.

## Questions resolved

| question | answer | source |
|---|---|---|
| Cancelled toast gains the duration as its body? | no; step 3 skipped, `notifyCopy` untouched | default |
| Duration cap | `DURATION_MAX_MS` = 7 days | default |
| Restart-only deployment carries `finished_at`? | unknown; the row and the `restarted` toast degrade to no duration | default |
| Panel model | `opus` (the d-plan ask said "opus 5", this d-implement ask said "opus 5.5"; the Agent tool takes the alias either way) | user |

## Audit

`git status --porcelain` empty on `roadmap-health-done`; `develop` = `origin/develop` = a84b3c3, the commit the plan's line numbers were checked against. PR #14 still open, so the plan's roadmap edit is skipped (plan note for the builder). Every path in Changes exists; `docs/plans/build-duration.md` is new. One mechanical mismatch: `rowRev`'s `join` separator is the byte `\x01`, not `""` as the plan's prose implied; the new element was appended with the separator preserved.

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| 0 | harden `durationOf` | 9f236be | `node tests/run.js` | 144 passed; notify bodies at `tests/run.js:643-666` unedited |
| 1 | `finishedAt` on the row, bounded timestamps, fingerprint | 5c45039 | `node tests/run.js`; `grep -n finishedAt Model.js` | 144 passed; `deploymentRow` line, `rowRev` element present, `historyRow` assignment no longer sets it |
| 2 | `rowTime` | 73fba61 | `node tests/run.js` | 145 passed |
| 3 | cancelled toast body | — | — | skipped (default no) |
| 4 | the two `Panel.qml` bindings | 6aeecfa | `bin/check` | ok (qmllint, validate, SR25); live checks below |
| 5 | docs | bf8e583 | `bin/check --no-shell`; span grep; `git diff --stat` | ok; 0 "span"; four doc files, roadmap skipped |
| 6 | `docs/plans/build-duration.md` | 93447a1 | `ls`; `bin/check --no-shell` | present; ok |
| review | a rejected `finishedAt` must not drive the age (`credibleFinish`) | 96bf092 | `node tests/run.js`; `bin/check --no-shell` | 145 passed; ok |
| review | the numeric start is caught by the cap, not the NaN guard | 35c0ca6 | `node tests/run.js` | 145 passed |
| review | no `createdAt`: the finish is anchored to `updatedAt` | 64e40c2 | `node tests/run.js`; `bin/check --no-shell` | 145 passed; ok |
| review | comment wording; two design.md reflows | 131fbfe | `node tests/run.js`; `bin/check --no-shell` | 145 passed; ok |
| review | the breadcrumb reads the same age gate; discriminating clocks; two labels | 33736cd | `node tests/run.js`; `bin/check` | 145 passed; ok; plugin re-synced and shell restarted clean |
| review | one more "span" in a comment | 61974b0 | `node tests/run.js`; `bin/check --no-shell` | 145 passed; ok |
| review | the finish-only row is a recorded decision (test only) | eb4ba9c | `node tests/run.js`; `bin/check --no-shell` | 145 passed; ok |

## Tests

| case | covers | file | commit |
|---|---|---|---|
| `Model.durationOf` table (raw six-digit stamps, `updatedAt` trap 29s/34s, NaN, reversed, equal, epoch, numeric, year 3000, ceiling, cap ±) | security requirement 2 | `tests/run.js` (before `Model.elapsed / age`) | 9f236be |
| `normaliseDeployment` bounding: 41 chars, `""`, number, object, array → null; 27-char stamp kept | security requirement 1 | `tests/run.js` `Model.deploymentRow / resourceRow` | 5c45039 |
| `deploymentRow.finishedAt` pass-through and null; `historyRow.finishedAt` equals the fixture; section/History agree from one record | data consistency | same tests + `Model.normaliseHistory` | 5c45039 |
| `sameRows`: `finishedAt` is a rev field; `updatedAt` still is not | security requirement 5 | `tests/run.js` `Model.sameRows` | 5c45039 |
| `panelRows`: terminal rows from `recent` carry `finishedAt` | plan step 1 | `tests/run.js` `Model.panelRows: deployments` | 5c45039 |
| `Model.rowTime` table: usage rows, four fallbacks, `createdAt: null`, History terminal with explicit `nowMs`, History in_progress unchanged, unmapped status 90 d old, null row, age source | plan Design; security requirement 7 | `tests/run.js` `Model.rowTime` | 73fba61 |
| `rowTime` / `credibleFinish`: over-cap, year-3000 and 1970 stamps (with and without `createdAt`) read today's `updatedAt` age at a clock where that text is not `Just now`; `credibleFinish` true/false pinned for the breadcrumb | review (data-analyst 1, skeptic 2, code-reviewer 1) | same test | 96bf092, 64e40c2, 33736cd |
| `durationOf`: `createdAt: "1"` (the file path's stringified form) → `""` via the cap | review (security-analyst 1) | `Model.durationOf` test | 35c0ca6 |
| `rowMatches` does not match on the duration | security requirement 6 | same | 73fba61 |
| cancelled body `6s` | step 3 | not written (step skipped) | — |
| unchanged, green unedited: `logRequestRow` `""` (`:753`), recent round-trip (`:839`), overlay key set (`:1879`), `updatedAt` not a rev field (`:1290`), notify bodies (`:643-666`) | plan | `tests/run.js` | — |

## Verification

| check | command or action | result |
|---|---|---|
| node tests | `node tests/run.js` | 145 passed, 0 failed |
| CI subset | `bin/check --no-shell` | ok |
| full check | `bin/check` | ok (step 4) |
| live sync | `bin/dev-sync && omarchy restart shell` | done; `status` shows `error: null`, 19 recent entries; `quickshell log` has no coolwatch warning (two unrelated: the portal app-id and a different plugin's Panel.qml) |
| (a) terminal section row | `omarchy-shell … log <uuid>` summoned the panel; Escape returned to the section; screen capture (scratchpad, not committed) | row reads `22s · 42m ago` with its `×` (the newest recent entry, under an hour old: created 23:24:21, finished 23:24:43; capture at 01:07 local, 00:07Z, the screenshot file's mtime) |
| (a) never-blank stand-in row | needs human: with nothing active and the newest terminal entry over an hour old, open the panel | expected `<duration> · <age>` (`22s · 3h ago`); the branch could not be exercised while a sub-hour entry existed |
| (c) breadcrumb | the summoned build-log view (before 33736cd; that commit only changes which stamp feeds the age when `finishedAt` is not credible, so the sane case is unchanged) | breadcrumb `‹ <app> · finished · 42m ago`, same age as the row (both off `finished_at`) |
| final head live | `bin/dev-sync && omarchy restart shell` at 33736cd; `status`; `quickshell log` | `error: null`, 19 recent entries, no coolwatch warning |
| (a) History rows | needs human: open the panel, `j` to an application row, `l`, `l` to More, Enter, `l` to History, Enter | expected `<duration> · <age>` on each terminal row, an age on a running one |
| (b) width check | needs human: deploy an application with a long commit message (`d`), watch the section row from finish through its first minute | expected `2m 21s · Just now` shape, name elides with its tooltip, nothing overflows; the number steps back a few seconds at the finish |

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 0 | cap-boundary and `Date.parse`-ceiling cases as numbers | ISO strings | `Date.parse` on a 13-digit epoch number is NaN, so a numeric end cannot exercise the cap; `Date.parse(1)` is 2001 and `createdAt: 1` (and its file-path form `"1"`) is caught by the cap, pinned as such |
| 2 | 1 | append to `rowRev`'s array | appended with the existing `\x01` join separator kept | the separator is a control byte, not `""` |
| 3 | 4 | three live checks | (a) section row and (c) breadcrumb captured; History, the never-blank stand-in and the real-deploy width check are needs-human | driving the strip by keystroke reached the browser once the panel closed; a real deploy is Dan's to run |
| 4 | 5 | roadmap edit | skipped | PR #14 still open (plan note) |
| 5 | 4 (review) | `Panel.qml:443` untouched | one line: `at` reads `Model.credibleFinish(row) ? row.finishedAt : row.updatedAt` | code-reviewer 1: once `deploymentRow` carries `finishedAt`, the truthiness chain there blanked the breadcrumb age on a garbage stamp and read `Just now` on a future one; the plan excludes a duration in the breadcrumb, not its fallback. The breadcrumb still renders an age only |

Not a deviation, recorded because it was one for a while: step 2 first shipped a reversed pair reading the age off the parseable `finishedAt` (73fba61); 96bf092 gates the age on `durationOf`'s bounds (`credibleFinish`), so all four fallback rows in the plan's usage table are byte-identical to today as written. Consequence for the open cap question: `DURATION_MAX_MS` now governs the age source as well as the duration; raising it loosens both.

## Review

| member | model | critical | warning | nit | fixed (commits) | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 0 | 2 | 0 | 2 (35c0ca6; 96bf092 + record) | — ; re-check: both resolved (record finalised after) |
| code-reviewer | opus | 0 | 2 | 2 | 4 (33736cd; 64e40c2; record; 33736cd labels) | re-check: 1, 3, 4 resolved; 2 narrowed to a finish-only row (no `createdAt`, no `updatedAt`) with an absurd stamp, reachable only from a hand-edited `recent.json`: kept as is and pinned as a decision (eb4ba9c), because blanking it would hide the legitimate finish-only entry and History already read it this way (data-analyst and ux-api-designer re-checks concur) |
| skeptic | opus | 1 | 2 | 2 | 5 (96bf092, 35c0ca6, 33736cd, record ×2) | — ; re-check: 1, 3, 5 resolved, 2 fixed after in 33736cd, 4 fixed in the record |
| data-analyst | opus | 1 | 1 | 0 | 2 (96bf092, 64e40c2) | finding 2 (`rowRev` separator) withdrawn by the reviewer: `cat -A` shows the `\x01` byte; re-check: resolved |
| ux-api-designer | opus | 0 | 1 | 3 | 5 (96bf092 + 64e40c2; 35c0ca6; 131fbfe ×2; 61974b0) | — ; re-check: 1, 3, 4 resolved, 2 reworded again in 61974b0 |

All ten security requirements `met` in the security-analyst's requirement check. Panel as the plan's record (the three fixed members plus the two situational analysts the plan ran); model `opus`. The finding four members raised independently (a rejected `finishedAt` driving the age) was one bug in one function, fixed once.

## Noticed, not done

- `Panel.qml:1104` History main text still reads `cancelled-by-user` (plan: out of scope).
- `Model.js:1845` history footer hint does not advertise `r` (plan: out of scope).
- A different plugin (`io.github.danjonesio.github`) logs a `TypeError` at its `Panel.qml:631`; not this repo.

## PR body

```
Build duration on terminal and History rows

Terminal deployment rows in the section and in History now read `duration · age` (`2m 21s · 4m ago`) from Coolify's `created_at → finished_at`; running rows are unchanged. Coolify has no `started_at` (the roadmap item's premise), so the duration includes any queue wait, the same value the finished/failed toasts already carry. `durationOf` is hardened (parse once, "" on a reversed pair or over 7 days, `0s` on an equal pair), timestamps are bounded at `normaliseDeployment`, `finishedAt` rides on `deploymentRow` and in the repaint fingerprint, and one pure `Model.rowTime` feeds both delegates. Side effect: a build log opened from the section now ages its breadcrumb off `finished_at`, as design.md:234 always said.

Plan: docs/plans/build-duration.md
Steps: 6 commits, one per plan step (step 3, the cancelled toast body, skipped by default), plus 7 review-fix commits
Review: 5 members on Opus; 2 critical + 8 warning + 7 nit raised, all fixed or recorded; 10/10 security requirements met
Verification: node 145 passed; bin/check ok; live: section row `22s · 42m ago`, breadcrumb agrees, shell restarted clean on the final head
Needs human: History view rows; the never-blank stand-in row; a real deploy for the `2m 21s · Just now` width check
```
