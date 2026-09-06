# AGENTS.md

Operating notes for anyone (human or agent) working in this repo.

Omarify is a native Omarchy shell plugin for **Coolify** (Cloud and self-hosted). One
bar icon, one panel: servers, projects, resources and their status, running and queued
deployments, and the actions to deploy, redeploy, restart, stop, start and cancel.
Notifications when deployments queue, build, finish or fail. It is a Quickshell plugin
that runs inside `omarchy-shell`; there is no daemon and no second process.

Status: **Phase 0, docs only. No code yet.** Read `docs/roadmap.md` before writing any.

## Product locks

- Plugin id: `io.github.danjonesio.omarify`. Repo: `git@github.com:danjonesio/omarify.git`.
  (The older omasnitch id used `danjones`; the GitHub handle is `danjonesio`.)
- API first, SSH last. Anything the REST API can answer comes from the REST API. SSH
  is only for Sentinel metrics, Phase 5, opt-in per server.
- Token abilities: `read`, `read:sensitive`, `deploy`. `write` is optional and only
  gates "Validate server".
- Failed deployment and unreachable server notify at `critical` (bypasses Do Not
  Disturb). Everything else `low`/`normal`.
- Config accepts `token` and `tokenCommand`; `tokenCommand` wins when both are set.
- Kinds: `service` + `bar-widget`, `keepLoaded: true`. The service owns polling, state,
  actions and notifications. The bar widget owns the icon and loads `Panel.qml`. No
  `panel`/`overlay` kind unless Phase 5 says so.
- Data comes from the Coolify REST API only (`/api/v1`, Bearer token). No CLI, no MCP,
  no webhooks, no WebSocket.
- **The API has no CPU/memory/disk numbers.** Do not invent utilisation. Phase 1 shows
  none and says why. Sentinel-over-SSH is Phase 5 and opt-in.
- **No push channel exists.** Every notification comes from polling and diffing.
  `GET /deployments` lists only `queued` + `in_progress`; a finished deployment vanishes
  from it, so track uuids and fetch `GET /deployments/{uuid}` when one disappears.
- The first poll after start or config change is a baseline. It raises no notification.
- HTTP is `curl` in a `Quickshell.Io.Process` with config on **stdin** (`-K -`). The
  token never goes in argv, never in logs, never in state files.
- Config lives in `~/.config/omarify/config.json` (0600), not in `shell.json`.
  `token` or `tokenCommand`. Watched live.
- Status strings have colons (`running:healthy`). Prefix-match the state; treat bare
  `exited` and `exited:unhealthy` as the same. Deployment terminal states are
  `finished`, `failed`, `cancelled-by-user`.
- Lifecycle endpoints are POST only. Restart of an application is itself a deployment
  (`restart_only: true`) and will appear in the deployments list.
- Stop and Redeploy-without-cache confirm. Deploy, Restart, Start do not.
- Look native or do not ship: only `qs.Ui` + `qs.Commons`, no hardcoded colours, sizes,
  radii or font families. `docs/design.md` is the spec, `docs/omarchy-shell-reference.md`
  the component reference.
- Rate limit is 200 req/min per token. Idle polling stays under 20/min, with a
  deployment under 60/min. See the schedule in `docs/architecture.md`.

## Layout

```
manifest.json      plugin manifest (service + bar-widget)
Service.qml        polling, state store, actions, diff → notifications, config watch, IPC
BarWidget.qml      bar icon states + Panel loader (serviceFor lookup)
Panel.qml          KeyboardPanel: hero, chips, deployments, servers, resources, actions
Model.js           pure: parse/normalise/diff/group/label/format (.pragma library)
Api.js             pure: curl config text per endpoint, response splitting
Mark.qml           (later) Coolify mark as a Shape, if the glyph reads badly
tests/run.js       node vm runner for Model.js + Api.js
tests/fixtures/    recorded API responses, secrets replaced, uuids kept
bin/check          node tests + omarchy plugin validate + qmllint
bin/dev-sync       copy plugin files into ~/.config/omarchy/plugins/<id>/
bin/dev-watch      inotify loop around dev-sync
docs/              product, architecture, design, roadmap, API + shell references
```

Installed plugin: `~/.config/omarchy/plugins/io.github.danjonesio.omarify/`
Config: `~/.config/omarify/config.json`
State: `~/.local/state/omarify/recent.json`
Shell source (read only, never edit): `/usr/share/omarchy/shell`

Files that ship into the plugin dir: `manifest.json LICENSE README.md Service.qml
BarWidget.qml Panel.qml Model.js Api.js` (+ `Mark.qml`, `preview.png` when they exist).
`docs/`, `tests/`, `bin/` stay in the repo.

## Commands

