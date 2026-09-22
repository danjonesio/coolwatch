# Roadmap

Each phase ends with something installable and demonstrable on Dan's machine. Nothing
in a later phase is started until the earlier phase's acceptance list is green.

Renamed from Omarify to Coolwatch on 2026-09-12 (manifest 0.4.0): new plugin id, config and
state paths, hard cut. Everything below was built under the old name.

## Phase 0 — research and docs (done 2026-09-06)

- `docs/coolify-api.md`, `docs/omarchy-shell-reference.md` researched from source.
- `docs/product.md`, `docs/architecture.md`, `docs/design.md`, this file, `docs/development.md` (then the root `AGENTS.md`).
- Open questions answered by Dan the same day; recorded as "Decisions" in
  `docs/product.md` and as product locks in `docs/development.md`.

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
- Type-to-filter: `/` opens a field under the chips; its text narrows resources and
  deployments live (folds with a match open, without one hide; tags hide; servers stay).
  The key catcher's `blocked` contract lets the field own the keys, so `j`/`k`/`x` type.
  Enter or Down lands on the first match, Esc clears. Was item 7.
- Grouping and folds survive a shell restart: the service owns them per instance in
  `~/.local/state/coolwatch/ui.json` (`Model.parseUi` / `serialiseUi` / `uiSet` / `uiFor`),
  written by `uiFlush` a second after the last gesture, never the click or `_resetStore`;
  every monitor's panel mirrors the same entry, and an instance switch shows that
  instance's own grouping. Was item 5.
- The deployments poll idles at 8 s with every panel closed and nothing deploying
  (`Model.IDLE_DEPLOYMENTS_SEC`); `deploymentsSec` (4 s) applies with a panel open and the
  2 s byte-stepped cadence while a build runs. Idle cost drops from ≈17 to ≈11 req/min per
  instance (Dan, 2026-09-13).
- The Coolify mark: `Mark.qml`, a `Shape` of the cloud with the "C" cut out, is the bar icon
  for the configured states (`Model.barMark`) and the hero icon; trouble states keep their
  glyphs (Dan, 2026-09-13).
- Edit config: a cog at the footer's right end, `e` anywhere in the list, and an
  **Edit config** button on the config-class callouts create the directory and a 0600
  sample file when none exists and open the file with `omarchy-launch-config-editor`
  (Phase 5 prep, 2026-09-13). The log says
  "coolwatch config edit -> created|kept|failed".
- Row polish: a running resource's caption is its health word alone (`healthy`, never
  `running · healthy`; the dot carries the state), which hands the name the width back;
  a name or deployment that still elides shows the full label in a `PanelToolTip` on the
  cursor row. The hero meta and the bar tooltip append `· N stopped` / `· N unhealthy`
  after the totals (`Model.countsLine`; zero clauses drop). Was items 2 and 3.
- Toast click opens the log: a failed build's toast runs the new IPC verb
  `log <deployment uuid>` (`--exec omarchy-shell io.github.danjonesio.coolwatch log <uuid>`,
  last in argv, the uuid through `UUID_RE` and `notifySafe`), which summons the panel on
  that build's log with the failing step visible; the browser tail stays when the token has
  no `read:sensitive`. The verb is the one that looks past the active instance (a uuid names
  one Coolify) and switches to the holder. Verified by the verb against a recorded failed
  api build with the panel closed and open; the live toast click and a toast from a
  non-active instance are needs-human. Was item 6.

Quick wins

1. Done above (names through `appLabel`).
2. Done above (health word alone, full-name tooltip on the cursor row).
3. Done above (`· N stopped` / `· N unhealthy` in the hero and the bar tooltip).
4. Done above (last deployment stays, with Dismiss).
5. Done above (grouping and folds persist to `ui.json`).

Medium

