# Architecture

```
Coolify Cloud / self-hosted        REST, Bearer token, 200 req/min
        │
        │  curl (config over stdin, token never in argv)
        ▼
Service.qml        one instance for the whole shell; owns polling, state, actions,
  │                change detection, notifications, config file watch
  │  bar.shell.serviceFor("io.github.danjonesio.omarify")
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
- `omarchy-shell shell summon|hide|toggle io.github.danjonesio.omarify` is routed to
  the bar widget's `open()`, `close()`, `opened` because the plugin has no panel kind.
  The payload is dropped on that path, so no feature depends on it.
- The service registers `IpcHandler { target: "io.github.danjonesio.omarify" }` with
  `refresh` and `status` (Phase 1; `status` returns fixed-shape JSON with counts,
  per-kind timings and the rolling request count, never a secret, body or URL).
  `deploy <uuid>`, `restart <uuid>`, `stop <uuid>`, `start <uuid>` are Phase 2.
- Hot reload: saving under `~/.config/omarchy/plugins/` reloads the plugin. `bin/dev-sync`
  copies the repo there (the validator refuses symlinks).

## Configuration

Secrets and behaviour live in one file the plugin owns, not in `shell.json`, because
`shell.json` is a layout file that tools like omardan print, diff and rewrite.

`~/.config/omarify/config.json`, mode `0600` in a `0700` directory the service creates, watched with two `FileView`s (file and directory):

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
- Token abilities are per phase: Phase 1 `read` only; `deploy` from Phase 2;
  `read:sensitive` from Phase 4 (it also makes `GET /deployments` carry full build
  logs). `write` is only needed for "Validate server"; the panel gates that action on
  it and names the missing ability instead of failing silently.
- Mode check: a `stat -c '%a %U'` process runs on every load and on every `refresh`.
  Group- or world-**writable**, or owned by someone else → "Config unsafe", no polling
  and no `tokenCommand` (a writable config could point the token at another `url`).
  Group- or world-readable with an inline `token` → a warning in the panel, polling
  continues.
- `url` must start with `http://` or `https://`; `http://` shows a plaintext warning.
- Every `poll` key has the default shown; values below 2 clamp to 2. `topologySec` is
  raised at runtime so the topology fan-out costs at most 3 req/min.
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
max-time = "6"
max-filesize = "8388608"
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
- Per-kind `max-time` (deployments 6, deployment 6, version 6, resources 10, servers 10,
  topology 8 per block). A `Req`'s deadline is `blocks × max-time + 3` s; one 5 s reaper
  `Timer`, armed once at service start, kills a `Req` past its deadline (bumping `seq`
  first) and counts a reap as a failure.
- Errors map per transfer: exit 6/7/28/35/60 → offline; exit 63 → response too large;
  401 → token rejected; 403 by `message` → API disabled / IP not allowed / missing
  ability; 429 → rate limited (`Retry-After` clamped to 1–300 s, else 30 → 60 → 60);
  other → Coolify error. Never read a `success` field (the 403 API-disabled body says
  `true`). The last good snapshot stays on screen with "Showing data from N ago".
- offline/http/reap back off 30 → 60 → 60 s on that kind; 429 pauses every timer;
  401/403 stop every timer and probe `GET /deployments` once a minute until a 2xx or a
  config change.
- Logging: only kind, HTTP code, curl exit, timing, bytes and a redacted, elided
  `errmsg`/`message`. Never a body, the config text, or token-command output.

## Polling schedule

Budget is 200 requests per minute per token; the acceptance bar is under 20/min idle
and under 60/min with one deployment. Idle is ≈17/min at 3 projects and 3 servers.

| Kind | Idle | Any panel open | Deployment active | Purpose |
|---|---|---|---|---|
| `GET /deployments` | 4 s | 4 s | 2 s | queued and in-progress |
| `GET /deployments/{uuid}` | once per uuid that vanished from the list | | | terminal state; never polled while active |
| `GET /resources` | 60 s | 30 s | 15 s | every app/service/db with status and `environment_id` |
| `GET /servers` | 120 s | 120 s | 120 s | reachability |
| topology, batched | `topologySec` ≥ 600 s | on first open, then as idle | as idle | `GET /projects`, then `GET /projects/{uuid}` × P and `GET /servers/{uuid}/resources` × S |
| `GET /version` | on config load | | | hero detail |

- A kind's interval is the minimum across every applicable column. Timers use
  `triggeredOnStart: false` and an explicit `primeAll()` (config load, token resolve,
  `refresh`, first panel open, at most once per 2 s), because changing a running
  `Timer`'s `interval` restarts it; after an interval change a kind whose last poll is
  older than the new interval launches immediately.
- Startup: deployments, version, resources and servers launch together; topology 2 s
  later. The icon lights on the first deployments response. A `startupRamp` retries
  every 2 s for 30 s if the first attempts are offline.
- Topology is `/projects` (35 s after the token is ready, then every `topologySec`),
  followed by one stage-2 block (`/projects/{uuid}` × P, `/servers/{uuid}/resources` × S)
  every 30 s until the queue drains, so no 60 s window holds more than ~3 topology
  requests; a server that answers late gets its resource list queued the same way.
  `topologySec` is raised so `(1 + P + S)` per cycle costs at most 3 req/min. Coolify refreshes stored statuses about once a minute, so faster
  resource polling would return the same bytes.
- Vanished deployment uuids go on a deduped queue (cap 20) drained one at a time by the
  `deployment` `Req`; its dispatch and fail handlers pop the next uuid immediately.
