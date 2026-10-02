# Build record: Token binding

Plan: `docs/plans/token-binding.md` (copied from `~/.claude/plans/stateful-conjuring-ripple.md`). Branch `token-binding` from base `7a9cf36` (`develop`, equal in content to `master` 9071730 = 1.1.0), head `fc59146` (the record commit follows it). PR into `develop`, then the 1.1.1 release PR into `master`; Dan merges. Trigger: marketplace issue 8253.

## Questions resolved

| question | answer | source |
|---|---|---|
| a name/poll edit while a command runs keeps waiting on the open prompt; a cached token survives such an edit | yes, as designed (binding = url + tokenCommand) | default |
| mention path 6 (the ungated view fetches) in the issue reply | yes, one sentence | default |

## Audit

Run against `7a9cf36`: every path in Changes exists; every cited line matched (`Service.qml:592-593`, `:772`, `:829-843`, `:873-892`, `:894-900`, `:903`, `:925`, `:1326`, `:1339`, `:1353`, `:1363`, `:1911-1913`; `Model.js:1187`; `tests/run.js:2359-2367`; `docs/architecture.md:99-107`, `:113-115`, `:599-602`, `:707-710`, `:737`; `docs/development.md:14-21`, `:70`, `:164`, `:423`; `docs/roadmap.md:220`; `CHANGELOG.md:3`). The wave-2 reviewers that hung were replaced by the orchestrator's own node run of the T1–T11 table before the build (every row held). `git status --porcelain` empty before the branch.

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| 0 | plan copy first | cb1e9dc | `ls docs/plans/token-binding.md`; `bin/check --no-shell` | present; ok |
| 1 | `Model.js` `tokenBinding` + `tokenVerdict` | b102a90 | `node tests/run.js`; grep both functions after `instanceKey` | 146 passed; `:1182` / `:1196` / `:1206` |
| 2 | `Service.qml` one unit | 804c036 | `bin/check`; verdict ×3; `Api.config(` ×1; no `_tokenCmdKey`/`_tokenCmdSeq`; `ctx._token` lines 5; `_stopTokenCmd()` ×5; added `!ctx._ready \|\|` ×4; no credential-adjacent console line | ok; 3; 1; none; 5; 5; 4 added (8 total, 4 pre-existing: deviation 1); none |
| 3 | `bin/check` SR41 | 7e352a5 | `bin/check --no-shell`; scratch copy with a second `Api.config(` fails; scratch copy logging `tokenCmd.key` fails; `shellcheck bin/check` | ok; "found 2"; "names a token binding… (1)"; clean |
| 4 | tests T1–T11 | 33b774d | `node tests/run.js`; `grep -ac tokenVerdict tests/run.js` | 147 passed, 0 failed; 2 |
| 5 | docs, roadmap, changelog, manifest | e9eeba6 | `grep SR41 … \| wc -l` ≥ 5; manifest 1.1.1; roadmap line; `bin/check --no-shell`; `git diff --stat develop` | 12; `:5`; `:233`; ok; the ten planned files |
| 6 | live check | (no commit) | see Verification | pass; config restored byte-identical |
| 7 | release prep | in step 5; after the merge into `develop`: fill `docs/roadmap.md:233`'s `PR #N, merged YYYY-MM-DD` (one commit on `develop`), the release PR `develop` → `master`, the signed `v1.1.1` tag, `gh issue edit 8253` + the comment below, `bin/dev-sync` from `master` + restart | — | — |

## Tests

One block at the tail of `tests/run.js` (commit 33b774d) plus one assertion in the SR34 test.

