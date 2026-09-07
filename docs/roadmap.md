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
- Polls: deployments, resources, servers, version, topology (projects, project
  environments, server resources). The token has `read` only. Enter on a leaf row is
  inert; server proxy status is Phase 2.
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
- Idle request rate measured under 20 per minute with the panel closed, and
  separately under 60 with one deployment running, both read from
  `omarchy-shell io.github.danjonesio.omarify status`'s `requestsLastMin`.
- Deleting the config file while running switches the icon to "not configured" without
  a shell restart; restoring it recovers.
- Revoking the token shows "TOKEN REJECTED"; no token string appears in
  `quickshell log` output or in `ps`.
- Panel passes the theme check in `docs/design.md`.

## Phase 2 — act (built 2026-09-07 on `phase-2-act`; see `docs/plans/phase-2-act.build.md`)

Deliverables

- Actions: deploy, redeploy (force), restart, stop, start, cancel, validate, open.
- Confirm dialog, optimistic pending state, status line, ability-error messages.
- Full keyboard map; IPC target with `deploy|restart|stop|start <uuid>` and `refresh`.

Acceptance

- Every action works from keyboard and mouse against a real resource and the row
  reflects Coolify's state within one status sweep plus one resources interval (≤ 90 s
  with the panel open) with "pending" in between. Validate is demonstrated as its
  `write` ability message on the `read` + `deploy` token. Still unverified after the
  build (see the record's needs-human rows): the mouse path, and Open on an
  application, service or database row.
- A token without `deploy` produces the exact ability message and nothing else breaks.
  **Unverified by the build**: the run used a `read` + `deploy` token; the `write`
  ability message on Validate exercised the same code path.
- Cancel on an in-progress deployment returns `cancelled-by-user` and the row updates.

## Phase 3 — notify (built 2026-09-07 on `phase-3-notify`; see `docs/plans/phase-3-notify.build.md`)

Deliverables

- Diff-based change detection with baseline-on-start (per poll kind).
- Notifications for deployment transitions, unexpected resource stops (and recovery),
  server reachability, with per-event toggles, click-to-open, and bounded volume.
- Recent deployments persisted to `~/.local/state/omarify/recent.json`.

Acceptance

- One push yields exactly: Queued (optional, skipped when the first poll already sees
  the build in progress), Building, Deployed or Failed. Never a duplicate, never a replay
  after `omarchy restart shell` mid-deployment (a deployment that finishes while the
  shell is down is neither toasted nor recorded: it never vanishes from an active list
  the plugin saw).
- A container stopped outside the plugin (Coolify UI or `docker stop`) produces
  "stopped" once within 0–120 s, and a deploy-caused restart or a Stop/Start from the
  plugin produces nothing extra.
- Do Not Disturb silences everything to history except a critical event, which is sent
  as `omarchy-action` and shown. The critical-under-DND path (a failed deployment or an
  unreachable server) is verified by fixture and node tests only; live it needs a
  deliberately broken build or a server outage (neither produced for this run).
- `recent.json` lives in a 0700 directory (the file is umask-mode) and the panel's
  Recent section is back within 2 s of a restart for deployments under an hour old.

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
