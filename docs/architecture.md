# Architecture

```
Coolify Cloud / self-hosted        REST, Bearer token, 200 req/min
        │
        │  curl (config over stdin, token never in argv)
        ▼
Service.qml        one instance for the whole shell; owns polling, state, actions,
  │                change detection, notifications, config file watch
  │  bar.shell.serviceFor("io.github.danjonesio.coolwatch")
  ├── BarWidget.qml   one per monitor; icon + tooltip; loads Panel.qml
  └── Panel.qml       KeyboardPanel anchored to the icon; reads service state,
                      calls service actions; all rendering from qs.Ui + qs.Commons

Model.js           pure functions: parse, normalise, diff, group, label, format
Api.js             pure functions: build curl config text for each endpoint
tests/run.js       node: Model.js + Api.js against recorded fixtures
```

No daemon, no second Quickshell, no Python collector. The shell is the runtime.

## Plugin contract

- `manifest.json`: `kinds: ["service", "bar-widget"]`, `keepLoaded: true`,
  `entryPoints.service = Service.qml`, `entryPoints.barWidget = BarWidget.qml`,
  `barWidget.defaultSection = "right"`. Same shape as omasnitch.
- The shell creates the service at startup (`shell.qml::ensureService`) and injects
  `shell` and `manifest`. It creates one bar widget per monitor and injects `bar`,
  `moduleName`, `settings`.
- The widget finds the service with `bar.shell.serviceFor(moduleName)` (the media
  widget and omasnitch do exactly this). The panel gets the same object handed down by
  `injectPanel()` and falls back to the lookup.
- `omarchy-shell shell summon|hide|toggle io.github.danjonesio.coolwatch` is routed to
  the bar widget's `open()`, `close()`, `opened` because the plugin has no panel kind.
  The payload is dropped on that path, so no feature depends on it.
- The service registers `IpcHandler { target: "io.github.danjonesio.coolwatch" }` with
  `refresh` and `status` (Phase 1; `status` returns fixed-shape JSON with counts,
  per-kind timings and the rolling request count, never a secret, body or URL).
  Phase 2 adds `deploy <uuid>`, `restart <uuid>`, `stop <uuid>`, `start <uuid>`: each
  returns `queued <verb> <uuid>` or a refusal token (`unknown uuid <uuid>` for a
  uuid-shaped argument the store does not hold, `unknown name <argument>`,
  `ambiguous name <argument>`, `not applicable <verb> <uuid>`, `already pending <uuid>`,
  `busy`, `not configured`, `config unsafe`, `rate limited`, `token rejected`,
  `refused: token lacks the <ability> permission` after three consecutive ability
  failures from the CLI); Phase 4 adds `instances` (`cloud (active), homelab`) and
  `instance <id>` (`active <id>` or `unknown instance <id>`), and the action verbs resolve
  against the active instance; the outcome is `status.lastAction`. An argument is tried
  as a uuid over every list first, then as a resource label (`Model.resolveActionTarget`,
  in front of the gate; resources only, never deployments, servers or tags, so a tag name
  cannot fan out unconfirmed; exact, then case-folded). CLI verbs never confirm. The uuid
  or name echoed back is bounded to 64 characters and one line; the `ipc` log line
  carries the resolved uuid8 on success and `-` otherwise, and `status.lastAction.uuid8`
  is `""` for any IPC call refused before resolution (a readiness gate, `unknown name`,
  `ambiguous name`).
- Hot reload: saving under `~/.config/omarchy/plugins/` reloads the plugin. `bin/dev-sync`
  copies the repo there (the validator refuses symlinks).

## Configuration

Secrets and behaviour live in one file the plugin owns, not in `shell.json`, because
`shell.json` is a layout file that tools like omardan print, diff and rewrite.

`~/.config/coolwatch/config.json`, mode `0600` in a `0700` directory the service creates, watched with two `FileView`s (file and directory).
The panel's **Edit config** (the footer's cog, `e`, and a second button on the config-class
callouts) calls the service's `editConfig()`: one `Process` running `umask 077; mkdir -p; [ -e file ] || printf
sample > file` with both paths and `Model.SAMPLE_CONFIG_FILE` as positional parameters, then
`Util.execArgv(["omarchy-launch-config-editor", path])`. It is the one place the service
writes the config file, only when none exists, and the sample holds a placeholder token,
never a real one; an existing file is never rewritten. The save arrives through the watcher
like any other edit.

```json
{
  "version": 1,
  "instances": [
    {
      "id": "cloud",
      "name": "Coolify Cloud",
      "url": "https://app.coolify.io",
      "token": "67|…",
      "tokenCommand": ["op", "read", "op://Private/Coolify API/credential"]
    }
  ],
  "poll": { "deploymentsSec": 4, "resourcesSec": 60, "serversSec": 120, "topologySec": 600 },
  "notify": {
    "deploymentQueued": true,
    "deploymentStarted": true,
    "deploymentFinished": true,
    "deploymentFailed": true,
    "resourceStateChanged": true,
    "serverReachability": true
  }
}
```

- `token` or `tokenCommand`; both are accepted and `tokenCommand` wins when both are
  present. `tokenCommand` must be an array of strings whose first element does not
  start with `-` (a bare string is a config error). It runs as
  `timeout -k 2 30 <argv…>` through `Process` on load and on every config change whose
  `tokenCommand` differs from the last one (a touch does not re-prompt a vault); its
  stdout (trimmed) is the token. Neither stdout nor stderr is ever logged; failure
  shows "Token unavailable (exit N)". While it runs the bar shows "waiting for token".
  `tokenCommand` keeps the token off disk but not away from other plugins loaded into
  the same shell.
- Token abilities are per phase: Phase 1 `read` only; `read` + `deploy` from Phase 2
  (a new token; abilities cannot be edited);
  `read:sensitive` from Phase 4 (it also makes `GET /deployments` carry full build
  logs). `write` is only needed for "Validate server"; the panel gates that action on
  it and names the missing ability instead of failing silently.
- Mode check: a `stat -c '%a %U'` process runs on every load and on every `refresh`.
  Group- or world-**writable**, or owned by someone else → "Config unsafe", no polling
  and no `tokenCommand` (a writable config could point the token at another `url`).
  Group- or world-readable with an inline `token` → a warning in the panel, polling
  continues.
- `url` must start with `http://` or `https://`; `http://` shows a plaintext warning; a
  URL carrying credentials (`https://u:p@host`) is a config error (SR33).
- `instances[]` (Phase 4): one entry per Coolify. `id` is one path segment,
  `[A-Za-z0-9_-]{1,32}`, unique across the list (it names `recent-<id>.json` and the IPC
  `instance` argument; SR32); a missing `id` is `instance<N>`. Two entries with the same
  origin are allowed with a warning (`instancesWarning`, shown as "Same Coolify twice"):
  every toast and drain then runs twice, which is the acceptance setup, not a product
  one. A config load reconciles per id: a new id creates a context, a removed id releases
  one (its requests killed, its token dropped), an entry or `poll` change resets that
  context only; a `notify`-only edit touches nothing.
