# Health check before auth: tell "Coolify not responding" from "token rejected"

Branch `health-before-auth` from `develop`, PR into `develop` (`gh pr create -B develop`). Dan merges. Backlog item: `docs/roadmap.md` "Health before auth" (on PR #10, still open; if #10 is not merged first, skip the roadmap edit in step 10).

Note for the builder: develop moved after the panel explored. `AGENTS.md` is now `docs/development.md` (PR #11), root `AGENTS.md`/`CLAUDE.md` are git-ignored, and `CHANGELOG.md` exists but is written at release time. Code files are identical to the panel's checkout apart from comment text, so every line number below holds on `develop`.

## Context

`Model.errorFor` (`Model.js:287`) already classifies a Coolify that never answers as `offline` or `tls` from the curl exit code, before it looks at the HTTP status. So the confusion is not "down vs bad token" in general. It is an *answering* front door: a reverse proxy or Cloudflare that returns 401 lands in the `auth` arm and the panel says "Token rejected" with an Edit config button; a proxy that returns 502 because Coolify is stopped lands in `http` and the panel says "Coolify error · Coolify returned 502."; a mistyped path or an `http://` url on an https-only Coolify answers 301/302 with an HTML page, which today is failed as "not JSON" and then cleared as a success on the same pass, leaving the hero at "Loading" forever. None of these says Coolify itself is not there.

`GET /api/v1/health` is unauthenticated, outside the ability system, and returns the plain text `OK` (`docs/coolify-api.md:56,71`; verified live against Cloud on 2026-09-22: 200, body `OK`, content-type text/html). It is absent from the openapi, so it is feature-detected like every other endpoint.

Outcome: when a poll fails with an HTTP answer, the plugin sends one unauthenticated health request and combines the two answers at render time. The callout, hero meta, bar tooltip and other-instance tooltip then say one of: "Coolify not responding" (health answered anything but `OK`), "Token rejected" with the sentence "Coolify is up and rejected this token" (health `OK`), or the unchanged 403 / offline / partial copy. Health is never polled while an instance is healthy, never lifts probe mode, never enters backoff, never pauses, never notifies.

## Findings from exploration

- `Api.block` (`Api.js:51-70`) emits `Authorization: Bearer` for every descriptor; there is no opt-out, and `tests/run.js:137` asserts every GET block is byte-identical apart from the url. The method local is `m` (`Api.js:52`). `Api.base()` (`Api.js:37`) appends `/api/v1`, so the path is `/health`.
- `reqVersion()` (`Api.js:83`) is the only `json:false` descriptor; `_dispatch` (`Service.qml:1017-1019`) `_fail`s any non-JSON body for every other kind with `makeError("http", "Coolify returned something that is not JSON", { httpCode: r.code, request: kind })`. `/version` runs at `max-time` 6 (`Service.qml:1723`).
- **Pre-existing bug.** `_finish` (`Service.qml:945-951`) sets `anyOk = true` *before* calling `_dispatch`, so a non-JSON body is `_fail`ed inside `_dispatch` and then `_succeeded(p.kind)` at `:963` clears that error, deletes the backoff entry and lifts probe mode. Because `_markPoll` is never reached, `_baselineDone` stays false and `startupRamp` (`Service.qml:1784`) relaunches three kinds every 2 s for 30 s with no backoff to stop it: a wrong URL answering 302 or 200-HTML costs about 49 requests in the first minute today, against the 20 lock. Live shapes that hit it (verified 2026-09-22, unauthenticated): `https://app.coolify.io/nope/api/v1/deployments` → 302 HTML; `http://app.coolify.io/api/v1/…` → 301 empty. Today those show hero "Loading" and bar "starting" forever, with a `console.warn` per poll, and a front door serving an HTML login page with 200 lifts probe mode indefinitely.
- `_finish` keys `_record` and `_fail` on the Req's kind (`p.kind`), and `_launch` names any descriptor array `topology` (`Service.qml:920`). A health block batched into another Req would be charged and classified as that kind.
- `_record` (`Service.qml:1452-1459`) reads `r.code`, `r.timeMs`, `r.bytes` unconditionally (null throws) and writes `ctx._rateLimitRemaining` from any response's headers.
- `_succeeded` (`Service.qml:1446-1450`) runs for any non-view Req with a 2xx block; it clears `_error` only when `_error.request === kind`, and lifts `_probeMode` unconditionally. `probeTimer` (`Service.qml:1792`) is the only launcher while probe mode holds and sends the authenticated `reqDeployments`.
- View kinds skip `_succeeded` via the early return at `Service.qml:961`. The reaper (`Service.qml:1800-1830`) has an explicit `p === actionReq` arm and a `_isViewKind` arm; everything else gets `consecutiveFailures += 1` and a `_backoff` entry that only `_succeeded(kind)` deletes.
- `_baselineDone` is a hardcoded AND over four kinds (`Service.qml:1357`). A fifth baseline flag would pin the hero at "Loading" forever.
- `barState` (`Model.js:1024-1066`) is a chain of equality tests with no default-deny: an unknown error kind renders the healthy cloud. It deliberately has no row for `ability`, `http` or `toolarge` (the latter two are the partial presentation via `isPartial`, `Model.js:973`). `instanceTroubleOf` (`Model.js:1076-1083`) lowercases the META title unless a kind has a hand-written word (`ability`).
- `EDITABLE_ERRORS` (`Model.js:1138`) is `{noconfig, configerror, unsafe, tokencmd, auth}`; `tests/run.js:913-915` asserts the complement. The footer cog always reaches the editor (product lock).
- The startup burst is measured at 20 in one window with the panel closed (`docs/development.md` rate lock); a fifth request at token-ready would break a written lock for no information.
- `calloutBody(e, s)` (`Model.js:1145`) reads `s` only for `backoffSec`, guarded (`Model.js:1155`). `callout()` (`Model.js:1177`) appends staleness from `e.staleSince`. `_fail` stamps `e.at = Date.now()` (`Service.qml:1478`). `hostOf(url)` is at `Model.js:143`; the snapshot carries `instance` (`Service.qml:706`).
- The snapshot literal (`Service.qml:705-714`), `_emptySnapshot` (`Service.qml:186`) and the test helper `snap()` (`tests/run.js:60`) have no health key. Nothing in `Panel.qml` or `BarWidget.qml` reads `error.kind` directly.
- `_status()` (`Service.qml:1849`) and root `_emptyStatus` (`Service.qml:498`) must keep the same key set. `error` is projected as `{kind, request, httpCode, curlExit}` (`:1880`). `perKind` entries are created on first `_record` and never removed.
- Shallow copies use `ctx._fresh(m)` (`Service.qml:1131`, 16 sites) or object literals; `Object.assign` appears nowhere in the shipped files.
- `bin/record-fixture:24` special-cases `/version` as a text body; every other path is piped to `jq` and fails on `OK`.
- `notifyPlan` (`Model.js:718-760`) never reads `s.error`; no error kind can produce a toast today.
- "unreachable" is already the word for a Coolify *server* in the bar tooltip and chip (`Model.js:1053,1081`).
- `docs/design.md:51` uses `7b` for a state added later; row 6 (`:49`) is "API disabled / IP blocked"; `docs/release.md` step 2 writes the CHANGELOG entry from `git log` on the release branch.

## Design

### Caller's usage first

What the operator sees per case. Chip word is the suffix in the bar tooltip for a non-active instance (`Model.instanceTrouble`). `<host>` is `hostOf(s.instance.url)`.

| Case | poll error today | health answer | shown kind | Callout title / body | Bar | chip word |
|---|---|---|---|---|---|---|
| Proxy answers 502 (Coolify stopped) | `http` 502 | 502 | `down` | Coolify not responding / "`<host>` answered 502 on Coolify's health check, so this is not a token problem. Retrying." | `G.cloudOff`, dimmed | not responding |
| Proxy answers 401 to everything | `auth` | 401 | `auth` | Token rejected / "`<host>` also refused Coolify's unauthenticated health check (401), so something in front of Coolify may be blocking this machine. If the proxy is expected, the token may have been revoked." + Edit config | `G.cloudAlert`, dimmed | token rejected |
| Path typo or `http://` on a real Coolify | `http` 301/302 (not JSON) | 301/302 | `down` | Coolify not responding / "`<host>` redirected Coolify's health check (302). Check the url in ~/.config/coolwatch/config.json: the scheme or the path is probably wrong." | `G.cloudOff`, dimmed | not responding |
| Host is not Coolify at all | `http` 404 or 200-HTML | 404 or HTML | `down` | Coolify not responding / "Nothing at `<host>` answers as Coolify. Check the url in ~/.config/coolwatch/config.json." | `G.cloudOff`, dimmed | not responding |
| Revoked token | `auth` | 200 `OK` | `auth` | Token rejected / "Coolify is up and rejected this token. Create a new one in Coolify → Security → API Tokens with the read ability." + Edit config | `G.cloudAlert`, dimmed | token rejected |
| Poll failed, health not answered yet | any | none | unchanged | unchanged copy (the answer lands within a second; no interim state) | unchanged | unchanged |
| Coolify up, one endpoint 5xx | `http` 5xx | 200 `OK` | `http` | unchanged (partial copy when data exists; "Coolify is up, but the API returned 500." when none) | unchanged | unchanged |
| Older Coolify without the health route, any poll error | `auth` / `http` 5xx | 404 | unchanged | unchanged | unchanged | unchanged |
| API disabled, IP blocked, ability | 403 recognised | not probed | unchanged | unchanged | unchanged | unchanged |
| DNS, refused, timeout, TLS | `offline` / `tls` | not probed | unchanged | Offline · retrying / "Nothing answered at `<host>`. Retrying." (body reworded) | unchanged | unchanged |
| 429, toolarge | unchanged | not probed | unchanged | unchanged | unchanged | unchanged |

`omarchy-shell io.github.danjonesio.coolwatch status`, per instance and mirrored at top level for the active one:

```json
"error":  { "kind": "down", "request": "deployments", "httpCode": 502, "curlExit": 0 },
"health": { "state": "fail", "httpCode": 502, "curlExit": 0, "at": 1789000000000 },
"perKind": { "health": { "lastAt": 1789000000000, "lastCode": 502, "interval": 0, "…": "…" } }
```

`health.state` is one of `unknown | ok | fail | blocked | absent`. An instance that has never failed has no `perKind.health` entry; after a recovery the entry lingers (entries are never removed) but its `lastAt` stops moving. That is the proof it is never probed while healthy. No body text is ever in `status`, a log line, `snapshot` or a state file.

Log lines: `coolwatch <id>/health <state> http=<n> exit=<n>` from `_healthDone`; `coolwatch <id>/health reaped` from the reaper. Health never reaches `_dispatch`, so its generic line does not fire.

### Data shapes

- `error.kind` gains one value, `down`. It is produced only by `Model.errorWithHealth`, never by `errorFor`. It is not in `EDITABLE_ERRORS`, not in `isPartial`. Why a new kind rather than a sentence on `auth`/`http`: the bar glyph, the bar tooltip, the hero meta and the other-instance tooltip all key on `error.kind`, and a Coolify that is not there must show `cloudOff` and "not responding" on all four, not "token rejected" or "deployments unavailable · showing last known".
- `ctx._health` (var, always a fresh object literal on write): `{ state, httpCode, curlExit, at }`. `at` is the answer stamp.
- `ctx._lastHealthAt` (double): the launch stamp and the 30 s floor. Standalone like `_lastViewFetchAt` (`Service.qml:691`) and `_lastPrimeAt` (`:626`); never inside `_health`, so no reset defeats the floor.
- `Model.parseHealth(body)` = `elide(trim(body), 16)` in the `parseVersion` shape (`Model.js:243`); never `JSON.parse`, never stored.
- `Model.healthResult(r, nowMs)` maps one `splitResponses` record (or null) to `{state, httpCode, curlExit, at: nowMs}` (the caller supplies the stamp, as every clock read in `Model.js` does):
  - `exit 0, code 200, parseHealth(body) === "OK"` → `ok`
  - `exit 0, code 404` → `absent`
  - `exit 0, code 401 or 403` → `blocked`
  - `exit 0, code 429` → `unknown`
  - `exit 0, any other code (3xx, 4xx, 5xx, 2xx with a body that is not OK)` → `fail`
  - `exit 63` (a body over the cap is not Coolify's `OK`) → `fail`
  - any other non-zero exit, or null → `unknown`
- `Model.errorWithHealth(e, health)` returns `e` itself when it has nothing to add, otherwise a fresh error via `makeError(kind, null, extra)` where `extra` copies `request`, `httpCode`, `curlExit`, `at`, `staleSince`, `notJson` from `e` and adds `healthState`, `healthCode`, `healthExit`. Rules, in order:
  1. `e` null, `health` null, or `health.state === "unknown"` → `e`.
  2. `health.state === "ok"` and `health.at < e.at` (an OK older than this failure) → treated as `unknown` → `e`. Negative verdicts need no age check: they clear through `_succeeded` the moment a poll returns 2xx.
  3. `e.kind === "auth"`: `fail` → kind `down`; `ok` or `blocked` → kind stays `auth`, annotated (the body changes, the button stays); `absent` → `e`.
  4. `e.kind === "http"`: `fail` or `blocked` → kind `down`; `absent` → kind `down` only when `e.httpCode === 404`, otherwise `e`; `ok` → annotated `http` (the "Coolify is up, but…" body).
  5. every other kind (`apidisabled`, `ipblocked`, `ability`, `offline`, `tls`, `ratelimited`, `toolarge`, config kinds) → `e`, always. A 403 that Coolify itself explained is conclusive; a curl-level failure of the health request is ambiguous and softens nothing.
  - The `absent` asymmetry is deliberate: an older Coolify that lacks the health route still answers the poll with 200, 401 or a real 5xx, so a 404 on health must not turn "Token rejected" (and its Edit config button) or a partial 500 into "not responding". When the poll itself 404s, nothing at that URL serves the API.
  - `blocked` never softens `auth`: a WAF can refuse a header-less request while passing the authenticated one, so a health 401/403 is not proof the token is fine. The body names both causes.
- `ctx._shownError`: `readonly property var`, `Model.errorWithHealth(ctx._error, ctx._health)`. Read by `snapshot.error`, the root summary and `_status().error`. `ctx._error` keeps the raw kind so `_succeeded`'s `_error.request === kind` clearing, `_fail`'s probe/backoff branches and `staleSince` keep reasoning about kinds `errorFor` produces. `snapshot` gains **no** health key; every body reads `e.healthState`/`e.healthCode`.
- `Model.healthWanted(e)` is the one probe gate, pure and tested: `!!e && (e.kind === "auth" || e.kind === "http") && e.curlExit === 0`. Every excluded kind is excluded by construction (403 variants, 429, curl exits), and `_fail` calls it from one site. `_dispatch`'s not-JSON error gains `notJson: true` in its `extra` so the 404-vs-HTML body can be chosen without matching the message string.

### Module map

- `Api.js`: `UNAUTH`, `reqHealth()`, the conditional Authorization line and GET-only refusal in `block()`. Nothing else.
- `Model.js`: `parseHealth`, `healthResult`, `errorWithHealth`, `healthWanted`, `META.down`, `calloutBody` cases, `barState` row, `instanceTroubleOf` word.
- `Service.qml`: the `_dispatch` return value and `anyOk` fix (step 0); `healthReq`, `_health`, `_lastHealthAt`, `_healthWanted`, `_shownError`, `_probeHealth()`, `_healthDone()`, hooks in `_finish`, `_fail`, `probeTimer`, `_succeeded`, `_resetStore`, `_record`, the reaper, `_status()`, root `_emptyStatus`; `notJson` on the dispatch error.
- `Panel.qml`, `BarWidget.qml`: no change (`grep -n 'error\.kind' Panel.qml BarWidget.qml` returns nothing; both render through `Model.callout` and `svc.bar`).
- `tests/run.js`, `tests/fixtures/health-ok.txt` (new), `bin/check` (SR40), `bin/record-fixture`, `docs/architecture.md`, `docs/design.md`, `docs/development.md`, `docs/roadmap.md`.

### Interfaces

```js
// Api.js
var UNAUTH = { health: true }   // kinds that carry no Authorization line; GET only
function reqHealth() { return { kind: "health", path: "/health", json: false, maxBytes: 65536 } }
// in block(), where m is the method local (Api.js:52):
var unauth = Object.prototype.hasOwnProperty.call(UNAUTH, req.kind)
if (unauth && m !== "GET") return null            // config() then returns null; nothing is sent
if (!unauth) s += "header = \"Authorization: Bearer " + quote(token) + "\"\n"
```

`token` is never referenced on the unauthenticated path. `proto`, `max-time`, `connect-timeout`, `max-filesize`, `silent`, `write-out` stay in the block because curl resets them at `next`. `location` is never added (SR2).

```js
// Model.js
function parseHealth(body)                 // -> string, trimmed, at most 16 chars
function healthResult(r, nowMs)            // -> {state, httpCode, curlExit, at}; r may be null
function errorWithHealth(e, health)        // -> e, or a fresh error (kind "down", or annotated auth/http)
function healthWanted(e)                   // -> bool: auth or http with curlExit 0
```

```qml
// Service.qml, inside InstanceCtx
Req { id: healthReq; owner: ctx }                 // appended to _reqs
property var _health: ({ state: "unknown", httpCode: 0, curlExit: 0, at: 0 })
property double _lastHealthAt: 0
property bool _healthWanted: false
readonly property var _shownError: Model.errorWithHealth(ctx._error, ctx._health)

function _probeHealth() {                          // the only launch site
  if (!ctx._ready || !ctx._instance || ctx._paused) return
  var now = Date.now()
  if (now - ctx._lastHealthAt < 30000) return      // <= 2/min per instance
  ctx._lastHealthAt = now
  ctx._launch(healthReq, Api.reqHealth(), 6)
}
function _healthDone(r) {                          // never _fail, _succeeded, _backoff, _probeMode, _pauseFor, _markPoll, notify
  var res = Model.healthResult(r, Date.now())
  ctx._health = { state: res.state, httpCode: res.httpCode, curlExit: res.curlExit, at: res.at }
  console.log("coolwatch " + ctx.instId + "/health " + res.state + " http=" + res.httpCode + " exit=" + res.curlExit)
}
```

Hook points, in the order the request flows:

0. **Step 0, the pre-existing bug.** `_dispatch` returns `false` from its not-JSON branch and `true` otherwise; `_finish`'s loop becomes `if (ctx._dispatch(p.arg[i], r, p.kind)) anyOk = true`. A non-JSON body now stays failed, takes the ordinary 30/60 s backoff, and never lifts probe mode. `anyOk` has a second reader at `Service.qml:973`, the topology latch: an unparseable `/projects` no longer sets `_topologyFetched`/`_topologyLoaded`, so `/projects` is retried on the ordinary 600 s topology cadence instead of latching an empty tree (no request-volume change; `topologyKick` is one-shot). Also add `notJson: true` to that `makeError` extra, and a one-line comment beside the loop in the shape of `Service.qml:664` ("HTTP 200 alone is not success").
1. `_fail` (`Service.qml:1475`): after the existing branches, `if (Model.healthWanted(e)) ctx._healthWanted = true`. Any `auth` or `http` error that came back with an HTTP answer (401, 3xx, 404, 5xx, not-JSON at any code). Set a flag; do not launch from inside `_finish`'s block loop (the `Qt.callLater` comment at `Service.qml:963-966` is the precedent).
2. `_finish` (`Service.qml:932`): right after the `actionReq` short-circuit at `:935`, before `isView` is computed:
   ```js
   if (p === healthReq) {
     var hs = Model.splitResponses(stdoutText)
     var h0 = hs[0] || { exit: code || 1, code: 0, body: "", errmsg: stderrText, headers: null, timeMs: 0, bytes: 0 }
     ctx._record("health", h0)
     ctx._healthDone(hs[0] || null)
     return
   }
   ```
   It never reaches the generic loop, so it cannot call `_fail`, `_dispatch`, `_succeeded`, `_rejoin`, `_pauseFor` or `_flushNotify`. A health 429 is `unknown` and nothing else: its bucket is IP-keyed and says nothing about the token's budget, and the 30 s floor already bounds the traffic.
3. `_record` (`Service.qml:1457`): the rate-limit line becomes `if (kind !== "health" && r.headers && r.headers.rateLimitRemaining !== null) …`, so an unauthenticated response never overwrites the token bucket's number. Everything else `_record` does for health (`lastAt`, `lastCode`, `lastMs`, `lastBytes`, `_noteBytes`) is wanted.
4. `_finish`, last statement beside `ctx._flushNotify()`: `if (ctx._healthWanted) { ctx._healthWanted = false; Qt.callLater(ctx._probeHealth) }`. The empty-stream branch at `:938-943` needs nothing: its error always carries a non-zero `curlExit`, so `healthWanted` is false there.
5. `probeTimer` (`Service.qml:1792`): `onTriggered` keeps `ctx._launch(deploymentsReq, Api.reqDeployments(), 12)` and adds `ctx._probeHealth()`. Added, never substituted: the authenticated probe is the only way out of probe mode.
6. `_succeeded` (`Service.qml:1446`): after the `_error` clearing line, `if (!ctx._error) ctx._health = { state: "unknown", httpCode: 0, curlExit: 0, at: 0 }`. Only when the failure actually cleared, so a mixed state (one kind 2xx, another 502) does not flip-flop the verdict. `_resetStore` (`Service.qml:835`, beside `_probeMode = false`): the same reset plus `ctx._lastHealthAt = 0` (a config change legitimately re-arms). `_lastHealthAt` is never touched by `_succeeded`.
7. Reaper (`Service.qml:1807`): an explicit arm before the view arm, modelled on the `actionReq` one: `if (p === healthReq) { ctx._perKind = ctx._perKind; ctx._healthDone(null); console.warn("coolwatch " + ctx.instId + "/health reaped"); continue }`. No `consecutiveFailures`, no `_backoff`, `_viewKinds` untouched.
8. `snapshot.error` (`Service.qml:707`), the root summary's `error` (`Service.qml:582`) and `_status().error` (`Service.qml:1880`) read `ctx._shownError`. `_status()` gains `health: { state, httpCode, curlExit, at }` from `ctx._health`; root `_emptyStatus` (`Service.qml:498`) gains `health: { state: "unknown", httpCode: 0, curlExit: 0, at: 0 }`. `intervals.health` stays absent so `perKind.health.interval` is 0.

Accounting: `_launch` charges `_noteRequest("health", 1)` like any block. With the 30 s floor the ceiling is 2/min per instance, and health only fires while polls are already in the 30/60 s backoff ladder or in probe mode. Budget per instance, panel closed: 502 front door first minute 8 polls + 2 = 10; steady 3 + 2 = 5; probe mode 1 + 1 = 2; self-hosted box down for an hour (curl exit 7) = 0 extra; healthy = 0. Assume `/api/v1/health` shares the 200/min bucket (the 1000/min figure in `docs/coolify-api.md:59` is documented for `/api/health` only) and is IP-keyed, so two instances on one origin share it. The health Req's deadline is 6+3 = 9 s and the reaper ticks at 5 s, so a hung probe blocks single-flight for under 30 s, inside the floor.

Not touched, deliberately: `_baseline`, `_lastPollAt`, `_timersOn`, `_backoff`, `_probeMode`, `consecutiveFailures`, `errorFor`, `notifyPlan`, `isPartial`, `EDITABLE_ERRORS`, `_viewKinds`, `errorText`, `KIND_WORDS`, `snapshot`'s key set.

### Copy (exact strings)

`META.down = "Coolify not responding"` (title; hero meta `COOLIFY NOT RESPONDING`). Bar: `G.cloudOff`, dimmed, not active, tooltip `Coolwatch — Coolify is not responding (502)` with ` (<code>)` omitted when `healthCode` is 0; the row sits after `ipblocked` in `barState`. `instanceTroubleOf`: `if (x.error === "down") return "not responding"` beside the `ability` line.

`calloutBody` reads `e.healthState` / `e.healthCode` (both absent on an unannotated error):

| condition | body |
|---|---|
| `down`, `healthCode` 3xx | `<host> redirected Coolify's health check (<code>). Check the url in ~/.config/coolwatch/config.json: the scheme or the path is probably wrong.` |
| `down`, `healthCode` 404 or `healthState` fail with poll not-JSON at 2xx | `Nothing at <host> answers as Coolify. Check the url in ~/.config/coolwatch/config.json.` |
| `down`, `healthCode` 401/403 (poll was `http`) | `<host> refused Coolify's unauthenticated health check (<code>), so something in front of Coolify is blocking this machine. Retrying.` |
| `down`, `healthCode >= 500` | `<host> answered <code> on Coolify's health check, so this is not a token problem. Retrying.` |
| `down`, `healthExit` 63 | `<host> sent a page, not Coolify's health answer. Retrying.` |
| `down`, anything else (catch-all, e.g. 400/405/418) | `<host> did not answer Coolify's health check (<code>). Retrying.` |
| `auth`, `healthState` ok | `Coolify is up and rejected this token. Create a new one in Coolify → Security → API Tokens with the read ability.` |
| `auth`, `healthState` blocked | `<host> also refused Coolify's unauthenticated health check (<code>), so something in front of Coolify may be blocking this machine. If the proxy is expected, the token may have been revoked.` |
| `auth`, no annotation / absent | unchanged: `Create a token in Coolify → Security → API Tokens with the read ability.` |
| `http`, `healthState` ok, no data (not partial) | `Coolify is up, but the API returned <httpCode>.` (redacted `detail` on a second line when present) |
| `offline` | `Nothing answered at <host>. Retrying.` (was `Retrying.`) |
| everything else | unchanged |

The `down` rows are tested in this order: `healthExit` 63 first, then 3xx, 404 / not-JSON-2xx, 401/403, ≥ 500, catch-all. Every `down` state `healthResult` can produce yields a non-empty body (asserted). `callout().edit` is unchanged: `calloutEditable` on the shown kind, so `auth` keeps the button in both annotated forms and `down` never has it. Staleness stays appended by `callout()` from `e.staleSince`, which `errorWithHealth` copies through.

### Rejected alternatives

- **Batch a `reqHealth()` block into the failing poll's curl config** (one process, two answers from the same instant). `_launch` names any descriptor array `topology` (`Service.qml:920`) and `_finish` charges `_record` and `_fail` to `p.kind`, so a health 502 would count as a deployments failure, feed two bytes into the byte-stepped cadence, and double the Req deadline. A separate Req costs one array entry.
- **Replace the probe-mode `reqDeployments` with `/health`.** Nothing would ever lift probe mode; a health 200 must not reach `_succeeded`.
- **A health request at token-ready.** Adds one request to the only window already measured at the 20 ceiling, for information nothing consumes while healthy.
- **No new kind, just a sentence on `auth`/`http`.** The bar glyph, tooltip, hero meta and other-instance tooltip key on `error.kind`; a Coolify that is not there would still read "token rejected" or "deployments unavailable · showing last known" on those surfaces.
- **A second kind `badurl`.** One kind with a 3xx/404 body names the file; the hero and tooltip word "not responding" is true in both cases.
- **An interim `checking` state.** The answer lands within a second on a reachable host; two copy rows, a test and an `edit` flip for a window the operator will not see.
- **A clock window (`HEALTH_FRESH_MS`).** The `_succeeded` reset when the error clears plus the `health.at < e.at` rule cover the two staleness paths without a constant.

## Reuse

- `Api.js:83` `reqVersion()`: descriptor shape, `json:false`, `max-time` 6.
- `Api.js:53,105,114` `hasOwnProperty` constant maps: the shape for `UNAUTH`.
- `Api.js:59` `maxBytes` per-descriptor opt-in, tested at `tests/run.js:150-157`.
- `Model.js:143` `hostOf(url)`, already used by `heroTitle`: the `<host>` in every new body, via `s.instance.url`.
- `Model.js:243` `parseVersion`: bounded plain-text parse for `parseHealth`.
- `Model.js:272` `makeError` with its `extra` loop: the annotated and `down` copies.
- `Model.js:287` `errorFor`: stays the single first-stage classifier; untouched.
- `Model.js:1078` the `ability` branch in `instanceTroubleOf`: hand-written trouble word precedent.
- `Model.js:1155` the guarded `s.backoffSec` read: the shape for any guarded read in `calloutBody`.
- `Service.qml:901-907` the `Req` list and `_reqs`: `healthReq` joins so the reaper, `_syncBusy` and `Component.onDestruction` see it.
- `Service.qml:938-943` the empty-stream record literal: the zeroed record's field spelling.
- `Service.qml:961` the view early return: the "settle and touch nothing else" contract `_healthDone` copies.
- `Service.qml:691,1289` `_lastViewFetchAt` / `_viewThrottled`, `Service.qml:626,1737` `_lastPrimeAt`: the standalone timestamp-floor idiom for `_lastHealthAt`.
- `Service.qml:1131` `_fresh` and plain object literals: the copy idiom (no `Object.assign` in shipped files).
- `Service.qml:1807-1815` the `actionReq` reaper arm: the template for the `healthReq` arm.
- `Service.qml:1478` `e.at` from `_fail` and `_health.at`: the freshness comparison, no new state.
- `tests/run.js:55` `trailer()`, `tests/fixtures/version.txt`, `tests/run.js:245`: text-body test shape.
- `tests/run.js:138` the descriptor list in the byte-identical test: extend with the five Phase 4 GETs rather than add a parallel enumeration.
- `bin/check:82-109` the SR16 literal-shape gate: the model for SR40.
- `bin/record-fixture:24` the `/version` text branch to widen.

## Security requirements

1. The token never appears in the health block. `Api.block` does not reference `token` on the unauthenticated path; test: `Api.block(inst, "AAA", reqHealth(), 6) === Api.block(inst, "BBB", reqHealth(), 6)` and the block contains neither `Authorization` nor `Bearer`. Step 1.
2. Only `health` is unauthenticated, only as a GET. `UNAUTH` is a module constant read with `hasOwnProperty`; an unauthenticated non-GET returns `null`. `bin/check` SR40 pins the literal `var UNAUTH = { health: true }` exactly once and the conditional Authorization emission exactly once in `Api.js` with comments stripped, so widening the allowlist is a deliberate gate edit. Test: a config of the five poll descriptors contains exactly five `header = "Authorization: Bearer` lines and the same config plus `reqHealth()` still contains five for six blocks. Steps 1, 5.
3. The health body is capped and never echoed. `maxBytes: 65536`; `parseHealth` slices to 16 chars; every `down`/annotated body is constant copy with only `<host>` and a numeric code; `_status()` exposes `state`, `httpCode`, `curlExit`, `at` only; the log line carries state and numbers. Steps 1, 2, 4.
4. A health success never lifts probe mode and a health failure never enters `_fail`, `_backoff`, `_probeMode`, `_pauseFor` or `consecutiveFailures`. `_finish` returns before the generic loop for `healthReq`; the reaper has its own arm. Step 4.
5. Health only hardens a diagnosis with positive evidence, and never softens `auth`. `errorWithHealth` rewrites `auth` to `down` only on `fail`; `blocked` and `ok` annotate `auth` but keep its kind and its button; `http` rewrites on `fail`/`blocked`, and on `absent` only when the poll itself 404'd; every other kind is returned as is; a curl-level, 429 or stale-OK health outcome is `unknown`. Tests: 401 + health timeout → Token rejected; 401 + health 502 → down; 401 + health OK → Token rejected with "Coolify is up"; 401 + health 403 → Token rejected with the proxy sentence and `edit: true`; 401 + health HTML 200 → down; 403 apidisabled + health 502 → apidisabled; 500 + health 404 → http unchanged; 404 + health 404 → down; 401 at T + health OK at T−40 s → body without "Coolify is up". Step 3.
6. A new kind cannot fall through to the healthy bar. `barState`, `heroMeta`, `calloutBody` and `instanceTroubleOf` each have an explicit `down` case; the heroMeta and callout kind lists derive from `Object.keys(M.META)` (with `ability` as the empty-title exception); a separate loop asserts every META kind except `ability`, `http`, `toolarge` yields `barState().dimmed === true`. Step 3.
7. `down` is not in `EDITABLE_ERRORS`; the footer cog stays the route to the editor. Asserted in the not-editable list, which becomes the complement of `EDITABLE_ERRORS` over `META`. Step 3.
8. No notification path: the health arm never calls `_queueNotify`, `notifyPlan` is untouched, SR16's single `omarchy-notification-send` occurrence holds. Step 4.
9. Health is gated on `ctx._ready` and `!ctx._paused` like every other launch, so the `unsafe` config state never triggers a request to a URL from that file. Step 4.
10. A non-JSON 200 body no longer lifts probe mode or clears an error (step 0). Test in step 0.
11. `location` and `proto-redir` are never set; the SR2 test covers the health block once it is in the descriptor list. Step 1.

## Changes

0. **`Service.qml`: `_dispatch` returns a boolean and `anyOk` follows it.** In `_dispatch` (`Service.qml:1017`): the not-JSON branch becomes `{ ctx._fail(kind, Model.makeError("http", "Coolify returned something that is not JSON", { httpCode: r.code, request: kind, notJson: true }), r.headers); return false }` and the function ends with `return true`. In `_finish` (`Service.qml:949-950`): `anyOk = true; ctx._dispatch(...)` becomes `if (ctx._dispatch(p.arg[i], r, p.kind)) anyOk = true`. No test can drive `_finish` (QML), so the pin is a `bin/check` grep over the comment-stripped file (`sed 's#//.*##' Service.qml`, like SR40): `if (ctx._dispatch(` once and `anyOk = true` once.
   **Verify**: `bin/check` (qmllint); the two greps. Live, with an entry whose url is `https://app.coolify.io/nope`: `status | jq '.instances[]|select(.id=="bad")|{error, probeMode, backoffUntil}'` shows `error.kind == "http"`, `error.httpCode == 302`, `probeMode == false`, `backoffUntil > 0`, `topologyFetched == false` (today it reads true), and the hero no longer sits at "Loading". Run that jq within the first minute after `omarchy restart shell` and assert `requestsLastMin < 20` on the bad entry: today that window reads about 49, after step 0 about 7.

1. **`Api.js`: the descriptor and the opt-out.** Add `UNAUTH`, `reqHealth()`, the conditional header and the GET-only refusal in `block()` as in Interfaces. Tests in `tests/run.js` beside `:137`: extend the descriptor list at `:138` with `reqBuildLog`, `reqHistory`, `reqContainerLog`, `reqService`, `reqTags` (with sample arguments) so the byte-identical assertion covers every authenticated GET; a sibling test that the health block equals the byte-identical GET text minus the Authorization line (8 non-blank lines against 9); token-independence and no-`Bearer` (requirement 1); the five-for-six header count (requirement 2); `Api.config(inst, TOK, [reqHealth()], 6)` contains no `TOK`; a health descriptor with `method: "POST"` returns `null` from `block()`.
   **Verify**: `node tests/run.js` passes; `grep -c 'Authorization' Api.js` is 1.

2. **`Model.js`: parse and classify.** Add `parseHealth`, `healthResult`, `errorWithHealth`, `healthWanted`. Tests: `parseHealth` (`"OK\n"` → `OK`; a 2 MB HTML string → 16 chars); `healthResult` over ok / absent / blocked 401 / blocked 403 / 429 / 500 / 302 / 2xx-not-OK / exit 7 / exit 60 / exit 63 / null; `errorWithHealth` matrix over every kind in `META` times every health state, plus the two `notJson` rows (poll 200-HTML + health 200-HTML → `down`; poll 200-HTML + health `OK` → `http` unchanged), asserting `request`, `httpCode`, `staleSince`, `notJson` copied through and the same object returned when unchanged; the `health.at < e.at` rule; `healthWanted` over every kind with `curlExit` 0 and 7.
   **Verify**: `node tests/run.js` passes.

3. **`Model.js`: copy and surfaces.** `META.down`, the `calloutBody` cases from the Copy table (including the `offline` reword), the `barState` row after `ipblocked`, the `instanceTroubleOf` word. Tests: the scenarios in the usage table asserting `callout().title`, `.body`, `.edit`, `barState().glyph/.dimmed/.tooltip`, `heroMeta`, `instanceTroubleOf`; every `down` health state yields a non-empty body; the existing partial-state tests unchanged (their errors carry no annotation); `barState` row count 15 → 16; heroMeta (`tests/run.js:886-889`) and callout (`:899`) lists derived from `Object.keys(M.META)` (heroMeta excludes `ability` only and thereby gains the `tls` row it lacks today; callout excludes nothing); the not-editable list (`:913-915`) as the complement of `EDITABLE_ERRORS`; the `barState` dimmed loop with the `{ability, http, toolarge}` exception set and the reason beside it (no bar row by design: `ability` must not take over, `http`/`toolarge` are the partial presentation); `calloutEditable` takes the snapshot, so the assertion is `calloutEditable(snap({ error: makeError("down", …) })) === false`; `offline` body contains the host and never `fqdn`.
   **Verify**: `node tests/run.js` passes; `bin/check --no-shell` passes.

4. **`Service.qml`: the Req and the hooks.** Hooks 1 to 8 from Interfaces plus `healthReq`, `_health`, `_lastHealthAt`, `_healthWanted`, `_shownError`, `_probeHealth`, `_healthDone`.
   **Verify**: `bin/check` passes (qmllint, validate). Then `bin/dev-sync && omarchy restart shell` against a config whose second `instances[]` entry (`id: "bad"`) has url `https://app.coolify.io/nope` and the real token:
   ```sh
   omarchy-shell io.github.danjonesio.coolwatch status | jq '[.instances[]|{id, error, health, requestsLastMin, h: .perKind.health}]'
   ```
   The bad entry reads `error.kind == "down"`, `health.state == "fail"`, `health.httpCode == 302`, `requestsLastMin < 20`, and its callout body starts "app.coolify.io redirected"; the good entry reads `health.state == "unknown"` with no `perKind.health`. Then set the bad entry's url to the real origin with a garbage token (the "Same Coolify twice" warning is appended to the body; expected noise): `error.kind == "auth"`, `health.state == "ok"`, `probeMode == true`, body starts "Coolify is up and rejected this token", Edit config visible. Then restore the token: within 60 s `error == null`, `health.state == "unknown"`, and `perKind.health.lastAt` stops changing. `quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E 'coolwatch [A-Za-z0-9_-]+/health '` shows at most two lines per minute per instance.

5. **`bin/check`: SR40.** After the SR16 block, with comments stripped (`sed 's#//.*##'`): the literal `var UNAUTH = { health: true }` appears exactly once in `Api.js`; the string `if (!unauth) s += "header = \"Authorization` appears exactly once; step 0's two Service.qml greps.
   **Verify**: `bin/check --no-shell` passes; a copy under `COOLWATCH_ROOT=$(mktemp -d)` with `UNAUTH = { health: true, deployments: true }` fails with the SR40 message.

6. **`bin/record-fixture`: text branch.** `:24` `[[ $apipath == /version ]]` → `[[ $apipath =~ ^/(version|health)$ ]]`.
   **Verify**: `shellcheck bin/record-fixture`; `bin/record-fixture health-ok /health` writes `tests/fixtures/health-ok.txt` containing `OK`.

7. **`tests/fixtures/health-ok.txt`** (new): `OK` and a newline, used by the `healthResult` ok test through `fixture("health-ok.txt")`.
   **Verify**: `bin/check --no-shell` (SR31, SR39 pass over it).

8. **`docs/architecture.md`.** HTTP client: the Authorization line is conditional on `UNAUTH` (`:181`); error mapping: `down` is a render-time kind from `errorWithHealth`, and a non-JSON body is a failure that no longer counts as success (`:193-197`); "the ten `Req`s" → eleven (`:275`); `error.kind` enum gains `down` (`:300-302`); the SR register (`:670-685`) gains item 42 for SR40; a "diagnostics, not polls" paragraph under the polling table (`:199-215`) with the 30 s floor, the 2/min ceiling and the budget numbers above.
   **Verify**: `grep -n 'down' docs/architecture.md` shows the four sites; `grep -n 'SR40' docs/architecture.md` shows the register item.

9. **`docs/design.md`.** Bar table (`:42-52`): a `6b` row for `down` after row 6 "API disabled / IP blocked" (`:49`), following the `7b` precedent at `:51`, no renumbering. Callout table (`:124-162`): rows for `down` (six bodies), the two annotated `auth` bodies, the `http`+ok body, the reworded `offline`. Error states (`:439-467`): a `down` row. Precedence line (`:441`) unchanged, with one sentence beneath: "A token rejection or an HTTP error that `/health` contradicts is rewritten to `Coolify not responding` before anything renders; nothing here out-ranks anything." Notifications table: an explicit "no change" line.
   **Verify**: read back; `bin/check --no-shell`.

10. **`docs/development.md`, `docs/roadmap.md`.** development.md: status line mentions the health diagnostic; under "Coolify facts that bite" add "`GET /api/v1/health` is unauthenticated, plain `OK` (content-type text/html on Cloud), absent from the openapi; a 404 means an older Coolify, not a wrong URL; a wrong path or `http://` answers 301/302"; under the SR29 sentence add the diagnostic lock ("`health` settles in `_healthDone` and touches nothing else; a health 2xx never lifts probe mode; a non-JSON body never counts as success"); the two log greps gain `|health`; add the jq lines `status | jq '{activeInstance, error, health, probeMode}'` and `status | jq '[.instances[]|{id, error: (.error.kind // "ok"), health: .health.state, requestsLastMin}]'`. roadmap.md: move the item out of the backlog into done (only if PR #10 has merged). `CHANGELOG.md` is **not** edited: `docs/release.md` step 2 writes the release entry from `git log --oneline vPREV..develop`, so make the first commit subject the user-visible sentence: `Health check before auth: the callout tells Coolify not responding from a rejected token`.
    **Verify**: `bin/check --no-shell`; `git diff --stat` touches only the files in the module map.

## Verification

```sh
node tests/run.js
bin/check --no-shell          # what CI runs
bin/check                     # adds omarchy plugin validate + qmllint
bin/dev-sync && omarchy restart shell
omarchy-shell io.github.danjonesio.coolwatch status | jq '{activeInstance, error, health, probeMode, requestsLastMin}'
omarchy-shell io.github.danjonesio.coolwatch status | jq '[.instances[]|{id, error: (.error.kind // "ok"), health: .health.state, requestsLastMin}]'
quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E 'coolwatch [A-Za-z0-9_-]+/health '
```

Done end to end: the live checks in steps 0 and 4 pass (the 502 and proxy-401 rows are covered by node tests only, since no such front door is to hand; say so in the PR); a never-failed instance shows no `perKind.health`; every `requestsLastMin` stays under 20 with the panel closed after a minute; the PR from `health-before-auth` into `develop` is green on `check`.

## Tests to add

- Api: health block byte-identical minus Authorization; token-independent; no `Bearer`; five-for-six header count; extended descriptor list; non-GET unauthenticated returns null; SR2 no `location` (requirements 1, 2, 11).
- `parseHealth`: `"OK\n"` → `OK`; 2 MB HTML → 16 chars, not `OK` (requirement 3).
- `healthResult`: the twelve-row table (requirement 5).
- `errorWithHealth`: full matrix; fields copied through; same object when unchanged; stale-OK rule (requirement 5).
- Scenarios: proxy 502; proxy 401 (annotated auth, `edit: true`); path typo 302; non-Coolify host 404; non-Coolify host 200-HTML; revoked token with health OK; API disabled with health 502 stays apidisabled; older Coolify 500 + health 404 stays http; partial `http` with health OK unchanged (requirements 5, 6, 7).
- `barState`: `down` row, dimmed, `G.cloudOff`, tooltip with and without code; dimmed loop over META (requirement 6).
- `instanceTroubleOf("down")` → `not responding` (requirement 6).
- `calloutEditable(snap({error: down}))` false; not-editable list as the complement (requirement 7).
- `healthWanted`: true for `auth`/`http` with `curlExit` 0, false for every other kind and for any non-zero exit.
- Every `down` health state has a non-empty body; `offline` body has the host, no `fqdn`.

## Risks and open questions

- **Risk: a proxy that serves its own 200 `OK` on `/api/v1/health`.** A revoked token then reads "Coolify is up and rejected this token", today's message plus one clause. Accepted; the path is specific and the failure mode is the status quo.
- **Risk: the `http` → `down` rewrite removes the partial presentation** for a 502 front door with a warm store. Intended; the staleness line stays.
- **Risk: step 0 changes behaviour for every non-JSON response.** Such a poll now backs off 30/60 s and keeps its error instead of flapping and lifting probe mode, and an unparseable `/projects` no longer latches the topology as loaded (it is re-polled on the topology kind's own backoff, at most one extra request per minute with the panel open). The cost on a healthy instance is one transient blip: a single interstitial on one poll now skips 30 s of that kind, never 60, because `_succeeded` deletes the whole backoff entry including `attempt` on the next good poll. The gain is that the wrong-URL case drops from about 49 requests in the first minute and 9/min steady to 7 and 2.5, so the feature's own live check can pass. That is the documented intent of `_fail`; the live check in step 0 shows it.
- **Open: should the `down` callout carry the Edit config button for the 3xx/404 bodies that name the file?** Default: no. `EDITABLE_ERRORS` stays "config and token only"; the body names the file and the footer cog opens it.
- **Open: swap the probe-mode probe from `reqDeployments` to `reqVersion` later?** Default: not here.
- **Open: does a self-hosted Coolify with the API disabled still answer `/api/v1/health` with `OK`?** Default: irrelevant, `apidisabled` is never overridden.
- **Open: is `/api/v1/health` on the 1000/min limiter?** Default: assume the 200/min bucket; `_noteRequest` charges it anyway and its headers never touch `_rateLimitRemaining`.

## Out of scope

Health polling while healthy; a "Coolify down" toast; uptime or metrics; a `badurl` kind; an interim "checking" state; changing the probe-mode probe; team switching; every other backlog item; the roadmap edit if PR #10 is still open.

## Panel record

| member | model | wave | findings | accepted | rejected (reason) |
|---|---|---|---|---|---|
| architect | opus | 1 | 7 | 7 | — |
| reuse-scout | opus | 1 | 12 | 11 | #2 "batch health with deployments in probe mode" (a batched Req is charged to one kind); #8 CHANGELOG absent (exists on develop; release-time entry per `docs/release.md`) |
| security-analyst | opus | 1 | 11 | 11 | — |
| ux-api-designer | opus | 1 | 11 | 7 | #1 swap probe to `reqVersion` (separate change); #4/#10 second kind `badurl` (one kind, body names the file); #5 clock ageing (the `health.at < e.at` rule and the clear-on-recovery reset cover it); #6b front-door 401 to backoff instead of probe mode (raw kind stays `auth`; probe mode with an authenticated probe self-clears at 2/min); #7 `checking` window (sub-second; dropped, see skeptic #12) |
| perf-analyst | opus | 1 | 8 | 8 | — |
| perf-analyst | opus | 2 | 5 | 5 | — |
| security-analyst | opus | 2 | 6 | 6 | — (#5 resolved by reading health off the error copy; `snapshot` unchanged) |
| security-analyst | opus | 2b (step 0) | 3 | 3 | — |
| perf-analyst | opus | 2b (step 0) | 3 | 3 | — |
| reuse-scout | opus | 2 | 7 | 7 | — (#7: SR40 kept but pins the literal allowlist and the emission, and the `:138` list is extended rather than duplicated) |
| ux-api-designer | opus | 2 | 8 | 6 | #2 `snapshot.health` (not needed once bodies read the error copy); #5 `edit` gate (no `checking` state, so no gate) |
| skeptic | opus | 2 | 12 | 11 | #9 "no new kind" (the four kind-keyed surfaces must say "not responding"; stated under Data shapes) |
| code-reviewer | opus | 2 | 14 | 14 | — (#1/#3/#4/#5/#6/#9/#12 were already closed in v2; #7 replaced `HEALTH_PROBE_KINDS` with `healthWanted`; #8 `blocked` kept because it alone leaves `auth` unrewritten) |

Deviations: the user asked for "opus 5.5"; the Agent tool accepts the alias `opus` only, so the panel ran on `opus`. Situational members added: ux-api-designer (callout copy and states) and perf-analyst (the per-token rate gate is a written lock). data-analyst (no persistence) and ops-analyst (no CI or config change) were not run. Wave 2 produced one design-changing critical (the `anyOk` bug, skeptic #2), so security-analyst and perf-analyst were resumed once more on step 0 only.
