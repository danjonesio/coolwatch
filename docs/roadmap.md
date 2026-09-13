# Roadmap

Each phase ends with something installable and demonstrable on Dan's machine. Nothing
in a later phase is started until the earlier phase's acceptance list is green.

Renamed from Omarify to Coolwatch on 2026-09-12 (manifest 0.4.0): new plugin id, config and
state paths, hard cut. Everything below was built under the old name.

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
  `omarchy-shell io.github.danjonesio.coolwatch status`'s `requestsLastMin`.
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
- Recent deployments persisted to `~/.local/state/coolwatch/recent.json`.

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
  as `omarchy-action` and shown. Verified live by Dan on 2026-09-08 with a deliberately
  failed build (a non-existent Docker image tag on api), DND on and off; a server
  outage under DND is still unobserved.
- `recent.json` lives in a 0700 directory (the file is umask-mode) and the panel's
  Recent section is back within 2 s of a restart for deployments under an hour old.

## Phase 4 — depth (built 2026-09-12 on `phase-4-depth` after the `read:sensitive` caps hotfix `e64f1fa`; see `docs/plans/phase-4-depth.build.md`)

Deliverables

- Deployment log viewer (read off the deployments poll and the drain, no log poller;
  keyed by array index because the first entry has no `order`; PlainText, monospace,
  auto-scroll with a "hold" when the user scrolls up; the failing step always shown on
  a failed build, other internal steps behind `H`).
- Container logs tail for a running resource (`lines=200`), with a picker for services.
- Deployment history per application with "show more".
- Tag deploy from a "Tags" fold if the account uses tags (Dan tagged landing
  `production-landing` for the build; the API cannot list a tag's members).
- Multi-instance chips; middle-click cycling: built 2026-09-12 on `phase-4-instances`
  (see `docs/plans/phase-4-instances.build.md`): one `InstanceCtx` per `instances[]`
  entry with its own store, timers, requests, ledgers, pending map, notify state and
  `recent-<id>.json`; chips under the hero, `h`/`l` on the hero, middle-click, IPC
  `instances` / `instance <id>`; the bar icon follows the current instance with a
  tooltip suffix for another's trouble; toast bodies name the instance; curl exit 60
  is the named `tls` kind.

Acceptance

- A failed deployment's log is readable in the panel within one poll of failure, with
  the failing command visible. Rendering verified from api's recorded failures
  (`$ docker exec … docker compose … pull'` and the unresolved image reference in
  urgent); the marker lands in the same dispatch as the Failed toast (the drain), so
  the latency is one deployments interval plus one drain round trip. Verified live by
  Dan on 2026-09-12 with a deliberately failed api build: the marker and the failing
  command appeared with the Failed toast.
- Two instances switch cleanly with independent polling and error states. Verified
  2026-09-12 with a second entry on the same Cloud account (a self-hosted box was not
  reachable from this machine): both contexts poll at 17–19/min each, a mangled second
  token puts only that context in `auth` while the first keeps polling and the icon
  stays healthy with the tooltip suffix, each writes and reads its own recent file (a
  reorder makes the other's file `recentRejected`), removing the entry leaves one chip
  and no stray curl, an unreachable dummy entry shows `offline` beside a healthy Cloud
  and a toast body ends in ` · Coolify Cloud`. Needs-human: a real self-hosted Coolify
  (plain-http warning, the `tls` kind, the API-disabled path, an older version's 404
  note), cross-account data isolation, and the keyboard and mouse paths (`h`/`l` on the
  hero, a chip click, the middle-click, the confirm refused across a switch).

## Phase 4b — polish (UX sweep before the marketplace submission; opened 2026-09-13)

Found by Dan using the panel daily. Each item is small and independent; the order is
payoff against effort. Nothing here adds a request, a kind or a state file format.

Done

- Opening a strip no longer moves the list: the ListView model is a `ListModel` patched
  in place by key (`Model.listPatch`), never swapped (`79fca28`).
- A strip above four buttons folds behind **More**: Redeploy · Restart · Stop · More, with
  Logs · History · Open beneath while More is open (`Model.stripFor`, `79fca28`).
- The deployments section keeps the newest terminal deployment past the hour window until
  it is dismissed: a `×` on every terminal row, `x`, or **Dismiss** in the strip. Dismiss is
  an acknowledge that clears the row and everything older (a promotion of the next build
  looked like nothing happened); local, persisted as `dismissed` in the recent file on the
  next poll; the file window is seven days. Was item 4 below.
- Resource and deployment rows pass `Model.appLabel`, as toasts already did. Was item 1.
- Grouping and folds survive a shell restart: the service owns them per instance in
  `~/.local/state/coolwatch/ui.json` (`Model.parseUi` / `serialiseUi` / `uiSet` / `uiFor`),
  written by `uiFlush` a second after the last gesture, never the click or `_resetStore`;
  every monitor's panel mirrors the same entry, and an instance switch shows that
  instance's own grouping. Was item 5.

Quick wins

1. Done above (names through `appLabel`).
2. **Name width.** The row lays out status words and the kind hint first, leaving the
   name about 18 characters on the 380 card. Either drop the state word the dot already
   carries (`running · healthy` → `healthy`) or stack status under the name as deployment
   rows do; add a full-name tooltip for whatever still elides. Acceptance: no name on
   Dan's account elides at the default width.
3. **Hero counts the trouble.** `1 SERVER · 7 RESOURCES` while one resource is exited.
   `Model.heroMeta` appends `· N stopped` / `· N unhealthy` (zero clauses dropped, as
   today); the bar tooltip gets the same. Acceptance: stop one resource, the hero and
   tooltip say so within one resources poll.
4. Done above (last deployment stays, with Dismiss).
5. Done above (grouping and folds persist to `ui.json`).

Medium

6. **Toast click opens the log.** A failed-build toast runs `--exec omarchy-launch-browser
   <url>`. Run `omarchy-shell io.github.danjonesio.coolwatch log <deployment uuid>`
   instead: a new IPC verb that opens the panel on that build's log (the panel is a
   bar-widget, so `summon` drops payloads; IPC is the only channel). Acceptance: click the
   Failed toast, the log view opens with the failing step visible. Every positional still
   passes `Model.notifySafe`; `--exec` stays last.
7. **Type-to-filter.** A `/` filter narrowing resources and deployments by name, Esc
   clears. Depends on whether `PanelKeyCatcher` hands plain text keys to the panel (read
   `/usr/share/omarchy/shell` first; the panel may not add a `Keys.onPressed`). Hold until
   a user with a large account asks or the catcher is known to allow it.

Left alone, on purpose

- `Ungrouped · loading` for the first minute is the topology drain; faster costs rate budget.
- The 380 card width is a design lock; widening fixes elision at the cost of looking native.
- The bar icon cannot carry a count (`BarIconButton` has no badge slot).
- A row inserted above the viewport shifts the visible content by one row; standard
  ListView behaviour, rare during interaction.

## Phase 5 — beyond the API (optional, each item its own decision)

- Overlay "console" for wide screens, summoned by keybinding.
- Marketplace submission: README with install/usage/remove, `preview.png`, public repo,
  issue form at plugins.omarchy.org.

## Out of the plan

- Utilisation via SSH to each server and Sentinel's localhost API. Dropped 2026-09-13:
  it would put an SSH client, agent socket and host keys inside the shell process, add
  a failure domain that is not Coolify, and poll N servers with no rate ceiling, for
  meters Coolify's own UI already draws. The plugin reads the REST API only.
- Editing env vars, creating or deleting resources or servers.
- Webhook receiver.
- Coolify older than v4.3.
