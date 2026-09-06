# Omarify

Coolify in the Omarchy bar. Servers, projects, resources, running and queued
deployments, and the buttons to deploy, redeploy, restart, stop and cancel, in a native
[Omarchy](https://omarchy.org/) panel. Works with Coolify Cloud and self-hosted Coolify
through the REST API.

**Status: Phase 1 (read-only bar icon and panel) in progress.** See [docs/roadmap.md](docs/roadmap.md).

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
omarchy plugin add https://github.com/danjonesio/omarify.git --enable
```

Then create `~/.config/omarify/config.json` (mode 0600; the plugin creates the
directory as 0700):

```json
{
  "version": 1,
  "instances": [
    { "id": "cloud", "name": "Coolify Cloud", "url": "https://app.coolify.io", "token": "67|…" }
  ],
  "poll": { "deploymentsSec": 4, "resourcesSec": 60, "serversSec": 120, "topologySec": 600 }
}
```

`poll` is optional; those are the defaults. Create the token in Coolify under
Security → API Tokens with the `read` permission (`deploy` is needed once Phase 2 adds
actions). Instead of `token` you can give
`"tokenCommand": ["op", "read", "op://Private/Coolify/credential"]` so the secret never
sits on disk; note that this keeps it off disk but not away from other plugins loaded
into the same shell.

## Docs

- [Product brief](docs/product.md)
- [Architecture](docs/architecture.md)
- [Design](docs/design.md)
- [Roadmap](docs/roadmap.md)
- [Coolify API reference](docs/coolify-api.md)
- [Omarchy shell reference](docs/omarchy-shell-reference.md)

## License

MIT. See [LICENSE](LICENSE).