| case | covers | file | commit |
|---|---|---|---|
| T1 common path → `""` | no regression | tests/run.js | 33b774d |
| T2 url changed; the maintainer's flow (url B + inline token B) → `stale` | requirements 2, 4, 5 | tests/run.js | 33b774d |
| T3 command changed; command → inline → `stale` (path 4) | requirements 2, 4, 5 | tests/run.js | 33b774d |
| T4 entry gone wins over a failed exit → `gone` | requirements 4, 11 | tests/run.js | 33b774d |
| T5 unsafe wins over stale and failed → `unsafe` | requirements 4, 11 | tests/run.js | 33b774d |
| T6 failed only when nothing stronger; `superseded` beats failed; stale is never failed | requirements 2, 7 | tests/run.js | 33b774d |
| T7 held-token form (no seq, no code): `""`, `stale`, empty bound, null inputs | requirement 3 | tests/run.js | 33b774d |
| T8 binding equal across name/plaintext; unequal across url, command, inline↔command | requirement 5 | tests/run.js | 33b774d |
| T9 empty url binds to `""` and matches nothing; query-bearing urls distinct | requirement 8 | tests/run.js | 33b774d |
| T10 no token in the binding; every verdict is one lowercase word | requirements 1, 8 | tests/run.js | 33b774d |
| T11 `instanceKey` moves on a url change | requirement 9 | tests/run.js (SR34 test) | 33b774d |
| unchanged and green: `:2359-2366`, `:347-353`, `:1045-1046`, `:1103`, `:1401` | — | tests/run.js | — |

## Verification

