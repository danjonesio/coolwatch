# IPC verbs by name

Branch `ipc-verbs-by-name` from `develop`, PR into `develop` (`gh pr create -B develop`). Dan merges. Backlog item: `docs/roadmap.md:245-246` "IPC verbs by name".

Note for the builder: at planning time `develop` is at 13303b9 and PR #16 (`roadmap-duration-done`, the "Done from this list" paragraph in `docs/roadmap.md`) is still open. Step 5's roadmap edit appends to that paragraph, so do it only if #16 has merged; otherwise leave `docs/roadmap.md` alone and say so in the build record. Every line number below was checked against 13303b9; Verify greps are anchored to patterns where an edit moves lines.

## Context

The CLI form is `omarchy-shell io.github.danjonesio.coolwatch deploy <uuid>` (`README.md:170`, `docs/development.md:285`; `omarchy-shell <target> <method> [args]` runs `qs ipc … call -- "$@"`, `/usr/share/omarchy/bin/omarchy-shell:59`; there is no `ipc -t` form). The operator's uuid comes from `status` or Coolify's URL bar; the panel itself shows a label (`Model.appLabel`, `Model.js:686-692`, rendered by `resourceRow`, `Model.js:1444`), so the string on screen is never the string the CLI accepts. Today `deploy storefront` answers `unknown uuid storefront`: `storefront` passes `UUID_RE` (`/^[A-Za-z0-9]{1,64}$/`, `Model.js:44`), `actionRequest` scans and misses (`Model.js:1560`), and `_refuse`'s shared `invalid`/`unknown` arm prints `unknown uuid <u>` (`Service.qml:1629-1632`). A hyphenated name (`umami-prod`) fails `UUID_RE` and lands in the same arm with the same token.

Outcome: `deploy storefront` queues the one resource whose panel label is `storefront` on the active instance and echoes `queued deploy h0wxyg40kc0lz727dom9l03i`, the resolved uuid, the same token a uuid call echoes. `restart`, `stop`, `start` likewise. A label nothing has echoes `unknown name <argument>`; a label two things have echoes `ambiguous name <argument>`; a uuid-shaped argument the store does not hold (a deleted resource, a finished deployment) keeps today's `unknown uuid <argument>`. An argument that is a uuid in the store keeps today's path byte-for-byte (the uuid pass runs first). `log`, `instance`, `instances`, `refresh`, `status` are untouched. No new request, no new state: resolution is one pass over `ctx.snapshot.resources`, already in memory (`Service.qml:713-722`).

## Findings from exploration

