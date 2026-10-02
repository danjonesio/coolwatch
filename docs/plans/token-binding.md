# Token binding: a tokenCommand result is usable only by the entry that asked for it

Branch `token-binding` from `develop` (which equals `master` at 9071730, the 1.1.0 release), PR into `develop`, then the 1.1.1 release PR `develop` → `master`. Dan merges. Trigger: marketplace blocker on https://github.com/omacom/omarchy-plugin-marketplace/issues/8253 (HANCORE-linux, 2026-10-01). Every line number below was checked against 9071730.

## Context

A context resolves its token either from the inline `token` or by running `tokenCommand` (`timeout -k 2 30 <argv>`, up to 30 s, `Service.qml:886`). The result of that command, and the token the context already holds, are tied to nothing: `tokenCmd` carries a sequence (`seq`, for "superseded by a later `_resolveToken`") and the command's argv JSON (`key`), never the URL the entry named. `_resetStore` (`Service.qml:846-871`) clears thirty fields but not `_token`, `_tokenCmdKey`, the running command or its sequence; `_suspend` (`:772-784`) and the inline branch of `_resolveToken` (`:890-891`) stop nothing either. So a token produced for one URL can be sent to another.

Six reachable paths, all one root cause (nothing compares the token's origin with the URL `Api.config` is about to build):

1. The maintainer's flow: command A running for `{id, url A}`; the entry is saved as `{id, url B, inline token B}`; `_configApplied` (`:742-756`) moves `_instance` to B and resets the store; command A exits, `onExited` (`:837-842`) accepts it, `_tokenReady` overwrites token B with A, polls B with A.
2. **No race needed:** `{url A, tokenCommand C}` resolved token T; the operator edits only `url` to B. `_resolveToken`'s cache branch (`:878`, `key === _tokenCmdKey && _token`) hands T to `_tokenReady` synchronously and B is polled with T.
3. Same command, URL changed: the "already waiting on this command" return (`:881`) keeps the run started for A; its result lands on B.
4. Inline B → command C → inline B: the inline branch never stops C; C's exit overwrites B with C's output and poisons `_tokenCmdKey`.
5. Config goes unsafe (`_applyStat`, `:387-391` → `_suspend`): the command keeps running; its exit sets `_ready = true` and `_prime("all")` while `root._configError.kind === "unsafe"`. `_configText` calls `_configApplied` before any safety check (`:353`), so `_instance` can move to B while unsafe.
6. **No token command needed:** between `_configApplied` (synchronous, `_instance` = B, `_ready = false`, `_token` still A) and `_tokenReady` (after the asynchronous stat round trip `:314-317` → `:373-393` → `:768`), the four panel-driven view fetches `refetchBuildLog` (`:1327`), `fetchContainerLog` (`:1341`), `_fetchContainerLogSub` (`:1355`) and `fetchHistory` (`:1367`) call `_launch` with no `_ready` gate (`fetchTags`, `:1372`, has one), and `_launch` (`:925-943`, the only `Api.config` site, `:938`) builds Bearer A for B. Reachable from the overlay during the unsafe window (the store is kept "behind the callout", `:770`) and via IPC `log <uuid>`.

Identical in 1.0.0 (`c21c455`). Outcome after this ships: a token is usable only for the exact `{url, tokenCommand}` pair that produced or configured it; any change to that pair, the entry's removal, or an unsafe config discards a pending command's result, stops the process and refuses every request until the entry resolves again; a name, poll or notify edit never re-prompts a vault. `_launch` refuses a request whose token is not bound to the URL it is about to use, whatever called it. Ships as 1.1.1.

## Findings from exploration

- `ctx._token` has five occurrences: declaration `:590`, `_halt` `:789`, cache `:878`, `_tokenReady` `:895`, `_launch` `:938`, destruction `:1913`. `tokenOut.text` has one (`:839`); `tokenErr` is never read (`:836`). No `console.*` in `Service.qml` names `_cfg`, an entry, `_instKey`, `_tokenCmdKey` or `tokenCmd.key`; `_status()` (`:1917-1969`, root `:484-512`) exposes none of them. `Model.redact` (`Model.js:226-232`) catches Coolify's `N|base62` shape. All of this must hold after the change.
- `ctx._instKey` (`:579`, set at `:745` from `Model.instanceKey(e, root._cfg.poll)`, `Model.js:1182-1187`) is the store-reset key: the entry minus `token`, plus `tokenFingerprint`, plus the poll block. A `name`, `plaintext` or `poll` edit changes it and resets the store. `docs/architecture.md:103` promises "a touch does not re-prompt a vault" and `tests/run.js:2359-2367` pins the key's shape (SR34) but never asserts a `url` change moves it.
- `_instKey`, `_tokenCmdKey` and `tokenCmd.key` all embed the `tokenCommand` argv verbatim (a vault item path such as `op://Private/Coolify Homelab/credential`): secret-adjacent and an SR39-class real-name string; none may reach a log line or `status`.
- The `Req` idiom is the precedent for every piece of this: `kill()` = `seq += 1; stopping = true; running = false` (`:432`), `onStarted: liveSeq = seq` (`:430`) so a coalesced `running = false; running = true` cannot deliver an old child's exit under the new sequence, and `_finish`'s `if (p.liveSeq !== p.seq) return` (`:947`). `tokenCmd` has the sequence (`seq`/`_tokenCmdSeq`, `:593`, `:831`, `:838`, `:882-884`) but no `liveSeq`, no `kill()`, and the two stop sites disagree: supersede bumps the sequence and stops (`:882-883`); `Component.onDestruction` only sets `running = false` (`:1911`).
- `_resolveToken` re-enters while a command runs on every `refresh` (`:93-95` → `_selfHeal` → `_stat` → `_applyStat:393` → `_applyConfig:767`), every config-dir `onFileChanged` (`:214`) and after `editConfig` (`:308`), because `_ready` is false during resolution. The early return at `:881` is what keeps a `refresh` during a 1Password prompt from restarting the command; it must stay first and compare the binding, not the argv.
- `_timersOn` (`:714`) is `_ready && !_paused && !_probeMode`; nothing in a context reads `root._configError`. `act` refuses unsafe through the root (`:1589`). `_halt` (`:786-790`, from the root's destruction `:479`) is `_suspend` then `_resetStore` then `_token = ""`.
- `Api.js:49` `var UNAUTH = { health: true }` and `:65`: the health descriptor emits no Authorization line; `_probeHealth` is gated on `_ready` like the polls, so the `_launch` guard needs no health exemption.
- `normaliseConfig` accepts `https://host?x=1` (`Model.js:77`) and strips trailing slashes (`:83`); `Model.origin` (`:1378-1383`) returns `""` for a query-bearing URL, so a binding built through `origin` would make two such entries compare equal. `Api.base` consumes `instance.url` as normalised.
- `_launch`'s early return counts `skipped` ("a dropped tick is starvation, not silence", SR30, `:926-931`, ledger item 32); a binding refusal must not touch it.
- `Model.canAct` (`Model.js:1609-1613`) is the shape for a pure guard: `""` to proceed, else a reason word.
- `_status()` maps `waitingtoken`/`tokencmd` to `configState` and exposes `tokenSource` (`:1926-1931`); `docs/development.md:291-294` are the jq lines over them.
- Existing busy strings at the view entry points: `"Busy · press r to retry"` (`:1325`, `:1353`), `"Busy · try again"` (`:1339`, `:1363`); `fetchTags`'s gate shape `if (!ctx._ready …) return` (`:1372`).
- `bin/check:111-125` (SR40) counts exact literals in `Service.qml` with comments stripped; `bin/check:68` (SR26) fails any `console.*` naming `.text`. Highest SR is SR40; the ledger ends at item 42 (`docs/architecture.md:729-736`).
- Doc sites: `docs/architecture.md:99-107` (the broken sentence at `:102-103`), `:113-115` (unsafe), `:599-605` (ledger items 6, 7), `:707-710` (item 38, SR34), `:737` (new item 43); `docs/development.md:14-21` (status paragraph), `:70`, `:164`, `:420-425` ("Don't" list); `CHANGELOG.md:3`; `manifest.json` 1.1.0; `docs/design.md` untouched (no new state, no copy); `SECURITY.md` untouched (a fixed boundary is not a known boundary).
- Tests: `tests/run.js:2359-2367` (SR34 `instanceKey`), the no-leak idiom `assert(k.indexOf("secret") < 0 && k.indexOf("67|") < 0)`, the literal test token `67|secretsecretsecret`; the file ends with the pass/fail summary. `bin/check:15`'s token-shape gate walks `tests/fixtures/` only.

## Design

### Caller's usage first

The three sites, as they will read:

```qml
// Service.qml tokenCmd (accept): the result is usable only if nothing about the entry, the
// run or the file's safety changed since it started.
onStarted: liveSeq = seq                                   // the Req idiom (:430): a coalesced restart cannot deliver an old child under a new seq
onExited: function(code) {
  var t = String(tokenOut.text || "").trim()
  var why = Model.tokenVerdict({ bound: tokenCmd.key, live: tokenCmd.liveSeq === tokenCmd.seq, code: code, hasText: t.length > 0 }, ctx._tokenNow())
  if (why === "failed") { ctx._setError(Model.makeError("tokencmd", "", { curlExit: code })); return }
  if (why) { console.log("coolwatch " + ctx.instId + "/token refused " + why); return }   // a reason word; never the key, the argv, the output or its length
  ctx._tokenReady(t, "command")
}
```
```qml
// Service.qml _launch (use), first statement: the token must be bound to the URL this request is built from.
var why = Model.tokenVerdict({ bound: ctx._tokenKey }, ctx._tokenNow())
if (why) { console.log("coolwatch " + ctx.instId + "/launch refused " + why); return false }
```
```qml
// Service.qml _resolveToken (cache and dedupe), both keyed on the binding, not the argv
var bind = Model.tokenBinding(i)
if (i.tokenCommand) {
  // the held token is reused only when the same rule _launch applies says it is usable (no vault re-prompt on a name or poll edit)
  if (ctx._token.length > 0 && !Model.tokenVerdict({ bound: ctx._tokenKey }, ctx._tokenNow())) { ctx._tokenReady(ctx._token, "command"); return }
  ctx._ready = false; ctx._setError(Model.makeError("waitingtoken"))
  if (tokenCmd.running && tokenCmd.key === bind) return                 // already waiting on this command for this url (a refresh mid-prompt): a bare compare, it asks about the run, not the token
  ctx._stopTokenCmd()                                                    // a different url or argv: supersede
  tokenCmd.key = bind
  tokenCmd.command = ["timeout", "-k", "2", "30"].concat(i.tokenCommand); tokenCmd.running = true
  return
}
ctx._stopTokenCmd()                                                      // an inline token: a command still running belongs to a config that no longer names it
ctx._tokenReady(i.token, "file")
```

Observable from a shell, no credential involved: `quickshell log … | grep 'coolwatch <id>/token refused\|/launch refused'` (reason word only); `status | jq '[.instances[]|{id, configState, tokenSource}]'` reads `waitingtoken` across the edit and `file`/`command` after.

### Data shapes

```js
// Model.tokenBinding(entry) -> string. The two facts the credential boundary is made of: the
// request target as Api.base consumes it (the normalised url, never Model.origin) and the
// producer (the tokenCommand argv, or null for an inline token). A name, poll or notify edit
// leaves it unchanged (a touch does not re-prompt a vault, docs/architecture.md:103); a url or
// command change, or a switch between inline and command, changes it. Never the token (SR34).
function tokenBinding(entry) {
  var e = entry || {}
  var url = String(e.url === undefined || e.url === null ? "" : e.url).trim()
  if (!url) return ""                                   // never matches anything, including itself (see tokenVerdict)
  return JSON.stringify({ url: url, cmd: Array.isArray(e.tokenCommand) && e.tokenCommand.length ? e.tokenCommand : null })
}
// Model.tokenVerdict(what, now) -> "" to proceed, else the reason word. `what` is a command
// result ({bound, live, code, hasText}) or a held token ({bound}); `now` is the context today
// ({current, hasEntry, safe}). Order: the strongest refusal wins, and a stale or unsafe result
// is never reported as "failed" (it must not re-arm the tokencmd callout).
function tokenVerdict(what, now) {
  what = what || {}; now = now || {}
  if (!now.hasEntry) return "gone"
  if (!now.safe) return "unsafe"
  if (what.live === false) return "superseded"
  var bound = String(what.bound === undefined || what.bound === null ? "" : what.bound)
  if (!bound || bound !== String(now.current === undefined || now.current === null ? "" : now.current)) return "stale"
  if (what.code !== undefined && (what.code !== 0 || !what.hasText)) return "failed"
  return ""
}
```
`ctx._tokenKey` (new, replaces `_tokenCmdKey`): the binding the held `_token` belongs to, written only by `_tokenReady` (`= Model.tokenBinding(ctx._entry)`) and cleared by `_suspend`, `_halt`/destruction. `tokenCmd.key`: the binding of the entry that started the run (replaces the argv JSON; `tokenCmd.liveSeq` new, the `Req` idiom). `ctx._tokenNow()` = `{ current: Model.tokenBinding(ctx._entry), hasEntry: !!ctx._entry, safe: !(root._configError && root._configError.kind === "unsafe") }`. `ctx._stopTokenCmd()` = `tokenCmd.seq += 1; if (tokenCmd.running) tokenCmd.running = false` (the `Req.kill` shape, `:432`; the bump is the stop, `running = false` alone is not). `ctx._tokenCmdSeq` (`:593`) is deleted: with `liveSeq` on the process the per-process pair answers liveness on its own, exactly as `Req` does, and a context-side counter would be a second mechanism (`grep -n _tokenCmdSeq Service.qml` → `:593, 838, 882-884`, all rewritten here).

### Module map

| File | Change |
|---|---|
| `Model.js` | `tokenBinding` + `tokenVerdict` directly after `instanceKey` (`:1187`) |
| `Service.qml` | `_tokenCmdKey` → `_tokenKey` (`:592`); `tokenCmd` gains `liveSeq`, `onStarted`, the verdict in `onExited` (`:829-843`); `_stopTokenCmd` + `_tokenNow` beside `_setError` (`:903`); `_resolveToken` (`:873-892`) as above; `_tokenReady` (`:894-900`) binds and refuses a gone entry; `_suspend` (`:772`) stops and unbinds; `Component.onDestruction` (`:1911-1913`) uses `_stopTokenCmd` and unbinds; `_launch` (`:925`) guard; `_ready` gates on the four view fetches (`:1319-1368`) |
| `bin/check` | SR41 counts (step 3) |
| `tests/run.js` | one test block after `:2367` + one assertion in the SR34 test |
| `docs/architecture.md`, `docs/development.md`, `CHANGELOG.md`, `manifest.json` | step 5 |
| `docs/plans/token-binding.md` (+ `.build.md`) | the pair |
| Not touched | `Api.js`, `Panel.qml`, `BarWidget.qml`, `docs/design.md`, `SECURITY.md`, `README.md`, fixtures, `_resetStore`, `_armRecent`/`recent.json` keying, `normaliseConfig`, the `timeout` wrapper, `_status()`'s shape |

### Interfaces

Given in Data shapes and Caller's usage. Plus:

```qml
// _tokenReady: the one place a token is bound
function _tokenReady(token, source) {
  if (!ctx._entry) return                                  // a removed entry binds nothing
  ctx._token = token; ctx._tokenSource = source
  ctx._tokenKey = Model.tokenBinding(ctx._entry)            // before _ready and _prime: _launch checks it
  … (unchanged: clear waiting/tokencmd/noconfig/configerror, _ready = true, _prime("all"), topologyKick.restart())
}
// _suspend: first statements
ctx._stopTokenCmd(); ctx._tokenKey = ""                   // an unsafe file: accept nothing in flight, hold nothing bound (its token is kept behind the callout and re-bound by the next _resolveToken)
// Component.onDestruction: replace `tokenCmd.running = false` with `ctx._stopTokenCmd()`; add `ctx._tokenKey = ""` beside `ctx._token = ""`
// the four view fetches: widen the existing busy condition, no new branch and no new copy:
//   :1326  if (!ctx._ready || logReq.running || logReq.stopping) { ctx._setBuildLogMessage(uuid, "Busy · press r to retry"); return }
//   :1339  if (!ctx._ready || serviceReq.running || serviceReq.stopping) { ctx._setPick(uuid, [], "Busy · try again", label); return }
//   :1353  if (!ctx._ready || logReq.running || logReq.stopping) { ctx._setContainerLogMessage(uuid, "Busy · press r to retry"); return }
//   :1363  if (!ctx._ready || historyReq.running || historyReq.stopping) { page.message = "Busy · try again"; … return }
```
`_resetStore` is untouched: the pending command's fate is decided by the `_resolveToken` that follows every reset (same binding → keep waiting on the open prompt; different → supersede), and the held token's fate by the cache branch (same binding → reuse; different → re-run). A late exit in the stat window between the two is refused by the verdict (`stale`), and the view fetches are refused by `_launch`.

### Rejected alternatives

- **Bind to `ctx._instKey`** (the store-reset key). It carries `name`, `plaintext`, the token fingerprint and the poll block, so a `poll.deploymentsSec` edit would refuse a pending result and, once the cache is bound too, re-prompt the vault on every cosmetic edit, breaking `docs/architecture.md:103`. It also cannot be checked at `_launch` against the URL being built. `_instKey` stays what it is.
- **A monotonic generation counter.** Over-invalidates the same way, says nothing about which URL a credential was for, and is a second notion of generation beside `_tokenCmdSeq` (which already is the counter, for "superseded").
- **Guard only `onExited`.** Leaves paths 2 (the cache) and 6 (the view fetches) open, and leaves a doomed command holding a vault prompt for up to 30 s after the operator typed an inline token.
- **Stop the command in `_resetStore`.** Kills and restarts the vault prompt on a name or poll edit; the `_resolveToken` dedupe at `:881` already decides correctly once it compares the binding.
- **Clear `_token` in `_resetStore`.** Re-prompts the vault on a poll edit; the cache branch bound to `tokenBinding` gives the same guarantee without it.
- **`Model.origin(url)` in the binding.** Flattens `https://h?a=1` and `https://h?b=2` to `""`; two such entries would bind equal.
- **A new `status` field** (`tokenBound`). Moves the "fixed-shape JSON" doc and four jq lines; the log line plus `configState`/`tokenSource` are enough to drive the live check and leak nothing.
- **A `_tokenReady` chokepoint alone.** `_tokenReady` runs after the verdict either way; putting the verdict there would make the cache branch call it with a token that is then refused, and `_launch` still needs its own check for path 6.

## Reuse

- `Service.qml:430-432` `Req.onStarted`/`kill()` and `:947` `_finish`'s `liveSeq` guard: `tokenCmd.liveSeq`, `_stopTokenCmd` and the `live` input are this idiom applied to the token process.
- `Model.js:1609-1613` `canAct`: the `""`-or-reason-word shape for `tokenVerdict`.
- `Model.js:1182-1187` `instanceKey` and `:1177-1181` `tokenFingerprint`: untouched; `_instKey` stays the store key; the SR34 test gains the `url` assertion.
- `Service.qml:1372` `fetchTags`'s `_ready` gate and the four existing busy strings: the view-fetch gates add no copy.
- `Service.qml:1589` the way `_refuse` reads `root._configError.kind === "unsafe"`: `_tokenNow().safe`.
- `Service.qml:1896` `console.warn("coolwatch " + ctx.instId + "/" + p.kind + " reaped")`: the log-line shape for the two refusal lines.
- `bin/check:111-125` SR40: the counting shape for SR41.
- `tests/run.js:2359-2367`: the SR34 test to extend; its no-leak assertion and `67|secretsecretsecret`.
- `docs/plans/ipc-verbs-by-name.md`: the plan-file shape; `docs/release.md` "Hotfixes" for the patch-release framing.

## Security requirements

1. **No credential-adjacent string reaches a log line, `status` or a new property.** The two new `console.log` lines carry `ctx.instId` and a reason word only; `tokenOut.text` stays the single read inside `onExited`; `tokenErr` stays unread; no `console.*` names `_tokenKey`, `tokenCmd.key`, `_instKey`, `tokenOut`, `.text`, `bind` or a length; `_status()` and `snapshot` gain nothing. Gate: step 3 (SR41 counts over `Service.qml` with comments stripped: `ctx._token\b` exactly 5 (today's count: `_halt`, the cache read, `_tokenReady`, `_launch`, destruction; the declaration is `property string _token`), `tokenOut.text` exactly 1, `Api.config(` exactly 1, `Model.tokenVerdict(` exactly 3 (accept, cache, use), no `console.*` line containing `_tokenKey|tokenCmd.key|_instKey|tokenOut`). Steps 2, 3.
2. **One acceptance chokepoint.** `tokenCmd.onExited` accepts only when `tokenVerdict` returns `""`, and reads nothing but the verdict before refusing. Tests T1–T6. Step 2.
3. **One use chokepoint.** `_launch` (the only `Api.config` site) refuses unless the held token's binding equals the current entry's binding and the config is safe, whatever called it; the refusal does not touch `skipped`. Test T7; gate `Api.config(` ×1. Step 2.
4. **All invalidation triggers are one mechanism.** URL change, command change, switch to inline, entry removed, unsafe: each either stops the command through `_stopTokenCmd` (inline branch, supersede, `_suspend`, destruction) or refuses its result through the verdict (`stale`, `gone`, `unsafe`). Tests T2–T5. Step 2.
5. **The cache is bound by the same rule as use.** `_resolveToken` reuses `_token` only when `tokenVerdict({bound: _tokenKey}, _tokenNow())` is `""` (the same call `_launch` makes, so the two can never disagree); a URL or command edit re-runs the command; a name or poll edit does not (T8). Step 2.
6. **Dedupe is bound.** The "already waiting" return compares `tokenCmd.key` with the current binding, so a `refresh` mid-prompt keeps waiting and a URL edit mid-prompt supersedes. Step 2.
7. **Stamped at start.** `tokenCmd.liveSeq` is set in `onStarted`; a coalesced restart cannot deliver an old child's output under a new sequence (`live` false → `superseded`). Step 2.
8. **The binding never holds a token and never flattens.** `tokenBinding` copies `url` and `tokenCommand` only; an empty URL binds to `""`, which matches nothing; query-bearing URLs stay distinct (T9, T10). Step 1.
9. **SR34 intact.** `instanceKey` unchanged, its test extended with the `url` assertion (T11). Step 4.
10. **No new request, no new state file, no fixture change, no `Api.js` change.** `git diff --stat` and the untouched list. Steps 1–5.
11. **The unsafe window stays closed.** `_suspend` stops the command and unbinds; `tokenVerdict` refuses `unsafe` before anything else; a late exit cannot set `_ready` or prime. T5. Step 2.

## Changes

0. **Plan copy first.** `docs/plans/token-binding.md` verbatim, the branch's first commit.
   **Verify**: `ls docs/plans/token-binding.md`; `bin/check --no-shell`.

1. **`Model.js`: `tokenBinding` and `tokenVerdict`** directly after `instanceKey` (`:1187`), as in Data shapes, comments included.
   **Verify**: `node tests/run.js` passes (146, unchanged); `grep -n 'function tokenBinding\|function tokenVerdict' Model.js` shows both after `instanceKey`.

2. **`Service.qml`, one unit.** (a) `:592` `property string _tokenCmdKey` → `property string _tokenKey: ""   // the binding (Model.tokenBinding) the held _token belongs to; written only by _tokenReady`; delete `:593` `_tokenCmdSeq`. (b) `tokenCmd` (`:829-843`): `property int liveSeq: -1`; `onStarted: liveSeq = seq`; `onExited` as in Caller's usage; the `key` comment becomes "the binding of the entry that started this run". (c) beside `_setError` (`:903`): `_tokenNow()` and `_stopTokenCmd()` as in Data shapes. (d) `_resolveToken` (`:873-892`) as in Caller's usage (the local `key` is gone; `bind` replaces it; every `_tokenCmdKey`/`_tokenCmdSeq` read/write becomes `_tokenKey`/`tokenCmd.seq` or is removed; `onExited` no longer writes a key, `_tokenReady` does). (e) `_tokenReady` (`:894-900`): the `if (!ctx._entry) return` and the `_tokenKey` write before `_ready = true`. (f) `_suspend` (`:772`): `ctx._stopTokenCmd(); ctx._tokenKey = ""` first, with the comment. (g) `Component.onDestruction` (`:1911`, `:1913`): `ctx._stopTokenCmd()`; `ctx._tokenKey = ""`. (h) `_launch` (`:925`): the guard as the first statement, above the busy arm, no `skipped` change; comment names SR41. (i) the four existing busy conditions at `:1326`, `:1339`, `:1353`, `:1363` gain `!ctx._ready ||` as their first operand (Interfaces); no new branch.
   **Verify**: `bin/check` (qmllint) passes; `sed 's#//.*##' Service.qml | grep -c 'Model.tokenVerdict('` → 3; `grep -c 'Api.config(' Service.qml` → 1; `grep -n '_tokenCmdKey\|_tokenCmdSeq' Service.qml` → nothing; `sed 's#//.*##' Service.qml | grep -c 'ctx\._token\b'` → 5; `grep -c '_stopTokenCmd()' Service.qml` → 5 (the definition plus supersede, inline, `_suspend`, destruction); `grep -c '!ctx._ready ||' Service.qml` → 4; `sed 's#//.*##' Service.qml | grep -nE 'console\.(log|warn|error)' | grep -E '_tokenKey|tokenCmd.key|_instKey|tokenOut|\.text|bind'` → nothing.

3. **`bin/check`: SR41** in the SR40 shape (comments stripped, `Service.qml`): `Api.config(` exactly 1; `Model.tokenVerdict(` exactly 3; `tokenOut.text` exactly 1; `ctx._token\b` exactly 5; no `console.(log|warn|error)` line containing `_tokenKey`, `tokenCmd.key`, `_instKey` or `tokenOut`. Message names SR41.
   **Verify**: `bin/check --no-shell` passes; a scratch copy with a second `Api.config(` fails it (run in `$TMPDIR`, never in the tree).

4. **`tests/run.js`.** After `:2367`, under `// ---- Model.js: token binding (SR41; marketplace review 2026-10-01) ----`, one `test("Model.tokenBinding / tokenVerdict: a tokenCommand result is usable only by the entry that asked for it (SR41; marketplace review 2026-10-01)")` with, using `A = {id:"home", name:"H", url:"https://a.example.net", token:"", tokenCommand:["op","read","op://Private/Coolify Homelab/credential"], plaintext:false}`, `now = (entry, extra) => Object.assign({ current: M.tokenBinding(entry), hasEntry: true, safe: true }, extra || {})`, `res = (entry, extra) => Object.assign({ bound: M.tokenBinding(entry), live: true, code: 0, hasText: true }, extra || {})`:
   - T1 `tokenVerdict(res(A), now(A))` → `""` (the common path).
   - T2 URL changed: `now(Object.assign({}, A, {url: "https://b.example.net"}))` → `"stale"`; the maintainer's flow exactly: `now(Object.assign({}, A, {url: "https://b.example.net", token: "67|secretsecretsecret", tokenCommand: null}))` → `"stale"`.
   - T3 command changed (`tokenCommand: ["op","read","op://Private/Other/credential"]`) → `"stale"`; command → inline, same URL → `"stale"` (path 4).
   - T4 `now(A, {hasEntry: false})` → `"gone"`, and wins over everything (`res(A, {code: 1})` too).
   - T5 `now(A, {safe: false})` → `"unsafe"`, wins over `stale` and `failed`.
   - T6 `res(A, {code: 1})` → `"failed"`; `res(A, {hasText: false})` → `"failed"`; `res(A, {live: false})` → `"superseded"` and wins over `failed`; a stale result with `code: 1` → `"stale"`, never `"failed"`.
   - T7 the `_launch` form: `tokenVerdict({bound: M.tokenBinding(A)}, now(A))` → `""`; with the URL changed → `"stale"`; `{bound: ""}` → `"stale"`; `tokenVerdict(null, null)` and `tokenVerdict({}, now(A))` → a refusal, no throw.
   - T8 cache width: `tokenBinding` equal across `name`, `plaintext` and `poll` (the function ignores poll by construction; assert `tokenBinding(Object.assign({}, A, {name: "X", plaintext: true})) === tokenBinding(A)`), unequal across `url` and `tokenCommand`, and unequal between inline and command.
   - T9 `tokenBinding({url: "", tokenCommand: A.tokenCommand})` → `""` and `tokenVerdict({bound: ""}, {current: "", hasEntry: true, safe: true})` → `"stale"`; `tokenBinding({url: "https://h?a=1"}) !== tokenBinding({url: "https://h?b=2"})`.
   - T10 no leak: `tokenBinding(Object.assign({}, A, {token: "67|secretsecretsecret"}))` contains neither `secret` nor `67|`; every verdict string is one lowercase word (`/^[a-z]*$/`).
   - T11 in the SR34 test (`:2359-2367`): `assert(k !== M.instanceKey(Object.assign({}, e, { url: "https://y" }), { deploymentsSec: 4 }), "a url change resets")`.
   **Verify**: `node tests/run.js` → 147 passed, 0 failed; `grep -ac 'tokenVerdict' tests/run.js` ≥ 1.

5. **Docs and release prep.** `docs/architecture.md:102-103` → "…through `Process` on load and whenever the entry's `url` or `tokenCommand` changes (a name, poll or notify edit, or a touch, does not re-prompt a vault); the result is bound to the exact `url` + `tokenCommand` pair that started it (`Model.tokenBinding`) and is refused if that pair, the entry or the file's safety changed meanwhile; a switch to an inline token, a URL or command change, an unsafe file or the entry's removal stops a running command; every request is built only from a token bound to its URL (SR41)"; `:113-115` add "and stops an outstanding `tokenCommand`"; ledger item 6 (`:599-602`) add the accept-side sentence; item 38 (`:707-710`) add "and is bound to the entry's `url` + `tokenCommand`"; new item **43. (SR41, 2026-10-01)** at `:737` stating the chokepoints, the `bin/check` counts, and in one clause the two keys over an entry: `Model.instanceKey` (entry minus token, token fingerprint, poll) resets the store; `Model.tokenBinding` (`url` + `tokenCommand`) gates the credential and is deliberately narrower, so neither is widened into the other. `docs/roadmap.md:220` "Done from this list" paragraph gains an entry in the health-before-auth shape: "**Token binding** (PR #N, merged YYYY-MM-DD into `develop`, 1.1.1; `docs/plans/token-binding.md`). Found in marketplace review (issue 8253): a `tokenCommand` result and the held token are now bound to the entry's `url` + `tokenCommand`; the four panel view fetches gained the readiness gate the polls already had." `docs/development.md:14-21` status paragraph: "Manifest 1.1.1 (2026-10-01): token binding (`docs/plans/token-binding.md`)"; `:70` and `:164` one clause each; `:423` a new Don't: "Don't send a token to a URL it was not resolved for: `_launch` checks `Model.tokenVerdict` and `tokenCmd.onExited` refuses a result whose entry changed (SR41)". `CHANGELOG.md`: `## 1.1.1 — 2026-10-01` with one bullet: "**Token binding.** A `tokenCommand` result, and the token an instance holds, are now bound to the exact `url` and `tokenCommand` that produced them; editing an instance while its command runs, switching it to an inline token, or an unsafe config discards the pending result and stops the command, and a request is never sent with a token resolved for a different URL. Found in marketplace review." `manifest.json` → `1.1.1`.
   **Verify**: `grep -n 'SR41' docs/architecture.md docs/development.md bin/check | wc -l` ≥ 5; `grep -n '"version": "1.1.1"' manifest.json`; `sed -n 1,8p CHANGELOG.md`; `grep -n 'Token binding' docs/roadmap.md`; `bin/check --no-shell`; `git diff --stat develop` lists `Model.js Service.qml bin/check tests/run.js docs/architecture.md docs/development.md docs/roadmap.md CHANGELOG.md manifest.json docs/plans/token-binding.md` and nothing else.

6. **Live check**, throwaway credentials only. Make `d=$(mktemp -d)`; `chmod 700 $d`; write a fake token (not a real one; e.g. `12|notarealtokennotarealtoken`) to `$d/t` mode 0600; `$d/cmd.sh` mode 0700: `#!/bin/sh\nsleep 25\ncat "$1"`. Back up `~/.config/coolwatch/config.json` to `$d/config.bak`. Write a config with one instance `{id: "probe", name: "Probe", url: "https://probe-a.invalid", tokenCommand: ["$d/cmd.sh", "$d/t"]}` (the real instance entries kept, the probe added; the token is never on argv, the file path is). `bin/dev-sync && omarchy restart shell`. Within the 25 s: `omarchy-shell $ID status | jq '[.instances[]|{id, configState, tokenSource}]'` shows probe `waitingtoken`; edit the probe entry to `url: "https://probe-b.invalid"` with an inline `token: "13|anotherfaketokenanotherfake"`. After 30 s: `quickshell log -p /usr/share/omarchy/shell --tail 300 | grep 'coolwatch probe/'` shows `coolwatch probe/token refused stale` (or `superseded`) and no `probe/deployments` line before the refusal; `status` shows probe `tokenSource: "file"`; `grep -E 'coolwatch probe/(deployments|resources|servers|health) '` lines all come after the inline token applied. Then restore `$d/config.bak`, `rm -rf $d`, `omarchy restart shell`. Second pass if time allows: with the probe `waitingtoken`, open its chip and press `r` on a History view; expect the busy message and no `probe/history` line.
   **Verify**: the log lines above; `~/.config/coolwatch/config.json` byte-identical to the backup afterwards (`cmp`); no real token ever in `$d`.

7. **Release prep is part of this branch** (hotfix shape, `docs/release.md` "Hotfixes": `develop` equals `master`): the manifest, changelog and status line in step 5. After merge into `develop`: the release PR `develop` → `master` "Release 1.1.1", merge commit, signed `v1.1.1` tag on the merge, `gh issue edit 8253` target commit → the new full SHA plus one comment naming the fix and the second path found (view fetches), `bin/dev-sync` from `master` + restart. The build record's PR body carries the issue comment text.
   **Verify**: `git log --oneline master..develop` after merge shows this branch only.

## Verification

```sh
node tests/run.js                 # 147 passed
bin/check --no-shell              # CI, incl. the new SR41 counts
bin/check                         # + qmllint over Service.qml
bin/dev-sync && omarchy restart shell
ID=io.github.danjonesio.coolwatch
omarchy-shell $ID status | jq '[.instances[]|{id, configState, tokenSource}]'
quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E 'coolwatch [A-Za-z0-9_-]+/(token|launch) refused|coolwatch probe/'
git diff --stat develop
```
Done: tests and checks green; the live probe shows the refusal line and no request to the new URL before the inline token applied; the real instance unaffected (`cloud` `configState` unchanged, polls continue); `master` unmoved until the release PR.

## Tests to add

T1–T11 as in step 4, each mapped: T1 (no regression), T2/T3 (requirements 2, 4, 5), T4/T5 (4, 11), T6 (2, 7), T7 (3), T8 (5), T9 (8), T10 (1, 8), T11 (9). Unchanged and green: `:2359-2366`, `:347-353`, `:1045-1046`, `:1103`, `:1401`.

## Risks and open questions

- **Open (default: as designed): a name or poll edit while a command runs keeps waiting on the open prompt** rather than restarting it, and a cached token survives such an edit. Same destination, same command; `docs/architecture.md:103` kept. The issue reply states this so the maintainer's literal "whenever that entry changes" is answered: every change that alters the destination or the producer stops the command.
- **Risk: Quickshell `Process` semantics** (`running = false` then `true` in one tick; `onExited` after `running = false`). Not depended on: the sequence bump and `liveSeq` refuse any exit from a stopped or coalesced child. The live check observes `refused superseded|stale` either way.
- **Risk: a stat that fails right after a URL edit** leaves `_needToken` true and a stale command running; its result is refused, the view fetches are refused by `_launch`, the context sits on `waitingtoken` until the next `refresh` or file event. Pre-existing, narrowed (the old code would have accepted the result).
- **Risk: `_launch` refusing while `_ready`** would mean a drifted binding; it logs once per attempt and returns false. Unreachable when the `_ready` gates hold; a backstop, not a path.
- **Risk: `tokenCmd.key` changes meaning** (argv JSON → binding JSON, which embeds the argv plus the URL). Same secrecy class as before; still never logged (gate).
- **Open: should the issue reply mention path 6** (the ungated view fetches, not in the maintainer's report)? Default yes, one sentence: it is the same boundary and the fix covers it.

## Out of scope

`normaliseConfig`'s `tokenCommand` rules; the `timeout -k 2 30` wrapper; `_armRecent`/`recent.json` keying (deliberately token-independent); a new `status` field or bar state; `docs/design.md`; `SECURITY.md`; `README.md`; a QML test harness; the rest of the maintainer's unfinished review; `Api.js`.

## Panel record

| member | model | wave | findings | accepted | rejected (reason) |
|---|---|---|---|---|---|
| architect | opus | 1 | 4 | 4 | — (its `_instKey` binding and re-stamp rule replaced by `tokenBinding` after security-analyst #2/#9: the cache path is reachable with no race, and a URL edit must invalidate; its `tokenBound` status field dropped for the log line; its view-fetch gates and `_launch` guard taken) |
| reuse-scout | opus | 1 | 9 | 8 | #4 "store `_instKey` in `tokenCmd.key`, no new key function" (the binding must exclude name/poll and be checkable against the URL; one function, used at every site, is still one notion); its `_stopTokenCmd`, `:881` ordering, no-new-status-key, doc sites and numbering all taken |
| security-analyst | opus | 1 | 12 | 12 | — (its binding and verdict shape are the design; `tokenBound` counts-only status field replaced by the log line, which it also offered) |
| reuse-scout | opus | 2 | 6 | 6 | — (#1 `_tokenCmdSeq` deleted, the `Req` pair alone; #2 the four busy conditions widened, no new branch; #3 the verdict in the cache branch, SR41 count 3; #4 roadmap entry; #5 item 43 names both keys; #6 README untouched confirmed; it withdrew its wave-1 #4) |
| code-reviewer, skeptic (fresh), architect, security-analyst (resumed) | opus | 2 | — | — | not received: the four ran for about eight hours without reporting and were stopped by the user on 2026-10-02 (harness hang, not a finding). Their wave-2 questions were covered by the orchestrator's own checks: the T1–T11 table was run under node against the proposed functions (every row holds), today's SR41 literal counts were measured (`Api.config(` 1, `tokenOut.text` 1, `ctx._token\b` 5), the container-log setter and `Process.onStarted` precedent were read. The implement skill's review panel is the second read. |

Deviations: the user asked for "opus 5.5"; the Agent tool takes the alias `opus`. Situational members not run: no UI copy, no persistence, no CI change beyond a gate in the existing shape. Wave 2 was cut short as recorded above; no extra loop.
