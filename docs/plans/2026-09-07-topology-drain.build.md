# Build record: faster topology drain while a panel is open, and an honest "Ungrouped" fold

Plan: `docs/plans/2026-09-07-topology-drain.md`. Branch `topology-drain` from base `28111f5`; last code commit `37244c1`. Dan merges.

## Questions resolved

| question | answer | source |
|---|---|---|
| (none without a default) | 10 s spacing; "Ungrouped · loading" wording | default |
| Panel model for the review | opus (named in the ask) | user |

## Audit

Tree at `28111f5`; the only dirty file was the plan itself, committed first (`ca3d9aa`). Every cited line exists: `Service.qml:823-825` (`topologyKick`, `topologyStep`), `:126` (the panel-open kick), `:58/413/509/533` (`_topologyFetched`), `:97` (`_resourcesSec`); `Model.js:397` (`buildTree` Ungrouped), `:934/938` (`panelRows` fallback tree and fold title); `tests/run.js:387, 562`. No mismatch changed **Design**; one design gap found while verifying (deviation 1).

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| 1 | `Service.qml`: panel-open drain cadence, `topologyFetched` in the snapshot; AGENTS.md and architecture.md cadence lines | `0f94760` | `bin/check`; restart + summon + 12 × 10 s `status` loop; restart with the panel closed + loop | `ok`. First open-panel run (`drain-open.log`): the queue drained one block per 10 s from the panel-open kick (6 → 1 by +52 s) and then refilled to 6 at +62 s because the 65 s kick ran the whole fan-out again (14 topology requests: 2 `/projects`, 2 server, 10 project); fixed inside the step (deviation 1) and re-run (`drain-open2.log`): 6 → 0 by +61 s, `topologyFetched` true, 7 topology requests in total, `requestsLastMin` max 24. Closed panel, first run (`drain-closed.log`): a panel was opened and closed by hand at about +85 s and +105 s, which restarted the timer twice, so the first block landed 80.6 s after `/projects` (log 04:03:25 → 04:04:46) and the loop itself saw no block; the 40 s spacing was read from the log after the loop (04:05:26, 04:06:06, 04:06:46). Re-run untouched after the review fixes (`drain-closed2.log`, below): `/projects` at +70 s, blocks at +110 s and +150 s, `openPanels` 0 at every sample, `requestsLastMin` max 19 |
| 2 | `Model.js` + tests + design.md: "Ungrouped · loading" while incomplete | `3cf33e1` | `node tests/run.js`; `bin/check`; restart + immediate summon + screenshots | 69 passed, 0 failed; `ok`; `t1.png` at +7 s: "UNGROUPED · LOADING"; `t2.png` at +77 s: every project fold named, no Ungrouped fold, `topologyFetched` true, `requestsLastMin` 22 |

## Tests

| case | covers | file | commit |
|---|---|---|---|
| Model.panelRows: the leftover fold reads "Ungrouped · loading" until the topology is complete; same key; `sameRows` false across the rename; Ungrouped stays last | the fold title | `tests/run.js` | `3cf33e1` |
| (existing) Model.panelRows group by project with folds … Ungrouped last | passes `topologyFetched: true` explicitly, still asserts "Ungrouped" | `tests/run.js` | `3cf33e1` |
| (existing) Model.buildTree … Ungrouped | unchanged: `buildTree` still names the project "Ungrouped" | `tests/run.js` | — |

## Verification

| check | command or action | result |
|---|---|---|
| `bin/check` | full | `ok` (69 tests, gates, staged validate, qmllint) |
| `status` | `omarchy-shell … status \| jq '{topologyFetched, topologyQueue, requestsLastMin, openPanels}'` | after the step 2 restart: `true, 0, 22, 1` then panel hidden |
| folds named within ~2 min of a restart with the panel summoned | `t2.png` | pass (+77 s) |
| closed-panel cadence and budget unchanged | `drain-closed2.log` (untouched run after the review fixes) | pass: `/projects` +70 s, blocks +110 s and +150 s, max 19/min, `openPanels` 0 throughout |
| the latch: fast drain and "loading" only on the first cycle; a mid-drain panel open launches at once | `drain-open3.log`, `drain-catchup.log` | pass: open from the start, 6 → 0 by +62 s, 7 topology requests, max 24/min; restart closed, summon at +72 s → queue 6 → 5 within 2 s, 4 at +86 s, back to 40 s after hide |
| the leftover fold says "loading" only while blocks are queued | `t1.png` then `t2.png` | pass |
| machine state | installed copy verified identical to `37244c1`'s `Service.qml` before the final run; panel hidden; config untouched | done |

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 1 | "Nothing else changes: … `topologyKick` at 65 s … all stay" | `topologyKick.onTriggered` now runs `_pollTopology()` only when `!_topologyFetched` | with 10 s spacing the panel-open drain finishes before 65 s, so the unguarded kick found an empty queue and re-ran the whole fan-out (`drain-open.log`: queue back to 6 at +62 s; 14 topology requests instead of 7). With the old 40 s spacing the queue was always still draining at 65 s, which is why the plan did not see it |
| 2 | 1 (review) | `snapshot.topologyFetched: root._topologyFetched`; the kick and the spacing keyed on `_topologyFetched` | a `_topologyLoaded` latch (true once the first drain completes, false after a config change) drives the snapshot field, the kick guard and the 10 s spacing; `_finish` marks a cycle complete only when a block succeeded (`anyOk`) | `_topologyFetched` meant "the queue is empty": a failed `/projects` set it too, which the guarded kick would then never retry (both reviewers, critical); and every 600 s cycle re-queues all blocks, so the title would have flipped to "loading" for minutes each cycle (security F2) |
| 3 | 1 (review) | the Timer restart on an interval change accepted as "up to one interval" | `topologyStep.onIntervalChanged` launches at once when the last block is older than the new interval (the `_catchUp` shape) | the first closed-panel run showed the cost compounding per open/close (80.6 s to the first block); observed fixed in `drain-catchup.log` |

