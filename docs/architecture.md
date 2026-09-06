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
  `refresh`, `status`, `deploy <uuid>`, `restart <uuid>`, `stop <uuid>`, `start <uuid>`
  so scripts and keybindings can drive it.
- Hot reload: saving under `~/.config/omarchy/plugins/` reloads the plugin. `bin/dev-sync`
  copies the repo there (the validator refuses symlinks).

## Configuration

Secrets and behaviour live in one file the plugin owns, not in `shell.json`, because
`shell.json` is a layout file that tools like omardan print, diff and rewrite.

`~/.config/omarify/config.json`, mode `0600`, watched with `FileView { watchChanges: true }`:

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
  "poll": { "deploymentsSec": 5, "resourcesSec": 30, "serversSec": 60, "treeSec": 300 },
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
  present. `tokenCommand` is an argv array run through `Process` on load and on every
  config change; its stdout (trimmed) is the token. It is never logged.
- Recommended token abilities: `read`, `read:sensitive`, `deploy`. `write` is only
  needed for "Validate server"; the panel gates that action on it and names the missing
  ability instead of failing silently.
- `url` is the origin; the service appends `/api/v1`. Cloud is
  `https://app.coolify.io`; self-hosted is usually `https://coolify.example.com` or
  `http://ip:8000`.
- Missing file → bar icon "not configured", panel shows the path and a sample.
- Bar-widget `settings` in `shell.json` are for display only (`groupBy`,
  `showLabel`), read with `setting(key, fallback)`; manifest `defaults` are not merged
  at runtime, so every read has a fallback.

## HTTP client

Omarchy panels do HTTP with `curl` inside `Quickshell.Io.Process` (weather does; the
tree has no `XMLHttpRequest`). We do the same, with one rule: **the token never appears
in argv**, because argv is visible in `ps` to every process on the machine.

```
command: ["curl", "-sS", "--max-time", "15", "-K", "-", "-w", "\n%{http_code}"]
stdinEnabled: true
onStarted: write(Api.curlConfig(instance, request))
```

`Api.curlConfig` emits curl's config-file syntax:

```
url = "https://app.coolify.io/api/v1/deployments"
header = "Authorization: Bearer 67|…"
header = "Accept: application/json"
header = "Content-Type: application/json"
request = "POST"
data = "{}"
```

- `-w '\n%{http_code}'` appends the status so one `StdioCollector` yields body and
  code; `Model.splitResponse(text)` separates them.
- One `Process` per logical request kind (deployments, resources, servers, tree,
  action, log) so calls of different kinds overlap but the same kind never stacks.
  Each carries a monotonic sequence number; late output from an older request is
  dropped (the `MultiSelect.optionsCommand` pattern).
- `--max-time 15`, and a watchdog timer that kills a hung process before the next
  tick (the tailscale panel lesson).
- Errors map to state: `401` → "token rejected", `403` → parse the message (API
  disabled, IP not allowed, missing ability), `429` → back off using `Retry-After`,
  curl exit 6/7/28 → "offline, retrying". The last good snapshot stays on screen.

## Polling schedule

Budget is 200 requests per minute per token. Idle cost is 16 per minute; one active
deployment adds 30.

| Request | Idle | Panel open | Deployment active | Purpose |
|---|---|---|---|---|
| `GET /deployments` | 5 s | 5 s | 2 s | detect queued and in-progress |
| `GET /deployments/{uuid}` per tracked uuid | — | — | 2 s | progress and terminal state |
| `GET /resources` | 30 s | 10 s | 10 s | every app/service/db with status |
| `GET /servers` | 60 s | 30 s | 30 s | reachability, proxy |
| `GET /projects` + `GET /projects/{uuid}/{env}` per env | 300 s | on open | — | project › environment › resource tree |
| `GET /version` | on config load | — | — | feature gate and hero detail |

- Timers pause while the config has no instances and while the machine has no
  network (curl failures back off to 30 s, then 60 s, capped).
- After any action the next deployments and resources polls run immediately.
- `GET /resources` is heavy but one call. If it proves slow on big accounts, switch
  to `GET /servers/{uuid}/resources` per server.

## State model

The service holds one normalised store per instance. Everything the panel renders is a
plain object built by `Model.js`, never a live QObject in a ListView.

```
instance:  { id, name, url, version, online, error, lastPollAt }
server:    { uuid, name, ip, reachable, usable, disabled, proxyStatus, resourceCount }
resource:  { uuid, name, kind (application|service|database), type, status,
             state (running|starting|restarting|degraded|paused|exited|unknown),
             health (healthy|unhealthy|unknown), fqdn, serverUuid, projectUuid,
             environmentName, pending (deploy|restart|stop|start|null), pendingSince }
deployment:{ uuid, appUuid, appName, status, commit, commitMessage, createdAt,
             updatedAt, url, restartOnly, force, isApi, isWebhook }
tree:      [ { project, environments: [ { name, resources: [uuid…] } ] } ]
```

- `Model.parseStatus("running:healthy")` → `{ state, health }`; bare `exited` and
  `exited:unhealthy` are the same state. Prefix-match, never equality.
- Deployment status vocabulary: `queued`, `in_progress`, `finished`, `failed`,
  `cancelled-by-user`.
- The tree is joined by uuid: resources come with status from `/resources`; the
  environment call tells us which project and environment each uuid belongs to;
  `/servers/{uuid}/resources` or the flat item's `destination_id` maps to a server.
- `recentDeployments` keeps the last 20 terminal deployments in memory and in
  `~/.local/state/omarify/recent.json` so a shell restart does not blank the section.

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

- Token never in argv, never in QML `console.*` output, never in the state file. Error
  bodies are logged only after `Model.redact()` strips anything matching
  `\d+\|[A-Za-z0-9]+`.
- Config file created by the user, checked for `0600`; a group- or world-readable file
  produces a warning in the panel hero.
- Every action that changes remote state goes through a confirm dialog when it is
  destructive (Stop, Redeploy without cache). Deploy, Restart and Start do not, because
  Coolify itself does not confirm them.
- Every URL opened in the browser is one Coolify returned (`deployment_url`, `fqdn`,
  or `url + "/project/…"`) and is passed as a single argv element.
- Log text from Coolify is rendered with `textFormat: Text.PlainText`.

## Testing

- `node tests/run.js` loads `Model.js` and `Api.js` in a `vm` context (omasnitch's
  runner) and asserts against fixtures in `tests/fixtures/` — recorded real responses
  with uuids kept and secrets replaced.
- Fixtures to record first: `servers.json`, `resources.json`, `projects.json`,
  `environment.json`, `deployments-active.json`, `deployment-finished.json`,
  `deployment-failed.json`, `deploy-response.json`, `error-403-ability.json`.
- `omarchy plugin validate <dir>` and `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell *.qml`
  in `bin/check`.
- Manual matrix before a release: click, `r`, Esc, Tab to neighbour panel, `omarchy-shell
  shell summon/hide`, disable, enable, `omarchy restart shell`, remove, config file
  deleted while running, token revoked while running, laptop offline.

## Runtime paths

| Path | Purpose |
|---|---|
| `~/.config/omarify/config.json` | instances, tokens, poll and notify settings (0600) |
| `~/.local/state/omarify/recent.json` | recent terminal deployments, survives restarts |
| `~/.config/omarchy/plugins/io.github.danjonesio.omarify/` | installed plugin files |
| `~/.config/omarchy/shell.json` | bar placement and display-only widget settings |
