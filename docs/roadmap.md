# Roadmap

Each phase ends with something installable and demonstrable on Dan's machine. Nothing
in a later phase is started until the earlier phase's acceptance list is green.

## Phase 0 — research and docs (done 2026-09-06)

- `docs/coolify-api.md`, `docs/omarchy-shell-reference.md` researched from source.
- `docs/product.md`, `docs/architecture.md`, `docs/design.md`, this file, `AGENTS.md`.
- Open questions answered by Dan the same day; recorded as "Decisions" in
  `docs/product.md` and as product locks in `AGENTS.md`.

## Phase 1 — see

Deliverables

- `manifest.json`, `Service.qml`, `BarWidget.qml`, `Panel.qml`, `Model.js`, `Api.js`.
- Config file loading with `token` and `tokenCommand`, file watch, 0600 check.
- Curl-over-stdin client with sequence numbers, timeouts, watchdog, error mapping.
- Polls: deployments, resources, servers, version, project tree.
- Bar icon states; panel with hero, deployments, servers, resources (by project and
  by server), refresh, keyboard cursor, footer.
- `tests/run.js` with fixtures for every parser; `bin/check` running node tests,
  `omarchy plugin validate`, `qmllint`; `bin/dev-sync` and `bin/dev-watch`.

Acceptance

- Installed via `bin/dev-sync` and enabled, the icon shows Dan's Cloud account with
  correct counts within 10 s of enabling.
- Pushing a commit to a Coolify-linked repo makes the icon go active and the row
  appear within 5 s of Coolify queuing it; it leaves the active list and shows as
  finished within 5 s of Coolify finishing.
- Idle request rate measured under 20 per minute; with one deployment under 60.
- Deleting the config file while running switches the icon to "not configured" without
  a shell restart; restoring it recovers.
- Revoking the token shows "TOKEN REJECTED"; no token string appears in
  `quickshell log` output or in `ps`.
- Panel passes the theme check in `docs/design.md`.

## Phase 2 — act

Deliverables

- Actions: deploy, redeploy (force), restart, stop, start, cancel, validate, open.
- Confirm dialog, optimistic pending state, status line, ability-error messages.
- Full keyboard map; IPC target with `deploy|restart|stop|start <uuid>` and `refresh`.

Acceptance

- Every action works from keyboard and mouse against a real resource and the row
  reflects Coolify's state within one status sweep (≤ 60 s) with "pending" in between.
- A token without `deploy` produces the exact ability message and nothing else breaks.
- Cancel on an in-progress deployment returns `cancelled-by-user` and the row updates.

## Phase 3 — notify

Deliverables

- Diff-based change detection with baseline-on-start.
- Notifications for deployment transitions, unexpected resource stops, server
  reachability, with per-event toggles and click-to-open.
- Recent deployments persisted to `~/.local/state/omarify/recent.json`.

Acceptance

- One push yields exactly: Queued (optional), Building, Deployed or Failed. Never a
  duplicate, never a replay after `omarchy restart shell` mid-deployment.
- A `docker stop` on a server produces "stopped" once, and a deploy-caused restart
  produces nothing extra.
- Do Not Disturb silences everything but critical.

## Phase 4 — depth

Deliverables

- Deployment log viewer (poll, diff by `order`, PlainText, monospace, auto-scroll
  with a "hold" when the user scrolls up).
- Container logs tail for a running resource (`lines=200`).
- Deployment history per application with "show more".
- Multi-instance chips; middle-click cycling.
- Tag deploy from a "Tags" fold if the account uses tags.

Acceptance

- A failed deployment's log is readable in the panel within one poll of failure, with
  the failing command visible.
- Two instances (Cloud + a self-hosted test box) switch cleanly with independent
  polling and error states.

## Phase 5 — beyond the API (optional, each item its own decision)

- Utilisation via SSH to each server and Sentinel's localhost API (server and
  per-container CPU and memory, history meters). Opt-in per server in the config.
- Overlay "console" for wide screens, summoned by keybinding.
- Marketplace submission: README with install/usage/remove, `preview.png`, public repo,
  issue form at plugins.omarchy.org.

## Out of the plan

- Editing env vars, creating or deleting resources or servers.
- Webhook receiver.
- Coolify older than v4.3.