- `_ipcAct` (`Service.qml:517-524`) scrubs the argument (`[\r\n\t]`→space, `trim`), refuses empty with `usage: <verb> <uuid>`, calls `root.act(verb, u, true)` and composes the success token from its own argument: `"queued " + verb + " " + u.slice(0, 64)`; it logs `u.slice(0, 8)` of raw argv on every outcome. `ctx.act` returns the bare string `"queued"` (`:1603`); that literal has one reader of the return value (`:521`; `:701` and `:1668` are deployment status / `lastAction.result`). `Panel.qml:335` and `:362` discard `act()`'s return.
- The echoed verb is the requested one, not the resolved one: `deploy <running app>` resolves to `redeploy` in `actionFor` (`Model.js:1536`) but `_ipcAct` echoes `queued deploy …`, while `status.lastAction.verb` is `redeploy` (`_finishAction`, `Service.qml:1670`). Both stay.
- `ctx.act` gate order (`Service.qml:1580-1603`): `wronginstance` → `notconfigured`/`unsafe` → `probe` → `ratelimited` → `toomany` → `Model.actionRequest` → `ipcability` → `canAct` → `_descriptorFor` → launch. The first five run before any store lookup; in every one of those states `ctx.snapshot.resources` is empty or stale (`_timersOn`, `Service.qml:712`, stops the resources poll in probe mode and while paused; `root._active` is null when unconfigured and `root.act` answers `_refuseNoContext`, `:143-150`, never reaching `ctx.act`).
- `_refuse` (`Service.qml:1620-1648`) is the whole token table: it bounds the caller's string (`[\r\n\t]`→space, `slice(0, 64)`), sets `u8 = u.slice(0, 8)` (a raw slice, not `Model.uuid8`), writes `_lastAction` for every `why` except `wronginstance`, writes the panel status line through `_say`, and logs `coolwatch action refuse <why> <verb> <u8>`. `invalid` and `unknown` share one arm. Today `u` is always caller argv or a panel row uuid. `wronginstance` is unreachable from IPC (`_ipcAct` passes no `instanceId`).
- `Model.actionRequest` (`Model.js:1547-1566`) is the single gate: `NAV_VERBS` → `UUID_RE` → a linear uuid scan over `s.resources`, `s.deployments`, `s.servers`, `s.tags` in that order, building a full row per hit, then `actionFor`. Nothing anywhere does a name→uuid lookup (`joinBranch`'s `byName`, `Model.js:559-562`, keys the raw name, is last-write-wins and exists only to join deployments to apps). `tests/run.js:2128` pins `actionRequest(s, "deployTag", "production-landing").why === "invalid"` with the comment "a tag name is not a key".
- Coolify uuids are not charset-validated at normalise: `normaliseResources:441` is `uuid: String(r.uuid || "")`, `:442` `name: String(r.name || r.uuid || "")`, so a row with neither yields `{uuid: "", name: ""}` whose label is `""` (`appLabel("", "")` is `""`; `uuid8("")` is `""`). `actionRequest` re-tests `UUID_RE` (`Model.js:1550`) and refuses with `invalid`, it does not sanitise. The codebase's existing guard is `UUID_RE` at the boundary: `normaliseTags` drops such rows (`Model.js:2078`), `logRequestRow` gates on it (`:1424`), `dismissRecent` too (`Service.qml:1678`).
- Label collision, measured over the fixtures under node: `resources.json` labels are `storefront`, `landing`, `xyhpwdxq` (generated name `xyhpwdxqu33omjgwuo6c7cjp-200537415987`, `Model.js:690` slices 8), `Storefront Prod WP`, `umami-prod`, `uptime-kuma-prod`, `authentik`; all seven distinct; four pass `UUID_RE` and three (space, hyphens) do not; none matches `/^[a-z0-9]{20,}$/`. `deployments-active.json` row 1 carries `application.name = "storefront:main-h0wxyg40kc0lz727dom9l03i"`, so `deploymentRow` (`Model.js:1411`) labels it `storefront` too: a name pass over `s.deployments` makes `deploy storefront` ambiguous exactly while storefront is building, and `actSnap()` (`tests/run.js:1422`) loads both fixtures.
- No IPC verb applies to a deployment (`logs`/`cancel`/`dismiss`/`open`), a server (`validate`) or, by name, a tag: `actionsFor` (`Model.js:1496-1524`). `deploy <tag uuid>` is a real `deployTag` fan-out today (`Model.js:1536`, pinned `tests/run.js:2125`), marked `confirm: true` (`tests/run.js:2112`), and `ctx.act` never reads `a.confirm` because CLI verbs never confirm (`Service.qml:513-514`, `docs/development.md:169-172`). `serverRow.name` is the raw `x.name` (`Model.js:1439`), not `appLabel`; `tagRow.name` is the raw tag name (`Model.js:2084`).
- `appLabel` (`Model.js:686-692`): strips `:<branch>-<uuid>` (`/:[^:]*-[a-z0-9]{20,}$/`), reduces a generated `<uuid>-<digits>` name to 8 chars (`/^[a-z0-9]{20,}-\d{6,}$/`), falls back to `uuid8(uuid)`, then `elide(n, 32)`. Both regexes are lowercase-only. `elide` (`Model.js:235-239`) collapses `\s+` to one space, trims, and replaces the 32nd character with `…`. So every label is single-line, ≤ 32 chars, whitespace-collapsed; a name longer than 32 chars renders with `…`, and two names sharing their first 31 characters render identically.
- `_ipcAct`'s scrub does not collapse whitespace runs, so `"Storefront  Prod WP"` would never equal the label unless the argument goes through the same normaliser.
- `rowMatches` / `filterTerms` (`Model.js:1319-1330`) are the type-to-filter's matcher: substring, multi-term, case-insensitive (plain `.toLowerCase()`), over name + status words + kind + sub. Wrong for exact resolution (`deploy prod` would hit three fixture rows) but the codebase's case-folding precedent (`docs/development.md:142-147`). `selectInstance` (`Service.qml:97-101`) matches its IPC argument case-sensitively; instance ids are config keys, not Coolify names.
- `actionsFor` pushes `restart` only for a running resource (`Model.js:1509`; `tests/run.js:1507` pins `stop SVC_EXITED` → `notapplicable`). `Storefront Prod WP` (`ulg0n467viqx9g7nb25pwm6t`) is exited; `umami-prod` (`iyoi5i0ot4nwvoz9zbkbnjsp`) is `running:healthy`.
- `Model.uuid8` (`Model.js:682`) strips non-alphanumerics and slices 8; `Model.js:683-684` states the rule "everything that reaches a log line goes through here" (SR15). `_ipcLog:530` logs no argument at all on its invalid branch. `Model.uuid8(` already appears at `Service.qml:1220, 1454, 1459, 1908`; `a.uuid.slice(0, 8)` on post-gate uuids at `:1601`, `:1673`.
- `snap()` (`tests/run.js:58-66`) has no `tags` key; `loadedSnap` (`:67-79`) does not add one; `actSnap(extra)` (`:1422-1425`) loads `resources.json` + `deployments-active.json` + `servers.json` and passes `extra` through `Object.assign`, so `actSnap({ tags: M.normaliseTags(fx("tags.json")) })` works (`normaliseTags`, `Model.js:2071`, keeps both fixture tags). Constants `APP`, `SVC_EXITED`, `SVC_RUNNING`, `SRV` at `:1420`. `hits.indexOf(x) < 0` is the existing dedupe idiom (`Model.js:597`). Key-shape assertion precedent: `tests/run.js:2082`. Not one IPC stdout token is pinned by a node test; the tokens live in QML.
- `bin/check`: SR26 (`:66-68`) bans `console.*` in `Service.qml` naming `.output/.entries/.lines/.text/logs`; SR16 (`:84-109`) pins argv literals in `Model.js`; SR40 (`:111-125`) counts exact literals in `Service.qml`. No gate reads the README's IPC block or the token lists. Nothing pins the `IpcHandler` parameter names (`Service.qml:560-563`, `function deploy(uuid: string)`); `omarchy-shell` has no introspection path, `qs ipc show` is where a parameter name is visible.
- `status` exposes `counts.resources` (`Service.qml:1916`) and `baseline.resources` (`:1942`): the observable for "the first resources poll has landed".
- Token lists and ledger lines to keep in step: `README.md:170` + closing prose `:179-181`; `docs/architecture.md:36-47` (full list; the 64-char one-line echo rule at `:46-47`), `:533-542` (`actionRequest` as the single gate), `:564-566` (`lastAction` shape for `status` consumers), `:620-624` (security item 16: "IPC verbs are exactly `deploy restart stop start`: a no-confirm destructive surface open to any local process"), `:701-704` (SR38); `docs/development.md:285` (copy-paste block), `:174` ("`d` and IPC `deploy` resolve the same way"), `:126` (row names pass `appLabel`), `:19-20` (latest landed work); `docs/design.md:354-360` (the status-line inventory; `:358` "Coolify no longer has that resource|deployment|server" is the panel's vanished-row line and stays).
- There is no `y` key (`grep -n 'Key_Y\|"y"\|wl-copy' Panel.qml` is empty; keys are `Panel.qml:698-708`); "`y` copies the cursor row's uuid" is an unbuilt sibling backlog item.
- Feature convention: `docs/plans/<name>.md` beside `<name>.build.md`, the plan copy committed first (`docs/plans/phase-4-depth.md:52`); the status paragraph at `docs/development.md:19-20` names the latest landed work.

## Design

### Caller's usage first

```sh
ID=io.github.danjonesio.coolwatch
$ omarchy-shell $ID deploy storefront                  # label on the active instance
queued deploy h0wxyg40kc0lz727dom9l03i                 # the resolved uuid, never the argument
$ omarchy-shell $ID status | jq -c .lastAction
{"verb":"redeploy","uuid8":"h0wxyg40","code":200,"curlExit":0,"ms":412,"at":…,"result":"queued","instance":"cloud"}

$ omarchy-shell $ID restart "UMAMI-PROD"               # case-insensitive
queued restart iyoi5i0ot4nwvoz9zbkbnjsp
$ omarchy-shell $ID start "storefront  prod wp"        # whitespace runs collapse, as the panel's label does
queued start ulg0n467viqx9g7nb25pwm6t
$ omarchy-shell $ID deploy umami-prod                  # resolves, then the verb does not apply to a service
not applicable deploy iyoi5i0ot4nwvoz9zbkbnjsp         # the resolved uuid; lastAction.uuid8 "iyoi5i0o"
$ omarchy-shell $ID deploy storefrnt
unknown name storefrnt                                 # lastAction.result "refused", uuid8 ""
$ omarchy-shell $ID deploy api                         # two resources labelled api (or Api and API)
ambiguous name api                                     # lastAction.result "refused", uuid8 ""
$ omarchy-shell $ID deploy h0wxyg40kc0lz727dom9l03i    # uuid in the store: unchanged
queued deploy h0wxyg40kc0lz727dom9l03i
$ omarchy-shell $ID deploy zzzzzzzzzzzzzzzzzzzzzzzz    # uuid-shaped, not in the store (deleted, or a finished deployment): unchanged
unknown uuid zzzzzzzzzzzzzzzzzzzzzzzz                  # lastAction.uuid8 "zzzzzzzz", as today
$ omarchy-shell $ID deploy
usage: deploy <uuid|name>
$ omarchy-shell $ID deploy storefront                  # unconfigured / probe / paused: the gate wins, as today
not configured | token rejected | rate limited
```

Quickshell log, one `ipc` line per call: `coolwatch ipc deploy h0wxyg40 -> queued` on success (the resolved uuid through `Model.uuid8`); `coolwatch ipc deploy - -> unknown`, `- -> ambiguous`, `- -> not`, `- -> already`, `- -> rate` for every other outcome (today the line carries the argument's first 8 raw characters on every outcome; the argument may now be a name, so it is dropped from this line; `_refuse`'s own line `coolwatch action refuse <why> <verb> <u8>` carries the resolved uuid8 for every refusal that has one and `-` for a name refusal).

Panel status line (`_say`, dim, 2.2 s, in the voice of `docs/design.md:356` "Nothing to start"): `No match for that name`; `That name matches more than one resource`.

What a name is: the string the panel row shows for a resource, `Model.appLabel(r.name, r.uuid)`, compared after the argument has gone through the same `appLabel` (so whitespace runs collapse, a pasted decorated `repo:branch-<uuid>` name resolves, a generated-name app resolves by its `uuid8`, and a name of 32 or more characters resolves when typed in full because both sides elide identically). Exact match first; if nothing matches exactly, a case-folded match (so `api` beside `API` each resolve, and `Api` refuses). Resources only: applications, services, databases. Not deployments (their label is the application's), not servers (no IPC verb applies; `serverRow` does not use `appLabel`), not tags (an unconfirmed fan-out from a guessable word, SR35). No prefix, no substring, no fuzzy. A miss on a uuid-shaped argument (`/^[a-z0-9]{20,}$/`, the same shape `appLabel` itself treats as a uuid, `Model.js:688, 690`) is answered as a uuid miss, `unknown uuid <argument>`, exactly as today; every other miss is `unknown name <argument>`.

### Data shapes

```js
// Model.resolveActionTarget(s, arg) →
{ ok: true,  uuid: "h0wxyg40kc0lz727dom9l03i", by: "uuid" }   // arg passes UUID_RE and a resource/deployment/server/tag holds it
{ ok: true,  uuid: "h0wxyg40kc0lz727dom9l03i", by: "name" }   // exactly one resource label matches (exact, else folded); the uuid is UUID_RE-clean
{ ok: false, why: "unknownname" }                             // no label matches and the argument is not uuid-shaped; also "" and > 64 chars
{ ok: false, why: "unknown" }                                 // no label matches and the argument is uuid-shaped: today's arm, today's token
{ ok: false, why: "ambiguousname" }                           // two or more distinct resource uuids match
```
The return carries a uuid and a verdict, never a name or a row (a shape test pins the keys). The `by: "name"` uuid has passed `UUID_RE` inside the resolver, so `actionRequest`'s re-test cannot fail on it and `_refuse`'s `invalid` arm is unreachable from IPC. New tokens: `unknown name <argument>`, `ambiguous name <argument>`: the operator's own argument, bounded and single-lined by `_refuse` exactly as `unknown uuid <argument>` is today, never a matched Coolify name.

### Module map

| File | Change |
|---|---|
| `Model.js` | after `actionRequest` (`:1566`): `IPC_ARG_MAX`, `UUID_SHAPED_RE`, `holdsUuid(s, uuid)`, `resolveActionTarget(s, arg)`. `actionRequest` untouched |
| `Service.qml` | one unit: resolution in `ctx.act` between the `toomany` gate (`:1586`) and `Model.actionRequest` (`:1587`), behind `fromIpc`; `return "queued " + a.uuid` (`:1603`); two arms in `_refuse` (`:1629-1641`) and `(u8 || "-")` in its log line (`:1647`); `_ipcAct` (`:517-524`) usage line, echo, console line; `IpcHandler` parameter names (`:560-563`); comment `:513-515` |
| `tests/run.js` | one `test("Model.resolveActionTarget: …")` after the `actionRequest` gate test (`:1522`) |
| `README.md` | `:170` usage line; one sentence in the closing prose `:179-181` |
| `docs/architecture.md` | `:39-47` token list, resolver rule, echo sentence; `:533-542` one line; `:564-566` `uuid8` note; `:620-624` item 16; `:701-704` SR38 clause |
| `docs/design.md` | `:356` status-line inventory gains the two dim refusals |
| `docs/development.md` | `:285` token list + `<uuid|name>`; `:174` sentence; `:19-20` landed-work clause |
| `docs/roadmap.md` | `:245-246` bullet removed, done paragraph extended (only if PR #16 has merged) |
| `docs/plans/ipc-verbs-by-name.md` | this plan, verbatim, the branch's first commit |
| Not touched | `Api.js`, `Panel.qml`, `BarWidget.qml`, `bin/check`, fixtures, `actionRequest`, `_ipcLog`, `_ipcInstance`, `rowMatches`, `notifySafe`, `appLabel`, `CHANGELOG.md` |

### Interfaces

```js
// Model.js, directly after actionRequest (:1566)
var IPC_ARG_MAX = 64          // the IPC argument's own bound: UUID_RE's ceiling and _refuse's echo bound (not FILTER_MAX_TERM: a filter term is a different input)
var UUID_SHAPED_RE = /^[a-z0-9]{20,}$/   // what appLabel treats as a Coolify uuid (the {20,} runs at :688 and :690); a miss on this shape is a uuid miss
// The four lists actionRequest scans (:1553-1559), by presence only. Kept beside the gate
// rather than extracted from it so the single gate stays byte-for-byte; a fifth list goes in both.
function holdsUuid(s, uuid) {
  return [s.resources, s.deployments, s.servers, s.tags].some(function (l) {
    return (l || []).some(function (x) { return !!x && x.uuid === uuid })
  })
}
// Turns an IPC argument into a store uuid, in front of actionRequest (which stays the gate).
// Uuid first, over every list the gate scans, so an existing uuid never changes meaning; then
// the resource label the panel shows (appLabel on both sides: whitespace collapses, a pasted
// decorated name and a 32+-char name both elide the same way; appLabel's regexes are
// lowercase-only, so an upper-cased decorated paste does not resolve while an upper-cased
// label does), exact first, then case-folded. Resources only: a deployment's label is its
// application's, no verb applies to a server, and a tag name would fan out unconfirmed (SR35).
// A row whose uuid fails UUID_RE is invisible (normalise does not charset-check uuids; the
// same drop normaliseTags makes at :2078), so a name never resolves to a string that would
// fail the gate's re-test and reach stdout, the log or status through _refuse.
function resolveActionTarget(s, arg) {
  var a = String(arg === undefined || arg === null ? "" : arg).trim()
  if (!a || a.length > IPC_ARG_MAX) return { ok: false, why: "unknownname" }
  s = s || {}
  if (UUID_RE.test(a) && holdsUuid(s, a)) return { ok: true, uuid: a, by: "uuid" }
  var label = appLabel(a, ""), want = label.toLowerCase(), exact = [], folded = []
  if (want) (s.resources || []).forEach(function (r) {
    if (!r || !UUID_RE.test(r.uuid)) return
    var l = appLabel(r.name, r.uuid)
    if (l === label && exact.indexOf(r.uuid) < 0) exact.push(r.uuid)
    if (l.toLowerCase() === want && folded.indexOf(r.uuid) < 0) folded.push(r.uuid)
  })
  var hits = exact.length ? exact : folded
  if (hits.length === 1) return { ok: true, uuid: hits[0], by: "name" }
  if (hits.length) return { ok: false, why: "ambiguousname" }
  return { ok: false, why: UUID_SHAPED_RE.test(a) ? "unknown" : "unknownname" }
}
```
Measured under node against the fixtures with this exact code: every row of the step 1 test table below holds (`storefront`/`STOREFRONT`/`  storefront `/decorated raw name → `APP` by name; `Storefront  Prod  WP` → `SVC_EXITED`; `xyhpwdxq` and its raw generated name → `xyhpwdxqu33omjgwuo6c7cjp`; `worker`, `hetzner-1`, `production-landing`, `canary`, `storefron`, `h0wx`, `storefrnt` → `unknownname`; `zzzzzzzzzzzzzzzzzzzzzzzz` → `unknown`; the server, tag and deployment uuids → `by: "uuid"`; `api`/`API` rows: `api` → first, `API` → second, `Api` → `ambiguousname`; `{uuid: "../../etc/passwd", name: "hostile"}` → `unknownname`; the empty row + `":x-" + "a".repeat(20)` → `unknownname`; two 40+-char names sharing 31 characters → `ambiguousname`).

```qml
// Service.qml ctx.act, inserted after the toomany gate (:1586), before Model.actionRequest (:1587)
// The panel hands a row uuid; the CLI may hand a label. Resolution sits after the readiness
// gates so not configured / token rejected / rate limited keep winning over unknown name.
var target = uuid
if (fromIpc) {
  var t = Model.resolveActionTarget(ctx.snapshot, uuid)
  if (!t.ok) return ctx._refuse(t.why, verb, uuid)      // "unknown" lands in today's arm with today's token
  target = t.uuid                                       // from here on every token, log and lastAction carries the uuid, not the argument
}
var a = Model.actionRequest(ctx.snapshot, verb, target)
if (!a.ok) return ctx._refuse(a.why, verb, target, targetHint)
if (fromIpc && ctx._ipcAbilityStreak >= 3) return ctx._refuse("ipcability", a.verb, target)
…
return "queued " + a.uuid                               // the one reader of the return is _ipcAct; the panel discards it
```
```qml
// Service.qml _refuse: two arms beside "invalid"/"unknown" (:1629); the log and lastAction get no argument
case "unknownname": ctx._say("No match for that name", "dim"); token = "unknown name " + u; u8 = ""; break
case "ambiguousname": ctx._say("That name matches more than one resource", "dim"); token = "ambiguous name " + u; u8 = ""; break
// :1647
console.log("coolwatch action refuse " + why + " " + String(verb || "").slice(0, 16) + " " + (u8 || "-"))
```
```qml
// Service.qml _ipcAct. The log line names the resolved uuid on success and nothing otherwise:
// the argument may be a Coolify name, and the refuse line already carries the uuid8 (SR15).
function _ipcAct(verb, target) {
  var u = String(target === undefined || target === null ? "" : target).replace(/[\r\n\t]/g, " ").trim()
  if (!u) return "usage: " + verb + " <uuid|name>"
  var parts = root.act(verb, u, true).split(" "), queued = parts[0] === "queued"
  var token = queued ? "queued " + verb + " " + parts[1].slice(0, 64) : parts.join(" ")
  console.log("coolwatch ipc " + verb + " " + (queued ? Model.uuid8(parts[1]) : "-") + " -> " + parts[0])
  return token
}
```
```qml
// Service.qml IpcHandler: the parameter name is what `qs ipc show` prints
function deploy(target: string): string { return root._ipcAct("deploy", target) }   // and restart, stop, start; log(uuid) stays
```

### Rejected alternatives

- **Resolve in `_ipcAct` before `root.act`** (no change to `ctx.act`). `Service.qml:1583-1586` answers `not configured`, `config unsafe`, `token rejected`, `rate limited` before any store lookup, and in every one of those states the resources list is empty or stale, so `deploy storefront` would print `unknown name storefront` and hide the diagnosis. Also `root._active` is null when unconfigured, so `_ipcAct` would need its own null path beside `_refuseNoContext`.
- **Call `root.act` twice** (uuid, then name on a miss). `_refuse` writes `_lastAction`, `_say` and a log line on the first miss, so a successful deploy-by-name would leave `status.lastAction.result === "refused"` and a stale status line.
- **A `ctx._ipcTarget` property** to carry the resolved uuid back. State plus a "nothing clears it in the same tick" argument, for a value the return string can carry; the `"queued"` literal has one reader.
- **Extract `actionRequest`'s scan into a shared `targetIn(s, uuid)`** so the four lists are written once. It refactors the function the architecture doc calls the single gate (`docs/architecture.md:537`) and builds four row objects plus `origin()` to answer a boolean. `holdsUuid` leaves the gate byte-identical at the cost of naming the four lists twice, with a comment in `holdsUuid` pointing at the gate; a fifth list is a two-line change.
- **Name pass over every list `actionRequest` scans.** Deployments make the headline case ambiguous while a build runs; tags turn one guessable word into an unconfirmed fan-out; servers have no applicable verb and do not use `appLabel`. The uuid pass keeps all four lists so `deploy <tag uuid>` keeps fanning out.
- **Name resolution inside `actionRequest`.** Fails `tests/run.js:2128` (a tag name must stay `invalid`) and the fix is the hole.
- **`rowMatches` as the comparator.** Substring, multi-term, over status/kind/sub: `deploy prod` hits three rows.
- **Case-folding only** (no exact pass first). Strictly less resolvable: `api` beside `API` would refuse `api`, the roadmap's own example. The ladder costs one array.
- **A raw-`r.name` second pass** so two long names sharing their first 31 characters can be told apart by typing them in full. It makes the CLI resolve what the panel shows identically, and the brief pins "the label the panel renders". Accepted limit: such a pair is uuid-only (risk below, README sentence, test).
- **Retire `unknown uuid` from IPC (a single `unknown name` for every miss).** The commonest real miss is a stale uuid (a deleted resource, a finished deployment: neither `holdsUuid` nor `actionRequest` scans `s.recent`), and `unknown name <24-char uuid>` is the wrong category; the discriminator is the shape `appLabel` already uses. Cost: a 20+-character all-lowercase-alphanumeric label typo reads `unknown uuid`; no fixture label is that shape. Open question below with this default.
- **`ambiguous name <arg>: <uuid>, <uuid>`** listing candidates. The roadmap's token is bare and the panel shows the two rows with their kind and branch where the CLI cannot. With the `UUID_RE` guard the uuids would be clean, so this is a product call, not a safety one. Open question below with default no.
- **`Model.notifySafe(arg, 64)` for the echo.** The argument is the caller's own argv echoed to the caller's own terminal, not Coolify data; `notifySafe` would redact a numeric name and rewrite a leading `-` to U+2011, changing a string scripts compare. `_refuse`'s existing bound (`[\r\n\t]`→space, 64 chars) is what `unknown uuid <arg>` already does; its lack of a control-character strip is pre-existing and out of scope.
- **Moving the two new tokens into `Model.js`** so node pins them. Splits the token table (`_refuse`) in two; the tokens are pinned by the live check and the doc lists, as every other token is.
- **A `bin/check` counter** for `Model.uuid8(` in `_ipcAct` or a zero count of `slice(0, 8)`. `Model.uuid8(` already appears four times in `Service.qml` and `slice(0, 8)` is legitimate at `:1601`, `:1673`, so neither a floor nor a zero gate discriminates; step 2's pattern-anchored grep plus the resolver's shape test cover it.
- **Servers by name** so `restart hetzner-1` reads `not applicable` instead of `unknown name`. No IPC verb applies to a server and `serverRow` has no `appLabel`, so the rule would need a second name source. Open question below with default no.
- **Live check (g), a deliberately unconfigured instance.** `configDirPath` is hard-wired to `$HOME/.config/coolwatch` (`Service.qml:23`); the check needs Dan's real config edited, a `recent-<id>.json` and a `ui.json` entry written and the active instance switched. The property it proves is textual (the block's position between `:1586` and `:1587`, and `root.act`'s null path at `:143-145`); step 2's Verify greps it.

## Reuse

- `Model.js:686-692` `appLabel` + `:235-239` `elide`: the one label function, used on both sides of the comparison, so screen and CLI agree by construction and the argument is bounded and whitespace-collapsed by the same code; its `[a-z0-9]{20,}` runs are where `UUID_SHAPED_RE` comes from.
- `Model.js:1547-1566` `actionRequest`: stays the single applicability gate (SR3, `docs/architecture.md:537`), untouched; the resolver hands it a uuid.
- `Model.js:44` `UUID_RE`: the uuid-pass precondition (as in `actionRequest`) and the name-pass row guard (as in `normaliseTags:2078`, `logRequestRow:1424`, `dismissRecent` `Service.qml:1678`).
- `Model.js:682` `uuid8`: the sanctioned way a uuid reaches a log line (SR15).
- `Model.js:1326` `rowMatches`'s plain `.toLowerCase()`: the case-folding idiom; `Model.js:597` `indexOf(x) < 0`: the dedupe idiom.
- `Service.qml:1620-1648` `_refuse`: the only token table, `_say` writer and `_lastAction` writer; two `case` arms, no second table; its `invalid`/`unknown` arm is reused as-is for uuid-shaped misses.
- `Service.qml:517-524` `_ipcAct`: the existing scrub, 64-char echo bound and `split(" ")[0]` idiom; edited, not paralleled.
- `Service.qml:713-722` `ctx.snapshot`: the in-memory store; no request.
- `tests/run.js:1420-1425` `APP`/`SVC_EXITED`/`SVC_RUNNING`/`SRV` + `actSnap`, `:67-79` `loadedSnap`, `:2082` the key-shape assertion precedent, `:1499-1522` the gate test the new test sits beside.
- `tests/fixtures/resources.json`: decorated (`storefront`, `landing`), generated (`xyhpwdxq`), spaced (`Storefront Prod WP`), hyphenated (`umami-prod`) labels; `deployments-active.json` supplies the `storefront` collision and the deployment-only name `worker`; `servers.json` `hetzner-1`; `tags.json` `production-landing`, `canary`. No new fixture.
- `docs/development.md:280-292`: the `status | jq` one-liner pattern the live check follows.
- `docs/plans/build-duration.md`: the plan-file shape including the "Note for the builder" paragraph.

## Security requirements

1. **No name reaches stdout, a log line or `status`.** The resolver returns `{ok, uuid, by}` / `{ok, why}` only (shape test); `_ipcAct` logs `Model.uuid8(resolved uuid)` or `-`; the two new `_refuse` arms set `u8 = ""` so `lastAction.uuid8` carries no argument text and the refuse log line prints `-`; the echo tokens carry the caller's own argument through `_refuse`'s existing `[\r\n\t]`→space + `slice(0, 64)`. Steps 1, 2.
2. **A name resolves only to a `UUID_RE`-clean uuid.** The name pass skips any row whose uuid fails `UUID_RE`, so `actionRequest`'s re-test cannot fail on a resolved uuid and `_refuse`'s `invalid` arm (raw `u.slice(0, 8)` into `lastAction`, the token, the log) is unreachable from IPC. Tests: `{uuid: "../../etc/passwd", name: "hostile"}` → `unknownname`; `{uuid: "", name: ""}` present and `":x-" + "a".repeat(20)` → `unknownname` (comment naming SR15). Step 1.
3. **Uuid-first precedence.** An argument that passes `UUID_RE` and is held by any of the four lists resolves by uuid before any label is looked at, so a resource named after another resource's uuid cannot steal by-uuid calls. Test: a resource named `APP` beside the real `APP` → `by: "uuid"`, `uuid === APP`. Step 1.
4. **Tags never resolve by name** (SR35). Name pass over `s.resources` only; `tests/run.js:2128` stays green unedited; `"production-landing"` and `"canary"` with `tags.json` loaded → `unknownname`. Step 1.
5. **Deployments and servers never resolve by name.** `"storefront"` with `deployments-active.json` loaded → `APP`, not ambiguous; `"worker"` → `unknownname`; `"hetzner-1"` → `unknownname`. Step 1.
6. **Ambiguity refuses, never picks first.** One comparator per pass (`appLabel(...)` exact, then `.toLowerCase()`), distinct uuids counted; the fold runs only when the exact pass is empty. Tests: `api`/`API` rows: `api` → first, `API` → second, `Api` → `ambiguousname`; duplicate-uuid rows → `ok`. Step 1.
7. **Bounded work and input.** Argument capped at `IPC_ARG_MAX` (64) before `appLabel` runs; one pass over `s.resources`; missing lists tolerated; `resolveActionTarget(undefined, x)` and a `null` row do not throw. Tests: `"x".repeat(65)` → `unknownname`; `snap()` shape; `resources: [null]`. Step 1.
8. **The readiness gates keep their answers.** Resolution runs after `toomany` (`Service.qml:1586`) and before `actionRequest`, against `ctx.snapshot` (active instance by construction, SR38); `root.act`'s `_refuseNoContext` path (`:143-145`) never reaches it. Step 2's Verify greps the block's position. Step 2.
9. **Uuid-shaped misses keep today's arm, token, `lastAction.uuid8` and log line.** `why: "unknown"` routes to the existing `invalid`/`unknown` arm with the argument, which is alphanumeric by `UUID_SHAPED_RE`. Test: `zzzzzzzzzzzzzzzzzzzzzzzz` → `why: "unknown"`. Step 1.
10. **`actionRequest` is untouched**: `git diff Model.js` shows no hunk inside it; `tests/run.js:1499-1522`, `:2119-2133` green unedited. Step 1.
11. **No new request, no new state, no state-file field, no `bin/check` count change:** `git diff --stat` touches no `Api.js`, no fixture; `bin/check --no-shell` green. Steps 1, 2.
12. **No confirm rule widens.** `ctx.act` still never reads `a.confirm`; the name pass cannot reach a `confirm: true` row because tags are excluded. Step 1.

## Changes

0. **Plan copy first.** `docs/plans/ipc-verbs-by-name.md` is this file verbatim, the branch's first commit (`docs/plans/phase-4-depth.md:52`).
   **Verify**: `ls docs/plans/ipc-verbs-by-name.md`; `bin/check --no-shell` (SR39: the plan names only fixture uuids and placeholders).

1. **`Model.js`: `IPC_ARG_MAX`, `UUID_SHAPED_RE`, `holdsUuid`, `resolveActionTarget`** directly after `actionRequest` (`:1566`) as in Interfaces, comments included. Test, one `test("Model.resolveActionTarget: uuid first, then one exact label over resources only (IPC verbs by name)")` after `:1522`, with `const rs = actSnap().resources` and `const ok = (r) => Object.keys(r).join(",")`:
   - `resolveActionTarget(actSnap(), "storefront")` → `{ok:true, uuid: APP, by:"name"}`; `"STOREFRONT"`, `"  storefront "` → same; `"Storefront  Prod  WP"` and `"storefront prod wp"` → `SVC_EXITED`.
   - `"xyhpwdxq"` → `xyhpwdxqu33omjgwuo6c7cjp`; `"xyhpwdxqu33omjgwuo6c7cjp-200537415987"` → same, `by: "name"`; `"storefront:main-h0wxyg40kc0lz727dom9l03i"` → `APP`, `by: "name"`.
   - A 41-char name resolves by its full text: `actSnap({ resources: rs.concat([{uuid: "longname000000000000001", name: "a-very-long-application-name-that-goes-on"}]) })` → that uuid; with a second row `longname000000000000002` `"a-very-long-application-name-that-ends-elsewhere"` → `ambiguousname` (the 31-character limit, pinned as a decision).
   - Uuid-first (requirement 3): `rs.concat([{uuid: "zzzzzzzzzzzzzzzzzzzzzzzz", name: APP}])`: `APP` → `{by:"uuid", uuid: APP}`; `"zzzzzzzzzzzzzzzzzzzzzzzz"` → `by:"uuid"`.
   - Uuid pass covers every list: with `actSnap({ tags: M.normaliseTags(fx("tags.json")) })`, `SRV`, `s.deployments[0].uuid`, `s.tags[1].uuid` → `by:"uuid"`.
   - Resources only (requirements 4, 5): `"storefront"` with the active deployments loaded → `APP`; `"worker"`, `"hetzner-1"` → `unknownname`; `"production-landing"`, `"canary"` with tags loaded → `unknownname` (comment: SR35).
   - No prefix: `"storefron"`, `"h0wx"`, `"xyhpwdx"` → `unknownname`.
   - Uuid-shaped miss (requirement 9): `"zzzzzzzzzzzzzzzzzzzzzzzz"` on the plain snapshot → `why: "unknown"`; `"storefrnt"` → `unknownname`.
   - Ambiguity (requirement 6): `storefront:main-<u1>` / `storefront:staging-<u2>` rows → `"storefront"` → `ambiguousname`; `api` + `API` rows: `"api"` → the `api` uuid, `"API"` → the `API` uuid, `"Api"` → `ambiguousname`; the same resource listed twice → `ok`.
   - Guards (requirements 2, 7): `{uuid: "../../etc/passwd", name: "hostile"}` → `"hostile"` → `unknownname`; `{uuid: "", name: ""}` present → `":x-" + "a".repeat(20)` and `""` → `unknownname`; `" "`, `"x".repeat(65)` → `unknownname`; `resolveActionTarget(undefined, "storefront")`, `resolveActionTarget(snap(), "storefront")` (no `tags`), `resources: [null]` do not throw; key shapes: `ok(hit) === "ok,uuid,by"`, `ok(miss) === "ok,why"` (requirement 1).
   - Untouched and green: `:1499-1522`, `:2119-2133`, `:597-605`.
   **Verify**: `node tests/run.js` passes; `git diff -U0 Model.js | grep -c '^@@'` equals 1 (one hunk, after `actionRequest`); `grep -ac 'resolveActionTarget' tests/run.js` ≥ 1.

2. **`Service.qml`, one unit** (steps that split here leave a wrong echo no Verify sees): the `ctx.act` block, the `return "queued " + a.uuid`, the two `_refuse` arms with `u8 = ""`, `(u8 || "-")` in `_refuse`'s log line, the `_ipcAct` rewrite, the four `IpcHandler` parameter renames (`log(uuid)` stays), and one clause in the comment above `_ipcAct` ("a name is the label the panel shows, resolved in `ctx.act` after the readiness gates; the `ipc` log line names the resolved uuid or nothing"). Every later use of the old `uuid` local inside `ctx.act` (`actionRequest`, the `_refuse` calls, `ipcability`) receives `target`; the `_refuse` calls for the resolver's own misses receive the argument.
   **Verify**: `bin/check` (qmllint) passes; `grep -n 'resolveActionTarget' Service.qml` shows exactly one call and `awk '/_requestsLastMin\(\) >= 120/{a=NR} /resolveActionTarget/{b=NR} /Model.actionRequest\(ctx.snapshot/{c=NR} END{print (a<b && b<c)}' Service.qml` prints 1; `grep -n '"queued"' Service.qml` lists only the deployment-status and `lastAction.result` sites (neither `_ipcAct` nor `ctx.act`'s return); `grep -n 'unknown name\|ambiguous name' Service.qml` shows both only inside `_refuse`; `sed -n '/function _ipcAct/,/^  }/p' Service.qml | grep -c 'slice(0, 8)'` prints 0; `grep -n 'function deploy\|function restart\|function stop\|function start' Service.qml` shows `target: string` on all four and `function log(uuid: string)` unchanged.

3. **Docs.** `README.md:170` → `deploy|restart|stop|start <uuid|name>   # -> "queued deploy <uuid>" or why not`; in the closing prose (`:179-181`) one added sentence: "A name is the label the panel shows for an application, service or database on the active instance (the name cut at 32 characters), matched whole, case-insensitively, against the last poll; a name nothing has answers `unknown name <name>`, a name two things have answers `ambiguous name <name>`; a uuid the instance no longer has answers `unknown uuid <uuid>`." `docs/architecture.md:39-46`: token list gains `unknown name <argument>` and `ambiguous name <argument>`, keeps `unknown uuid <uuid>` with "(a uuid-shaped argument the store does not hold)"; one clause after the list: "an argument is tried as a uuid over every list first, then as a resource label (`Model.resolveActionTarget`, in front of the gate; resources only, never deployments, servers or tags, so a tag name cannot fan out unconfirmed; exact, then case-folded)"; `:46-47` → "The uuid or name echoed back is bounded to 64 characters and one line; the `ipc` log line carries the resolved uuid8 on success and `-` otherwise, and `status.lastAction.uuid8` is `""` for a name refusal." `docs/architecture.md:533-542`: one sentence naming the resolver as the step in front of the gate, not a second gate. `:564-566`: append "(`uuid8` is `""` when a name refused before resolution)". `:620-624` item 16: "…IPC verbs are exactly `deploy restart stop start`, taking a uuid or the active instance's resource label (`Model.resolveActionTarget`: resources only, so a tag name cannot fan out unconfirmed): a no-confirm destructive surface…". `:701-704` (SR38): "a name resolves against the active instance's last resources poll". `docs/design.md:356`: add `"No match for that name"`, `"That name matches more than one resource"` to the dim refusals; `:358` stays. `docs/development.md:285`: `<uuid|name>` and the two tokens in the `# ->` list; `:174`: append "and a name argument resolves to the row the panel shows (`Model.appLabel`, resources only, uuid first)"; `:19-20`: one clause "IPC verbs by name (`docs/plans/ipc-verbs-by-name.md`)".
   **Verify**: `grep -rln 'ambiguous name' README.md docs/architecture.md docs/development.md | wc -l` prints 3 and `grep -n 'more than one resource' docs/design.md` prints one line; `grep -c 'resolveActionTarget' docs/architecture.md` ≥ 2 (the token list and item 16); `bin/check --no-shell` passes; `git diff --stat develop` lists `Model.js Service.qml tests/run.js README.md docs/architecture.md docs/design.md docs/development.md docs/plans/ipc-verbs-by-name.md` and nothing else (plus `docs/roadmap.md` only after step 5).

4. **Live check** (`bin/dev-sync && omarchy restart shell`, then wait until `omarchy-shell $ID status | jq '{r: .counts.resources, b: .baseline.resources}'` shows `b: true`). With `ID=io.github.danjonesio.coolwatch`:
   (a) `omarchy-shell $ID deploy <a label from Dan's panel>` → `queued deploy <uuid>`; `status | jq -c .lastAction` shows `uuid8` = the first 8 of that uuid and `result` `queued`; the panel shows the row pending. If it answers `ambiguous name`, pick another label and note it.
   (b) the same label upper-cased → the same uuid, or `already pending <uuid>` (resolution proven either way); `busy` proves nothing, retry after a second.
   (c) `omarchy-shell $ID deploy no-such-thing-here` → `unknown name no-such-thing-here`; `status | jq -c .lastAction` shows `uuid8: ""`, `result: "refused"`.
   (d) `omarchy-shell $ID deploy <the uuid from (a)>` → `queued deploy <uuid>` or `already pending <uuid>` (uuid path unchanged); `omarchy-shell $ID deploy zzzzzzzzzzzzzzzzzzzzzzzz` → `unknown uuid zzzzzzzzzzzzzzzzzzzzzzzz`.
   (e) `omarchy-shell $ID deploy` → `usage: deploy <uuid|name>`.
   (f) `quickshell log -p /usr/share/omarchy/shell --tail 100 | grep 'coolwatch ipc\|coolwatch action refuse'` shows a uuid8 or `-` after the verb and no label text; no new `WARN qml` line.
   **Verify**: the echoes above as printed.

5. **Roadmap** (only if PR #16 has merged): delete the bullet at `docs/roadmap.md:245-246` and add to the "Done from this list" paragraph: "**IPC verbs by name** (PR #N, merged YYYY-MM-DD into `develop`; `docs/plans/ipc-verbs-by-name.md`). `deploy <label>` resolves the panel's label on the active instance (uuid first, resources only, exact then case-folded), `unknown name` / `ambiguous name` otherwise; a uuid-shaped miss still reads `unknown uuid`." The build record `docs/plans/ipc-verbs-by-name.build.md` is written by the implement skill last.
   **Verify**: `git log --oneline develop -3` shows #16's merge; `grep -n 'IPC verbs by name' docs/roadmap.md` shows the done paragraph only.

## Verification

```sh
node tests/run.js
bin/check --no-shell          # what CI runs (.github/workflows/check.yml:19)
bin/check                     # adds omarchy plugin validate + qmllint
bin/dev-sync && omarchy restart shell
ID=io.github.danjonesio.coolwatch
omarchy-shell $ID status | jq '{r: .counts.resources, b: .baseline.resources}'
omarchy-shell $ID deploy <label>; omarchy-shell $ID status | jq -c .lastAction
omarchy-shell $ID deploy no-such-thing-here
omarchy-shell $ID deploy zzzzzzzzzzzzzzzzzzzzzzzz
quickshell log -p /usr/share/omarchy/shell --tail 100 | grep -i 'coolwatch ipc\|coolwatch action refuse\|warn'
```

Done end to end: node tests green with the resolver table; `bin/check` green; the live echoes in step 4 (a)–(f) as printed; the PR from `ipc-verbs-by-name` into `develop` green on `check`.

## Tests to add

- `Model.resolveActionTarget` table (step 1): label / case / whitespace; generated and decorated raw names; 41-char name by full text and the 31-character collision (decision); uuid-first (requirement 3); uuid pass over all four lists; resources only, deployment collision, deployment-only name, server, tags (requirements 4, 5); no prefix; uuid-shaped miss vs name miss (requirement 9); ambiguity incl. exact-then-fold and duplicate-uuid rows (requirement 6); hostile and empty store uuids (requirement 2); bounds, missing lists, `undefined` snapshot, `null` row (requirement 7); return key shapes (requirement 1).
- Unchanged and confirmed green without edits: `tests/run.js:1499-1522` (`actionRequest` gate), `:2119-2133` (nav verbs, tag arm, `"production-landing"` → `invalid`) (requirement 10), `:597-605` (`appLabel`).

## Risks and open questions

- **Open (default: keep it, as designed): `unknown uuid` for a uuid-shaped miss, `unknown name` for every other miss.** The alternative is one `unknown name` token for every miss, which retires `unknown uuid` from the IPC surface and reads wrong for a deleted resource's uuid. Changing the default changes the resolver's last line, one test row, and the three token lists in step 3.
- **Open (default no): should `ambiguous name <arg>` list the candidate uuids** (`ambiguous name api: <uuid>, <uuid>`, up to 3)? For: a script can retry with a uuid without opening the panel. Against: the roadmap's token is bare; the panel shows the rows with kind and branch. If yes: build it inside the `ambiguousname` arm from the resolver's (already `UUID_RE`-clean) hits, returned as `uuids: []`, and pin the string.
- **Open (default no): servers by name.** See the rejected alternative.
- **Open: on Dan's Coolify, do two resources share a label, or two names share their first 31 characters?** Decides whether step 4 (a) hits `ambiguous name` on the first try; pick another label and note it in the record.
- **Risk: two names sharing their first 31 characters are jointly unresolvable by name** (both label `…`); two labels differing only in case resolve individually by the exact pass but a third spelling is ambiguous; two differing only in whitespace runs are ambiguous. Accepted: the panel shows them the same way; the uuid path is the escape; the README sentence says the name is cut at 32 characters; pinned in step 1.
- **Risk: a rename or a new resource in Coolify silently changes what a by-name script hits** (a rename → `unknown name` or a different resource; a new same-label resource → `ambiguous name`), and a name resolves against the last poll (60 s stale with the panel closed). Accepted: the echoed uuid, the refuse line's uuid8 and `status.lastAction` are the audit trail; the README sentence says "against the last poll".
- **Risk: the `ipc` log line loses the argument's first 8 characters on refusals** (today `coolwatch ipc deploy iyoi5i0o -> not`; after, `- -> not`). Intended: the argument may be a name; `_refuse`'s line carries the resolved uuid8 for every refusal that has one.
- **Risk: the first seconds after `omarchy restart shell`** answer `unknown name` for every label until the resources poll lands. Same class as today's empty store; step 4 waits on `baseline.resources`.
- **Risk: an IPC call now scans the store twice** (`holdsUuid` presence, then `actionRequest`'s row-building scan). Tens of rows; mirrors the panel's resolve-then-re-resolve (`Panel.qml:320-321`).
- **Risk: the `IpcHandler` parameter rename** changes what `qs ipc show` prints from `uuid` to `target` on the four verbs. Intended; nothing pins it.

## Out of scope

Names for `log` and `instance`; prefix, substring or fuzzy matching; a new IPC verb; resolving across instances; listing candidates on `ambiguous` (unless the open question says yes); a `bin/check` gate on the token lists; moving the token table out of `_refuse`; `notifySafe` or a control-character strip on the echo (pre-existing on `unknown uuid`); a raw-name tiebreak for 31-character collisions; the panel's `d`/`s` keys and confirm flow; `y` copies uuid and the README keybinding (unbuilt sibling items); a scratch-config live check of the readiness gates; `CHANGELOG.md` (release time).

## Panel record

| member | model | wave | findings | accepted | rejected (reason) |
|---|---|---|---|---|---|
| architect | opus | 1 | 5 | 4 | #4 `targetIn` extraction (replaced by `holdsUuid` after the skeptic's wave-2 case: the single gate stays byte-identical; the four list names appear twice, with a cross-reference); its `ctx._ipcTarget` replaced by the `"queued " + uuid` return; its single-`unknown name` rule replaced by the uuid-shaped discriminator |
| reuse-scout | opus | 1 | 8 | 7 | #4's "do not write the scan twice" (see architect #4; `holdsUuid` is presence-only, not a second row-building scan) |
| security-analyst | opus | 1 | 11 | 9 | #5b/#6 a `bin/check` counter (no discriminating gate exists: `Model.uuid8(` appears four times, `slice(0, 8)` is legitimate twice; the shape test + step 2's pattern grep cover it); #11 homoglyph note (no code, no doc) |
| ux-api-designer | opus | 1 | 13 | 10 | #4 `notifySafe` on the echo (caller's own argv; redacts a numeric name, rewrites `-`); #6 tokens into `Model.js` (splits the table); #7 servers by name (no applicable verb, no `appLabel`; open question, default no); #10's candidate list on `ambiguous` (open question, default no); #9 `unknown uuid` for `UUID_RE`-shaped misses taken in its `UUID_SHAPED_RE` form instead (a `UUID_RE`-shaped typo like `storefrnt` must read `unknown name`) |
| security-analyst | opus | 2 | 2 | 2 | — (`UUID_RE` row guard; item 16 ledger line) |
| ux-api-designer | opus | 2 | 5 | 5 | — (the `y` clause dropped; `unknown uuid` kept in the lists with its new meaning rather than removed, since the discriminator keeps it reachable; `UUID_RE` guard; 31-char collision as option (b); the five exact-text items) |
| reuse-scout | opus | 2 | 7 | 7 | — (#1 answered by the discriminator; #3 log line fixed to `-`; #5 moot with `holdsUuid`; #6 `split(" ")` idiom; #7 `IPC_ARG_MAX` comment) |
| code-reviewer | opus | 2 | 7 | 7 | — (#1 `!want` guard plus the `UUID_RE` guard; #2 steps merged; #3 `-`; #4 example changed to `umami-prod`/`start`; #5 collision pinned; #6, #7 Verify fixes) |
| skeptic | opus | 2 | 9 | 8 | #6's "state the trade-off" taken as the `holdsUuid` decision; its "resolve open question 1 before building" not taken as a block (the skill never blocks after framing): the discriminator is the default and the delivery reply asks Dan |

Deviations: the user asked for "Opus 5.5"; the Agent tool takes the alias `opus`. Situational member added: ux-api-designer (the IPC surface is an API scripts consume). Not run: data-analyst (no persistence), ops-analyst (no CI/config change), perf-analyst (one pass over tens of rows per CLI call). Wave 2 produced one critical shared by four members (an unguarded store uuid on the name pass) that changed a code block, not the design, so no extra loop was run; two wave-2 arguments (the uuid-shaped discriminator, exact-then-fold) changed defaults, both re-measured under node by the orchestrator before draft v2.
