# Security

Coolwatch holds a Coolify API token with `read`, `read:sensitive` and `deploy`
abilities and can start, stop and redeploy your resources. Treat a flaw in how it
handles that token or those actions as a security issue.

## Reporting

Use GitHub's private vulnerability reporting for this repository
(**Security → Report a vulnerability**). Please do not open a public issue.

Include the Omarchy and Coolify versions, whether the instance is Cloud or self-hosted,
and the steps. Never paste a token, a build log or a config file; the `status` output
carries none of those by design and is safe to attach.

You will get a reply within a week. Fixes ship as a normal release and the advisory is
published once a fixed version is on the marketplace.

## In scope

- The token reaching argv, a log, a state file, `status` output or a toast.
- A Coolify string reaching a notification, a URL or a process argument unescaped.
- An action sent to a resource or instance other than the one shown.
- Anything written outside `~/.config/coolwatch/` and `~/.local/state/coolwatch/`.

## Known boundaries

- The plugin runs inside `omarchy-shell` with every other plugin; another plugin loaded
  into the same shell can reach its service object and the token. `tokenCommand` keeps
  the token off disk but not away from the shell.
- A `tokenCommand` is your own command, run as you.
- The Omarchy marketplace's automated baseline is not a security review.
