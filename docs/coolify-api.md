> Reference generated 2026-09-06 from coolify.io docs (`llms-full.txt`), the Coolify
> v4.x `openapi.yaml` (identical at tag v4.3.17, kept at
> `docs/reference/coolify-openapi-v4.3.17.yaml`), and Coolify PHP source. It is the
> factual basis for `docs/product.md` and `docs/architecture.md`. When Coolify ships a
> new release, re-check §6 first.

# Coolify REST API — research notes for the Omarchy desktop plugin

Researched 2026-09-06. Sources consulted (only the openapi file is kept, under `docs/reference/`):

- `coolify-llms-full.txt` (not kept in repo) — full coolify.io docs dump (Authorization page at lines 1-300, Sentinel at 15298, Notifications at 12018, Webhook Payloads at 15560, MCP Server at 7992, API reference pages from line 26525 on).
- `openapi.yaml` — `raw.githubusercontent.com/coollabsio/coolify/v4.x/openapi.yaml` (OpenAPI 3.1, 275 operations). `openapi-v4.3.17.yaml` is the same file at the current release tag; **the two are identical**, so everything below is released in v4.3.17 (released 2026-09-04; `versions.json` on v4.x currently advertises 4.3.18 as the v4 auto-update target and 4.4-rc.1 nightly).
- `src/*.php` — Coolify source at v4.x (routes/api.php, the Api controllers, models, enums, middleware, ContainerStatusAggregator, HasMetrics trait) fetched to verify behaviour the OpenAPI does not spell out.
- `src/sentinel-README.md` — README of github.com/coollabsio/sentinel.

Everything marked **[src]** is verified from Coolify PHP source, **[openapi]** from openapi.yaml, **[docs]** from the docs dump.

---

## 1. Authentication

### Enabling the API (self-hosted only)
- **[docs Authorization]** Settings → Advanced → "API Settings" → toggle **API Access** on. Optional **Allowed IPs for API Access** field (comma-separated IPv4/IPv6 addresses and CIDRs; empty or `0.0.0.0` = allow all). Misconfiguring locks you out with 403.
- **[src ApiAllowed.php]** The middleware short-circuits with `if (isCloud()) return $next()` — on **Coolify Cloud the API is always enabled and there is no IP allowlist**. Self-hosted: disabled API returns HTTP 403 `{"success":true,"message":"API is disabled."}`; blocked IP returns 403 `{"message":"You are not allowed to access the API."}`.
- Programmatic toggle: `POST /api/v1/enable`, `POST /api/v1/disable` (need `write` ability per routes; docs say `root`). `GET` on those paths returns a "POST required" error.

### Creating a token
- **[docs]** Security → API Tokens → name, expiry (7/30/60/90 days, 1 year, or never), pick permissions, Create. Shown **once**. Format `67|abcthisisa123dummytoken` — the integer before `|` is the Sanctum token id, the rest is the secret; send the whole string. Stored as SHA-256; expiring tokens trigger a warning email.
- Tokens are bound to the team that was active when created. All list endpoints are team-scoped; one token per team.

### Header
```
Authorization: Bearer 67|abcthisisa123dummytoken
Accept: application/json
Content-Type: application/json   (for POST/PATCH bodies)
```
`Accept: application/json` matters: Laravel returns HTML redirects for unauthenticated requests without it.

### Permissions / abilities (Sanctum token abilities) **[docs + src ApiAbility.php, ApiSensitiveData.php, routes/api.php]**
| Ability | What it unlocks |
|---|---|
| `read` | Every GET (servers, projects, envs, apps, dbs, services, deployments, logs endpoints, version, teams, notification settings). |
| `read:sensitive` | Adds secret fields to responses: env var values, passwords, private keys, docker compose bodies, `sentinel_token`, log drain keys, **and deployment `logs`** (see §2 Deployments). Only effective if the user is admin/owner of the team. |
| `write` | POST/PATCH/DELETE on resources, `/servers/{uuid}/validate`, `/enable`, `/disable`, notification settings PATCH. |
| `write:sensitive` | Used only by `PATCH /settings/email`. |
| `deploy` | `POST /deploy`, `POST /deployments/{uuid}/cancel`, all `start`/`stop`/`restart` routes (apps, dbs, services, service sub-containers), rollback. |
| `root` (shown as `*`/"Full access" in UI) | Bypasses every ability check; only admins/owners can create it. |

- Missing ability → 403 `{"message":"Missing required permissions: deploy"}`. Bad/expired token → 401 `{"message":"Unauthenticated."}`.
- **[src ApiAbility]** Team *members* (non-admin) may only hold `read`; a member's token that carries `write`/`deploy`/`read:sensitive`/`root` is rejected with 403 on every call.
- For this plugin: `read` + `deploy` is the minimum; add `read:sensitive` if you want deployment build logs and container env values; `write` only for server validate / notification-webhook configuration.

