# Build duration on terminal and history rows

Branch `build-duration` from `develop`, PR into `develop` (`gh pr create -B develop`). Dan merges. Backlog item: `docs/roadmap.md:232` "Build duration on terminal and history rows".

Note for the builder: at planning time `develop` is at a84b3c3 and PR #14 (`roadmap-health-done`, the "Done from this list" paragraph in `docs/roadmap.md`) is still open. Step 5's roadmap edit appends to that paragraph, so do it only if #14 has merged; otherwise leave `docs/roadmap.md` alone and say so in the build record (the rule the last feature used). Every other line number below was checked against a84b3c3.

## Context

A deployment that has finished, failed or been cancelled shows only how long ago it ended: `4m ago` on the deployments-section row (`Panel.qml:1478`), `4m ago` on a History row (`Panel.qml:1122`). How long the deployment ran is data Coolify already gives (`created_at` and `finished_at` on every terminal record, `docs/coolify-api.md:188`) and the plugin already computes it for the finished, failed and restarted toasts (`Model.durationOf`, `Model.js:732`; body `2m 21s · main` pinned at `tests/run.js:646`). Nothing in the panel shows it.

The roadmap item names `started_at`; Coolify deployments have no such field (`docs/coolify-api.md:183`; the openapi's `started_at`/`duration` belong to backup executions only). The real pair is `created_at → finished_at`, which includes any queue wait. That is what `docs/design.md:495` already defines `dur` as. The shipped docs call the value the duration or `dur`; never "build time", "build took", or a third word.

Outcome: a terminal row in the deployments section reads `2m 21s · 4m ago`; a terminal History row reads `29s · 5m ago`; running rows are unchanged (the section's ticking `1m 20s`, History's age); a terminal row whose timestamps are missing, unparseable, reversed or absurd reads exactly what it reads today (`4m ago`). The finished toast already says what the roadmap asked for and is unchanged. No new request, no new state-file field, no new row type, no new `Text` item.

## Findings from exploration

- `normaliseDeployment` (`Model.js:459-480`) keeps `createdAt`, `updatedAt`, `finishedAt` as `d.x || null` with no type or length check; the values are ISO strings like `2026-09-04T23:16:46.000000Z` (six fractional digits, `Z`). No other `normalise*` function bounds a length; `recentEntry` (`Model.js:881`) is the only bound, and it truncates with `elide(redact(String(v)), 40)` rather than rejecting.
- `durationOf(d)` (`Model.js:732-735`): guard `Date.parse(d.createdAt)`, then `elapsed(d.createdAt, b)`. Measured under node: a reversed pair renders `0s` (`elapsed` clamps, `Model.js:2129`); `createdAt: 1` passes the guard as year 2001 but is computed as epoch 1 ms (`elapsed`'s number branch, `:2127`) and renders `496823h 16m`; `finished_at` in year 3000 renders `8531976h 45m`. `elapsed`'s second argument is `nowMs || Date.now()` (`:2128`), so a finish instant of exactly 0 falls back to the wall clock. `durationOf` has no direct test; its only caller is `notifyCopy` (`Model.js:757`).
- `elapsed(iso, nowMs)` (`Model.js:2126`) formats `45s` / `1m 4s` / `2h 03m` (`pad2` on the hour form only) and accepts a number for either argument; `age()` (`Model.js:2138`) formats `Just now` / `4m ago` / `3h ago` / `2d ago` and returns `""` on NaN (`:2140`).
- `TERMINAL` (`Model.js:37`) and `ACTIVE` (`Model.js:38`) are the two status maps; `activeDeployments` filters on `ACTIVE` (`:1043`) and `parseRecent`/`serialiseRecent` keep terminal entries only, so a section row is always one or the other. `normaliseHistory` (`Model.js:2031-2035`) filters on nothing: a History record with an empty or unmapped status (`docs/coolify-api.md:254` lists a second Coolify enum `error, killed, cancelled, closed`) has `terminal: false`.
- `deploymentRow` (`Model.js:1394-1402`) carries `createdAt`, `updatedAt`, `terminal`, `status`, `type: "deployment"` but not `finishedAt`. Two callers bolt it on: `logRequestRow` (`Model.js:1412`, `""` when absent, pinned by `tests/run.js:753` `eq(r1.finishedAt, "")`; its bare-row branch at `:1411` has no `deploymentRow` to inherit from) and `historyRow` (`Model.js:2041`, `null`, then `viewRow` turns `null` into the `""` placeholder). `Panel.qml:443` (`openLogsFor`) already reads `row.finishedAt || row.updatedAt` for the build-log breadcrumb on both row types, so a log opened from the deployments section ages off `updatedAt` today, against `docs/design.md:234`, while one opened by IPC (`logRequestRow`) ages off `finished_at`.
- `rowRev` (`Model.js:1792-1797`) lists no timestamp; `tests/run.js:1290` pins "updatedAt is not a rev field". The active→terminal flip repaints because glyph, tone and `terminal` change. `listPatch` (`Model.js:1681`) issues a `set` only on a `rowRev` change.
- `VIEW_DEFAULTS` (`Model.js:1898-1899`) already has `finishedAt: ""` and `terminal: false` (a typed boolean, so overlay rows carry a real `terminal`); `viewRow` (`:1982`) silently drops unknown keys and `tests/run.js:1879` pins the key set. Only `rowType === "history"` reaches `historyComp` (`Panel.qml:1024-1027`); `moreRow` has its own delegate. `viewModel.get(i)` objects are already passed into `Model.*` functions (`Panel.qml:489, 554`).
- The main list stores the whole row object under one `row` role (`Panel.qml:172`), so a `null` `finishedAt` there cannot mistype a role.
- `depTime` (`Panel.qml:1475-1483`): `terminal ? Model.age(row.updatedAt, nowMs) : Model.elapsed(row.createdAt, nowMs)`; `histTime` (`:1119-1127`): `Model.age(finishedAt || updatedAt || createdAt, nowMs)`, a truthiness chain that blanks the column for a non-empty unparseable `finishedAt` (latent today). Each is the single `Text` whose `implicitWidth` the name column subtracts (`:1445`, `:1095`). The 1 s `Timer` (`:130-135`) runs while the panel is open. The History view is a one-shot fetch (`docs/design.md:259`); `r` refetches page 0 (`Panel.qml:485, 690`) and is not in the history footer hint (`Model.js:1845`).
- Every fixture has `updated_at` 1–5 s after `finished_at`: `deployment-finished.json` 23:14:25 → 23:16:46 (`2m 21s`; updated 23:16:50), `deployment-failed.json` 11:54:26 → 11:55:30 (`1m 4s`), `deployment-cancelled.json` 02:01:49 → 02:01:55 (`6s`; `tests/run.js:880` asserts it carries `finished_at`), `history-page.json` rows 29s / 9s / 16s by `finished_at` (34s / 10s / 20s by `updated_at`). `deployments-active.json` rows carry `finished_at: null`; `GET /deployments` lists only queued and in_progress, so the poll can never produce a duration.
- `recent.json` written by 1.0.0 already holds all three timestamps (`RECENT_STRING_FIELDS`, `Model.js:877`, 40 chars each; `git show master:Model.js` line 804); `dismissRecent` copies every key, `mergeRecent` passes entries through; `parseRecent` (`:905`) validates `finishedAt || updatedAt` only. `recentEntry` stringifies: a file value `1` becomes `"1"`, which `Date.parse` reads as 2001. No `RECENT_FILE_VERSION` change is needed. `redact()` over a 10 MB string measures about 525 ms per pass and runs on every `_saveRecent`; `Date.parse` over the same string about 30 ms.
- `history-page.json` rows are dated after the test clock `NOW` (`tests/run.js:52`, 2026-09-06T22:00Z), so `age()` on them reads `Just now` at `NOW`; a history test passes its own `nowMs` (`tests/run.js:2146` precedent).
- `state-recent.json` reuses uuid `vdyasty4cmgyoekplcarxpfh` with different timestamps from `deployment-finished.json` (2m 0s vs 2m 21s) and has `updatedAt === finishedAt` on both entries; it proves persistence only, never the pair choice.
- No test feeds `normaliseDeployment` a non-string or over-40-char timestamp (`dep()` at `tests/run.js:538` bypasses it; `:771` bypasses it with a string).
- `notifyCopy` (`Model.js:757-766`): `finished` body `[dur, branch]`, `restarted` `dur`, `failed` `[dur, …]`, `cancelled` `""` (`tests/run.js:655`). The self-cancel rule (`NOTIFY_CANCEL_WINDOW_MS`, `Model.js:692`) drops the operator's own cancel, so a cancelled toast fires almost only for a cancel from elsewhere. `docs/design.md:497` documents the empty body as the deliberate compact one-line toast.
- `rowMatches` (`Model.js:1310`) builds its haystack from `name, statusWords, kindHint, sub, status`.
- `docs/design.md` states the current right-column rule at `:83-86` (sketch: `web finished 4m ago`, `cron failed 12m ago`), `:190`, `:196-197` (the never-blank row "stays with its age"), `:208-209` (tick rule), `:257` (History); `dur` at `:495-496`; the copy table `:501-515`. `docs/architecture.md:334-335` documents the deployment record without `finishedAt`, `appId`, `serverName`. `docs/coolify-api.md:188` states the `updated_at` fallback without saying it is for the age only.
- Feature convention: `docs/plans/<name>.md` beside `<name>.build.md` (seven pairs), cited from the status paragraph of `docs/development.md:19`.
- No first-party Omarchy panel stacks two values in a row's right column; a two-line right column would be the one non-native shape.

## Design

### Caller's usage first

Right column of each row (`Style.font.caption`, `root.dim`, the existing `depTime` / `histTime` `Text`), fixture numbers:

| row | today | after |
|---|---|---|
| section, in_progress | `1m 20s` (ticks) | unchanged |
| section, queued | `12s` (ticks) | unchanged |
| section, finished (`deployment-finished.json`, 4 min later) | `4m ago` | `2m 21s · 4m ago` |
| section, failed (`deployment-failed.json`, 12 min later) | `12m ago` | `1m 4s · 12m ago` |
| section, cancelled (`deployment-cancelled.json`, 2 days later) | `2d ago` | `6s · 2d ago` |
| section, finished, just drained | `Just now` | `2m 21s · Just now` |
| section, never-blank stand-in row (Friday build on Monday) | `3d ago` | `2m 21s · 3d ago` |
| section, terminal, `finishedAt` null / `"garbage"` / before `createdAt` / over the cap | `4m ago` (off `updatedAt`) | `4m ago` (off `updatedAt`), byte-identical |
| section, terminal, `createdAt` null (an old `recent.json` entry) | `4m ago` | `4m ago` |
| History, finished (`history-page.json` row 1, 5 min later) | `5m ago` | `29s · 5m ago` |
| History, failed (row 3) | `1h ago` | `16s · 1h ago` |
| History, in_progress or queued | `4m ago` | unchanged |
| History, empty or unmapped status, months old | `90d ago` | unchanged |
| build-log breadcrumb | age | age; a log opened from the section now ages off `finished_at` (step 1 side effect) |

Duration first, then age, joined with the codebase's ` · `. The order keeps the slot's meaning constant: the running elapsed freezes into the final duration in the same position, and the age is what elides. Width cost: `2m 21s · Just now` is 17 characters against `4m ago`'s 6, about 54 px at caption size, taken from the terminal row's name and commit-message line only (`Panel.qml:1445` subtracts `depTime.implicitWidth`); the name's `PanelToolTip` (`Panel.qml:1455-1459`, bound to `truncated`) recovers the name; the commit message has no tooltip and that is the sibling backlog item "Commit message on the cursor row". `2m 0s` (an exact two minutes) and `Just now` with its capital are the existing formatters' output and stay.

Toasts: unchanged. `Deployed storefront` / `2m 21s · main` already is the roadmap's "finished in 2m 21s" (the body leads with the duration; a "finished in" phrase would restate the headline and break the `A · B · C` body shape of the copy table). The cancelled toast keeps its empty body unless Dan says otherwise (open question below).

`omarchy-shell … status`, `snapshot`, `recent.json`, `console.*`: no change.

### Data shapes

- `deploymentRow` gains `finishedAt: d.finishedAt || null` (its neighbours' convention). No other row field; no string is precomputed onto a row, so `VIEW_DEFAULTS`/`VIEW_KEYS` are untouched and `rowMatches` cannot see it.
- `normaliseDeployment` bounds the three timestamps with `tsField(v)`: `typeof v === "string" && v && v.length <= RECENT_STRING_FIELDS.createdAt ? v : null` (read at call time, so declaration order is irrelevant; `""` stays `null` as today so `recent.json` never gains a `""`). Why here: it is the first bound in the `normalise*` layer, and it is load-bearing twice: it keeps a 10 MB timestamp out of `recentEntry`'s `redact()` (525 ms per `_saveRecent`) and out of the per-tick parses that the delegate route below needs. The file path is different on purpose: `recentEntry` truncates (a 41-char value becomes 40 chars plus `…`) and stringifies; the two paths share the number 40 and both end unparseable, and `durationOf`'s bounds are the guard for what the file path lets through. Do not move `tsField` into `recentEntry` (it would turn coercion into rejection and put the `tests/run.js:844` round-trip at risk).
- `rowRev` appends `r.finishedAt || ""`. `finishedAt` is set once per uuid, so it adds no churn (unlike `updatedAt`, deliberately kept out). It makes "everything the right column renders is in the rev" hold by inspection: a `recent.json` load or a re-drain that fills `finishedAt` on an already-terminal row repaints.
- `durationOf(d)` is hardened and stays the one formatter, with its own cap:
  ```js
  var DURATION_MAX_MS = 7 * 24 * 3600 * 1000   // longer than this is not a deployment: caps the string the name column is sized against
  function durationOf(d) {
    var a = Date.parse(d && d.createdAt), b = Date.parse(d && d.finishedAt)
    if (isNaN(a) || isNaN(b)) return ""
    var span = b - a
    if (span < 0 || span > DURATION_MAX_MS) return ""
    return span === 0 ? "0s" : elapsed(0, span)
  }
  ```
  Parse once, compute from the two numbers (closes the guard/arithmetic mismatch and the epoch-0 clock fallback in `elapsed`), `""` for a reversed pair (a fabricated `0s` is a metric the API did not give), `""` above the cap (7 days of `168h 00m` is 8 characters; `Date.parse`'s own ceiling would give 15), `0s` for an equal pair (Coolify's timestamps are second-granular; `0s` is already what a just-created active row shows). The cap is its own literal, sited directly above `durationOf`, not an alias of `RECENT_FILE_MAX_AGE_MS` (a file-retention policy; History rows are bounded by no file window). No `updatedAt` fallback, ever: that idiom is right for an age and 1–5 s wrong for a duration. The toasts inherit the hardening; their pinned bodies do not change.
- `rowTime(r, nowMs)` is the one chooser, pure, in the format section after `age()`:
  ```js
  // The right column of a deployment or a history row. A running section row shows the ticking
  // elapsed; a terminal row shows the duration Coolify gives (createdAt → finishedAt; there is
  // no started_at, so a queue wait is inside it) beside how long ago it ended. A history row
  // that is not terminal keeps its age. No duration: the row reads exactly the age it read before.
  // age() || age() rather than age(a || b): a non-empty unparseable stamp must fall through.
  function rowTime(r, nowMs) {
    var t = r || {}
    if (t.type === "deployment" && !t.terminal) return elapsed(t.createdAt, nowMs)
    var dur = t.terminal ? durationOf(t) : ""
    var ago = age(t.finishedAt, nowMs) || age(t.updatedAt, nowMs) || age(t.createdAt, nowMs)
    return [dur, ago].filter(function (x) { return !!x }).join(" · ")
  }
  ```
  Both delegates call it. The running branch is keyed on the section (`type === "deployment"`, where a non-terminal row is always `ACTIVE`), so History non-terminal rows keep the age they show today and an unmapped-status History row from months ago cannot start counting up. The age chain falls through on the formatter's own empty return, not on truthiness: the four `Date.parse(d.finishedAt || d.updatedAt || "")` sites (`Model.js:802, 905, 948, 1714`) are the decision precedent (finish first, then update), not the expression precedent (they feed `isNaN`; this one renders). For the section's terminal row the age source moves from `updatedAt` to `finishedAt` when it parses, a deliberate alignment with History and `panelRows` (1–5 s apart, at most one minute bucket at a boundary). `viewDelegate.modelData` carries a real boolean `terminal` (`VIEW_DEFAULTS`), so the branch is safe on overlay rows.

### Module map

- `Model.js`: `tsField` + `normaliseDeployment`; `DURATION_MAX_MS` + `durationOf`; `deploymentRow` `finishedAt`; `historyRow` loses its `r.finishedAt` bolt-on (value-identical now); `rowRev`; `rowTime`. `logRequestRow` is not edited: its line survives as the IPC bare row's `""`-for-`null` coercion, no longer as the carrier.
- `Panel.qml`: the `text:` binding and comment of `depTime` (`:1477-1478`) and `histTime` (`:1121-1122`). No new `Text` (SR25 counts unchanged), no width-math change, no tooltip change, no timer change.
- Side effect, intended: `Panel.qml:443` is untouched but a log opened from the deployments section now ages its breadcrumb off `finished_at`, which is what `docs/design.md:234` already specifies and what the IPC path already did. The breadcrumb chooser (`Panel.qml:607-617`) is not routed through `rowTime`: it runs over the view object (`at`, `createdAt`, `status`, no `terminal`/`finishedAt`), takes its verdict from the live record, and `docs/design.md:234` pins it as an age, never a duration.
- `tests/run.js`: tests listed under Changes.
- `docs/design.md`, `docs/architecture.md`, `docs/coolify-api.md`, `docs/development.md`, `docs/roadmap.md`, `docs/plans/build-duration.md`: steps 5 and 6.
- Not touched: `Service.qml`, `Api.js`, `BarWidget.qml`, `notifyCopy` (unless the open question says yes), `recentEntry` / `parseRecent` / `RECENT_FILE_VERSION`, `VIEW_DEFAULTS`, `rowMatches`, `elapsed`, `age`, `logRequestRow`, the history footer hint, `CHANGELOG.md` (release time), fixtures (no new fixture: every case is an inline override over `deployment-finished.json` / `history-page.json`, keeping SR31/SR39 out of the change).

### Interfaces

```js
// Model.js
function tsField(v)                    // -> v when it is a non-empty string of <= 40 chars, else null
function durationOf(d)                 // -> "2m 21s" | "0s" | "" ; createdAt → finishedAt; "" on NaN, reversed, or > DURATION_MAX_MS
function rowTime(r, nowMs)             // -> "1m 20s" (running section row) | "2m 21s · 4m ago" | "4m ago" (no duration) | "" (nothing parses)
// deploymentRow(d, originStr).finishedAt : string | null
```

```qml
// Panel.qml
// depTime:  text: Model.rowTime(rowDelegate.row, root.nowMs)
// histTime: text: Model.rowTime(viewDelegate.modelData, root.nowMs)
```

### Rejected alternatives

- **The duration replaces the age on terminal rows** (the roadmap's literal reading, zero width cost). `docs/design.md:196-197` pins the never-blank stand-in row as "stays with its age": that row's job is recency, and a two-day-old failure reading only `1m 4s` is indistinguishable from one a minute old. History would lose every "when" over 39 rows.
- **A precomputed `dur` string on the row.** The age must tick anyway, so the delegate reads `nowMs` regardless; a string field would need a `VIEW_DEFAULTS` placeholder and a `rowRev` entry and would move the house rule "rows carry timestamps, not strings". `finishedAt` in `rowRev` gives the same repaint guarantee, and `rowTime` is what the node tests pin.
- **Ternary in the delegates, no `Model` function.** Untestable: `tests/run.js` evaluates `Model.js` and `Api.js` only.
- **History running rows switch to the ticking elapsed** (draft v1 had it). The brief keeps running rows as they are; the History view never refreshes, so an in_progress row that finished while the view stayed open would count up without bound with no hinted way out (`r` is not in the footer hint); and an unmapped-status row months old would read `2160h 00m`.
- **`updatedAt` as the finish instant** to remove the visible backwards jump when a build ends (the running row counts to ~`2m 29s`, then the record says `2m 21s`). It inflates every duration by Coolify's write lag and makes the row disagree with the toast. The jump is correct and expected.
- **A two-line right column.** No first-party Omarchy panel does it.
- **The duration in `sub`.** `rowMatches` searches `sub`, so `/` typing `2m` would match on duration.
- **"finished in 2m 21s" toast copy.** Restates the headline; the body already leads with the duration.
- **`DURATION_MAX_MS` as an alias of `RECENT_FILE_MAX_AGE_MS`.** Two unrelated policies sharing one number; a file-retention change would silently move what the panel renders.
- **A `DURATION_MAX_MS` of 24 h.** A stalled queue can hold a deployment longer than a day and the value is real data. Open question below.

## Reuse

- `Model.js:732` `durationOf` — the one duration formatter, already the toasts' source; hardened in place.
- `Model.js:2126` `elapsed` / `:2138` `age` / `:2124` `pad2` — the two vocabularies; both accept numbers; `age`'s `""`-on-NaN contract is what the fallback chain leans on.
- `Model.js:37-38` `TERMINAL` / `ACTIVE` — the status maps; `type: "deployment"` on `deploymentRow` and `r.type = "history"` on `historyRow` are the existing surface discriminator.
- `Model.js:1394` `deploymentRow` — the single row builder behind the section, `historyRow` and `logRequestRow`; the place `finishedAt` belongs.
- `Model.js:877` `RECENT_STRING_FIELDS.createdAt` — the 40 `tsField` reads; `recent.json` already persists `finishedAt`.
- `Model.js:1898` `VIEW_DEFAULTS.finishedAt` / `.terminal` — the placeholders that already carry both fields, typed, into History rows.
- `Model.js:1792` `rowRev` / `:1799` `sameRows` / `:1666` `listPatch` — the repaint fingerprint.
- `Model.js:1398`, `:761-765` — the `.filter(Boolean).join(" · ")` shape `rowTime` reuses.
- `Panel.qml:1475` `depTime`, `:1119` `histTime` — the two `Text` blocks re-bound; `Panel.qml:489, 554` — the precedent for passing a `viewModel` row into `Model.*`.
- `tests/run.js:13-68` helpers, `NOW` at `:52`; `:1298` (`Model.elapsed / age`) as the formatter-test shape; `:1073` (`Model.heroMeta`) as the display-string-test shape; `:1143-1146` recent rows with `createdAt: null`; `:1905-1925` `normaliseHistory / historyRow`; `:1284` `sameRows`; `:643-666` notify bodies; `:839` recent round-trip; `:1879` `viewRow` key set; `:2146` passing an explicit `now`; `:880` the cancelled-carries-`finished_at` anchor.
- Fixtures: `deployment-finished.json` (2m 21s), `deployment-failed.json` (1m 4s), `deployment-cancelled.json` (6s), `deployments-active.json` (`finished_at: null`), `history-page.json` (29s / 9s / 16s; the discriminating fixture for "not `updatedAt`").
- `docs/plans/health-before-auth.md` — the plan-file shape, including the "Note for the builder" paragraph.

## Security requirements

1. Untrusted timestamps are bounded before they are rendered, parsed per tick, or redacted on save: `normaliseDeployment` keeps only non-empty strings of at most 40 characters (`tsField`), which covers the poll, the drain and the History page (`normaliseHistory` → `normaliseDeployments`). The file path is coerced by `recentEntry` (stringified, truncated to 40) and guarded by `durationOf`'s bounds (requirement 2), never by `tsField`. Tests: a 41-char string, `""`, a number and an object each normalise to `null`; a 27-char ISO string is kept. Step 1. `tsField` is the precondition for the delegate route in step 4; weakening it means revisiting the rejected precomputed-string design, not just the test.
2. The duration is bounded on both sides in one place: `durationOf` returns `""` for NaN, a reversed pair, or a span over `DURATION_MAX_MS`, and computes from the span, so no absurd string can drive the name column's width to zero, no fabricated `0s` ships, and an epoch-0 pair cannot reach the clock fallback. Tests: reversed → `""`; year-3000 `finished_at` → `""`; `Date.parse` ceiling → `""`; `createdAt: 1` → `""` (load-bearing for the file path); equal pair → `0s`; epoch pair (`1970-01-01T00:00:00.000Z` twice) → `0s`; cap boundary (`DURATION_MAX_MS` exactly → `168h 00m`, `+1000` → `""`). Step 0.
3. Nothing new is persisted or reported: no key in `RECENT_STRING_FIELDS`, no `RECENT_FILE_VERSION` bump, no `""` written where `null` was, no field in `_status()` / `snapshot`, no `console.*` line. Proof: the recent round-trip test (`tests/run.js:839`) unchanged and green; `git diff --stat` touches no `Service.qml`. Steps 1, 5.
4. The overlay row key set is unchanged: `tests/run.js:1879` stays green unedited; `historyRow` adds no key. Step 1.
5. Every rendered right-column string is in the repaint fingerprint: `rowRev` lists `finishedAt`; `sameRows` on two rows differing only in `finishedAt` is false. Step 1.
6. The filter cannot match on the duration: `rowMatches` untouched; test that `rowMatches(terminalRow, ["2m"])` is false when name/sub lack it. Step 2.
7. `rowTime` cannot render an unbounded elapsed on a History row: the running branch is keyed on `type === "deployment"`; test a history row with `status: ""` and a `created_at` months before `nowMs` reads the age. Step 2.
8. No new `Text` item, so SR25's Text/PlainText and pixelSize/family counts stay equal; no hardcoded size or colour. Step 4 (`bin/check`).
9. No new fixture (SR31/SR39 untouched): every edge case is an inline object over an existing fixture. Steps 0–2.
10. Toast argv shape unchanged: `notifyCopy` is untouched by default; if the cancelled body is taken, it is assembled inside `notifyCopy` and passes `notifyBody`, so SR16 counts are unchanged. Step 3.

## Changes

0. **`Model.js`: harden `durationOf`.** Insert `var DURATION_MAX_MS = 7 * 24 * 3600 * 1000` with its comment directly above `durationOf` (`Model.js:732`) as a literal (an alias of a constant declared later in the file would be `undefined` at evaluation time and the cap would never fire). Replace the body with the Data shapes version. Tests, one `test("Model.durationOf: …")` beside `Model.elapsed / age` (`tests/run.js:1298`), over the **raw** fixture strings (six fractional digits, `Z`), not `toISOString()` output: `deployment-finished.json` → `2m 21s`; `deployment-cancelled.json` → `6s`; a synthetic 2 h 3 min pair → `2h 03m`; `updatedAt`-is-later trap: `history-page.json` row 1 with `finishedAt` → `29s` and never `34s`; `createdAt` missing → `""`; `finishedAt: "garbage"` → `""`; reversed → `""`; equal → `0s`; epoch pair → `0s`; `createdAt: 1` → `""`; year 3000 → `""`; `DURATION_MAX_MS` exactly → `168h 00m`, `+1000` → `""`.
   **Verify**: `node tests/run.js` passes; the notify bodies at `tests/run.js:643-666` are unedited and green.

1. **`Model.js`: `finishedAt` on the row, bounded timestamps, fingerprint.** `tsField(v)` above `normaliseDeployment` (`Model.js:459`), reading `RECENT_STRING_FIELDS.createdAt` inside the function body; `createdAt: tsField(d.created_at)` and the same for `updated_at`, `finished_at`. `deploymentRow` (`:1394`): one added line `finishedAt: d.finishedAt || null,` after `updatedAt` (keep the diff to that line; the sibling "Preview builds" item edits the same literal). `historyRow` (`:2041`): delete `r.finishedAt = d.finishedAt || null` from the assignment line. `rowRev` (`:1792`): append `r.finishedAt || ""` as the last array element. `logRequestRow` untouched (see Module map). Tests: `tests/run.js:1621` `deploymentRow` gains `finishedAt` pass-through and `null` when absent; `:1284` `sameRows` gains "finishedAt is a rev field" (two rows differing only there → false; the `updatedAt` line at `:1290` stays); `:1143` panelRows gains "terminal rows from `recent` carry `finishedAt`"; `:1905` `historyRow` gains `finishedAt` equals the fixture's; a consistency test deriving a section row (`deploymentRow(normaliseDeployment(fx))`) and a history row (`historyRow(normaliseDeployment(fx))`) from one `deployment-finished.json` record and asserting equal `durationOf`; `normaliseDeployment` over `{created_at: "x".repeat(41)}`, `{created_at: ""}`, `{created_at: 1}`, `{created_at: {}}` → `null`, and a 27-char ISO string kept. `:1879`, `:753` and `:839` must stay green unedited. Side effect to record: a log opened from the deployments section now ages its breadcrumb off `finished_at` (`Panel.qml:443`), satisfying `docs/design.md:234` for both entry paths.
   **Verify**: `node tests/run.js` passes; `grep -n finishedAt Model.js` shows the new `deploymentRow` line and the new `rowRev` element, and no `finishedAt` on the `historyRow` assignment line.

2. **`Model.js`: `rowTime`.** Add after `age()` (`Model.js:2148`) as in Data shapes. Tests, one `test("Model.rowTime: …")` in the `heroMeta` shape: finished fixture at `finishedAt + 4 min` → `2m 21s · 4m ago`; failed at `+12 min` → `1m 4s · 12m ago`; cancelled at `+2 d` → `6s · 2d ago`; finished at `+10 s` → `2m 21s · Just now`; active row from `deployments-active.json` at `createdAt + 80 s` → `1m 20s` with no ` · `; queued row → elapsed; terminal with `finishedAt: null` → equals `M.age(row.updatedAt, now)` (today's text); `finishedAt: "garbage"` → same; reversed pair → same; over-cap pair → same (pick a `now` where `finishedAt` and `updatedAt` fall in different minute buckets so the test is not bucket-dependent); `createdAt: null` (the `tests/run.js:1144` rows) → same; history row via `historyRow(normaliseHistory(fixture).rows[0])` with `nowMs = Date.parse(finishedAt) + 5*60000` → `29s · 5m ago`; a history row with `status: "in_progress"` and `finished_at: null` → the age (unchanged); a history row with `status: ""` and `created_at` 90 days before `nowMs` → `90d ago`, no `h`; `rowTime(null, now)` → `""`; age source: a terminal section row with both timestamps reads the age off `finishedAt` (choose a `now` where the buckets differ). Requirement 6: `rowMatches(row, ["2m"])` false on a row whose name/sub lack it.
   **Verify**: `node tests/run.js` passes.

3. **`Model.js`: cancelled toast body (only if Dan says yes; default skip).** `case "cancelled": head = "Cancelled " + A; body = dur; break` (`Model.js:766`). Test `tests/run.js:655`: `eq(cc.body, "6s")` (from `deployment-cancelled.json`); the other cancelled sites (`:692, :718, :760, :785, :832, :2268`) stay green (no parseable pair). `docs/design.md:509` Body cell → `dur`. If skipped, the build record says so and nothing in this step is touched.
   **Verify**: `node tests/run.js` passes; `bin/check --no-shell` passes (SR16 counts unchanged).

4. **`Panel.qml`: the two bindings.** `depTime` (`:1477-1478`): comment → `// Rows carry timestamps, not strings: the elapsed and the age tick with nowMs; the duration is fixed.` and `text: Model.rowTime(rowDelegate.row, root.nowMs)`. `histTime` (`:1121-1122`): same comment, `text: Model.rowTime(viewDelegate.modelData, root.nowMs)`. Nothing else in the file.
   **Verify**: `bin/check` (qmllint, validate, SR25). Live, `bin/dev-sync && omarchy restart shell`, three checks: (a) open the panel: the never-blank stand-in row reads `<duration> · <age>` with no deploy needed; open **History** from an application's strip: terminal rows read `<duration> · <age>`. (b) Deploy an application with a long commit message from the panel (`d`); while it builds open **History** from its strip: the in_progress row still reads an age (unchanged); watch the section row from finish through the first minute: `2m 21s · Just now` is on screen, the name elides and its tooltip fires, nothing overflows; the number steps back a few seconds at the finish (expected). (c) `L` on that terminal section row: the breadcrumb age equals the age part of the row (both off `finished_at`). `quickshell log -p /usr/share/omarchy/shell --tail 100` shows no new warning. If step 3 was taken: cancel a build from Coolify's web UI, not the panel (the panel's own cancel is dropped by the 300 s self-cancel rule), and confirm the toast body carries the duration.

5. **Docs.** `docs/design.md`: `:85-86` sketch rows → `2m 21s · 4m ago` (web, finished) and `1m 4s · 12m ago` (cron, failed), re-padded inside the box frame (`1m 4s`, never `1m 04s`; never a fixture's `updated_at`-derived number); `:190` "right-aligned elapsed or age" → "right-aligned: the ticking elapsed on a running row; on a terminal one how long the deployment ran, from Coolify's `created_at → finished_at`, then the age (`2m 21s · 4m ago`); the age alone when Coolify's pair is missing"; `:196-197` → "stays with its duration and age (`2m 21s · 3h ago`, `1m 4s · 2d ago`)"; `:208-209` → "A running row's elapsed ticks every second while the panel is open (a `Timer` on `root.opened`), formatted `45s`, `1m 20s`, `2h 03m`. The age beside it (`Just now`, `4m ago`, `3h ago`, `2d ago`) follows the same clock and changes once a minute. A terminal row's duration is fixed from Coolify's `created_at → finished_at` and is never recomputed."; one sentence under the deployments section: "A terminal row without Coolify's pair renders the age alone; it is not a state."; `:257` History → "right-aligned `duration · age` on a terminal row; a running row keeps its age"; `:495-496` `dur` → "`dur` is `createdAt → finishedAt` ("1m 42s"; a queue wait is inside it, Coolify has no start time), empty when either is unparseable, reversed or over 7 days; the panel's terminal rows render the same value"; `:509` only if step 3 was taken; states table `:450-481` unchanged. `docs/architecture.md:334-335` deployment record gains `finishedAt, appId, serverName`. `docs/coolify-api.md:188` → "(the plugin reads it for the age, falling back to `updated_at`; the duration is `created_at → finished_at` with no fallback: `updated_at` is 1–5 s late on every recorded row)". `docs/development.md:19` status paragraph: one clause "build duration on terminal and History rows (`docs/plans/build-duration.md`)". `docs/roadmap.md`: delete the bullet at `:232-234`, add to the "Done from this list" paragraph "**Build duration** (PR #N, merged YYYY-MM-DD; Coolify has no `started_at`, the duration is `created_at → finished_at`)" — only if PR #14 has merged.
   **Verify**: `bin/check --no-shell`; `grep -n 'span' docs/design.md` returns nothing new; `git diff --stat` lists `Model.js Panel.qml tests/run.js docs/design.md docs/architecture.md docs/coolify-api.md docs/development.md` plus `docs/roadmap.md` when #14 has merged, and nothing else.

6. **`docs/plans/build-duration.md`.** Copy this plan file verbatim (the `docs/plans/health-before-auth.md` convention); the build record `docs/plans/build-duration.build.md` is written by the implement skill beside it.
   **Verify**: `ls docs/plans/build-duration.md`; `bin/check --no-shell` (SR39 finds no real host in it: the plan names only `app.coolify.io`-free placeholders and fixture uuids).

## Verification

```sh
node tests/run.js
bin/check --no-shell          # what CI runs
bin/check                     # adds omarchy plugin validate + qmllint
bin/dev-sync && omarchy restart shell
quickshell log -p /usr/share/omarchy/shell --tail 100 | grep -i 'coolwatch\|warn'
```

Done end to end: node tests green with the new `durationOf` and `rowTime` tables; `bin/check` green; the three live checks in step 4 pass (stand-in row and History rows read `<duration> · <age>`, a real deploy shows `2m 21s · Just now` inside its first minute with the name eliding, the breadcrumb age matches); the PR from `build-duration` into `develop` is green on `check`.

## Tests to add

- `Model.durationOf` table (requirement 2; raw six-digit format; `updatedAt` trap; reversed / numeric / absurd / epoch / cap boundaries).
- `normaliseDeployment` timestamp bounding incl. `""` (requirement 1).
- `deploymentRow.finishedAt` pass-through and `null`; `historyRow.finishedAt` equals the fixture; section/History consistency from one record.
- `sameRows`: `finishedAt` is a rev field, `updatedAt` still is not (requirement 5).
- `panelRows`: terminal rows from `recent` carry `finishedAt`.
- `Model.rowTime` table (usage rows, the four fallbacks, `createdAt: null`, History terminal with explicit `nowMs`, History in_progress unchanged, History unmapped status months old (requirement 7), `null` row, age source).
- `rowMatches` does not match on the duration (requirement 6).
- Only if step 3: `notifyCopy` cancelled body `6s`.
- Unchanged and confirmed green without edits: `:753` (`logRequestRow` `""`), `:839` (recent round-trip), `:1879` (overlay key set), `:1290` (`updatedAt` not a rev field), `:643-666` (notify bodies).

## Risks and open questions

- **Risk: the terminal row's name/commit line loses ~54 px** (about 28% at the default width) to `2m 21s · Just now`. Accepted: terminal row only, whose commit message has stopped being actionable and which already gives 22 px to the `×`; the name keeps its tooltip. Live check (b) is the evidence.
- **Risk: the running row's number steps back a few seconds when the build ends.** Correct and expected; do not "fix" with `updatedAt`.
- **Risk: `durationOf`'s hardening changes toast bodies for a reversed or absurd pair** (`0s` / a huge number today, `""` after). Intended; no pinned body changes.
- **Risk: the section's terminal age moves from `updatedAt` to `finishedAt`** (1–5 s). Intended alignment with History and `panelRows`; pinned by the age-source test.
- **Open (Dan's copy call): should the cancelled toast gain the duration as its body** (`Cancelled xyhpwdxq` / `6s`)? For: a cancelled toast fires almost only for a cancel from elsewhere, where the time it ran is the one fact the operator lacks, and `restarted` already ships a bare-duration body. Against: the empty body is the documented compact one-line toast for a `low` event. Default: no (the brief's default of leaving toast copy alone); yes = build step 3.
- **Open: the duration cap.** Default `DURATION_MAX_MS` = 7 days (`168h 00m` renders; longer reads as today's age alone). If a deployment on Dan's Coolify can legitimately sit queued longer, raise it; if a day is the honest ceiling, lower it. One literal, two boundary assertions.
- **Open: does a restart-only deployment carry `finished_at` on 4.3.x?** No fixture records one. Default: irrelevant; the row and the `restarted` toast degrade to no duration.

## Out of scope

Progress or ETA; the "build ran past its usual duration" toast (`docs/roadmap.md:253`); a duration in the build-log breadcrumb (`docs/design.md:234`) or routing the breadcrumb through `rowTime`; History running rows switching to elapsed; `r refetch` in the history footer hint (`Model.js:1845`, a pre-existing gap); a commit-message tooltip (sibling item); the History main text still reading `cancelled-by-user` (`Panel.qml:1104`, pre-existing); `2m 0s` → `2m 00s`; a lowercase `just now`; a two-line right column; any `recent.json` shape change; bounding timestamps in `recentEntry`; the preview-builds item; `CHANGELOG.md` (release time).

## Panel record

| member | model | wave | findings | accepted | rejected (reason) |
|---|---|---|---|---|---|
| architect | opus | 1 | 8 | 8 | — (its History-running-rows-keep-age rule and cancelled-body-empty default are the ones v2 ships) |
| reuse-scout | opus | 1 | 8 | 8 | — (#6 resolved by `finishedAt` in `rowRev`, no string on the row) |
| security-analyst | opus | 1 | 9 | 8 | #1/#6 "compute the string in the row builder" (the age must tick, so the delegate reads `nowMs` anyway; `rowTime` is the pinned pure function and `finishedAt` in `rowRev` gives the repaint; the raw-timestamp bound at `normaliseDeployment` is taken) |
| ux-api-designer | opus | 1 | 12 | 9 | #1/#2 `dur` string on the row (as above); #6 History running rows to elapsed (reverted in v2: brief keeps running rows, the view never refreshes, unmapped statuses count up); breadcrumb `:234` edit (out of scope); #10 cancelled-by-user mapping (pre-existing); #8 cancelled body taken as an open question with default no, not as the default |
| data-analyst | opus | 1 | 10 | 10 | — (#5 taken as `durationOf`'s bounds plus the `createdAt: null` test, not a `parseRecent` change) |
| security-analyst | opus | 2 | 2 | 2 | — |
| ux-api-designer | opus | 2 | 6 | 6 | — (#5 answered by reverting the History elapsed switch; `r refetch` hint listed out of scope) |
| data-analyst | opus | 2 | 6 | 6 | — |
| reuse-scout | opus | 2 | 5 | 5 | — (two decorative reuse entries dropped) |
| code-reviewer | opus | 2 | 8 | 8 | — |
| skeptic | opus | 2 | 9 | 8 | #2 "block on Dan before building" for the cancelled body (the skill never blocks after framing; it is an open question with the brief's default of no, and the delivery reply asks him) |

Deviations: the user asked for "opus 5"; the Agent tool takes the alias `opus`. Situational members added: ux-api-designer (row and toast copy), data-analyst (`recent.json` persistence). Not run: ops-analyst (no CI/config change), perf-analyst (no request, an existing tick). Wave 2 produced one critical (the age fallback chain, found independently by data-analyst and code-reviewer) that changed a code block, not the design, so no extra loop was run.
