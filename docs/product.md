# Omarify — product brief

Omarify is a native Omarchy shell plugin that puts Coolify in the bar. One icon, one
panel: every server, project and resource on your Coolify account, what is deploying
right now, and the buttons to deploy, restart, stop and cancel without opening a
browser. It talks to Coolify Cloud (`app.coolify.io`) and self-hosted Coolify through
the same REST API, and it looks and behaves like the panels Omarchy ships with.

## Who it is for

Dan first: Coolify Cloud user, several servers, wants to glance at the bar and know
whether the deploy he just pushed is building, and to kick a redeploy or restart from
the keyboard. Then anyone on Omarchy who runs Coolify.

## Jobs to be done

1. **Is anything deploying?** See it in the bar without opening anything. Get a
   notification when a deployment starts, finishes, fails or is cancelled.
2. **What is the state of my estate?** Servers reachable or not, every application,
   service and database with its status, grouped by server or by project/environment.
3. **Act fast.** Deploy, force-redeploy (no cache), restart, stop, start, cancel a
   deployment, validate a server, open the resource or the deployment in the browser.
   Two keystrokes from the bar.
4. **Dig in when it breaks.** Read deployment build logs and container logs for a
   failed or unhealthy resource.
5. **Switch instances.** Cloud and self-hosted side by side, one chip each.

## What the Coolify API can and cannot give us

The API research (`docs/coolify-api.md`) sets hard limits. The product is designed
around them rather than pretending they are not there.

| Asked for | API reality | What Omarify does |
|---|---|---|
| Servers list + status | `GET /servers` → `is_reachable`, `is_usable`, proxy status. No status string. | Derive **ready / unreachable / disabled / building-only** from those flags. |
| Projects, environments, resources | `GET /projects`, `GET /projects/{uuid}/{env}` (has resources with status), `GET /servers/{uuid}/resources`, flat `GET /resources`. | Build the tree client-side. Apps carry only integer foreign keys, so the tree is assembled from the environment and server calls. |
| Resource status | `"running:healthy"`, `"exited"`, `"degraded:unhealthy"` … refreshed by Coolify roughly once a minute. | Prefix-match on state. Show "pending" after an action until the string changes. |
| CPU / memory / disk utilisation | **Not exposed by the REST API at all.** Sentinel collects it on the server and Coolify reads it over SSH for its own UI. Only a disk-usage boolean and webhook event exist. | Phase 1 shows **no** utilisation figures and says why. A later phase may read Sentinel over SSH from this machine (needs `read:sensitive` for the token and SSH access to each server). See open question 3. |
| Running and queued deployments | `GET /deployments` returns **only** `queued` + `in_progress`; finished ones vanish. `GET /deployments/{uuid}` gives any one by uuid. Per-app history at `GET /deployments/applications/{uuid}`. | Poll the active list, remember every uuid seen, fetch each tracked uuid once it disappears to learn the terminal state, and keep a local "recent" list. |
| Notifications when a deployment builds | No push channel (no WebSocket, SSE or subscription). Outgoing webhooks exist but have **no "started" event** and cannot reach a laptop behind NAT. | Polling drives every notification. Webhooks are out of scope. |
| Redeploy, restart, stop, start | `POST /deploy?uuid=…&force=…`, `POST /applications|services|databases/{uuid}/start|restart|stop`, `POST /deployments/{uuid}/cancel`, `POST /servers/{uuid}/validate`. Need the `deploy` ability (`write` for validate). | All wired. Restart of an app is itself a deployment and shows up as one. |
| Logs | `GET /deployments/{uuid}` `logs` field (needs `read:sensitive`, JSON string inside JSON, no streaming). Container logs `GET …/{uuid}/logs?lines=` (400 when stopped). | Poll-and-diff log viewer. Works without `read:sensitive`; the log section just says the token cannot read logs. |

Rate limit is 200 requests per minute per token. The polling schedule in
`docs/architecture.md` stays under 60 even with a deployment running.

## Feature map by phase

Phases are defined in `docs/roadmap.md`. Every feature below names the API it rests on.

### Phase 1 — see

- Bar icon with four states: not configured, unreachable, idle, deploying. Failed
  deployment holds the urgent colour until the panel is opened.
- Panel hero: instance name, Coolify version, one-line summary ("3 servers · 14
  resources · 1 deploying").
- Deployments section: active and queued with application name, commit, elapsed time;
  the last few finished ones with outcome.
- Servers section: name, reachability, resource count, proxy state.
- Resources: grouped by project › environment, each row with a status dot and the
  status word. Toggle to group by server.
- Refresh on open, on `r`, and on a timer.

### Phase 2 — act

- Row actions: Deploy, Redeploy (force, no cache), Restart, Stop or Start, Open in
  browser. Deployment rows: Cancel, Open. Server rows: Validate, Open.
- Confirm dialog for Stop and for Redeploy without cache.
- Optimistic "pending" state on the row until Coolify's status catches up.
- Full keyboard map (see `docs/design.md`).

### Phase 3 — notify

- Deployment queued → started → finished / failed / cancelled, one notification per
  transition, with the application name and commit message, click to open the
  deployment in the browser.
- Resource changed to exited or degraded outside of a deployment or user action.
- Server became unreachable or reachable again.
- Per-event toggles in the config file. No flood on first start: the first snapshot
  after launch is a baseline, not a stream of events.

### Phase 4 — depth

- Deployment log viewer inside the panel (poll and diff by log `order`).
- Container log tail for a resource.
- Deployment history per application (`skip`/`take` pagination).
- Multi-instance chips (Cloud + self-hosted) in the hero.
- Tag deploy (`POST /deploy?tag=`).

### Phase 5 — beyond the API (optional)

- Utilisation via Sentinel over SSH (server and per-container CPU and memory) when the
  user opts in per server.
- Full-screen overlay "console" for wide screens, if the bar panel gets cramped.
- Marketplace listing at plugins.omarchy.org.

## Non-goals

- Creating or deleting servers, projects, applications, or editing environment
  variables. Coolify's web UI does that well; a bar panel does not.
- Wrapping the Coolify CLI or MCP server. We call the REST API directly.
- Receiving webhooks. No listener, no tunnel, no relay.
- Any second process. Everything runs inside `omarchy-shell` as a service plus a bar
  widget, following Omarchy's plugin contract.
- Supporting Coolify older than v4.3.x. Feature-detect where cheap, otherwise require
  current.

## Decisions (Dan, 2026-09-06)

1. **Plugin id** is `io.github.danjonesio.omarify`, matching the GitHub handle and the
   repo `git@github.com:danjonesio/omarify.git`.
2. **Token storage** supports both forms: `token` inline in the 0600 config file, or
   `tokenCommand` (for example `op read "op://Private/Coolify/credential"`). When both
   are present `tokenCommand` wins.
3. **API first, SSH last.** Everything that the REST API can answer comes from the REST
   API. SSH is used only for what the API cannot give (Sentinel metrics), in Phase 5,
   opt-in per server. Servers are SSH-reachable from this machine, so that phase is
   feasible.
4. **Token abilities**: `read`, `read:sensitive`, `deploy`. That covers every Phase 1
   to 4 feature including build logs. `write` is optional and only unlocks "Validate
   server"; without it the button explains what is missing.
5. **Failed deployments and unreachable servers notify at `critical`**, which bypasses
   Do Not Disturb. Everything else is `low` or `normal`.