### Base URLs
- Self-hosted: `http(s)://<host>:8000/api/v1` (port 8000 by default; via reverse proxy usually `https://coolify.example.com/api/v1`).
- Coolify Cloud: `https://app.coolify.io/api/v1` **[openapi servers[0]]**.
- `GET /api/health` and `GET /api/v1/health` are unauthenticated and outside the ability system (return plain `OK`). `/api/feedback` is also outside `/v1`.

### Rate limiting **[docs + src RouteServiceProvider.php, config/api.php]**
- `RateLimiter::for('api')`: **200 requests/minute per user-id (or IP)**, configurable with env `API_RATE_LIMIT` on self-hosted. `/api/health` gets 1000/min. Exceeding → HTTP 429. Standard Laravel headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` are present.
- Coolify Cloud: same 200/min default; not user-configurable.

---

## 2. Endpoint inventory (all paths relative to `/api/v1`) **[openapi + routes/api.php]**

Lifecycle verbs (`start`/`stop`/`restart`/`deploy`/`validate`/`enable`) are **POST only**; a GET to them returns a JSON "POST required" error (routes map GET → `OtherController::post_required`). The docs sentence "`Post` request is also accepted" is legacy — GET does not work.

### System
| Method | Path | Ability | Notes |
|---|---|---|---|
| GET | `/health` (also `/api/health`) | none | text `OK` |
| GET | `/version` | read | text/html body, e.g. `4.3.17` (no leading `v` in current versions; treat as opaque string) |
| POST | `/enable`, `/disable` | write (docs: root) | toggle API |
| POST | `/mcp/enable`, `/mcp/disable` | write (docs: root) | MCP server at `https://<host>/mcp` (Streamable HTTP, same Bearer token, read-only tools; see §4) |