- Every `poll` key has the default shown; values below 2 clamp to 2. `topologySec` is
  raised at runtime so the topology fan-out costs at most 3 req/min.
- Every `notify` key defaults to `true`; `"notify": false` sets all six false; `true`,
  `null` or absent means defaults. A non-boolean key value (or a `notify` that is neither
  an object nor a boolean) is **not** a config error: the key keeps its default and
  `normaliseConfig` returns a `warning` the panel shows as a callout while polling
  continues (a quoted `"false"` must never switch off a critical alert or stop the
  plugin). Unknown keys are ignored. A config edit that changes only `notify` applies
  live: `_configText` compares `Model.configSansNotify` of the old and new config and
  skips `_resetStore` (no killed request, no new baseline, no token re-resolution).
- `url` is the origin; the service appends `/api/v1`. Cloud is
  `https://app.coolify.io`; self-hosted is usually `https://coolify.example.com` or
  `http://ip:8000`.
- Missing file → bar icon "not configured", panel shows the path and a sample.
  `FileView` cannot watch a file that does not exist, so the directory is watched too
  (the `Bar.qml` bar-off flag pattern); a directory watch can go silent, so `refresh`
  and the servers tick re-run `mkdir -p`, re-arm the watch and re-stat.
- Bar-widget `settings` in `shell.json` are for display only (`groupBy`,
  `showLabel`), read with `setting(key, fallback)`; manifest `defaults` are not merged
  at runtime, so every read has a fallback.

## HTTP client

Omarchy panels do HTTP with `curl` inside `Quickshell.Io.Process` (weather does; the
tree has no `XMLHttpRequest`). We do the same, with one rule: **the token never appears
in argv**, because argv is visible in `ps` to every process on the machine.

```
command: ["curl", "-q", "-S", "-K", "-"]        // -q first: ignore ~/.curlrc; nothing else in argv
stdinEnabled: true                                // set before running = true
onStarted: { write(Api.config(instance, token, reqs, maxTime)); stdinEnabled = false }
```

`stdinEnabled = false` closes the write channel (Quickshell calls
`QProcess::closeWriteChannel`), which is the EOF `curl -K -` waits for. `Api.config`
emits one complete block per request, joined with `next`, because curl resets every
per-transfer option at `next`:

```
url = "https://app.coolify.io/api/v1/deployments"
silent
connect-timeout = "5"
max-time = "12"
max-filesize = "4194304"
proto = "=https,http"
header = "Authorization: Bearer 67|…"
header = "Accept: application/json"
write-out = "\n<RS>%{exitcode} %{http_code} %{time_total} %{size_download} %{errormsg}\n%{header_json}\n<US>"
```