6. Done above (a failed toast's click runs `log <uuid>`, which opens the panel on the log).
7. Done above (type-to-filter through the catcher's inline-editor contract).

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

## Backlog — 1.x candidates (opened 2026-09-14, after the 1.0.0 submission)

Each item is its own PR into `develop`; a release bundles whatever is merged
(`docs/release.md`). Nothing here breaks a product lock: REST only, no metrics, no
second process. Ordered by value over cost inside each group.

Done from this list: **Health before auth** (PR #13, merged 2026-09-22 into `develop`;
`docs/plans/health-before-auth.md` and its build record). One unauthenticated
`GET /health` when a poll fails with an HTTP answer; the callout tells "Coolify not
responding" from "token rejected". It also fixed a pre-existing bug: a 2xx whose body did
not parse counted as a success and cost about 49 requests in the first minute on a wrong URL.

### Small (an hour each, `Model.js` + a test, patch or minor)

- **Preview builds labelled.** Coolify builds every open pull request of a GitHub-App
  application as its own copy when previews are on; those deployments carry
  `pull_request_id` and today look like a production deploy. Row and toast say
  `PR #123` (`Model.appLabel` caption, `notifyCopy`).
- **Build duration on terminal and history rows.** Running rows show elapsed; finished
  rows could show `2m 14s` from `started_at`/`finished_at`, and the finished toast could
  say `finished in 2m 14s`. Real data, not progress.
- **Commit message on the cursor row.** Parsed (`commit_message`) and never shown. A
  `PanelToolTip` on a deployment row, same binding as the elided-name tip; `notifySafe`
  is not needed (it never reaches argv).
- **Coolify version in the hero meta.** `/version` is fetched for the instance probe and
  never displayed. No "update available": that needs a second source.
- **`y` copies the cursor row's uuid** through `wl-copy` (`Util.execArgv`), for the IPC
  verbs. Panel-only key.
- **Hyprland keybinding in the README.** A `bindd` line for the toggle IPC; the biggest
  usability gap for the cost of one doc line.
- **IPC verbs by name.** `deploy api` resolves an unambiguous `Model.appLabel` match on
  the active instance, `unknown name` / `ambiguous name` otherwise. Uuids still work.

### Medium (a plan, a fixture, a needs-human list)

- **Per-instance notify overrides.** `instances[].notify` merged over the top-level
  block, so a noisy staging Coolify can be quiet and production loud. Parsing and tests
  only; every notify state is already per context.
- **Long build warning.** A `notify.longBuildMin` threshold (default off): one `normal`
  toast when a build has run past it, from local elapsed time, once per uuid. Not a
  progress claim.
- **Toast click on a building deployment** opens its log the way a failed one does
  (`--exec … log <uuid>`), and on a queued one offers nothing (a click cannot confirm a
  cancel).
- **Database backup state.** `GET /databases/{uuid}` may carry scheduled-backup status
  that `/resources` does not; a failed backup is the failure nobody notices. Record a
  fixture first; if the field is not there, drop the item.
- **Log search.** `/` inside the log overlay reuses the filter contract to narrow lines
  and jump between matches; the view already holds the text.
- **Idle-aware polling.** Halve every interval while the session is locked or idle if
  the shell exposes that state (check `hypridle`/lock signals in `qs.Commons` first);
  restores the full cadence on unlock with one immediate poll. Saves rate budget on a
  desk that is not being looked at.
- **Validate outcome.** Validate has no observable end; a single `/servers/{uuid}` read
  at the end of the pending window would let the row show the reachability word that
  changed. One request, only after the action.

### Deferred (decide after marketplace feedback)

- The Phase 5 overlay console.
- Team switching: a token belongs to one team, so "one `instances[]` entry per team"
  already covers it; document the pattern, build nothing.

## Out of the plan

- Utilisation via SSH to each server and Sentinel's localhost API. Dropped 2026-09-13:
  it would put an SSH client, agent socket and host keys inside the shell process, add
  a failure domain that is not Coolify, and poll N servers with no rate ceiling, for
  meters Coolify's own UI already draws. The plugin reads the REST API only.
- Editing env vars, creating or deleting resources or servers.
- Webhook receiver.
- Coolify older than v4.3.
