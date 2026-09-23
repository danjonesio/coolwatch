# Changelog

## 1.1.0 — 2026-09-23

- **Health before auth.** When a poll fails with an HTTP answer, one unauthenticated
  `GET /health` tells "Coolify not responding" from "token rejected" in the callout and
  the bar. Also fixes a 2xx whose body did not parse counting as a success, which cost
  about 49 requests in the first minute on a wrong URL.
- **Build duration.** Finished, failed and cancelled deployments in the section and in
  History read `duration · age` (`2m 21s · 4m ago`), from Coolify's `created_at` to
  `finished_at`; a running row still ticks its elapsed time.
- **IPC verbs by name.** `omarchy-shell io.github.danjonesio.coolwatch deploy <name>`
  resolves the label the panel shows on the active instance (also `restart`, `stop`,
  `start`); `unknown name <name>` and `ambiguous name <name>` otherwise. Uuids work as
  before.
- Operating notes moved from a root `AGENTS.md` to `docs/development.md`; the
  `develop` → `master` release flow (`docs/release.md`); the 1.x backlog in
  `docs/roadmap.md`.

## 1.0.0 — 2026-09-13

First marketplace submission: servers, projects, resources and deployments in one panel;
deploy, redeploy, restart, stop, start, cancel and tag deploy; notifications for queued,
building, finished and failed deployments and for server reachability; build and container
logs, deployment history, several Coolify instances.