- Every value passes `Api.quote` (curl's `\\ \" \n \r \t \v` escapes) and every
  path segment passes `Api.seg` (`encodeURIComponent`), so an API-supplied name can
  never add a line to the config. `<RS>`/`<US>` are the raw bytes 0x1E/0x1F.
- The per-block `write-out` gives one trailer per transfer, including failed ones.
  `Model.splitResponses(text)` returns `[{ body, exit, code, timeMs, bytes, errmsg,
  headers }]`; an RS not followed by the trailer grammar is body text; `headers` is a
  whitelist (`retryAfter`, `rateLimitRemaining`, `rateLimitLimit`, integers or null) and
  the raw header blob is discarded there.
- One `Process` per request kind (deployments, deployment, resources, servers, version,
  topology) so kinds overlap but the same kind never stacks. Each carries a monotonic
  `seq`/`liveSeq`; output from a reaped or superseded request is dropped (the
  `MultiSelect.optionsCommand` pattern). Collectors are `id`'d and read in `onExited`.
- Per-kind `max-time` (deployments 12, deployment 12, buildlog 12, history 12, containerlog
  12, service 12, tags 12, version 6, resources 10, servers 10, topology 8 per block; the
  four log-bearing kinds `deployments`, `deployment`, `buildlog` and `history` carry
  `maxBytes` 4 MB, the largest cap a 12 s transfer can deliver at the slowest measured
  throughput, because with `read:sensitive` every deployment row carries its full build
  log). A `Req`'s deadline is `blocks × max-time + 3` s; one 5 s reaper
  `Timer`, armed once at service start, kills a `Req` past its deadline (bumping `seq`
  first) and counts a reap as a failure.
- Every block carries `header = "Authorization: Bearer …"` except the one kind in
  `Api.UNAUTH` (`health`): `GET /api/v1/health` is Coolify's unauthenticated route, so its
  block is byte-identical for any token (GET only; `bin/check` SR40 pins the literal).
- Errors map per transfer: exit 6/7/28/35/60 → offline; exit 63 → response too large;
  401 → token rejected; 403 by `message` → API disabled / IP not allowed / missing
  ability; 429 → rate limited (`Retry-After` clamped to 1–300 s, else 30 → 60 → 60);
  other → Coolify error. Never read a `success` field (the 403 API-disabled body says
  `true`). The last good snapshot stays on screen with "Showing data from N ago". A 2xx
  whose body does not parse is a failure like any other (`_dispatch` reports it and
  `_finish`'s `anyOk` follows that report, SR40): it never clears an error, drops a
  backoff, lifts probe mode or latches the topology. `down` (Coolify not responding) is a
  render-time kind: `Model.errorWithHealth` rewrites an `auth` or `http` error to it when
  the health check contradicts it; `errorFor` never produces it.
- offline/http/reap back off 30 → 60 → 60 s on that kind; 429 pauses every timer;
  401/403 stop every timer and probe `GET /deployments` once a minute until a 2xx or a
  config change.
- Logging: only kind, HTTP code, curl exit, timing, bytes and a redacted, elided
  `errmsg`/`message`. Never a body, the config text, or token-command output.

## Polling schedule

Budget is 200 requests per minute per token; the acceptance bar is under 20/min idle with the panel closed (≈ 20 with a panel open: measured 18 and 20 on 2026-09-07)
and under 60/min with one deployment. Idle is ≈11/min at 3 projects and 3 servers (≈17/min
before the deployments poll idled at 8 s on 2026-09-13).

| Kind | Idle | Any panel open | Deployment active | Purpose |
|---|---|---|---|---|
| `GET /deployments` | 8 s (or `deploymentsSec` if larger) | `deploymentsSec` (4 s) | 2 s | queued and in-progress |
| `GET /deployments/{uuid}` | once per uuid that vanished from the list | | | terminal state; never polled while active |
| `GET /resources` | 60 s | 30 s | 15 s | every app/service/db with status and `environment_id` |
| `GET /servers` | 120 s | 120 s | 120 s | reachability |
| topology, batched | `topologySec` ≥ 600 s | on first open, then as idle | as idle | `GET /projects`, then `GET /projects/{uuid}` × P and `GET /servers/{uuid}/resources` × S |
| `GET /version` | on config load | | | hero detail |

- A kind's interval is the minimum across every applicable column, except that the
  deployments poll idles at 8 s with every panel closed and nothing deploying
  (`Model.IDLE_DEPLOYMENTS_SEC`; `deploymentsSec` only lowers the panel-open cadence and
  raises the idle one when set above 8). A toast for a change made elsewhere therefore
  arrives within about 8 s with the panel closed and 4 s with it open. Timers use
  `triggeredOnStart: false` and an explicit `primeAll()` (config load, token resolve,
  `refresh`, first panel open, at most once per 2 s), because changing a running
  `Timer`'s `interval` restarts it; after an interval change a kind whose last poll is
  older than the new interval launches immediately.
- Diagnostics, not polls (health before auth, 2026-09-22): when a poll fails with an HTTP
  answer of kind `auth` or `http` (`Model.healthWanted`), the service sends one
  unauthenticated `GET /health` on its own `Req` (`max-time` 6, 64 KB cap), floored at
  30 s per instance; in probe mode the probe's own 401 triggers it the same way, after the
  failure is stamped (a health request launched beside the probe answered first and read
  as stale). Never at token-ready, never while healthy (a never-failed instance has no
  `perKind.health`), never for a curl-level failure, a recognised 403, a failure kept
  behind a standing rate limit, or a view fetch. Ceiling two per minute per instance; a 502 front door costs
  about 10 in the first minute and 5 steady, probe mode 2, a box that is down 0 extra.
  Its answer settles in `_healthDone` and touches nothing else: never `_fail`,
  `_succeeded`, `_backoff`, `_probeMode`, `_pauseFor` (its 429 is an IP bucket) or a
  toast, and its headers never write `rateLimitRemaining`. The verdict is reset when the
  error it explains clears; an OK older than the failure by more than the 30 s floor
  (`Model.HEALTH_FLOOR_MS`) is not evidence, one inside it is (a panel open re-primes every
  kind and re-stamps the failure, and the floor refuses a re-probe there).
- Startup: deployments, version, resources and servers launch together; `/projects`
  65 s later, outside the first minute's burst. The icon lights on the first deployments response. A `startupRamp` retries
  every 2 s for 30 s if the first attempts are offline.
- Topology is `/projects` (65 s after the token is ready unless a panel opening has already
  completed it, then every `topologySec`),
  followed by one stage-2 block (`/servers/{uuid}/resources` × S first, then
  `/projects/{uuid}` × P) every 40 s until the queue drains, so no 60 s window holds more
  than 2 topology requests with the panel closed. While a panel is open and the topology
  is still incomplete the spacing is 10 s (six blocks in the first minute on top of the
  ≈20/min panel-open idle rate, under the 60 line), so the folds fill in within about a
  minute of a restart; the resources sit in an "Ungrouped · loading" fold until then. Both
  the fast spacing and the title key off a latch that sets once the first drain completes
  (a failed `/projects` does not set it), so later cycles run at 40 s and never say
  "loading" again until the next config change. A
  tick that lands mid-drain is skipped and a server that answers late gets its resource
  list queued the same way.
  `topologySec` is raised so `(1 + P + S)` per cycle costs at most 3 req/min. Coolify refreshes stored statuses about once a minute, so faster
  resource polling would return the same bytes.
- Vanished deployment uuids go on a deduped queue (cap 20) drained one at a time by the
  `deployment` `Req`; its dispatch and fail handlers pop the next uuid immediately.
- Phase 4 view fetches never run on a timer: `GET /deployments/{uuid}` once for a build
  log that is neither active nor just drained, `GET /{applications,databases,services}/
  {uuid}/logs?lines=200` on `L` and `r`, `GET /services/{uuid}` once for the picker,
  `GET /deployments/applications/{uuid}?skip&take=10` per history page, `GET /tags` on
  panel open at most once a minute. The active build's log is read off the deployments
  poll (every row carries it under `read:sensitive`); the terminal body off the drain.
  With a build running the deployments interval steps up with the last body size
  (256 KB → 4 s, 1 MB → 8 s, 4 MB → 15 s; `Model.deploymentsInterval`; the 15 s rung sits
  above the 4 MB transport cap and is reachable only if that cap is raised), a dropped tick
  is counted in `perKind.<kind>.skipped` (a panel-open prime or `r` colliding with an
  in-flight poll increments it too, and it is cumulative since the service started, not
  cleared by `_resetStore`, so only `deployments.skipped` rising during a build is the
  starvation signal), and `perKind.<kind>.bytesLastMin` is a bare-number ring. The view
  refetch keys are throttled to one launch per second. Measured 2026-09-12: 19 closed, 22 open during the first drain, 29
  with a build running and the log view open.
- "Panel open" is a registry keyed by panel id: `panelOpened(id)`, `panelClosed(id)`
  (also from `Component.onDestruction`), and a `panelAlive(id)` ping every second
  while open, which also re-registers a panel after a service reload once two pings
  arrive within 2.5 s; entries older than 5 s expire, so a destroyed panel or a
  hot-reloaded service cannot pin the fast cadence.
- A ring of request timestamps per instance context backs `status.requestsLastMin`
  (the active instance's) and `status.instances[].requestsLastMin`, the number the
  acceptance test reads per token; `status.requestsTotalLastMin` sums every context.
  Every schedule above runs once per configured instance (its own timers, startup ramp,
  65 s kick and topology fan-out), so N instances cost N times the idle rate on N
  tokens; the panel-open cadences apply to every context at once because the panel
  registry is the root's.

## State model

The service holds one normalised store per instance: `Service.qml` declares an inline
`InstanceCtx` component (its own store, timers, the eleven `Req`s, ledgers, baseline, pending
map, notify state, recent file, `_status()`), instantiated by an `Instantiator` over a
`ListModel` of instance ids that `_setInstanceIds` edits in place (a reassigned array would
rebuild every context). The root owns the config file, the panel registry, the reaper tick
and the per-shell toast budget, and mirrors the **active** context as `snapshot`, `bar`
(with a tooltip suffix naming another instance's trouble, `Model.instanceTrouble`),
`views`, `pending`, `actionStatus`; `instances` (chip input, `Model.instanceChips`) and
`activeId` are the switch surface. Everything the panel renders is a plain object built
by `Model.js`, never a live QObject in a ListView.

```
snapshot:  { instance, error, warning, servers, resources, deployments, recent, tree,
             byServer, failedUnacked, lastPollAt, busy, openPanels, baselineDone, backoffSec,
             topologyFetched, tags, sensitive }          // tags: [{uuid, name}]; sensitive: "unknown" | "yes" | "no"
views:     { buildLogs, containerLogs, picks, history } // beside snapshot, the `pending` precedent: the panel binds on these, never through snapshot
           buildLogs[uuid]:     { uuid, entries: [{ i, seq, hidden, stream, command, output, at }], dropped, rev, status, terminal,
                                  source: "list" | "drain" | "fetch", truncated, refused, bytes, fetchedAt, message, at }   // LRU 3, panel targets pinned
           containerLogs[uuid]: { uuid, kind, sub, label, lines | null, truncated, fetchedAt, message, at }             // LRU 3
           picks[uuid]:         { uuid, label, names | null, message }
           history[appUuid]:    { appUuid, label, count, rows: [deployment], skip, loading, message, at }               // LRU 3; never merged into recent
           bounds: 2000 entries and 5000 physical lines (tail, `dropped` counts the head), 200 lines and 4000 chars per output, 320 per command (middle-elided),
                   a logs string above 3 MB is refused unparsed; every slice write assigns a fresh copy (a var property
                   assigned the same object emits no change)
instance:  { id, name, url, version, plaintext }
error:     null | { kind, title, detail, httpCode, curlExit, request, at, staleSince }
           kind ∈ noconfig | configerror | unsafe | tokencmd | waitingtoken | auth |
                  apidisabled | ipblocked | ability | ratelimited | offline | tls | toolarge | http | down
           // tls (Phase 4, SR36): curl exit 60, the peer certificate failed verification; nothing was sent; retried like offline
           // down (2026-09-22): render-time only, from Model.errorWithHealth; an auth/http error the health
           // check contradicted. An annotated auth/http error also carries healthState, healthCode, healthExit.
warning:   null | { kind (permissions | plaintext | notify | instances), title, detail }
server:    { uuid, name, ip, reachable, usable, disabled, buildServer, resourceCount }
resource:  { uuid, name, kind (application|service|database), type, status,
             state (running|starting|restarting|degraded|paused|exited|unknown),
             health (healthy|unhealthy|unknown), fqdn, environmentId, serverUuid,
             projectUuid, projectName, environmentName, environmentUuid, gitBranch }
           // pending is NOT a resource field: it is a service-owned map applied at render
deployment:{ uuid (from deployment_uuid), appId, appUuid, appName, serverName, branch, status, commit,
             commitMessage, createdAt, updatedAt, finishedAt, url, restartOnly, force, isApi, isWebhook }
           // the three stamps are kept only as non-empty strings of <= 40 chars (tsField);
           // durationOf renders createdAt -> finishedAt on terminal rows and in the toasts
tree:      [ { projectUuid, projectName, environments: [ { id, name, resourceUuids } ] } ]
byServer:  { serverUuid: [resourceUuid…] }
```

- `Model.parseStatus("running:healthy")` → `{ state, health }`; bare `exited` and
  `exited:unhealthy` are the same state. Prefix-match, never equality.
- Deployment status vocabulary: `queued`, `in_progress`, `finished`, `failed`,
  `cancelled-by-user`.
- The tree is joined by `environment_id`: `/resources` items carry it and
  `/projects/{uuid}` returns environments with the matching integer `id`; a resource
  whose environment is unknown lands in an "Ungrouped" fold. `/servers/{uuid}/resources`
  maps uuids to servers. A deployment's branch comes from the joined application's
  `git_branch`, else the first seven characters of the commit.
- `recent` keeps the last 20 terminal deployments in memory (the panel renders the
  newest 5 under an hour old, else the newest one at any age until dismissed; a
  `dismissed` entry is hidden at any age and kept for `hasTerminal`). Phase 3 persists them to
  `~/.local/state/coolwatch/recent.json` (`$XDG_STATE_HOME` honoured; Phase 4: `instances[0]`
  keeps that name, every further instance writes `recent-<id>.json`, and every file written
  carries `id`; `parseRecent` rejects a file whose `id` is another instance's and accepts a
  Phase 3 file without one only for the first instance, so a rollback reads a Phase 4 file, an
  upgrade keeps `instances[0]`'s history, and a reorder of `instances[]` moves which file the
  first entry reads; a file without `id` read by any later instance is rejected):
  `{ version: 1, instance: <Model.origin(url)>, id, savedAt, recent: [ { uuid, status, appId,
  appName, serverName, commit, commitMessage, createdAt, updatedAt, finishedAt, url,
  restartOnly, force, isApi, isWebhook, dismissed } ] }`. Written from the `deployment` arm of
  `_dispatch` (the one place a terminal record enters `recent`; `_recent` itself is
  reassigned on every poll by the joins, so a writer bound to it would write every 4 s and
  `_resetStore` would truncate it) and, after a dismiss, from the next `deployments` arm
  (`ctx.dismissRecent` flips the entry with `Model.dismissRecent` and sets `_recentDirty`;
  the click itself never writes, and `_resetStore` clears the flag), armed only after the state directory exists and the
  file was read once, skipped when the stamp-free content is unchanged. Read on every
  config load (keyed on the instance origin, not the token, so a `tokenCommand` vault is
  never waited on) and again after every `_resetStore`; `_resetStore` never writes. The
  file is untrusted input: `Model.parseRecent` bounds the text at 262 144 chars, requires
  `version 1` and a non-empty matching instance (the bound applies after FileView has read the
  whole file: there is no size-capped read, and no remote path writes a large file), whitelists fields, validates `uuid` and a
  terminal `status`, drops unparseable or > 7 d timestamps, caps at 20, never throws;
  `branch`/`appUuid` are recomputed by `joinBranch`; `url` passes `openUrl` on every use;
  `status.recentPersisted` is the count accepted at the last load, not the file's current length;
  every string is redacted and elided on the way out. Loading never notifies and never
  touches `_failedUnacked` or `_activeUuids`; neither the tracked active set nor
  `_failedUnacked` is persisted. `FileView` has no mode API and its atomic write is a
  rename, so the file is umask-mode and the 0700 directory (created **and chmod'ed** by
  `mkdirProc` before the first write) is the control. Coolify uuids are not
  charset-validated at normalise; `Model.uuid8` filters them before any log line.
- Grouping and the folded set (Phase 4b) are the service's: `root.ui` is
  `{ <instance id>: { origin, groupBy, folded: { <fold key>: true } } }`, `activeUi` is
  `Model.uiFor` of the active instance (the entry's grouping; its folds only while the entry's
  `origin` matches, so a re-pointed id drops them), and every monitor's panel binds `groupBy`
  and `folded` to it, so two monitors agree. A gesture calls `setUiGroupBy` /
  `toggleUiFold`; `Model.uiSet` returns the same map when nothing changed, otherwise the map
  is replaced, `_uiDirty` set and `uiFlush` (a one-second single-shot, restarted per gesture)
  writes `~/.local/state/coolwatch/ui.json`: `{ version: 1, savedAt, instances: { <id>:
  { origin, groupBy, folded: [key, ...] } } }`, one file for all instances, umask-mode in the
  same 0700 directory. The writer is `uiFlush` only: never the click, never `_resetStore`
  (which does not touch `root.ui`), never before the file was read once (a flush that runs
  first stays dirty and is re-armed by the load); an unchanged stamp-free key skips the
  write; entries for ids no longer configured are pruned on write. The file is untrusted
  input: `Model.parseUi` bounds the text at 65 536 chars, requires `version 1` and an
  `instances` object, keeps configured ids only, accepts `groupBy` from `{project, server}`
  (anything else falls back to project without rejecting the file), and keeps a fold key only
  when it matches one of the three shapes `panelRows` emits (`fold:tags`,
  `fold:s:<uuid|unassigned>`, `fold:p:<uuid>/<environment name, ≤ 64 chars, no control
  characters>`), 500 per instance; a bad shape rejects the file, which then reads as empty
  and is replaced by the next gesture. `folded` lists the keys whose flag is true, so the
  tags fold (whose flag means "opened") round-trips without the file knowing. A rejected or
  missing file never changes anything else; `status.ui` carries `{ loaded, rejected, entries,
  dirty }`, counts only.
- Panels never build state: the service builds the snapshot once per poll; a panel
  flattens it into rows only while open. `rowsModel` (a plain array) is the index space
  for the cursor; the ListView renders a `ListModel` (`rowsList`, roles `key` and `row`)
  that `applyRows` patches in place with `Model.listPatch` (keyed remove / insert / set)
  only when `Model.sameRows` says the rows changed. A wholesale model swap would reset
  the scroll to the top and rebuild every delegate (measured 2026-09-13: contentY 910 →
  0 → 946 on one inserted row), which was the "flick" on opening a strip. The nested
  `actions`, `primary` and `secondary` lists reach the delegate as QVariantList
  sequences (`length` works, `Array.isArray` is false). The cursor is a row key, not an
  index.

## Change detection and notifications

Every diff runs inside its `_dispatch` arm from the previous store value, which is still
in hand there, and is gated on that kind's own `_baseline[kind]` flag captured before
`_markPoll` flips it (never `_baselineDone`: a self-hosted `/version` that never answers
must not silence everything). No new tracked-state property exists.

```
deployments  Model.diffDeployments(prev, next, first) → { vanished, events }
             new uuid at queued → "queued" (restart_only → "restarting"); new at in_progress → "started";
             tracked queued → in_progress → "started"; vanished → _terminalQueue → GET /deployments/{uuid}
deployment   Model.terminalEvent(d): finished → "finished" (restart_only → "restarted"), failed, cancelled-by-user
             → "cancelled"; a non-terminal status (a transient vanish) → nothing.
             Emitted only when Model.hasTerminal(recent, uuid) is false (the intra-session dedupe).
resources    Model.resourceEvents(prevRaw, nextRaw, first): running|starting|restarting|degraded → exited = "stopped";
             running|starting|restarting → degraded = "degraded"; exited|degraded → running|starting = "recovered".
             State prefix only; unknown or paused on either side is nothing.
servers      Model.serverEvents(prev, next, first): reachable true→false "unreachable", false→true "reachable"; disabled skipped.
```

**No replay after a restart or a config change** comes from two existing facts: `GET
/deployments` lists only active deployments, and the post-baseline `vanished` set is
empty, so a deployment that finished while the shell was down never reaches the drain; an
in-flight one is part of the baseline set and yields one terminal toast when it vanishes.
`recent.json` extends `hasTerminal` across a restart and feeds the panel; it is not what
prevents a replay.

**The terminal fetch is now load-bearing.** `_drainTerminal` records the uuid in flight on
`deploymentReq.inflight` (never in `Req.arg`, which is the descriptor list `_finish`
indexes); `_drainDone`, called from `_finish` and the reaper before the next drain,
re-queues the uuid at the back on any outcome but a dispatched record or a 404 (empty stream, 5xx, 429, reap, a 200 whose body is not JSON or carries no `deployment_uuid`),
at most twice per uuid (`_drainTries`), honouring the existing `deployment` backoff and
pause; a 404 drops it (`coolwatch drain 404`). A failed drain therefore stalls the queue for
the existing 30/60 s backoff and a Deployed toast can arrive up to ~90 s late; the retry
adds ≤ 2 requests per uuid and cannot burst. `status.drainRetries` counts them.

Events queue on the service and drain once at the end of every `_finish`, after the joins,
so `Model.notifyPlan(events, snapshot, ctx)` resolves each event's render object by uuid
from the **joined** snapshot (the raw store lists carry no `serverUuid`, `projectUuid` or
`branch`); the event's own object is used for state fields only. `notifyPlan` owns every
rule, in this order, and counts every drop per rule into `status.notify.suppressed`:

1. `toggle`: the row's `notify` key is off.
2. `selfCancel`: `cancelled` within 300 s of the service's own Cancel (`_actionAt`).
3. `pending`: `stopped`/`degraded` with a `_pending` entry for the uuid.
4. `actionWindow`: `stopped`/`degraded` within 180 s of any action on the uuid
   (`_actionAt`, written by `_setPending`; a service/database restart's pending entry is
   gone before the container flaps).
5. `activeDeployment`: an active deployment matches the app (`appUuid` or `appName`).
6. `postDeployGrace`: the newest `recent` deployment for the app finished within 120 s.
7. `serverDown`: the resource's server is unreachable or flips unreachable in the same
   batch (the server toast carries "N resources down").
8. `cooldown`: the same `kind:uuid:event` within 300 s (`_lastNotified`, pruned at 1 h);
   `recovered` also needs a `stopped`/`degraded` for the uuid within the last hour.

Survivors are ordered critical → normal → low. Then `resourceCap`: more than 3 resource
toasts → the first 3 plus one "N more resources stopped"; `minuteCap`: at most 12
non-critical toasts per rolling minute (`_notifyLog`, which is therefore what
`status.notify.sentLastMin` reports: the non-critical ring, not every toast sent); critical
is never capped or summarised. Each argv is exactly

```
["omarchy-notification-send", "--app-name", <name>, "-g", <glyph>, "-u", <urgency>,
 <headline>[, <body>][, "--exec", "omarchy-launch-browser", <url>]]
```

or, for a failed build whose instance holds `read:sensitive` (`ctx.logClick`, a boolean the
service reads from the context's `_sensitive`, never Coolify data):

```
[…, <headline>, <body>, "--exec", "omarchy-shell", <plugin id>, "log", <deployment uuid>]
```

The `log <uuid>` IPC verb (Phase 4b item 6) validates the uuid against `UUID_RE`, finds the
context holding it (the active one first; a hit elsewhere switches the instance, the one
verb that looks past the active one, since a deployment uuid names exactly one Coolify; no
hit still opens on the active context and the fetch reports in-view), parks
`root.viewRequest = {uuid, at}` and, unless a panel is open, summons the bar widget through
the scoped shell (a bar-widget summon carries no payload, so the request lives on the
service). The open panel takes it once (`takeViewRequest`, stale after 5 s) and hands
`Model.logRequestRow` to `openLogsFor`, so a held, active or unheld log resolves as `L` does.

built in `Model.js` (so `tests/run.js` covers it; `bin/check` SR16 pins both program
strings there and bans the notifier from QML) and handed to `Util.execArgv` unchanged.
The body is omitted when empty; the `--exec` triple is omitted when `Model.openUrl`
returns `""`; `--exec` is always last and the URL is one element. Every positional passes
`Model.notifySafe` (redact → strip C0/C1 controls → elide → a leading `-` run becomes
U+2011) because the helper keeps parsing options after the headline; the body also
escapes `&` and `<` (the shell renders it as StyledText). `<name>` is the plugin id,
except a critical event while Do Not Disturb is on, which is sent as `omarchy-action`,
the only sender the shell shows through DND (`NotificationLogic.js:118-122`; the shell
archives it to history as that sender). DND is read from
`shell.serviceFor("omarchy.notifications").doNotDisturb`; `null` (service unreachable)
counts as off and `status.notify.dnd` reports it. With two or more instances the body
ends in ` · <instance name>` (Phase 4; `ctx.instanceLabel`), and the ≤ 12-a-minute
budget is per shell: each context plans against what every context already sent and
charges the root's ring. The copy table is in `docs/design.md`.
Log lines are `coolwatch notify <event> <uuid8>` at intent (a detached process cannot
report success), never a name, message or URL. Names, branches, commit messages and the
instance URL appear in the notifier's argv and in the shell's 0644 history files by
design; the token never does. Resource-stop latency is 0–120 s with the panel closed
(Coolify's sweep plus the resources interval) and no kick shortens it.

## Actions

All actions are `POST` with an empty JSON body (the lifecycle routes reject `GET`).

| Panel action | Request | Optimistic state |
|---|---|---|
| Deploy (stopped application) / Redeploy (running application) | `POST /deploy?uuid=<uuid>` | caption `deploying…` / `redeploying…`; clears when the created deployment appears |
| Rebuild without cache (`D`, keyboard only) | `POST /deploy?uuid=<uuid>&force=true` | `rebuilding…`, after confirm |
| Restart | `POST /<kind>/{uuid}/restart` | `pending: restart` (apps: a deployment with `restart_only`) |
| Stop | `POST /<kind>/{uuid}/stop` | `pending: stop`, after confirm |
| Start | `POST /<kind>/{uuid}/start` | `pending: start` |
| Cancel | `POST /deployments/{uuid}/cancel` | deployment row caption gains ` · cancelling…`; clears when the uuid leaves the active list |
| Validate server | `POST /servers/{uuid}/validate` | server row caption gains ` · validating…`; clears on the next servers poll (the API exposes no result) |
| Open | `omarchy-launch-browser <url>` | — |

Every action block adds `request = "POST"`, `header = "Content-Type: application/json"`
and `data-raw = "{}"` (constants; `data` would read a file for a leading `@`) and never
`location`. `Model.actionRequest` is the single gate for the panel and the IPC verbs
(uuid shape, presence in the store, the applicability table); the service builds the
`Api` descriptor from the stored kind. `Model.resolveActionTarget` runs in front of the
gate for IPC calls only, turning a label into a store uuid; it is not a second gate.
One single-flight `actionReq` goes through
`_launch` like a poll; `act()` refuses while an action is in flight or within 1 s of the
last launch, while the same uuid is pending, when not ready / probing / paused, and
after 120 requests in the last minute. There is no queue and no compensating poll.

Pending is a service-owned map `{ uuid: { verb, targetType, kind, since, baseStatus,
deploymentUuid, stale } }` applied at render through `Model.panelRows`'s `ui.pending`
(a value written into the store would be erased by the next poll). It is set at launch,
cleared on any non-2xx (a 429 answers before the action runs), kept only after a reap
(the POST may have landed), and
resolved on the 5 s reaper tick by verb: deploy/redeploy/restart clear when the created
deployment appears in the active list or in recent, or once two deployments polls have
run since the action without listing it (a deployment shorter than the poll interval);
for an application whose response has not yet named its deployment, when an active
deployment created for this action (not one already running) belongs to it; for a
service/database restart, on the first resources poll after the action; stop/start
clear when the status *state* (prefix, per the status lock) differs from the state at
launch and gain " · still pending" at 150 s (sweep 60 s plus the panel-closed resources
interval 60 s plus margin); validate clears on the first
servers poll after the action; cancel clears when the deployment leaves the active list;
everything is dropped when its target is gone or at 300 s.

The outcome is one status line under the hero (`Model.actionOutcome`, 2.2 s for success
and dim refusals, 6 s for failures), never the callout, never `_error`, `_backoff`,
`_probeMode` or `consecutiveFailures`. The one escalation is a 429, which enters the
instance-wide pause through `_pauseFor` (extracted from `_fail`). A reaped action says
"Sent, but Coolify did not answer", keeps its pending entry, and is never retried.
`status` gains `lastAction { verb, uuid8, code, curlExit, ms, at, result, instance }` (`instance` since Phase 4; `uuid8` is `""` for an IPC call refused before resolution: a readiness gate, `unknown name`, `ambiguous name`), `pending`,
`pendingStale`, `actionsLastMin` and `inflightAction`; the log line is
`coolwatch action <verb> <code> exit=<n> <ms>ms <uuid8>`.

Ability errors are surfaced as text, not swallowed: "Token lacks the deploy
permission" tells the user exactly what to add in Coolify. IPC-originated actions are
refused after three consecutive ability failures until a 2xx or a config change.

## Security

1. Curl config injection: every emitted value passes `Api.quote`, every path segment
   `Api.seg`; the write-out is a per-block line through `quote` too.
2. `~/.curlrc` isolation: `-q` is argv[1]; nothing else is in argv.
3. Bounds per block: `connect-timeout 5`, per-kind `max-time`, `max-filesize` 8388608
   (4194304 on the log-bearing `deployments` and `deployment` kinds, set per descriptor
   with `maxBytes`; exit 63 → "response too large"), `proto =https,http`; `url` validated on load,
   `http://` warns.
4. Header whitelist: `Model.splitResponses` discards the raw header blob; only
   `retry-after`, `x-ratelimit-remaining`, `x-ratelimit-limit` survive, as integers or
   null; `Retry-After` clamps to 1–300 s.
5. Token scope per phase (`read` only in Phase 1).
6. Token handling: never in argv, `console.*`, `snapshot`, `status`, or disk; no
   function on the service returns it or the config text; `Api.config` is called only
   in `_launch`, its result cleared in `onStarted`. `tokenCommand` is an argv array run
   under `timeout`, never a shell; its output is never logged.
7. Config trust: `mkdir -m 700`; writable-by-others or foreign-owned → unsafe, no
   polling, no `tokenCommand`; loose read bits with an inline token → warning.
8. Logging: kind, code, exit, timings, bytes and a `Model.redact`ed, `Model.elide`d
   message only. `redact` covers `\d+|…`, `Bearer …`, `://user:pw@`, `set-cookie`.
   `FileView.printErrors: false`.
9. IPC surface: `refresh` and `status` only; `status` is fixed-shape JSON.
10. Every `Text` in `Panel.qml` and `BarWidget.qml` sets `textFormat: Text.PlainText`;
    `bin/check` counts them.
11. Fixtures are recorded by `bin/record-fixture` with the read-only token; values of
    denylisted keys (`internal_db_url external_db_url docker_compose docker_compose_raw
    dockerfile git_full_url private_key sentinel_token value custom_labels
    configuration_snapshot configuration_diff logs`, `_token$ _password$ _secret$ _key$`)
    are replaced with `«scrubbed»`; `bin/check` fails closed on any token-, key- or
    credential-shaped string or the literal keys `"configuration_snapshot"`/`"logs"`.
12. `bin/dev-sync` copies an explicit allowlist, refuses a target with `.git`, another
    plugin's manifest, or a path outside the plugins dir and `$TMPDIR`, and locks.
13. Verification never puts the token prefix in argv: greps read it through process
    substitution.
14. Destructive actions confirm: `selectedIndex = 0` on open and again when the dialog
    arms 250 ms later; only `activateRequested` resolves it and only once armed; the
    target is captured immutably at open; every other key is swallowed while it is up;
    the dialog fills the card above every row; a panel close resets it; the Esc ladder
    descends one rung per 250 ms.
15. Browser URLs: `Model.openUrl` joins the configured instance origin (scheme, host and
    an optional path prefix; no query or fragment) with a path it
    builds from uuids (resource, server) or with a deployment's relative
    `deployment_url` (rejected if it carries a scheme, `//`, or no leading `/`); `fqdn`
    is never opened; the launcher receives exactly one argv element through
    `Util.execArgv`; `bin/check` fails unless every `omarchy-launch-browser` call has
    that form and no `.qml` mentions `fqdn`.
16. Actions never poison polling (see Actions), the POST body is a constant, the
    method comes from a whitelist checked with `hasOwnProperty`, and IPC verbs are
    exactly `deploy restart stop start`, taking a uuid or the active instance's resource
    label (`Model.resolveActionTarget`: resources only, so a tag name cannot fan out
    unconfirmed): a no-confirm destructive surface open to any local process, documented
    in the README.
17. (plan SR15) No Coolify string becomes a notifier option or a control sequence: every
    positional passes `Model.notifySafe`, the body `Model.notifyBody`; log lines use
    `Model.uuid8`.
18. (plan SR16) argv[0] and the launcher keep a checked shape: `bin/check` pins
    `omarchy-notification-send` (argv literal head) and `omarchy-launch-browser` (the
    `--exec` tail with one identifier) to at most one occurrence each in `Model.js` and
    bans the notifier from every `.qml`; the SR9 QML gate is unchanged.
19. (plan SR17) `--exec` is last, holds one URL element (or, for a failed build, the shell
    CLI, the plugin id, `log` and one uuid element that passed `UUID_RE`), and is absent
    when there is no page; an empty body is omitted, never passed as `""`. `bin/check` pins
    `"omarchy-shell"` to one occurrence in `Model.js` with that tail shape.
20. (plan SR18) `recent.json` is untrusted input (see State model); loading never notifies.
21. (plan SR19) No secret or credential reaches a toast, the state file, the shell's
    history or the log: `redact` on every persisted and displayed string, `Model.origin`
    rejects userinfo, log lines carry event + uuid8, the state dir is 0700 before the
    first write and `_saveRecent` refuses until it is.
22. (plan SR20) No new request, no new escalation, no compensating poll: the drain retry
    only re-enters the existing queue under the existing backoff and pause, twice at most.
23. (plan SR21) Bounded toast volume: ≤ 3 resource toasts per flush plus one summary,
    ≤ 12 non-critical per minute, a 300 s cooldown per kind:uuid:event, server-outage
    correlation; critical is never dropped by a cap.
24. (plan SR22) Config safety: a malformed `notify` value warns and keeps its default; a
    `notify`-only edit never resets the store.
25. (plan SR23) DND honesty: `omarchy-action` only when `urgency === "critical"` and the
    service read `doNotDisturb === true` from the shell; `null` means the plugin id.
26. (plan SR24) Verification hygiene: staging only via `COOLWATCH_DEST`, no `--delete` tool
    against a real path, the token needle check fails loudly when the needle is empty.
27. (Phase 4 SR25) No rich text: every `Text`, `TextEdit` and `TextArea` in every `.qml`
    is PlainText; `bin/check` bans `Text.RichText|StyledText|MarkdownText|AutoText`.
    Log text is the most attacker-influenced string in the product.
28. (Phase 4 SR26) Log text is view-only: it lives in the service's view slices and the
    panel's overlay model and never enters `snapshot`, `_status()`, `recent.json`, a
    `console.*` line, an error `detail` or a notifier argv; `Model.logViewStatus` emits
    counts and a digits-only rev; `bin/check` greps `Service.qml` for a console line
    naming a log field. `views` is readable through `serviceFor()` like `_token` and
    `snapshot` (the machine is the trust boundary).
29. (Phase 4 SR27) Every parsed log entry is validated as an object and bounded: C0/C1
    control characters stripped (`\n`, `\t` kept), output ≤ 4000 chars, command ≤ 320
    (middle-elided), ≤ 2000 entries kept from the tail with `dropped`, a `logs` string
    above 3 MB refused rather than parsed; malformed input yields an empty log, never a
    throw.
30. (Phase 4 SR28) Query values through `Api.seg`, integers from constants: `lines` (200)
    and `take` (10) are module constants, `skip` is clamped, the container endpoint
    family comes from a `hasOwnProperty` whitelist, one tag per request (`TAG_RE`
    excludes the comma).
31. (Phase 4 SR29) A view fetch never poisons global state: the empty-stream branch, the
    per-result branch and the reaper route the five view kinds to `_viewFail`, which sets
    the view's message only; a view success never calls `_succeeded`; only 429 pauses.
32. (Phase 4 SR30) Per-descriptor `max-filesize` (4 MB on the log-bearing kinds, the
    largest a 12 s transfer delivers at the slowest measured throughput), a byte-aware
    deployments cadence, `skipped` and `bytesLastMin` so starvation is observable.
33. (Phase 4 SR31) Fixtures cannot carry a real log or a `read:sensitive` secret:
    `bin/check` walks each fixture's JSON and requires a `logs`/`configuration_snapshot`
    value to be null or `«scrubbed»` and the keys the new ability returns
    (`manual_webhook_secret_*`, `sentinel_token`, `sentinel_custom_url`, `logdrain_*`,
    `last_saved_proxy_configuration`, `last_applied_settings`, `last_saved_settings`,
    `validation_logs`) to be scrubbed; build-log fixtures are hand-authored entry arrays
    under `entries`, the container-log fixture keeps its text under `text`.
34. (Phase 4 SR35) Tag deploy states its blast radius: the confirm says the API cannot
    list what a tag deploys, the response is counted per item (queued / refused, a
    missing deployment uuid or a queue-full item is a refusal), one tag per request.
35. (Phase 4 SR37) Missing `read:sensitive` is detected, not silent: a terminal
    deployment row without `logs` sets `sensitive: "no"` (one-way toward `"yes"`), the
    log view shows the swap-the-token sentence, `_status().sensitive` reports it.
36. (Phase 4 SR32) An instance `id` is a safe filename: `Model.ID_RE`
    (`[A-Za-z0-9_-]{1,32}`) and uniqueness are config errors before any path is built.
37. (Phase 4 SR33) No userinfo in an instance URL: a config error, so credentials never
    reach browser argv or the shell's history files; chips render `name` only.
38. (Phase 4 SR34) Tokens live in one place per context (`_token`, written by
    `_tokenReady`, read by `_launch`); a released context kills its requests and drops its
    token in `Component.onDestruction`; the exposure through `serviceFor()` scales with
    the instance count and is stated here rather than discovered.
39. (Phase 4 SR36) TLS failures are named: curl exit 60 is the `tls` kind at every site
    (`META`, `errorFor`, `barState`, `calloutBody`), retried like a transport error
    (curl aborts before any request, so the Bearer header was never sent); `insecure`,
    `-k` and `proto-default` are never emitted (node test).
40. (Phase 4 SR38) Actions bind to the instance they were opened on: IPC verbs resolve
    against the active instance only (a name against its last resources poll); the
    confirm dialog captures `activeId` and the
    context refuses a mismatch with "Instance changed; nothing sent"; every pending entry
    lives in its context; `status.lastAction.instance` names it.
41. (SR39, 2026-09-13) Fixtures name no real account: `bin/check` extracts every URL host
    (including the `https:\/\/` form inside an escaped-JSON string), bare IPv4,
    `git_repository` and commit-message slug from `tests/fixtures/` and fails on anything
    outside the placeholder set (`example.net`/`.com`/`.org` and subdomains,
    `app.coolify.io`, `localhost`, `203.0.113.x`, RFC 1918, `example/<repo>`,
    `coollabsio/coolify`); `bin/record-fixture` rewrites those fields at capture time.
    Added after the 2026-09-13 review found three live hostnames, a private repository
    path and a real commit message that the by-hand rename and the key-name gates (SR31)
    had both missed. Names and descriptions stay a by-hand check.
42. (SR40, 2026-09-22) Health before auth: exactly one descriptor kind is unauthenticated,
    named by the literal `var UNAUTH = { health: true }` in `Api.js`, GET only, its block
    byte-identical for any token, and the Authorization line is emitted from one
    conditional site; `_dispatch` reports a body that does not parse and `_finish`'s
    `anyOk` follows that report (one `if (ctx._dispatch(` and one `anyOk = true` in
    `Service.qml`, comments stripped). The health answer settles in `_healthDone` and
    touches nothing else; its body is capped at 16 chars by `Model.parseHealth` and never
    stored, logged or shown; `down` never carries the Edit config button.

## Testing

- `node tests/run.js` loads `Model.js` and `Api.js` in separate `vm` contexts (a
  cross-import between them would fail there as it does in QML) and asserts against
  fixtures in `tests/fixtures/`; every test names the function or security requirement
  it covers.
- Fixtures are recorded with `bin/record-fixture <name> <api-path>` using the
  read-only token: `version.txt`, `servers.json`, `server-resources.json`,
  `resources.json`, `projects.json`, `project-detail.json`, `deployments-active.json`,
  `deployments-empty.json`, `deployment-finished.json`, `deployment-failed.json`,
  `error-401.json`, `error-403-api-disabled.json`, `error-403-ability.json`,
  `error-429.json`, `headers-2xx.json`, `batch-stream.txt`; Phase 4 adds `tags.json`,
  `history-page.json` (trimmed to 3 rows), `history-empty.json`, `history-404.json`,
  `service-detail.json` (trimmed), `container-log-400.json`, `container-log-404.json`,
  and the hand-written `deployment-log-failed.json`, `deployment-log-finished.json`
  (entry arrays under `entries`, fabricated hosts and images), `container-log.json`
  (text under `text`), `tags-empty.json`, `action-deploy-tag-ok.json`. Hand-written ones
  say so in a `_note` key.
- `bin/check`: node tests, repo symlink scan, fixture secret scan (a jq walk: SR31),
  fixture identity scan (hosts, IPs, repository and commit slugs: SR39),
  PlainText and `font.family` count gates over every `.qml` including `TextEdit`/
  `TextArea`, the rich-text ban (SR25), the no-log-text-in-console grep (SR26),
  hardcoded-token grep, `omarchy plugin validate` of a staged
  copy of the shipping list, and `qmllint` through a temp import root containing
  `qs -> /usr/share/omarchy/shell`, gated on import/type-resolution failures and hard
  errors. `--no-shell` is the CI subset.
- Manual matrix before a release: click, `r`, `g`, `j/k`, Enter on a fold, Esc, Tab to a
  neighbour panel, `omarchy-shell shell toggle`, disable, enable, `omarchy restart
  shell`, remove, config file deleted while running, token revoked while running,
  `url` pointed at `https://127.0.0.1:9` (offline). Token-leak checks: `ps -eww -o
  args=` and `quickshell log -t 100000`, each piped through `grep -cFf <(needle)`.

## Runtime paths

| Path | Purpose |
|---|---|
| `~/.config/coolwatch/config.json` | instances, tokens, poll and notify settings (0600 in a 0700 directory) |
| `~/.local/state/coolwatch/recent.json` | recent terminal deployments of `instances[0]`, survives restarts; the directory is created and chmod'ed 0700 by the service (`mkdir -m` is create-only), the file is umask-mode |
| `~/.local/state/coolwatch/recent-<id>.json` | the same for every further instance (Phase 4); a removed instance's file is left in place |
| `~/.local/state/coolwatch/ui.json` | grouping and folded set per instance id, one file for all instances (Phase 4b); a removed instance's entry is pruned on the next write |
| `~/.config/omarchy/plugins/io.github.danjonesio.coolwatch/` | installed plugin files |
| `~/.config/omarchy/shell.json` | bar placement and display-only widget settings |
