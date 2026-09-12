# Coolwatch

Coolify in the Omarchy bar. Servers, projects, resources, running and queued
deployments, and the buttons to deploy, redeploy, restart, stop and cancel, in a native
[Omarchy](https://omarchy.org/) panel. Works with Coolify Cloud and self-hosted Coolify
through the REST API.

**Status: Phase 3 (notifications and a persisted Recent list) built; Phases 1 (read-only bar icon and panel) and 2 (actions) merged.** See [docs/roadmap.md](docs/roadmap.md).

**Renamed from Omarify on 2026-09-12.** New plugin id `io.github.danjonesio.coolwatch`, config at
`~/.config/coolwatch/config.json`, state at `~/.local/state/coolwatch/recent.json`. Nothing is read
from the old paths. If you ran Omarify: `omarchy plugin remove io.github.danjonesio.omarify`, move your
config file across, then install again.

## What it will do

- Bar icon that goes active while something is deploying and stays lit after a failure
  until you look.
- Panel with deployments (active, queued, recent), servers (reachable or not), and
  every application, service and database grouped by project or by server, each with
  its live status.
- Deploy, redeploy without cache, restart, stop, start, cancel a deployment, validate a
  server, open in the browser. Keyboard first.
- Notifications when a deployment is queued, building, finished, failed or cancelled,
  when a resource stops unexpectedly, and when a server drops off.
- Cloud and self-hosted instances side by side.

What it will not do, because the Coolify API does not offer it: show CPU, memory or
disk usage. See [docs/product.md](docs/product.md) for the honest list.

## Install (once it exists)

```sh
omarchy plugin add https://github.com/danjonesio/coolwatch.git --enable
```

Then create `~/.config/coolwatch/config.json` (mode 0600; the plugin creates the
directory as 0700):

```json
{
  "version": 1,
  "instances": [
    { "id": "cloud", "name": "Coolify Cloud", "url": "https://app.coolify.io", "token": "67|…" }
  ],
  "poll": { "deploymentsSec": 4, "resourcesSec": 60, "serversSec": 120, "topologySec": 600 },
  "notify": { "deploymentQueued": true, "deploymentStarted": true, "deploymentFinished": true,
              "deploymentFailed": true, "resourceStateChanged": true, "serverReachability": true }
}
```

`poll` is optional; those are the defaults. `notify` is optional too: every key
defaults to `true`, `"notify": false` switches every toast off, a cancelled deployment
rides `deploymentFinished`, and the values are booleans, unquoted (a bad value keeps its
default and polling continues; the panel shows a warning unless a plaintext or
permissions warning already occupies the callout, and `status | jq .notify` always shows
the effective values and the warning text). Editing `notify` takes
effect on the next poll without resetting anything else.

Notifications land in Omarchy's notification history and respect Do Not Disturb, with
one exception: a failed deployment or an unreachable server while DND is on is sent
under the app name `omarchy-action`, the only sender the shell shows through DND, so it
is listed as that sender in history. Click a toast to open the deployment, resource or
server in Coolify. Recent terminal deployments are kept in
`~/.local/state/coolwatch/recent.json` (a directory the plugin creates as 0700; the file
holds names, branches, commit messages and the instance URL, never the token) so the
panel's Recent section survives a shell restart; the panel shows the last hour. Create the token in Coolify under
Security → API Tokens with the `read` and `deploy` permissions (`write` only if you want
"Validate server" to succeed; without it the panel says "Token lacks the write
permission"). Coolify cannot change a token's abilities afterwards: create a new one and
swap it in. Instead of `token` you can give
`"tokenCommand": ["op", "read", "op://Private/Coolify/credential"]` so the secret never
sits on disk; note that this keeps it off disk but not away from other plugins loaded
into the same shell.

From the command line, `omarchy-shell io.github.danjonesio.coolwatch deploy|restart|stop|start <uuid>`
queues the action without a confirmation (typing the verb is the confirmation) and
prints `queued <verb> <uuid>` or the reason it was refused; `… status | jq .lastAction`
shows the outcome. Any local process can call these, and any plugin loaded into the
same shell can call the service directly, so treat the machine as the trust boundary.

## Docs

- [Product brief](docs/product.md)
- [Architecture](docs/architecture.md)
- [Design](docs/design.md)
- [Roadmap](docs/roadmap.md)
- [Coolify API reference](docs/coolify-api.md)
- [Omarchy shell reference](docs/omarchy-shell-reference.md)

## License

MIT. See [LICENSE](LICENSE).