## Review

| member | model | critical | warning | nit | fixed (commits) | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 1 | 2 | 1 | F1 `37244c1` (`anyOk` gate + latch); F2 `37244c1` (latch drives the title); F3 `37244c1` (catch-up); F4 `37244c1` (docs mention the guarded kick) | — |
| code-reviewer | opus | 1 | 1 | 3 | F1 `37244c1`; F2 `37244c1`; F3 re-run untouched (`drain-closed2.log`); F4 `37244c1` (AGENTS ≈ 24 during the first drain); F5 `37244c1` (fallback-path test) | — |
| skeptic | opus | 0 | 5 | 2 | F1 re-run untouched and the first run described honestly (step 1 row); F2 80.6 s corrected, PR body reworded; F3 `37244c1`; F4 `37244c1`; F5 the in-flight fixes are `37244c1` with their own Verify; F6 14 corrected; F7 the key log lines are inlined below | — |

Panel: the plan's minimum (no situational analysts ran in planning). Re-check round recorded below.

Evidence excerpts (the scratch logs do not survive a reboot):

```
drain-open2.log (guarded kick, panel open from +1 s)      drain-closed2.log (untouched)
+1s  queue 6  req 6                                        +60s  queue 0  req 16  openPanels 0
+11s queue 5  req 9                                        +70s  queue 6  req 17  openPanels 0
+21s queue 4  req 13                                       +100s queue 6  req 17  openPanels 0
+31s queue 3  req 17                                       +110s queue 5  req 18  openPanels 0
+41s queue 2  req 21                                       +140s queue 4  req 19  openPanels 0
+51s queue 1  req 24                                       +150s queue 4  req 19  openPanels 0
+61s queue 0  req 23  topologyFetched true  (7 requests)
drain-catchup.log (restart closed, summon mid-drain)
+72s before summon queue 6 | +74s after summon queue 5 | +86s queue 4 | +88s hidden queue 4
```

## Noticed, not done

- The by-server view (`g`) puts every resource under "Unassigned" until the first server block lands (10 s with a panel open, ~105 s closed) with no loading hint; the plan's Out of scope covers it (code-reviewer).
- `_enqueueMissingServerResources` re-queues a late server's block on the 40 s cadence even with a panel open, because the latch is already set by then; harmless, one block.
- `status.perKind.topology.interval` reports `_topologySec` (600), not the step spacing; harmless, but it does not show the 10 s / 40 s state.

## PR body

```
Faster topology drain while a panel is open; "Ungrouped · loading" until it completes

After a shell restart the project folds took up to five minutes to fill in and every resource sat under "Ungrouped". With a panel open the stage-2 topology blocks now land one per 10 s instead of 40 s (six blocks in the first minute, still under the 60/min line), and the leftover fold is titled "Ungrouped · loading" until the last block arrives. With the panel closed the cadence and the idle budget are unchanged (a panel opening mid-drain now launches the next block at once instead of restarting the wait). The 65 s /projects kick skips when the first drain has already completed, a failed /projects no longer counts as complete, and the fast spacing and the loading title apply to the first drain only.

Plan: docs/plans/2026-09-07-topology-drain.md
Steps: 2 step commits, 1 review-fix commit, the plan and the record
Verification: bin/check green (69 tests); live: folds named 61–77 s after a restart with the panel open, 7 topology requests, max 24 req/min; closed-panel run untouched: /projects at +70 s, blocks 40 s apart, max 19/min; a summon mid-drain launches within 2 s
Needs human: none
```
