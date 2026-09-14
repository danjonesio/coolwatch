# Contributing

Thanks for looking. Coolwatch is small and opinionated, so a few minutes here save a
round trip later.

## Start here

- `AGENTS.md` is the contract: product locks, layout, commands, the things that bite.
  Read it before writing code; it applies to humans as much as to agents.
- `docs/roadmap.md` says what is planned and what is deliberately out. Open an issue
  before a large change so we can agree on the shape first; the locks in `AGENTS.md`
  are decisions, not oversights.
- `docs/architecture.md` and `docs/design.md` are the specs the code follows.

## Dev loop

```sh
git checkout -b my-change develop
bin/check                 # tests, gates, shellcheck, plugin validate, qmllint
bin/dev-sync              # copy into ~/.config/omarchy/plugins/<id>/
omarchy restart shell     # Service.qml and Panel.qml changes need it
```

`bin/check --no-shell` is what CI runs on every PR. Model.js and Api.js are pure and
covered by `tests/run.js`; a change to either comes with a test. The shell source in
`/usr/share/omarchy` is read only.

## Pull requests

- Branch from `develop`, one change per PR, into `develop` (`gh pr create -B develop`).
  The `check` status must pass; the branch is deleted on merge.
- `master` is the released code: what the marketplace has verified and what
  `omarchy plugin update` fast-forwards to. Nothing lands on it except a release PR from
  `develop` (see `docs/release.md`).
- Keep the docs in step: a lock, a command or a layout change lands in `AGENTS.md` or
  the relevant `docs/` file in the same PR.
- Look native or do not ship: only `qs.Ui` and `qs.Commons`, no hardcoded colours,
  sizes, radii or fonts.

## Two rules that trip newcomers

1. **Nothing from a real account except uuids.** Fixtures, screenshots and docs carry
   no tokens, names, hostnames, domains, IPs, repository paths or commit messages from a
   real Coolify. `bin/record-fixture` scrubs and rewrites what it can; rename the rest by
   hand (`hetzner-1`, `203.0.113.10`, `api`, `storefront`, `landing`, `example.net`).
   `bin/check` fails on what it can detect. The repo is public and its history has been
   rewritten twice for this; do not make it a third.
2. **The token never leaves stdin.** Not in argv, not in `console.*`, not in state files,
   not in `status` output. Every request goes through the curl config on stdin.

## Reporting

Bugs and ideas: the issue templates. Security: see `SECURITY.md`, not a public issue.