| check | command or action | result |
|---|---|---|
| node tests | `node tests/run.js` | 147 passed, 0 failed |
| CI gate | `bin/check --no-shell` | ok (incl. SR41) |
| full gate | `bin/check` | ok (qmllint, validate) |
| diff scope | `git diff --stat develop` | the ten planned files `CHANGELOG.md Model.js Service.qml bin/check docs/architecture.md docs/development.md docs/plans/token-binding.md docs/roadmap.md manifest.json tests/run.js` plus this record; `Api.js`, `Panel.qml`, fixtures, `docs/design.md`, `SECURITY.md`, `README.md` untouched |
| live probe, setup | scratch dir 0700 with a fake token file 0600 (`12\|notarealtoken…`) and `cmd.sh` (`sleep 25; cat "$1"`); the real config backed up; a `probe` instance added with `url https://probe-a.invalid` and `tokenCommand [cmd.sh, t]`; `bin/dev-sync && omarchy restart shell` | at t+6 s `status`: `cloud ok/file`, `probe waitingtoken` |
| live probe, the maintainer's flow | at t+7 s the probe entry edited to `url https://probe-b.invalid` + inline `token 13\|anotherfake…` (tokenCommand removed) | at t+10 s `probe ok/file`; at t+38 s (command A exited ~t+31 s) `probe ok/file, requestsLastMin 5` |
| live probe, log | `quickshell log … \| grep 'coolwatch probe/\|refused'` | `coolwatch probe/token refused superseded` (the inline switch stopped command A; its exit was refused); then `probe/version`, `resources`, `deployments`, `servers` `failed: offline … Could not resolve host: probe-b.invalid` — every request after the inline token applied, none to `probe-a.invalid`, none carrying command A's output |
| live probe, cleanup | restore the backup, `cmp`, `rm -rf` the scratch dir, restart | "config restored byte-identical"; `status` shows `cloud` only; the real instance polled throughout (`requestsLastMin 8`) |
| live probe 2, same command with a url edit mid-prompt (the relaunch case) | the probe entry edited to `url https://probe-b.invalid`, `tokenCommand` kept, at t+7 s | at t+10 s `probe waitingtoken` (the new run for B in flight); at t+38 s `probe ok/command`; log: `coolwatch probe/token refused superseded` (the run for A, judged against its own seq) then requests to `probe-b.invalid` only; no `tokencmd` callout (`stopping` recorded the asked-for stop); config restored byte-identical |
| Quickshell `Process` restart ordering | throwaway `shell.qml` probe under `qs -p` (Quickshell 0.3.1): a 2 s child stopped and restarted in one tick | `exited code=15 seq=2 liveSeq=1` delivered before `started seq=2`; the second exit carried only the second child's text: a stopped child's exit arrives first, with its own output |
| second pass (`r` on a History view during `waitingtoken`) | needs human | the run did not drive the panel; the `_launch` guard and the widened busy conditions are the evidence |
| `master` unmoved | `git rev-parse master` | 9071730 before and after |

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 2 | Verify `grep -c '!ctx._ready \|\|' Service.qml` → 4 | the count is 8; `git diff \| grep -c '^+.*!ctx._ready \|\|'` → 4 | four such conditions already existed (`fetchTags` and others); the plan's count was of the added ones |
| 2 | 3 | SR41 counts by `grep -c` (lines); `ctx._token` exactly 5 | counts by occurrence (`grep -o \| wc -l`); `ctx._token` exactly 6 | a line count let two calls on one line pass (the first scratch mutation did not fail); the cache branch reads `ctx._token` twice on one line, so six occurrences is the true count |
| 3 | 2 (review) | `_suspend`: `ctx._stopTokenCmd(); ctx._tokenKey = ""` (requirement 11 "stops the command and unbinds") | `_suspend` stops the command only; the held token keeps its binding | the verdict's `unsafe` arm precedes the binding compare and `_launch` re-asks `_tokenNow()` on every call, so the window is closed without unbinding; clearing `_tokenKey` made every unsafe-to-safe repair re-run the vault command (skeptic 1, code-reviewer 1, security-analyst 2). Requirement 11 is carried by `unsafe` + `_ready = false`, not by unbinding; the plan file keeps its approved wording and this row is the correction |
| 4 | 2 (review) | `_tokenNow().current` = `tokenBinding(ctx._entry)` | built from `ctx._instance.url` (what `Api.base` consumes) with `ctx._entry.tokenCommand` | the guard must be about the url the request is built from (security-analyst 3) |
| 5 | 2 (review) | `tokenCmd` gains `liveSeq` only | also `stopping` (the `Req` idiom's other half) and an arm that raises the `tokencmd` callout for an exit nobody asked for with no start seen | an unstarted exit (a spawn failure) would otherwise be a silent `superseded` with nothing to retry it (skeptic 3, code-reviewer 2); the restart ordering was measured rather than assumed (security-analyst 1) |

## Review

| member | model | critical | warning | nit | fixed (commits) | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 0 | 3 | 3 | 3 warnings + 2 nits (cc4320c, 38b065d, 0b19d4e, fc59146) | nit 5 (`_launch` false strands a view: unreachable backstop, recorded under Noticed) |
| code-reviewer | opus | 0 | 4 | 3 | warnings 1, 2, 4 and the nits (cc4320c, 38b065d, 0b19d4e, fc59146; the roadmap placeholders go on the post-merge list) | warning 3 (`_launch` false and the pre-set loading state: unreachable backstop, recorded under Noticed) |
| skeptic | opus | 0 | 3 | 2 | warnings 1, 3 and nit 5 (cc4320c, 38b065d, 0b19d4e, the record commit); warning 2 is the issue-comment wording below | — |
| re-check | opus | 0 | 2 | 1 | skeptic: 4 resolved, new warning 6 (both sides of the compare from one helper) fixed in 0b19d4e; code-reviewer: 7 resolved, its warning 8 is the same asymmetry (0b19d4e), nit 9 (`_halt` unbinds) fixed in fc59146 | security-analyst's re-check did not arrive within the ten-minute window; its three findings are addressed in 38b065d (measured restart ordering + `stopping`; `_instance.url` on the compare side, then 0b19d4e on both sides; `bind` in the gate) and deviation 3 |

Default panel; no situational members (the plan ran none). The review ran against the diff with a fifteen-minute brief after the planning panel's wave-2 reviewers had hung.

## Noticed, not done

- `_launch`'s new `return false` is a backstop no caller handles: `fetchHistory`, `refetchBuildLog` and `_fetchContainerLogSub` pre-set a loading state and `_drainTerminal` pre-sets `deploymentReq.inflight` before launching; `act()` reports it as `busy`. Unreachable while `_ready` and `_tokenKey` move together in `_tokenReady` (code-reviewer 3, security-analyst 5); worth a follow-up that moves those state writes after the launch.
- `_resolveToken` launches the vault command with no safety check of its own; it is safe because its only caller is `_applyStat`'s safe branch (security-analyst 6).
- `root._configError.kind === "unsafe"` is read at four sites now (`:149`, `:1589`, `_status`, `_tokenNow`).
- `tokenOut` is one `StdioCollector` shared across runs; measured: a restart's exit carries only the new child's text.

- A stat that fails right after a URL edit leaves the context on `waitingtoken` with a stale command running until the next `refresh` or file event; its result is now refused (plan risk; pre-existing, narrowed).
- The probe's `tokenSource` for a stopped command never reads `command`; `status` has no field for "a token command was refused" beyond the log line (by design, plan rejected alternative).

## PR body

```
Token binding (1.1.1)

A tokenCommand result, and the token an instance holds, are now bound to the exact url + tokenCommand that produced them (Model.tokenBinding) and are usable only while that pair, the entry and the file's safety are unchanged (Model.tokenVerdict, asked at accept, cache reuse and in _launch, the only request builder). Editing an instance while its command runs, switching it to an inline token, an unsafe config or the entry's removal stops the command (_stopTokenCmd, the Req.kill shape, with liveSeq stamped at start) and refuses its result. The four panel view fetches gained the readiness gate the polls already had, closing the same boundary with no token command involved. A name, poll or notify edit never re-prompts a vault. bin/check gains SR41 (occurrence counts over the chokepoints and a no-credential-in-logs grep). Found in marketplace review (omacom/omarchy-plugin-marketplace#8253); identical in 1.0.0.

Plan: docs/plans/token-binding.md
Steps: 6 commits, one per plan step (step 7, the release, follows the merge)
Verification: node tests 147/147, bin/check ok, live probe with throwaway credentials: a mid-run switch to an inline token logged `token refused superseded` and no request reached the new URL with the old command's output
Needs human: `r` on a History view while an instance is waiting for its token (expect the busy message, no request); after merge fill the roadmap's PR number and date before the release PR

Issue 8253 comment (after the release PR merges and v1.1.1 is tagged):
Fixed at <full SHA> (1.1.1). Each tokenCommand result is bound to the exact url + tokenCommand pair that started it (Model.tokenBinding) and is accepted only if that pair, the entry and the file's safety are unchanged (Model.tokenVerdict in tokenCmd.onExited); the held token is re-checked by the same rule before every request (_launch, the only Api.config site) and before any cache reuse; an outstanding command is stopped and its result refused when the entry's url or command changes, when it switches to an inline token, when the config goes unsafe, and on context teardown, with the sequence stamped at process start so a coalesced restart cannot deliver an old child's output. A name, poll or notify-only edit keeps a running command (same destination, same producer). The same review found a second route to the same boundary that needed no token command: the four panel-driven view fetches (build log, container log, service picker, history) could reach _launch between a config edit and the token re-resolution; they now carry the readiness gate the polls had. Regressions: tests/run.js "Model.tokenBinding / tokenVerdict" pins the acceptance rule itself in node (eleven cases, among them a pending result judged against an entry that now holds a different url and an inline token); the wiring is covered by a bin/check gate (SR41) that counts the three verdict sites and the single request builder and rejects any log line naming a binding, key or the command output, and by two live probes with throwaway credentials (a mid-prompt switch to an inline token, and a mid-prompt url change with the same command: both logged `token refused superseded` and no request carried the old run's output). The restart ordering of Quickshell's Process was measured rather than assumed. The issue body names the new SHA.
```
