# Build record: faster topology drain while a panel is open, and an honest "Ungrouped" fold

Plan: `docs/plans/2026-09-07-topology-drain.md`. Branch `topology-drain` from base `28111f5`. Dan merges.

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
| 1 | `Service.qml`: panel-open drain cadence, `topologyFetched` in the snapshot; AGENTS.md and architecture.md cadence lines | `0f94760` | `bin/check`; restart + summon + 12 × 10 s `status` loop; restart with the panel closed + loop | `ok`. First open-panel run (`drain-open.log`): the queue drained one block per 10 s from the panel-open kick (6 → 1 by +52 s) and then refilled to 6 at +62 s because the 65 s kick ran the whole fan-out again (13 topology requests); fixed inside the step (deviation 1) and re-run (`drain-open2.log`): 6 → 0 by +61 s, `topologyFetched` true, 7 topology requests in total, `requestsLastMin` max 24. Closed panel (`drain-closed.log` + log timestamps): `/projects` at +70 s, blocks 40 s apart (1788750326 → 1788750366), `requestsLastMin` max 18 |
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
| closed-panel cadence and budget unchanged | `drain-closed.log`, log timestamps | pass (40 s spacing, max 18/min) |
| the leftover fold says "loading" only while blocks are queued | `t1.png` then `t2.png` | pass |
| machine state | installed copy synced from the step 2 tree and restarted; panel hidden; config untouched | done |

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 1 | "Nothing else changes: … `topologyKick` at 65 s … all stay" | `topologyKick.onTriggered` now runs `_pollTopology()` only when `!_topologyFetched` | with 10 s spacing the panel-open drain finishes before 65 s, so the unguarded kick found an empty queue and re-ran the whole fan-out (`drain-open.log`: queue back to 6 at +62 s; 13 topology requests instead of 7). With the old 40 s spacing the queue was always still draining at 65 s, which is why the plan did not see it |

## Review

(pending: security-analyst, code-reviewer, skeptic on opus; the plan ran no situational analysts)

## Noticed, not done

- Opening and closing a panel during a drain restarts `topologyStep` each time (a Timer restarts on an interval change), which showed up in `drain-closed.log` as a 50 s gap with no block while a panel was briefly open; the plan lists it as an accepted risk. A `_catchUp`-style "launch now if the last block is older than the new interval" would remove it (`Service.qml` `topologyStep`).
- `status.perKind.topology.interval` reports `_topologySec` (600), not the step spacing; harmless, but it does not show the 10 s / 40 s state.

## PR body

```
Faster topology drain while a panel is open; "Ungrouped · loading" until it completes

After a shell restart the project folds took up to five minutes to fill in and every resource sat under "Ungrouped". With a panel open the stage-2 topology blocks now land one per 10 s instead of 40 s (six blocks in the first minute, still under the 60/min line), and the leftover fold is titled "Ungrouped · loading" until the last block arrives. With the panel closed nothing changes, so the idle budget stands. The 65 s /projects kick now skips when the topology is already complete, which the faster drain exposed as a double fan-out.

Plan: docs/plans/2026-09-07-topology-drain.md
Steps: 2 commits, one per plan step
Verification: bin/check green (69 tests); live: folds named 61–77 s after a restart with the panel open, 7 topology requests, max 24 req/min; closed-panel cadence 40 s and max 18/min unchanged
Needs human: none
```