```sh
# tests and static checks
node tests/run.js
omarchy plugin validate .
/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell *.qml   # qmllint is not on PATH
bin/check                                                     # all of the above

# dev loop (validator refuses symlinks, so copy)
bin/dev-sync                     # then the shell hot-reloads the plugin
bin/dev-watch                    # keep syncing on save
omarchy plugin enable io.github.danjonesio.omarify right   # first time
omarchy-shell shell rescanPlugins                          # if not picked up

# drive it
omarchy-shell shell toggle io.github.danjonesio.omarify
omarchy-shell io.github.danjonesio.omarify refresh
omarchy-shell io.github.danjonesio.omarify status
omarchy-shell io.github.danjonesio.omarify deploy <uuid>

# logs
quickshell log -p /usr/share/omarchy/shell --tail 100
omarchy restart shell            # after Service.qml or manifest changes
```

QML under `~/.config/omarchy/plugins/` hot-reloads on save. `Service.qml` is
recreated on reload too, but a stuck `Process` or timer sometimes survives; when in
doubt `omarchy restart shell`.

Poking the API by hand (token from the config file, never pasted into a shell history):

```sh
tok=$(jq -r '.instances[0].token' ~/.config/omarify/config.json)
curl -sS -H "Authorization: Bearer $tok" -H "Accept: application/json" \
  https://app.coolify.io/api/v1/deployments | jq .
```

## Coolify facts that bite

- Apps carry only integer `environment_id` / `destination_id`, never a project or
  server uuid. Build the tree from `GET /projects/{uuid}/{env}` (resources with
  status) and `GET /servers/{uuid}/resources`. `GET /resources` is the flat everything.
- `GET /deployments/applications/{uuid}` returns `{count, deployments[]}`; the openapi
  says `Application[]` and is wrong.
- Deployment `logs` need `read:sensitive` and are a JSON string inside JSON; parse twice.
- Container log endpoints return 400 when the container is not running. Service logs
  need `sub_service_name` equal to `applications[].name` from `GET /services/{uuid}`.
- `403` means one of three things: API disabled (self-hosted), IP not allowed, or a
  missing ability. Read `message`.
- Coolify refreshes stored statuses about once a minute. After an action, show
  "pending" and wait; do not poll the resource faster to compensate.
- Cloud (`https://app.coolify.io`) has the API always on and no IP allowlist.
  Self-hosted must enable it in Settings → Advanced.
- No pagination anywhere except app deployment history (`skip`, `take`).

## Omarchy facts that bite

- Bar widgets exist once **per monitor**. State lives in the service; the widget and
  panel only render it. Never put a poller in the widget.
- `settings` from `shell.json` do not include manifest `defaults`. Every read has a
  fallback.
- `omarchy-shell shell summon <id> '<json>'` on a bar-widget-only plugin drops the
  payload. Do not design a feature on it.
- `PanelHero`'s icon loader does not size children; set `width`/`height` to
  `hero.iconSize` (omasnitch lesson).
- JetBrainsMono Nerd Font maps some Material codepoints to the wrong glyph. Check
  every glyph in the bar before committing to it; a `Shape` mark is the fallback.
- Rows never colour from `containsMouse`; hover writes the panel cursor and
  `hasCursor` paints. That is the `CursorSurface` contract.
- ListView models get plain objects from `Model.js`, never live QObjects.
- Notifications go through `omarchy-notification-send --app-name <plugin id>`, so they
  respect Do Not Disturb and land in history. Never `notify-send`.
- `Util.execArgv` for anything containing data; `bar.run` only for literal strings.

## Don't

- Don't add a daemon, a Python collector, or a second Quickshell.
- Don't put the token in argv, `console.*`, state files, or `shell.json`.
- Don't fake metrics, progress percentages or "started" events the API does not give.
- Don't notify on the baseline poll.
- Don't hardcode a colour, radius, size or font family.
- Don't create your own `PanelWindow` for the bar popup; `KeyboardPanel` exists.
- Don't edit `/usr/share/omarchy`.
- Don't call create/delete/env-var endpoints. Read, deploy, lifecycle, validate only.
- Don't commit fixtures with real tokens; uuids and names are fine.

## Docs

- `docs/product.md` — what, for whom, feature map, what the API cannot do, open questions
- `docs/architecture.md` — runtime contract, config, HTTP client, polling, state, notifications, actions, security
- `docs/design.md` — bar icon states, panel anatomy, keyboard map, states, notification copy
- `docs/roadmap.md` — phases with acceptance criteria
- `docs/coolify-api.md` — API reference distilled from docs + openapi + source (2026-09-06)
- `docs/omarchy-shell-reference.md` — plugin runtime and `qs.Ui` component catalogue (Omarchy 4.0.0.alpha)
- `docs/reference/coolify-openapi-v4.3.17.yaml` — the authoritative endpoint list
