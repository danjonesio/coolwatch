# Faster topology drain while a panel is open, and an honest "Ungrouped" fold

Repo `/home/danjones/Projects/coolwatch`, base `master` at `28111f5`, branch `topology-drain`. Dan merges. Small change, no planning panel (two mechanisms, both already in the code; recorded here so `/deej-stack:d-implement` can build it with a Verify gate).

## Context

After a shell restart or a config change, every resource sits under one "Ungrouped" fold for up to four minutes (Dan's screenshot, 2026-09-07). The grouping needs the topology stage 2 blocks (`GET /projects/{uuid}` per project, `GET /servers/{uuid}/resources` per server), which Phase 1 spreads deliberately: `/projects` at 65 s after the token is ready (`Service.qml:823` `topologyKick`), then one block per 40 s (`Service.qml:824` `topologyStep`), servers first (`Service.qml:497-510`). With one server and five projects the last project lands at roughly 65 + 6 × 40 = 305 s. Until a project's environments have arrived its resources have no fold and `Model.buildTree` (`Model.js:397`) puts them in "Ungrouped", which reads as a broken join rather than a transient state.

**Outcome.** With a panel open, the folds fill in within about a minute of a restart instead of five; while they are still arriving the fold is titled "Ungrouped · loading", and after they have all arrived a genuinely unplaced resource is still "Ungrouped". The idle budget with the panel closed is untouched.

## Findings from exploration

- `Service.qml:824`: `Timer { id: topologyStep; interval: 40000; repeat: true; triggeredOnStart: false; running: root._timersOn && root._topologyQueue.length > 0 }`. Changing a running Timer's interval restarts it (Phase 1 lesson, `docs/architecture.md`), so an interval that depends on `_panelOpen` re-arms the moment a panel opens.
- `Service.qml:126`: `panelOpened` already kicks `/projects` when the topology has never been fetched and the queue is empty; the stage 2 blocks still wait for `topologyStep`.
- `Service.qml:58, 413, 509, 533`: `_topologyFetched` is true only when the queue has drained; it is already in `_status()` (`:916`) but not in `snapshot`.
- `Service.qml:97`: with a panel open the resources interval is 30 s and deployments idle at 4 s, so the panel-open idle rate is ≈ 20/min (measured 20 on 2026-09-07). Six topology blocks at 10 s spacing add 6 in the first minute → ≈ 26/min, under the 60 line; the "under 20" bar is defined with the panel closed (`AGENTS.md:68`) and is unchanged because the faster spacing applies only while a panel is open.
- `Model.js:397` (`buildTree`) and `:934` (`panelRows`'s fallback tree) both name the fold "Ungrouped"; `:938` builds the fold title; `rowRev` hashes `title`, so a title change repaints without any other churn.
- Tests: `tests/run.js:387` (`buildTree` Ungrouped) and `:562` (`panelRows` group by project, Ungrouped last) assert the current name.

## Design

- **Drain cadence.** `topologyStep.interval` becomes `root._panelOpen && !root._topologyFetched ? 10000 : 40000`. Nothing else changes: the queue, the servers-first order, `topologyKick` at 65 s, the skip-while-draining rule in `_pollTopology`, and the 40 s spacing with the panel closed all stay. Opening a panel mid-drain re-arms the timer at 10 s (a Timer restarts on an interval change); closing it returns to 40 s.
- **Fold title.** `snapshot` gains `topologyFetched: root._topologyFetched`. `Model.panelRows` titles the leftover fold `"Ungrouped · loading"` while `!s.topologyFetched` and `"Ungrouped"` afterwards (the fold **key** stays `fold:p:/` so the fold's open/closed state survives the rename). `buildTree` keeps `projectName: "Ungrouped"`; only the rendered title changes.

Rejected: kicking every stage 2 block at once on panel open (a burst of P + S requests is exactly what pushed a Phase 1 window past the budget); a longer `RECENT`-style cache of the topology across restarts (that is `recent.json` territory, Phase 3).

## Changes

### 1. `Service.qml`: panel-open drain cadence and `topologyFetched` in the snapshot

- `topologyStep.interval: root._panelOpen && !root._topologyFetched ? 10000 : 40000` with a one-line comment naming the budget arithmetic above.
- `snapshot` gains `topologyFetched: root._topologyFetched`.
- `docs/architecture.md` polling schedule: the topology row gains "one block per 10 s while a panel is open and the topology is incomplete"; `AGENTS.md:66-69` rate-limit lock gains the same clause.

**Verify**: `bin/check` → `ok`. `bin/dev-sync && omarchy restart shell`; within 5 s `omarchy-shell shell summon io.github.danjonesio.coolwatch`; then `for i in $(seq 12); do omarchy-shell io.github.danjonesio.coolwatch status | jq -c '{t: now|floor, topologyFetched, topologyQueue, requestsLastMin}'; sleep 10; done` shows `topologyQueue` falling by one per sample after the 65 s kick and `topologyFetched` true within ~130 s of the restart, with `requestsLastMin` never above 30. Then `omarchy-shell shell hide …`, `omarchy restart shell` without summoning: the same loop shows one block per 40 s and `requestsLastMin` ≤ 20 (the Phase 1 closed-panel bar holds).

### 2. `Model.js` + tests: "Ungrouped · loading" while the topology is incomplete

- `panelRows`: the fold title for the leftover project is `s.topologyFetched ? "Ungrouped" : "Ungrouped · loading"`; the key is unchanged.
- `tests/run.js`: the two existing Ungrouped cases pass `topologyFetched: true` explicitly and keep asserting "Ungrouped"; one new case asserts `"Ungrouped · loading"` with `topologyFetched: false` and that the fold key is identical in both states; `sameRows` false across the rename.
- `docs/design.md` resources section: one sentence on the loading title.

**Verify**: `node tests/run.js` → all pass (the two Ungrouped cases plus the new one); `bin/check --no-shell` → `ok`; after `bin/dev-sync && omarchy restart shell` and an immediate summon, the fold reads "UNGROUPED · LOADING" (`grim` screenshot), and after `status.topologyFetched` turns true the leftover fold, if any, reads "UNGROUPED".

## Verification

```sh
bin/check
omarchy-shell io.github.danjonesio.coolwatch status | jq '{topologyFetched, topologyQueue, requestsLastMin, openPanels}'
```

Done: after a restart with the panel summoned, every project fold is named within ~2 minutes; with the panel closed the Phase 1 cadence and budget are unchanged; the leftover fold says "loading" only while blocks are still queued.

## Tests to add

- `Model.panelRows`: leftover fold titled "Ungrouped · loading" when `topologyFetched` is false, "Ungrouped" when true, same key both ways, `sameRows` false across the change.

## Risks and open questions

- Opening and closing the panel repeatedly during a drain re-arms the timer each time (a Timer restarts on interval change), which can delay a block by up to one interval; it never adds requests.
- No open questions; defaults as stated (10 s spacing, "Ungrouped · loading" wording).

## Out of scope

Persisting the topology across restarts; changing the 65 s `/projects` kick; the closed-panel cadence; a "loading" note anywhere else.
