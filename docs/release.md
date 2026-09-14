# Releasing

`master` is the released code. The marketplace verifies one commit SHA on it, and
`omarchy plugin update` fast-forwards an installed copy to its head, so it moves only
when a release goes out. Everything else lands on `develop` through ordinary PRs.

Versions follow semver on `manifest.json`: a fix or a polish item bumps the patch, a
feature the minor, a change to config or state file format the major.

## Checklist

1. On `develop`, `bin/check` is green and the installed copy has run the head for a day
   of real use (a shell restart, a deployment, a failed build, a panel session).
2. Branch `release-X.Y.Z` from `develop`. Bump `"version"` in `manifest.json`. Update
   the status line at the top of `AGENTS.md` (version and date) and add a short entry
   at the top of `CHANGELOG.md` listing the user-visible changes since the last tag:
   `git log --oneline vPREV..develop` is the source.
3. PR it into `develop`, merge it. Then open the release PR: `gh pr create -B master
   -H develop --title "Release X.Y.Z"`. `check` runs on it like any other PR; merge it
   with a merge commit, never a squash, so `develop` and `master` share history and the
   next release PR shows only the new commits.
4. Tag the merge commit on `master` and push the tag:

   ```sh
   git checkout master && git pull --ff-only
   git tag -s vX.Y.Z -m "Coolwatch X.Y.Z" && git push origin vX.Y.Z
   ```

5. File the marketplace verification issue at
   https://github.com/omacom/omarchy-plugin-marketplace/issues/new/choose ("Plugin
   verification") with the full SHA of the tagged commit (`git rev-parse vX.Y.Z^{}`).
   The listing serves the last verified SHA until that issue is closed.
6. Update the installed copy (`omarchy plugin update io.github.danjonesio.coolwatch`,
   then `omarchy restart shell`) so the running plugin matches what was shipped.

## Hotfixes

A fix that cannot wait for the next minor branches from `master`, PRs into `master` as
a patch release with its own tag and verification issue, and is merged back into
`develop` straight after (`git checkout develop && git merge master`).