- "Panel open" is a registry keyed by panel id: `panelOpened(id)`, `panelClosed(id)`
  (also from `Component.onDestruction`), and a `panelAlive(id)` ping every second
  while open; entries older than 5 s expire, so a destroyed panel or a hot-reloaded
  service cannot pin the fast cadence.
- A ring of request timestamps backs `status.requestsLastMin`, the number the
  acceptance test reads.

## State model

The service holds one normalised store per instance. Everything the panel renders is a
plain object built by `Model.js`, never a live QObject in a ListView.

```
snapshot:  { instance, error, warning, servers, resources, deployments, recent, tree,
             byServer, failedUnacked, lastPollAt, busy, openPanels, baselineDone, backoffSec }
instance:  { id, name, url, version, plaintext }
error:     null | { kind, title, detail, httpCode, curlExit, request, at, staleSince }
           kind ∈ noconfig | configerror | unsafe | tokencmd | waitingtoken | auth |
                  apidisabled | ipblocked | ability | ratelimited | offline | toolarge | http
warning:   null | { kind (permissions | plaintext), title, detail }
server:    { uuid, name, ip, reachable, usable, disabled, buildServer, resourceCount }
resource:  { uuid, name, kind (application|service|database), type, status,
             state (running|starting|restarting|degraded|paused|exited|unknown),
             health (healthy|unhealthy|unknown), fqdn, environmentId, serverUuid,
             projectUuid, projectName, environmentName, gitBranch,
             pending (Phase 2) }
deployment:{ uuid (from deployment_uuid), appUuid, appName, branch, status, commit,
             commitMessage, createdAt, updatedAt, url, restartOnly, force, isApi, isWebhook }
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
  newest 5). Phase 3 persists them to `~/.local/state/omarify/recent.json`.
- Panels never build state: the service builds the snapshot once per poll; a panel
  flattens it into rows only while open and reassigns its ListView model only when
  `Model.sameRows` says the rows changed. The cursor is a row key, not an index.

## Change detection and notifications

Every deployments poll diffs the new active set against the tracked set:

```
new uuid, status queued          → "Queued"      (if notify.deploymentQueued)
tracked uuid queued → in_progress → "Building"
tracked uuid gone from active list → GET /deployments/{uuid} once
    finished          → "Deployed"
    failed            → "Deployment failed"
    cancelled-by-user → "Cancelled"
```

Resource polls diff `state` per uuid. A change to `exited` or `degraded` that is not
explained by a pending user action or an active deployment for that app raises
"Stopped unexpectedly". Server polls diff `reachable`.

The first successful poll after service start or config change is a **baseline**:
it seeds the tracked sets and raises nothing. Otherwise a shell restart during a
deployment would replay a notification.

Notifications go through Omarchy's own helper, never `notify-send`:

```
Util.execArgv(["omarchy-notification-send",
  "--app-name", "io.github.danjonesio.omarify",
  "-g", "<glyph>", "-u", "normal",
  "Deployed api", "main · fix login redirect",
  "--exec", "omarchy-launch-browser", deployment.url])
```

`--app-name` set to the plugin id means the toast lands in history and respects Do
Not Disturb. Failed deployments and unreachable servers use `-u critical`, which
bypasses Do Not Disturb by Dan's decision; everything else is `low` or `normal`.

## Actions

All actions are `POST` with an empty JSON body (the lifecycle routes reject `GET`).

| Panel action | Request | Optimistic state |
|---|---|---|
| Deploy | `POST /deploy?uuid=<uuid>` | resource `pending: deploy`; deployment appears on next poll |
| Redeploy (no cache) | `POST /deploy?uuid=<uuid>&force=true` | same, after confirm |
| Restart | `POST /<kind>/{uuid}/restart` | `pending: restart` (apps: a deployment with `restart_only`) |
| Stop | `POST /<kind>/{uuid}/stop` | `pending: stop`, after confirm |
| Start | `POST /<kind>/{uuid}/start` | `pending: start` |
| Cancel | `POST /deployments/{uuid}/cancel` | deployment `status: cancelled-by-user` |
| Validate server | `POST /servers/{uuid}/validate` | server `validating: true` until `is_reachable` changes |
| Open | `omarchy-launch-browser <url>` | — |

`pending` clears when the polled status changes, or after 90 s with an inline "still
pending" note. The action process's stderr and any non-2xx body become a short
`actionStatus` line in the panel for 2.2 s (tailscale's `actionStatusTimer`).

Ability errors are surfaced as text, not swallowed: "Token lacks the deploy
permission" tells the user exactly what to add in Coolify.

## Security

1. Curl config injection: every emitted value passes `Api.quote`, every path segment
   `Api.seg`; the write-out is a per-block line through `quote` too.
2. `~/.curlrc` isolation: `-q` is argv[1]; nothing else is in argv.
3. Bounds per block: `connect-timeout 5`, per-kind `max-time`, `max-filesize 8388608`
   (exit 63 → "response too large"), `proto =https,http`; `url` validated on load,
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
14. Destructive actions (Phase 2) confirm; every browser URL is one Coolify returned,
    passed as a single argv element.

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
  `error-429.json`, `headers-2xx.json`, `batch-stream.txt`. Hand-written ones say so
  in a `_note` key.
- `bin/check`: node tests, repo symlink scan, fixture secret scan, PlainText and
  `font.family` count gates, hardcoded-token grep, `omarchy plugin validate` of a staged
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
| `~/.config/omarify/config.json` | instances, tokens, poll and notify settings (0600 in a 0700 directory) |
| `~/.local/state/omarify/recent.json` | recent terminal deployments, survives restarts (Phase 3) |
| `~/.config/omarchy/plugins/io.github.danjonesio.omarify/` | installed plugin files |
| `~/.config/omarchy/shell.json` | bar placement and display-only widget settings |