### Teams
| GET `/teams` | GET `/teams/{id}` | GET `/teams/{id}/members` | GET `/team` (token's team) | GET `/team/members` | also `/teams/current`, `/teams/current/members` |
Team object: `id, name, description, personal_team, created_at, updated_at, show_boarding, custom_server_limit, members[]`. Note teams use integer `id`, not uuid.

### Servers
| Method | Path | Ability | Notes |
|---|---|---|---|
| GET | `/servers` | read | array of Server (see shape below) |
| POST | `/servers` | write | body `name, description, ip, port, user, private_key_uuid, is_build_server, instant_validate, proxy_type(traefik|caddy|none)` → 201 `{uuid}` |
| GET | `/servers/{uuid}` | read | `?resources=true` adds `resources[]` (same shape as `/resources` below) **[src]** |
| PATCH | `/servers/{uuid}` | write | name, description, ip, port, user, private_key_uuid, is_build_server, instant_validate, proxy_type, concurrent_builds, dynamic_timeout, deployment_queue_limit, server_disk_usage_notification_threshold, server_disk_usage_check_frequency, connection_timeout |
| DELETE | `/servers/{uuid}` | write | 400 if it has resources unless `?force=true` |
| GET | `/servers/{uuid}/resources` | read | `[{id, uuid, name, type, status, created_at, updated_at}]` — every application/database/service on that server with its **status string**. Cheapest "everything on server X" call. |
| GET | `/servers/{uuid}/domains` | read | `[{ip, domains: [..]}]` |
| POST | `/servers/{uuid}/validate` | write | optional body `{install: bool}`; 201 `{"message":"Validation started."}` — **async**, poll `GET /servers/{uuid}` → `settings.is_reachable` / `is_usable` / `validation_logs`. |
| GET/PATCH | `/servers/{uuid}/sentinel` | read/write | Sentinel settings (see §3) |
| GET/PATCH | `/servers/{uuid}/proxy`, PUT `/servers/{uuid}/proxy/configuration`, POST `/servers/{uuid}/proxy/restart` | read/write | proxy (Traefik/Caddy) settings and restart |
| GET/PATCH/POST | `/servers/{uuid}/docker-cleanup`, `/docker-cleanup/run`, GET `/docker-cleanup/executions` | read/write | cleanup config, trigger, history |
| GET/PATCH | `/servers/{uuid}/log-drains` | | New Relic/Axiom/custom |
| GET/PATCH/POST | `/servers/{uuid}/cloudflare-tunnel[/enable|/disable]` | | |
| GET/POST/PATCH/DELETE | `/servers/{uuid}/envs[/{env_id}]` | | server-scoped shared env vars |
| GET/POST | `/servers/{server_uuid}/destinations` | | docker network destinations |
| misc | `/servers/{uuid}/migrate`, `/export`, `/export/mailbox`, `/claim`, `/transfer/complete`, POST `/servers/import` | | instance-to-instance server transfer |
| POST | `/servers/hetzner`, `/servers/digitalocean`, `/servers/vultr` + `/hetzner/*`, `/digitalocean/*`, `/vultr/*` catalog GETs, `/cloud-tokens*`, `/cloud-init-scripts*` | | cloud provisioning |

**Server object** (`GET /servers`, verified **[src ServersController::servers]**): the list endpoint selects only `name, uuid, ip, user, port, description` and then appends `is_reachable`, `is_usable`, `is_coolify_host` and a `proxy` object holding **only `redirect_enabled`** (verified 4.3.19, 2026-09-12) at top level plus a full `settings` object; `id` is hidden. With `read:sensitive` the list's `settings` also carries `sentinel_token`, and `GET /resources` grows from 65 KB to 100 KB with `docker_compose`, `dockerfile`, `custom_labels`, `http_basic_auth_password` and the `manual_webhook_secret_*` values: whitelist at normalise, scrub at record. `GET /servers/{uuid}` returns the whole model: `uuid, name, description, ip, user, port, proxy{type,status,...}, proxy_type, high_disk_usage_notification_sent, unreachable_notification_sent, unreachable_count, validation_logs, log_drain_notification_sent, swarm_cluster, sentinel_updated_at, settings{...}`.
`settings` fields **[openapi ServerSetting]**: `is_reachable, is_usable, is_build_server, is_jump_server, is_swarm_manager, is_swarm_worker, is_cloudflare_tunnel, is_terminal_enabled, is_sentinel_enabled, is_metrics_enabled, sentinel_metrics_refresh_rate_seconds, sentinel_metrics_history_days, sentinel_token (read:sensitive only), concurrent_builds, deployment_queue_limit, dynamic_timeout, force_disabled, force_server_cleanup, docker_cleanup_frequency, docker_cleanup_threshold, delete_unused_volumes, delete_unused_networks, connection_timeout, wildcard_domain, logdrain_* ...`.
There is **no CPU/RAM/disk field on the server object** (see §3).

### Private keys
GET `/security/keys`, POST `/security/keys`, PATCH `/security/keys` (uuid in body), GET/DELETE `/security/keys/{uuid}`. Private key material only with `read:sensitive`.

### Projects & environments
| Method | Path | Notes |
|---|---|---|
| GET | `/projects` | `[{id, uuid, name, description}]` |
| POST/PATCH/DELETE | `/projects`, `/projects/{uuid}` | |
| GET | `/projects/{uuid}` | project + `environments[]` (`{id, uuid, name, description, project_id, created_at, updated_at}`) **[src]** |
| GET | `/projects/{uuid}/environments` | list environments |
| POST/PATCH/DELETE | `/projects/{uuid}/environments[/{environment_name_or_uuid}]` | |
| GET | `/projects/{uuid}/{environment_name_or_uuid}` | environment **with** `applications[]`, `postgresqls[]`, `redis[]`, `mongodbs[]`, `mysqls[]`, `mariadbs[]`, `services[]` (full models incl. `status`) **[src ProjectController::environment_details]**. Note: keydb/dragonfly/clickhouse are *not* loaded here. |
| GET/POST/PATCH/DELETE | `/projects/{uuid}/envs[/{env_id}]`, `/projects/{uuid}/environments/{env}/envs[/{env_id}]`, `/team/envs[/{env_id}]` | shared env vars (project / environment / team scope) |

### Resources (flat inventory)
`GET /resources` — **[src ResourcesController]** returns a flat array of every application, service, and database (all DB types) for the team; each item is the full model `toArray()` plus `status` and `type` (`application`, `service`, `standalone-postgresql`, `standalone-redis`, `standalone-mysql`, `standalone-mariadb`, `standalone-mongodb`, `standalone-keydb`, `standalone-dragonfly`, `standalone-clickhouse`). OpenAPI marks the schema as "Content is very complex. Will be implemented later." Heavy but the best single call for a dashboard.

### Applications
| Method | Path | Ability | Notes |
|---|---|---|---|
| GET | `/applications` | read | `?tag=` filter. Array of Application. |
| POST | `/applications/public`, `/private-github-app`, `/private-deploy-key`, `/dockerfile`, `/dockerimage` | write | create by source type (`/applications/dockercompose` is deprecated → use services) |
| GET | `/applications/{uuid}` | read | Application |
| PATCH | `/applications/{uuid}` | write | any Application field |
| DELETE | `/applications/{uuid}` | write | `?delete_configurations&delete_volumes&docker_cleanup&delete_connected_networks` |
| GET | `/applications/{uuid}/logs` | read | `?lines=100` (no server-side clamp: `lines=100000` returned 2.3 MB; the docs say max 10000) `&show_timestamps=false` → `{"logs": "<text>"}`, no trailing newline; **404 `Container not found.`** when no container is running (the source says 400; verified 4.3.19) |
| POST | `/applications/{uuid}/start` | deploy | `?force=true` (no-cache rebuild) `&instant_deploy=true` (skip queue) → `{message:"Deployment request queued.", deployment_uuid}` |
| POST | `/applications/{uuid}/restart` | deploy | `{message:"Restart request queued.", deployment_uuid}` — a restart is itself a deployment queue entry with `restart_only=true` |
| POST | `/applications/{uuid}/stop` | deploy | `?docker_cleanup=true` → `{message:"Application stopping request queued."}` (no deployment uuid; poll status) |
| GET | `/applications/{uuid}/rollback-images` | read | `{current, images:[{tag, created_at, is_current}]}` |
| POST | `/applications/{uuid}/rollback` | deploy | body `{commit}` → `{message, deployment_uuid}` |
| GET/POST/PATCH/DELETE | `/applications/{uuid}/envs`, `/envs/bulk`, `/envs/{env_uuid}` | read/write | env vars (values need read:sensitive) |
| GET/POST/PATCH/DELETE | `/applications/{uuid}/storages[/{storage_uuid}]`, PUT/DELETE/POST `.../storages/{storage_uuid}/backups[/run]` | | volumes and volume backups |
| GET/POST/DELETE | `/applications/{uuid}/tags[/{tag_uuid}]` | | |
| GET/POST/PATCH/DELETE/POST | `/applications/{uuid}/scheduled-tasks[/{task_uuid}][/executions|/execute]` | | cron tasks |
| POST | `/applications/{uuid}/move`, `/migrate`, `/clone` | write | |
| GET/POST/DELETE | `/applications/{uuid}/destinations[/{destination_uuid}]` | | multi-server |
| DELETE/PATCH | `/applications/{uuid}/previews/{pull_request_id}` | | PR previews |

**Application object** (key fields, **[openapi Application]**): `id, uuid, name, description, fqdn, status, build_pack (nixpacks|railpack|static|dockerfile|dockercompose), git_repository, git_branch, git_commit_sha, git_full_url, docker_registry_image_name, docker_registry_image_tag, ports_exposes, ports_mappings, base_directory, publish_directory, health_check_* , limits_memory, limits_cpus, ..., destination_type, destination_id, environment_id, source_id, private_key_id, dockerfile, docker_compose*, custom_labels, watch_paths, redirect, preview_url_template, max_restart_count, created_at, updated_at, deleted_at, settings{...}` plus (from the model, not in openapi) `restart_count, last_restart_at, last_online_at, container_present, restart_limit_reached`. `status` is the colon-form string described in §5, e.g. `"running:healthy"`. Note there is **no `server_uuid`/`project_uuid` on the app** — only `destination_id` (integer) and `environment_id` (integer); map via `GET /servers/{uuid}/resources` or `GET /projects/{uuid}/{env}` if you need the tree.

### Databases (standalone)
| Method | Path | Notes |
|---|---|---|
| GET | `/databases` | all types, each with `status`, `type`-specific fields, `backup_configs[]` (with `latest_log`) **[src]** |
| POST | `/databases/postgresql|mysql|mariadb|mongodb|redis|keydb|dragonfly|clickhouse` | create |
| GET/PATCH/DELETE | `/databases/{uuid}` | openapi schema again says "very complex"; response is the model incl. `uuid, name, description, status, image, is_public, public_port, internal_db_url / external_db_url (sensitive), limits_*, environment_id, destination_id, created_at, updated_at` |
| GET | `/databases/{uuid}/logs` | `?lines&show_timestamps` → `{logs}` |
| POST | `/databases/{uuid}/start`, `/restart`, `/stop` (`?docker_cleanup`) | deploy ability; responses are `{message: "... request queued."}` — **no deployment uuid** for databases |
| GET/POST/PATCH/DELETE | `/databases/{uuid}/backups[/{scheduled_backup_uuid}][/executions[/{execution_uuid}]]` | backup schedules and executions (execution has `status`, `message`, `size`, `created_at`) |
| envs, storages, tags, move, migrate, clone | same pattern as applications | |

### Services (one-click / compose stacks)
| Method | Path | Notes |
|---|---|---|
| GET | `/services` | array of Service **[src: no sub-resources loaded]** |
| POST | `/services` | create one-click/custom service |
| GET | `/services/{uuid}` | Service **with `applications[]` and `databases[]`** sub-resources loaded **[src]**; each sub-resource has `uuid, name, human_name, description, image, fqdn, status, exclude_from_status, is_log_drain_enabled, ...` |
| PATCH/DELETE | `/services/{uuid}` | |
| GET | `/services/{uuid}/logs?sub_service_name=<name>` | **required** `sub_service_name` = `applications[].name` or `databases[].name` from GET /services/{uuid} (not `human_name`, not container name); without it **400 `Sub service name is required.`**; a stopped container **404 `Container not found.`** |
| POST | `/services/{uuid}/start`, `/stop` (`?docker_cleanup`), `/restart` (`?latest=true` pulls images) | deploy ability; `{message}` only |
| GET | `/services/{uuid}/applications`, `/services/{uuid}/applications/{app_uuid}` | list/get compose sub-containers |
| GET/POST | `/services/{uuid}/applications/{app_uuid}/logs` | per-container logs |
| POST | `/services/{uuid}/applications/{app_uuid}/start|restart|stop` | per-container control |
| GET/PATCH/GET logs/POST start|restart|stop | `/services/{uuid}/databases/{database_uuid}[...]` | per-DB-container control |
| envs, envs/bulk, storages, tags, scheduled-tasks, move, migrate, clone | same pattern as applications | |

**Service object** **[openapi Service]**: `id, uuid, name, description, environment_id, server_id, destination_type, destination_id, docker_compose_raw, docker_compose (sensitive), connect_to_docker_network, config_hash, service_type, created_at, updated_at, deleted_at` + `status` (computed, see §5). Services *do* carry `server_id` (integer).

### Deployments **[openapi + src DeployController.php]**
| Method | Path | Ability | Notes |
|---|---|---|---|
| GET | `/deployments` | read | **Only `in_progress` and `queued`** deployments across all team servers (`whereIn('status',['in_progress','queued'])`, sorted by id). Empty array when idle. Finished/failed ones are NOT here. |
| GET | `/deployments/{uuid}` | read | one ApplicationDeploymentQueue row by `deployment_uuid`; 404 if not team-owned |
| POST | `/deployments/{uuid}/cancel` | deploy | 200 `{message:"Deployment cancelled successfully.", deployment_uuid, status:"cancelled-by-user"}`; 400 `Deployment cannot be cancelled. Current status: finished` if not queued/in_progress; 403 if no permission |
| POST | `/deploy` | deploy | query **or** JSON body: `uuid` (comma-separated list OK — apps, services **and databases** all accepted, since it resolves any resource uuid), `tag` (comma-separated; deploys every resource carrying that tag), `force` (bool, no-cache rebuild), `pr` / `pull_request_id` (int, preview build, not with `tag`), `docker_tag` (with `pull_request_id`, docker-image apps). `uuid`+`tag` together → 400. Response `{"deployments":[{message, resource_uuid, deployment_uuid}]}`. For services/databases `deployment_uuid` is `null` and message is "Service X started. It could take a while, be patient." If a server's queue is full (`deployment_queue_limit`) the per-item entry carries status 429 / `queue_full` message. |
| GET | `/deployments/applications/{uuid}` | read | history for one app: `?skip=0&take=10` → **`{"count": <total>, "deployments": [ApplicationDeploymentQueue...]}`** newest first **[src Application::deployments]**. (The openapi wrongly says it returns `Application[]`.) |

**ApplicationDeploymentQueue object** **[openapi + src]**: `id, application_id, deployment_uuid, pull_request_id, docker_registry_image_tag, configuration_hash, configuration_snapshot, configuration_diff, force_rebuild, commit (sha), commit_message, status, is_webhook, is_api, restart_only, rollback, git_type, server_id, server_name, application_name, deployment_url (UI link), destination_id, only_this_server, current_process_id, created_at, updated_at, logs`.
- `logs` is **hidden unless the token has `read:sensitive`** (and user is admin/owner) — on all three deployment GETs **[src removeSensitiveData]**.
- `POST /deploy?tag=<name>` answers **`{"details": [{resource_uuid, deployment_uuid}], "message": ["Application … deployment queued."]}`** on 4.3.19, not the `deployments` array below (verified 2026-09-12). `GET /tags` → `[{uuid, name, created_at, updated_at}]` carries **no membership**; only `/applications` takes `?tag=`, so a tag's fan-out over services and databases cannot be listed.
- **The first log entry has no `order` key** (verified on four 4.3.19 deployments; the rest run `2..n`, monotonic); `batch` is not monotonic. Key on the array index.
- `logs` is a **JSON-encoded string** (not an array): `"[{\"command\":null,\"output\":\"...\",\"type\":\"stdout|stderr\",\"timestamp\":\"2026-09-06T10:00:00.000000Z\",\"hidden\":false,\"batch\":1,\"order\":2}, ...]"` — parse it twice. `hidden:true` entries are internal commands the UI hides; `command` is set for shell steps, `output` for their output; sensitive values are already redacted server-side. There is **no streaming** — poll `GET /deployments/{uuid}` and diff by `order`.
- `finished_at` **is** present on 4.3.19 rows (the plugin reads it, falling back to `updated_at`).

### Notifications settings (team-level) **[openapi]**
`GET|PATCH /notifications/email|discord|slack|telegram|pushover|webhook` — read/update the team's channel config (secrets/URLs only returned with read:sensitive). `PATCH /notifications/webhook` lets the plugin *programmatically* register its own webhook URL and enable events (field names mirror the UI: `webhook_enabled`, `webhook_url`, `deployment_success_webhook_notifications`, `deployment_failure_webhook_notifications`, `status_change_webhook_notifications`, `server_unreachable_webhook_notifications`, ... — exact names are not in the openapi schema, fetch GET first and echo the keys back).

### Other groups present (not needed for the plugin)
GitHub apps (`/github-apps*`), GitLab apps, S3 storages (`/s3-storages*`), tags (`/tags*`), destinations (`/destinations*`), instance email settings, cloud tokens/provisioning, volume backups. Total: 275 operations.

---

## 3. Resource utilisation — what the API exposes

**Short answer: the public REST API exposes no CPU / RAM / per-container metrics at all.** Only:
- `GET /servers/{uuid}` → `settings.is_reachable`, `settings.is_usable`, `unreachable_count`, `high_disk_usage_notification_sent` (bool — disk over threshold), `sentinel_updated_at` (last Sentinel heartbeat; if older than 3 × `sentinel_push_interval_seconds` Coolify considers Sentinel dead **[src Server::isSentinelLive]**).
- `GET /servers/{uuid}/sentinel` → `is_sentinel_enabled, is_metrics_enabled, is_sentinel_debug_enabled, sentinel_metrics_refresh_rate_seconds, sentinel_metrics_history_days, sentinel_push_interval_seconds, sentinel_updated_at` (+ `sentinel_token`, `sentinel_custom_url` with read:sensitive). Config only, no data.
- Disk usage percentage: only indirectly via the `high_disk_usage` webhook event (`disk_usage`, `threshold` ints) — see §4.
- Application `limits_cpus`, `limits_memory` etc. are *configured limits*, not usage.

### Sentinel **[docs Sentinel page + sentinel README + src HasMetrics.php]**
- Sentinel (`ghcr.io/coollabsio/sentinel`, Rust, currently v0.0.22 per versions.json) is an **experimental**, per-server agent container (`coolify-sentinel`) that collects **server CPU + memory** and **per-container CPU + memory** (Docker socket) into local SQLite, and **pushes** container state to Coolify at `POST /api/v1/sentinel/push` every `PUSH_INTERVAL_SECONDS` (default 60). It is enabled per server: Servers → server → General → "Enable Sentinel" and optionally "Enable Metrics". Metrics are **not collected for Docker-Compose apps or one-click services** [docs].
- Sentinel's own HTTP API (port 8888 inside the server, Bearer = `sentinel_token`): `GET /api/health`, `/api/version` (public), `GET /api/cpu/current`, `/api/cpu/history`, `/api/memory/current`, `/api/memory/history`, `/api/container/:id/cpu/history`, `/api/container/:id/memory/history` (+ optional traffic-analytics endpoints). Full spec in the sentinel repo `API.md` / `openapi.yaml`.
- **Coolify itself reads those metrics over SSH** (`docker exec coolify-sentinel sh -c 'curl -H "Authorization: Bearer $token" http://localhost:8888/api/cpu/history?from=...'`) to draw the Metrics tab in the UI **[src HasMetrics::getMetrics]**. **No REST endpoint re-exposes this.** The only way a desktop plugin could get CPU/RAM is (a) SSH to the server and hit Sentinel's localhost API itself (needs the `sentinel_token`, obtainable via `GET /servers/{uuid}/sentinel` with read:sensitive), or (b) expose port 8888 (not default; not recommended). Be honest in the UI: "resource usage not available via API".
- What Sentinel *pushes* to Coolify is the container list (`containers[]` with name/state/restart_count, `filesystem_usage_root`) used to update statuses faster than the SSH poll — it is not persisted as queryable metrics.

---

## 4. Real-time / notification options

### Nothing push-based in the REST API
- No WebSocket, SSE, long-poll, or event endpoint in openapi.yaml or routes/api.php. Coolify's own UI uses a Soketi/Pusher WebSocket (`coolify-realtime`, port 6001/6002, `/terminal/ws`) authenticated by the web session — not usable with API tokens.
- The MCP server (`/mcp`) is Streamable HTTP but only wraps the same read/deploy operations; no subscriptions.

### Outgoing notifications (team-level) **[docs Notifications + Webhook Payloads]**
Channels: **Email** (SMTP/Resend/instance-wide), **Telegram** (bot + chat id + optional topic), **Discord** (webhook URL), **Slack** (incoming webhook; Mattermost-compatible), **Pushover** (user key + app token), **Webhook** (any HTTP/HTTPS URL, `POST` with `Content-Type: application/json`).
Per-channel event toggles: Deployment Success, Deployment Failure, Container Status Changes, Backup Success/Failure, Scheduled Task Success/Failure, Docker Cleanup Success/Failure, Server Disk Usage, Server Reachable, Server Unreachable, Server Patching, Traefik Proxy Outdated.

Generic webhook payload always has `success` (bool), `event`, `message`; events and extra fields:
| event | fields |
|---|---|
| `deployment_success` / `deployment_failed` | `application_name, application_uuid, deployment_uuid, deployment_url, project, environment, fqdn` (PR previews: `pull_request_id, preview_fqdn` instead of fqdn) |
| `status_changed` | app stopped unexpectedly: `application_name, application_uuid, project, environment, fqdn, url` |
| `container_stopped` / `container_restarted` | `container_name, server_name, server_uuid, url` |
| `server_reachable` / `server_unreachable` | `server_name, server_uuid, url` |
| `high_disk_usage` | `server_name, server_uuid, disk_usage (int %), threshold (int %)` |
| `server_patch_check` / `server_patch_check_error` | `total_updates, os_id, package_manager, updates[], critical_packages_count` / `error` |
| `traefik_version_outdated` | `affected_servers_count, servers[{name, uuid, current_version, latest_version, update_type, ...}]` |
| `backup_success` / `backup_failed` / `backup_success_with_s3_warning` | `database_name, database_uuid, database_type, frequency, [error_output|s3_error, s3_storage_url], url` |
| `task_success` / `task_failed` | `task_name, task_uuid, output, application_uuid|service_uuid, url` |
| `docker_cleanup_success` / `docker_cleanup_failed` | `server_name, server_uuid, cleanup_message|error_message` |
| `test` | from "Send Test Notification" |

- **There is no `deployment_started` / `deployment_queued` event.** Start detection must come from polling `GET /deployments`.
- No signature/HMAC header is documented for the generic webhook; treat the URL as the secret (put a random token in the path) and validate `application_uuid`/`server_uuid` against known ids.
- A desktop plugin behind NAT cannot receive these directly without a tunnel/relay, so the practical design is **polling**, with the webhook as an optional accelerator.

### Polling budget (200 req/min)
A reasonable loop: `GET /deployments` every 5 s (12/min) while idle; when non-empty, `GET /deployments/{uuid}` per active deployment every 2-3 s; `GET /servers` + `GET /resources` (or `GET /servers/{uuid}/resources` per server) every 30-60 s for statuses; on "finished/failed" fetch `GET /deployments/applications/{uuid}?take=1` if you need the final row. That stays well under 60 req/min. Back off on 429 using `Retry-After`.
Status freshness caveat: application/database/service `status` is refreshed by Coolify's own scheduler (SSH `docker inspect` sweep roughly every minute, or faster from Sentinel pushes); the API just returns the stored value, so expect up to ~60 s lag after a stop/start.

---

## 5. Status vocabulary

### Deployment (`ApplicationDeploymentQueue.status`) **[src app/Enums/ApplicationDeploymentStatus.php]**
`queued` → `in_progress` → `finished` | `failed` | `cancelled-by-user`. (Exact strings; note the hyphenated `cancelled-by-user`.)
`GET /deployments` only ever shows `queued` and `in_progress`. Terminal states are visible via `GET /deployments/{uuid}` or the per-app history.
(Service/database start/stop activities use a separate `ProcessStatus` enum — `queued, in_progress, finished, error, killed, cancelled, closed` — but that is not exposed by the API.)

### Application / database / service-sub-resource `status` **[src ContainerStatusAggregator + GetContainersStatus + Application::status mutator]**
Format `"<state>:<health>"` where state ∈ Docker container state and health ∈ `healthy | unhealthy | unknown`; the one exception is bare `exited`. The aggregator can emit exactly:
- `running:healthy`, `running:unhealthy`, `running:unknown` (no healthcheck defined)
- `starting:unknown` (created/starting, or some containers still starting)
- `restarting:unknown` (crash-looping; single resources) — with a legacy `restarting:<health>` variant when set directly from docker inspect
- `degraded:unhealthy` (mixed running/exited, dead/removing, restarting when aggregated at service level, or recently crash-looped grace period)
- `paused:unknown`
- `exited` (all containers gone / stopped). Older rows may still contain `exited:unhealthy` (the model's mutator appends `:unhealthy` when no health is given), so **match on prefix**: `startsWith('running')`, `startsWith('exited')` — this is what Coolify itself does (`isRunning()`, `isExited()`).
Services (`Service.status`) aggregate their sub-containers with the same vocabulary but *without* preserveRestarting (so a restarting sub-container makes the service `degraded:unhealthy`); Coolify checks services with `contains('running')`/`contains('exited')`/`contains('stopped')`.
Legacy UI form `running (healthy)` is accepted on input but never returned by the API.

### Server
No single status string. Derive from `settings.is_reachable` (SSH OK) and `settings.is_usable` (Docker OK) → *ready* when both true; `unreachable_count > 0` / `unreachable_notification_sent` → flapping/down; `settings.force_disabled` → disabled (Cloud: unpaid); `settings.is_build_server`; `proxy.status` (`running`/`exited`/...) for the reverse proxy (**`GET /servers/{uuid}` only**: the list's `proxy` holds `redirect_enabled` alone); `sentinel_updated_at` for Sentinel liveness. Validation is async (`POST /servers/{uuid}/validate` returns immediately; `validation_logs` string accumulates).

### Backup execution `status`
`success` or `failed` (with `message`) **[src DatabaseBackupJob]**; the executions list (`GET /databases/{uuid}/backups/{id}/executions`) returns `{executions:[{uuid, filename, size, created_at, message, status}]}`. A row can also be `running` while the job is in flight (initial state), so treat anything other than the two terminal values as in-progress.

---

## 6. Version, compatibility, limitations

- API version prefix is `v1`; openapi `info.version` is `0.1` (meaningless). Coolify version from `GET /version` (plain text). The endpoint set documented here matches **v4.3.17** (2026-09-04) exactly; older 4.0.0-beta.4xx instances lack: `/deployments/{uuid}/cancel`, `/deployments/applications/{uuid}`, `/applications/{uuid}/logs`, `/databases/{uuid}/logs`, `/services/{uuid}/logs`, `/servers/{uuid}/sentinel`, `/notifications/*`, rollback, storages, scheduled-tasks, the `instant_deploy`/`force` query params, and `read:sensitive` gating (older versions had only `read`, `write`, `deploy`, `*`). Feature-detect by version or by 404.
- The docs site (`coolify.io/docs/api-reference/api/...`) is **behind** the openapi.yaml in the repo: it does not list rollback, notifications, storages, tags, proxy, docker-cleanup, cloud-init, MCP, GitLab, Vultr/DigitalOcean, per-service-container control, etc. Trust `openapi.yaml`.
- **No pagination** on any list endpoint except `GET /deployments/applications/{uuid}` (`skip`/`take`, default 10, returns `count`). `/applications`, `/databases`, `/services`, `/servers`, `/resources`, `/deployments` return full arrays. `/applications?tag=` is the only list filter.
- **No log streaming**: container logs are a one-shot `docker logs --tail N` (ANSI stripped) and fail with 404 `Container not found.` when the container isn't running; deployment logs are a JSON blob that grows — poll and diff.
- **No metrics** (CPU/RAM/disk numbers) via API — see §3.
- **No deployment-started event**; no server-level "events" endpoint; no audit log endpoint.
- `GET /resources`, `GET /databases/{uuid}` and several others are typed as `string` "Content is very complex" in openapi — write tolerant parsers.
- The openapi response schema for `GET /deployments/applications/{uuid}` is wrong (says `Application[]`; actual `{count, deployments[]}`).
- Response field order is normalised by `serializeApiResponse` (uuid/name/description first, timestamps last, keys sorted) — irrelevant for JSON parsers but explains inconsistent examples.
- Team members (non-admin) get read-only tokens; sensitive fields also require admin/owner role even with `read:sensitive`.
- Coolify Cloud: same API, base `https://app.coolify.io/api/v1`, API always enabled, no IP allowlist, servers with unpaid subscription are `force_disabled` and Sentinel pushes are rejected.

---

## 7. Gotchas for the client implementer

1. **Base URL**: user must supply the full origin; append `/api/v1`. Cloud = `https://app.coolify.io`. Self-hosted default `http://<ip>:8000`. Always send `Accept: application/json`.
2. **Token string contains `|`** (`67|secret`); pass verbatim in `Authorization: Bearer`. Do not URL-encode or split.
3. **uuid vs id**: every path takes the short `uuid` (7-8 char strings like `og888os`, `doogksw`); the integer `id` is hidden or only informational. Foreign keys inside objects (`environment_id`, `destination_id`, `server_id`, `application_id`) are integer ids — you cannot plug them into a path. Teams are the exception (`/teams/{id}` integer). Deployments use `deployment_uuid`, not `uuid`.
4. **Status strings have colons** (`running:healthy`); prefix-match on the state, never equality-match, and treat bare `exited` and `exited:unhealthy` the same.
5. **Deployment status is `cancelled-by-user`** (hyphens), `in_progress` (underscore).
6. **`GET /deployments` is "active only"**; a deployment vanishes from it the moment it finishes — keep the `deployment_uuid` you were tracking and fetch `/deployments/{uuid}` to learn the terminal state.
7. **Deployment `logs`** require `read:sensitive` and are a JSON string inside JSON — `JSON.parse(JSON.parse(body).logs)`.
8. **`POST /deploy`** accepts `uuid=a,b,c` or `tag=x,y`; params work as query string or JSON body; `force=true` = rebuild without cache; `pr=<n>` for previews. Returns one entry per resource; `deployment_uuid` is `null` for services/databases. Use `POST /applications/{uuid}/start` for a single app if you want `instant_deploy`.
9. **Lifecycle routes are POST-only** despite docs claiming GET works. Send an empty body (`Content-Length: 0` or `{}`).
10. **Restart of an application creates a deployment** (`restart_only: true`) — it will show up in `/deployments`; stop does not.
11. **Logs endpoints 400 when stopped**; service logs need `sub_service_name` exactly equal to `applications[].name`/`databases[].name` from `GET /services/{uuid}`.
12. **Server validate is async** (201 "Validation started."); poll `GET /servers/{uuid}` for `is_reachable`/`is_usable`/`validation_logs`.
13. **Rate limit 200/min** per token user; `/api/health` separately 1000/min; obey `Retry-After` on 429.
14. **403 has three meanings**: API disabled (self-hosted), IP not allowlisted, or missing ability — inspect `message`.
15. **No tree in one call**: apps don't carry project/environment/server uuids. Build the tree from `GET /projects` → `GET /projects/{uuid}/{env}` (has resources with status) or from `GET /servers` → `GET /servers/{uuid}/resources`. `GET /resources` gives everything flat with `type` + `status`.
16. **`GET /version` is text**, possibly with or without a leading `v`; strip and semver-compare for feature gating.
17. **Status lag**: stored statuses refresh on Coolify's ~1 min sweep (faster with Sentinel); after issuing stop/start show "pending" until the string changes.
18. **Sensitive redaction is silent**: without `read:sensitive` fields are simply absent or `null` — don't treat missing `logs`/`value` as an error.
19. **Webhook events lack a start event and any signature**; if you use `PATCH /notifications/webhook` to auto-register, first GET to learn field names, and remember it's a *team-wide* single webhook URL — overwriting it may hijack the user's existing integration.
20. **Docs vs spec drift**: the online API reference omits ~40% of endpoints; the repo `openapi.yaml` (identical at tag v4.3.17) is authoritative.
