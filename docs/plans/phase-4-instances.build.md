# Build record: Coolwatch Phase 4 — "instances" (one context per Coolify, chips)

Plan: `docs/plans/phase-4-depth.md` (one plan for the hotfix, the depth branch and this branch; this record covers steps 10–14). Branch `phase-4-instances` from the depth head `2f2c4c2` (not from a merged depth branch: Dan merges; the relationship is the same once both land in order). Built with `/deej-stack:d-implement` on 2026-09-12; panel model `opus`. Commits carry no attribution trailers (Dan's standing preference).

**Commits.** Step 10 `b157486`, step 11 `7d34b49`, step 12 `8dd8721`, step 14 `e1a3225`, the review commits `feda449`, `83ca23f`, `4fef763`, `94c99ad`, `130b4f3`, `2e96af0`, `dfd64e5`, `d93db7e`, then this record. Between 11:02 and 11:35 every `git commit` was refused by the SSH signer (`error: 1Password: failed to fill whole buffer`; the 1Password app was running with its agent socket present, so the vault was presumably locked); steps 11–14 were built and verified in the working tree meanwhile, staged per step, and committed in order once the signer answered. Nothing was done to work around it.

## Questions resolved

| question | answer | source |
|---|---|---|
| 1. A self-hosted Coolify reachable from this machine | none available; acceptance 2 ran with a second entry on the same Cloud account, then a dummy unreachable entry for the offline path; the self-hosted paths are needs-human | default |
| 2. Bar icon when instances disagree | the current instance, with a tooltip suffix naming the first other instance in trouble | default |
| 5. Optional per-instance `sensitiveToken` | no; unchanged from the depth record | default |
| 7. Idle rate gate with N instances | per instance < 20, `requestsTotalLastMin` reported alongside (Dan's choice, recorded in the depth record) | user |
| (new) a read-only second token for step 13 | not available during the build; the second entry used the same token, so `sensitive` could not differ (needs-human) | default |

## Audit

Tree clean at `2f2c4c2`. Anchors re-checked before building: `Service.qml` `instances[0]` at three sites (`_configText`, `_applyStat`, `_resolveToken`), one `tokenCmd`, one `_requestLog`; `grep -c 'root\._' Service.qml` → 530 references, 169 distinct identifiers (the plan counted 419 at `0e6bd60`; the depth branch added the rest); `Model.js` `normaliseConfig` at `:62`, `OFFLINE_EXITS` at `:248` (60 listed), `errorFor` at `:265`, `barState` at `:869`, `calloutBody` at `:920`, `parseRecent`/`serialiseRecent` at `:783`/`:806`; `Panel.qml` hero stub at `:190` ("h/l on the hero: chips are Phase 4"), `onOpenedChanged` at `:90`, `openConfirm`/`resolveConfirm` at `:295`/`:307`; `BarWidget.qml` `onPressed` at `:61`; shell precedents `plugins/agents/Main.qml:52-74` (Instantiator with `required property var modelData`, rebuild in both handlers) and `plugins/agents/Panel.qml:461-494` (chips). No mismatch changed **Design**; the Instantiator-model rule needed a correction found in step 13 (deviation 5).

## Steps

| # | step | commit | verify | result |
|---|---|---|---|---|
| 10 | config rules (`ID_RE`, unique ids, no userinfo, same-origin warning), `tls` at four sites, `instanceChips`/`instanceTrouble`, `parseRecent`/`serialiseRecent` with `id`, the notify body suffix; fixture `config-two-instances.json` | `b157486` | `node tests/run.js`; `bin/check --no-shell` | 127 passed (8 new cases, 3 updated); `ok` |
| 11 | `InstanceCtx`: the whole per-instance body moved into an inline component; the root keeps config, panels, the toast budget, the reaper and the public surface; `Instantiator` over an in-place `ListModel` of ids; per-id reconciliation in `_configText`; `_status().instances[]`, `activeInstance`, `requestsTotalLastMin`; IPC `instances`/`instance`; `act(…, instanceId)` | `7d34b49` | `node tests/run.js`; `bin/check`; `status \| jq -S "$DEL"` before and after; `instances \| length`; `ls` the state dir; 12 × 10 s closed loop; a `notify`-only edit; a panel summoned over IPC | 127 passed; `ok` (qmllint clean); the pre/post diff is empty apart from `topologyFetched`/`topologyQueue`, the per-cycle phase (pre was taken mid-refresh with four blocks queued, post after the cycle completed; the volatile keys and the new keys `activeInstance`, `instances`, `requestsTotalLastMin`, `id`, `instance.name` removed); `perKind` key set identical (the ten keys); 1 instance; `recent.json` only; closed loop 20 once at t+60 s (the startup burst of four kinds plus the 65 s kick), 17–19 steady (samples below); the notify edit: baseline all true, `perKind.deployments.lastAt` advanced 4 s, `recentPersisted` 13 unchanged, `inflightAction` false, `Action interrupted` 0; the panel: `openPanels` 1, `tags` 2, no QML error. Two extraction slips were caught live before the step closed: the `Req` component's `onExited` briefly kept `root._finish` (TypeError on every exit) and two property declarations (`_servers`, `_backoff`) fell on segment boundaries; both fixed and re-verified. The first attempt also cleared the per-shell notify ring from a context reset; removed |
| 12 | chips under the hero (no cursor ring), `h`/`l` on the hero, views popped and the row collapsed on an instance switch, the confirm bound to its instance, middle-click on the icon, the hero footer hint, `bar.tooltip` in `status` | `8dd8721` | `bin/check`; a two-entry config; the panel summoned and screenshotted on each instance via `instance <id>`; `instances`; a nonsense id | `ok`; two chips ("Coolify Cloud" selected, then "Cloud again" after the IPC switch; the hero title, the "Same Coolify twice" callout and the deployment row follow); `status.activeInstance` follows; `instances` → `cloud (active), cloud2`; `instance nope` → `unknown instance nope`; `lastAction` reads the active context's (null after the switch). Keyboard and mouse paths (`h`/`l` on the hero, a chip click, the middle-click, a confirm left open across a switch) are **needs human**: synthetic keys land in whatever window Dan has focused (depth record) |
| 13 | two instances live | no files | see **Verification** | a second entry on the same account (same token, `notify: false`): both contexts poll with independent baselines, both drain the same build and write their own recent files with `id`; a mangled second token → `instances[1].error.kind == "auth"` and `probeMode` true there only, `instances[0]` keeps polling, the icon stays `U+F015F` undimmed, the tooltip ends in `· Cloud again: token rejected`; the order swapped → the context now at index 0 reads `recent.json` (id `cloud`) and reports `recentRejected: true`, the other reads its own; the entry removed → one chip, `instances` reads `cloud (active)`, no reaper warning in the log (then `coolwatch reaped <kind>`, since the review `coolwatch <id>/<kind> reaped`), `pgrep -c curl` 0 for the next 10 s, `recent-cloud2.json` left in place (deleted by hand at the end of the build); an unreachable dummy entry (`http://127.0.0.1:9`, `notify` on) → `offline` with `curlExit 7` and the `plaintext` warning on it only, the tooltip ends in `· Dummy box: offline`; a api deploy then produced `Building xyhpwdxq` / `main · Coolify Cloud` and `Deployed xyhpwdxq` / `21s · main · Coolify Cloud` (history files `1789208599826-1`, `1789208622182-2`); the original single-entry config restored and confirmed |
| 14 | docs, manifest 0.6.0, this record | `e1a3225` | `bin/check` | `ok`; the staged validate passes with 0.6.0; the installed copy matches the working tree (`cmp` on the seven shipped files) |

Step 11's commit carries more than step 11: the whole `Service.qml` half of step 12 (the `instances`/`instance` IPC verbs, the `wronginstance` arm, `lastAction.instance`), the step 13 correction (the in-place `ListModel`, deviation 5) and the `status.bar.tooltip` line, all written while the signer was down and staged as one file; step 12's commit carries `Model.js` and `tests/run.js` (the hero footer hint) beyond its file list. The step 11 pre/post comparison was re-run against the tree after the review fixes: with the volatile keys, the per-cycle topology keys and the seven new keys (`activeInstance`, `instances`, `requestsTotalLastMin`, `id`, `instance.name`, `bar.tooltip`) removed, the only difference against the depth build's capture is `counts.recent`/`recentPersisted` 13 → 15, the two api builds that finished in between.

## Step 11 inventory

Every `root._<name>` identifier `Service.qml` used at `2f2c4c2`, with where it lives after the refactor (`context` = `InstanceCtx`, one per configured instance; `root` = the service). Generated mechanically (`grep -o 'root\._[A-Za-z0-9_]*' | sort -u` over the old file, each name looked up in the new file). Mechanical check after the move: inside the component body, every remaining `root.` reference names a root-owned identifier (`_cfg`, `_chargeNotify`, `_configError`, `_configMode`, `_ctxs`, `_dnd`, `_instanceIds`, `_notifiedLastMin`, `_openPanels`, `_panelOpen`, `_selfHeal`, `_stateDirReady`, `pluginId`, `sensitiveMessage`, `stateDirPath`); outside it, every `root._` reference is one of the root's own 33. `git diff -w 2f2c4c2 -- Service.qml` shows the moves; the plain diff is dominated by the two-space re-indent of the context body.

| identifier | destination |
|---|---|
| `_acceptStamp` | root |
| `_actionAt` | context |
| `_actionLog` | context |
| `_actionsLastMin` | context |
| `_actionStatus` | context |
| `_actionTone` | context |
| `_activeCount` | context |
| `_activeUuids` | context |
| `_applyStat` | root |
| `_armRecent` | context |
| `_backoff` | context |
| `_backoffSec` | context |
| `_backoffUntil` | context |
| `_baseline` | context |
| `_baselineDone` | context |
| `_buildLogs` | context |
| `_busy` | context |
| `_byServer` | context |
| `_bytesAt` | context |
| `_bytesKind` | context |
| `_bytesLastMin` | context |
| `_bytesN` | context |
| `_captureLog` | context |
| `_catchUp` | context |
| `_cfg` | root |
| `_clearPending` | context |
| `_configMode` | root |
| `_configOwner` | root |
| `_configText` | root |
| `_containerLogs` | context |
| `_copyPending` | context |
| `_deploying` | context |
| `_deployments` | context |
| `_deploymentsBytes` | context |
| `_deploymentsSec` | context |
| `_descriptorFor` | context |
| `_dispatch` | context |
| `_dnd` | root |
| `_drainDispatched` | context |
| `_drainDone` | context |
| `_drainRetries` | context |
| `_drainTerminal` | context |
| `_drainTries` | context |
| `_enqueueMissingServerResources` | context |
| `_envsByProject` | context |
| `_error` | context |
| `_evictLru` | context |
| `_expirePending` | context |
| `_fail` | context |
| `_failedUnacked` | context |
| `_fetchContainerLogSub` | context |
| `_finish` | context |
| `_finishAction` | context |
| `_flushNotify` | context |
| `_fresh` | context |
| `_history` | context |
| `_inflightAction` | context |
| `_instance` | context |
| `_ipcAbilityStreak` | context |
| `_ipcAct` | root |
| `_isLogTarget` | context |
| `_isViewKind` | context |
| `_joinDeployments` | context |
| `_lastAbility` | context |
| `_lastAction` | context |
| `_lastActionLaunchAt` | context |
| `_lastEvent` | context |
| `_lastNotified` | context |
| `_lastPollAt` | context |
| `_lastPrimeAt` | context |
| `_lastRecentKey` | context |
| `_lastTopologyStepAt` | context |
| `_lastViewFetchAt` | context |
| `_launch` | context |
| `_loadRecent` | context |
| `_logTargets` | context |
| `_markPoll` | context |
| `_maxBackoffUntil` | context |
| `_needToken` | context |
| `_noteBytes` | context |
| `_noteRequest` | context |
| `_noteSensitive` | context |
| `_notifiedLastMin` | root |
| `_notifyLog` | root |
| `_notifyQueue` | context |
| `_openPanels` | root |
| `_panelCandidates` | root |
| `_panelOpen` | root |
| `_panels` | root |
| `_paused` | context |
| `_pauseFor` | context |
| `_pending` | context |
| `_perKind` | context |
| `_perKindEntry` | context |
| `_pollDeployments` | context |
| `_pollResources` | context |
| `_pollServers` | context |
| `_pollTopology` | context |
| `_pollVersion` | context |
| `_prime` | context |
| `_probeMode` | context |
| `_projects` | context |
| `_pruneNotify` | context |
| `_queueNotify` | context |
| `_rateLimitRemaining` | context |
| `_ready` | context |
| `_recent` | context |
| `_recentKey` | context |
| `_recentLoaded` | context |
| `_recentPersisted` | context |
| `_recentRejected` | context |
| `_record` | context |
| `_refuse` | context |
| `_rejoin` | context |
| `_reqs` | context |
| `_requestLog` | context |
| `_requestsLastMin` | context |
| `_resetStore` | context |
| `_resolveToken` | context |
| `_resources` | context |
| `_resourcesRaw` | context |
| `_resourcesSec` | context |
| `_saveRecent` | context |
| `_say` | context |
| `_selfHeal` | root |
| `_sensitive` | context |
| `_servers` | context |
| `_serversSec` | context |
| `_servicePicks` | context |
| `_setBuildLogMessage` | context |
| `_setContainerLog` | context |
| `_setContainerLogMessage` | context |
| `_setError` | context |
| `_setHistoryMessage` | context |
| `_setHistoryPage` | context |
| `_setLogTarget` | context |
| `_setPending` | context |
| `_setPick` | context |
| `_stamp` | root |
| `_stat` | root |
| `_stateDirReady` | root |
| `_statPending` | root |
| `_status` | root |
| `_succeeded` | context |
| `_suppressed` | context |
| `_syncBusy` | context |
| `_syncOpenPanels` | root |
| `_tags` | context |
| `_tagsAt` | context |
| `_terminalQueue` | context |
| `_timersOn` | context |
| `_token` | context |
| `_tokenCmdKey` | context |
| `_tokenCmdSeq` | context |
| `_tokenReady` | context |
| `_tokenSource` | context |
| `_topologyFetched` | context |
| `_topologyLoaded` | context |
| `_topologyQueue` | context |
| `_topologySec` | context |
| `_topologyStage2` | context |
| `_topologyStep` | context |
| `_tree` | context |
| `_version` | context |
| `_viewDone` | context |
| `_viewFail` | context |
| `_viewKinds` | context |
| `_viewThrottled` | context |
| `_warning` | context |


## Tests

| case | covers | file | commit |
|---|---|---|---|
| `normaliseConfig`: two instances from the fixture; a single-entry file unchanged; default ids | SR32 | `tests/run.js` | `b157486` |
| `normaliseConfig`: duplicate id, `../x`, `a/b`, `a.b`, a space, 33 chars, `é`, a newline are errors; `a`, `home-lab_2`, 32 chars, `0` pass | SR32 | `tests/run.js` | `b157486` |
| `normaliseConfig`: the same origin twice warns (`instancesWarning`), the notify slot untouched; `configSansNotify` drops it | design | `tests/run.js` | `b157486` |
| `normaliseConfig`: `https://u:p@host` is now an error (the SR19 case updated) | SR33 | `tests/run.js` | `b157486` |
| `errorFor`: exit 60 → `tls` with title and detail; 6/7/28/35 stay `offline`; `barState` and `callout` rows for `tls` | SR36 | `tests/run.js` | `b157486` |
| `Api.block never emits insecure` (depth branch) | SR36 | `tests/run.js` | `7f72e6c` |
| `instanceChips`: none for one instance or an empty/null list; id, bounded label, selected, trouble; the exact key set | chips | `tests/run.js` | `b157486` |
| `instanceTrouble`: the first non-active instance in trouble; never the active one; error title, failed builds, servers; bounded | tooltip | `tests/run.js` | `b157486` |
| `parseRecent`/`serialiseRecent` with an id: a v1 file without id loads for any id; `id` emitted in the head (key order pinned); a mismatch, a missing caller id and an empty id reject; no `logs` key; the key carries the id and ignores `savedAt` | SR26, state files | `tests/run.js` | `b157486` |
| `notifyCopy`: `ctx.instanceLabel` appended to the body, escaped, headline untouched; an otherwise empty body is just the label | notifications | `tests/run.js` | `b157486` |
| `footerHints("hero")` with 1 and 2 instances | chips | `tests/run.js` | `8dd8721` |
| `barState` "all 15 rows", `callout` every kind: `tls` added to both loops | SR36 | `tests/run.js` | `b157486` |

## Verification

| check | command or action | result |
|---|---|---|
| node tests | `node tests/run.js` | 128 passed, 0 failed (127 at step 14; the security fix added one) |
| full check | `bin/check` | `ok` at every step (qmllint clean on the refactored `Service.qml`) |
| CI subset | `bin/check --no-shell` | `ok` |
| acceptance 2 | step 13 (same-account second entry, then a dummy unreachable entry) | passes on every axis the configuration can show: independent polling, baselines, error states, recent files, chips, IPC, tooltip suffix, toast suffix. **Needs human**: a real self-hosted Coolify (plain-http warning, the `tls` kind, the API-disabled path, an older version's 404 note); cross-account isolation (a same-origin pair cannot reveal a bleed); `sensitive` differing per token (a read-only token was not available) |
| rate, one instance after the restart | 12 × 10 s `status \| jq .requestsLastMin`, panel closed | 20 once at t+60 s (startup burst), 17–19 steady (samples below). The skeptic also read a one-off 20 at steady state with one instance: the deployments timer at 4 s plus resources, servers and one topology block is 18 per minute by arithmetic, and timer jitter can put a sixteenth deployments poll inside a 60 s window; the lock's wording now names the startup minute and the depth record's 19 stands as the typical ceiling |
| rate, two instances | 12 × 10 s `[.instances[]\|{id, requestsLastMin}]` + `requestsTotalLastMin`, panel closed | first run: the first three samples still hold the build and the panel-open window from step 12 (28/26, 28/26, 23/23), then 17–19 per instance, 34–38 total. Second run after the review, from a quiet start (75 s after the config edit, no build, no panel): 17–19 per instance and 35–38 total for ten samples; at the eleventh a panel was opened at the keyboard (`openPanels` 1: Dan), which put the two contexts at 20/19 and then 24/24 with the panel closed again, the panel-open prime and first-drain window of both contexts at once (single-instance allowance ≤ 24 during the first drain). `deployments.skipped` 0 on both, both runs (samples below) |
| token leak | not re-run on this branch: the transport, `Api.config` and the log lines are unchanged apart from the `<id>/<kind>` prefix on the per-request line (counts only); the depth record's 209 651-sample result stands for the same code path | — |
| keyboard and mouse | `h`/`l` on the hero, a chip click, the middle-click, a confirm opened then the instance switched then Confirm → "Instance changed; nothing sent" | **needs human** (the service side of the refusal is the `wronginstance` arm of `_refuse`, reached only through the panel's `confirmAction.instanceId`) |
| `deploy` on a uuid the active instance does not know | not distinguishable with two entries on one account | **needs human** with two accounts; the path is `Model.actionRequest` against the active context's snapshot (`unknown uuid`) |
| History on a `read`-only instance → the SR37 sentence, not a spinner (plan step 13) | needs a token without `read:sensitive` | **needs human** (skeptic 4) |
| `d` on api while a `read`-only instance is active → the deploy-ability message and that instance's `error` still null (plan step 13) | needs a token without `deploy` | **needs human** (skeptic 4): the isolation of an ability 403 from `error` is the depth-era `_finishAction` path, unchanged, but unobserved with two contexts |
| the `Same Coolify twice` callout | the two-entry config, step 13 | shown on both instances as the warning callout: title "Same Coolify twice", body `"cloud2" and "cloud" are the same Coolify (app.coolify.io): notifications arrive twice` (after the ux fix; the first run read `instances[1] and instances[0] …`, screenshot `chips-cloud.png`). It is the last warning arm, below `permissions`, `plaintext` and `notify`: a duplicate pair on `http://` shows "Plaintext instance" instead (ops 5, recorded as a limitation) |

## Measurement samples

One instance, 12 × 10 s from the restart at step 11 (`req` = `requestsLastMin`, `tot` = `requestsTotalLastMin`):

```
{"t":1789207297,"req":14,"tot":14,"open":0,"skipped":0}
{"t":1789207307,"req":16,"tot":16,"open":0,"skipped":0}
{"t":1789207317,"req":20,"tot":20,"open":0,"skipped":0}
{"t":1789207327,"req":17,"tot":17,"open":0,"skipped":0}
{"t":1789207337,"req":17,"tot":17,"open":0,"skipped":0}
{"t":1789207347,"req":17,"tot":17,"open":0,"skipped":0}
{"t":1789207370,"req":18,"tot":18,"open":0,"skipped":0,"topo":false}
{"t":1789207380,"req":19,"tot":19,"open":0,"skipped":0,"topo":false}
{"t":1789207390,"req":18,"tot":18,"open":0,"skipped":0,"topo":false}
{"t":1789207400,"req":18,"tot":18,"open":0,"skipped":0,"topo":false}
{"t":1789207410,"req":19,"tot":19,"open":0,"skipped":0,"topo":false}
{"t":1789207420,"req":19,"tot":19,"open":0,"skipped":0,"topo":false}
```

Two instances (`cloud`, `cloud2` on the same account, `notify: false`), 12 × 10 s, panel closed; the first three samples still carry the api build and the panel-open window from step 12:

```
{"t":1789208174,"tot":54,"open":0,"per":[{"id":"cloud","req":28,"skipped":0,"err":null},{"id":"cloud2","req":26,"skipped":0,"err":null}]}
{"t":1789208184,"tot":54,"open":0,"per":[{"id":"cloud","req":28,"skipped":0,"err":null},{"id":"cloud2","req":26,"skipped":0,"err":null}]}
{"t":1789208194,"tot":46,"open":0,"per":[{"id":"cloud","req":23,"skipped":0,"err":null},{"id":"cloud2","req":23,"skipped":0,"err":null}]}
{"t":1789208204,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"err":null},{"id":"cloud2","req":18,"skipped":0,"err":null}]}
{"t":1789208214,"tot":34,"open":0,"per":[{"id":"cloud","req":17,"skipped":0,"err":null},{"id":"cloud2","req":17,"skipped":0,"err":null}]}
{"t":1789208224,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"err":null},{"id":"cloud2","req":18,"skipped":0,"err":null}]}
{"t":1789208234,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"err":null},{"id":"cloud2","req":18,"skipped":0,"err":null}]}
{"t":1789208244,"tot":34,"open":0,"per":[{"id":"cloud","req":17,"skipped":0,"err":null},{"id":"cloud2","req":17,"skipped":0,"err":null}]}
{"t":1789208254,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"err":null},{"id":"cloud2","req":18,"skipped":0,"err":null}]}
{"t":1789208264,"tot":38,"open":0,"per":[{"id":"cloud","req":19,"skipped":0,"err":null},{"id":"cloud2","req":19,"skipped":0,"err":null}]}
{"t":1789208274,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"err":null},{"id":"cloud2","req":18,"skipped":0,"err":null}]}
{"t":1789208284,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"err":null},{"id":"cloud2","req":18,"skipped":0,"err":null}]}
```

The same configuration after the review fixes, from a quiet start; a panel was opened at the keyboard at the eleventh sample:

```
{"t":1789210710,"tot":37,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"dep":0},{"id":"cloud2","req":19,"skipped":0,"dep":0}]}
{"t":1789210720,"tot":37,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"dep":0},{"id":"cloud2","req":19,"skipped":0,"dep":0}]}
{"t":1789210731,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"dep":0},{"id":"cloud2","req":18,"skipped":0,"dep":0}]}
{"t":1789210741,"tot":35,"open":0,"per":[{"id":"cloud","req":17,"skipped":0,"dep":0},{"id":"cloud2","req":18,"skipped":0,"dep":0}]}
{"t":1789210751,"tot":35,"open":0,"per":[{"id":"cloud","req":17,"skipped":0,"dep":0},{"id":"cloud2","req":18,"skipped":0,"dep":0}]}
{"t":1789210761,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"dep":0},{"id":"cloud2","req":18,"skipped":0,"dep":0}]}
{"t":1789210771,"tot":35,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"dep":0},{"id":"cloud2","req":17,"skipped":0,"dep":0}]}
{"t":1789210781,"tot":35,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"dep":0},{"id":"cloud2","req":17,"skipped":0,"dep":0}]}
{"t":1789210791,"tot":36,"open":0,"per":[{"id":"cloud","req":18,"skipped":0,"dep":0},{"id":"cloud2","req":18,"skipped":0,"dep":0}]}
{"t":1789210801,"tot":38,"open":0,"per":[{"id":"cloud","req":19,"skipped":0,"dep":0},{"id":"cloud2","req":19,"skipped":0,"dep":0}]}
{"t":1789210811,"tot":39,"open":1,"per":[{"id":"cloud","req":20,"skipped":0,"dep":0},{"id":"cloud2","req":19,"skipped":0,"dep":0}]}
{"t":1789210821,"tot":48,"open":0,"per":[{"id":"cloud","req":24,"skipped":0,"dep":0},{"id":"cloud2","req":24,"skipped":0,"dep":0}]}
```

## Deviations

| # | step | plan said | done instead | why |
|---|---|---|---|---|
| 1 | 10 | `SAMPLE_CONFIG` gains a commented second entry | one valid-JSON entry; the README shows the two-entry form | JSON has no comments; the callout's sample must paste |
| 2 | 10 | the duplicate-origin warning is `warning` "instances" | its own field `instancesWarning`, mapped to the `instances` warning kind by `_applyConfig` | the `warning` string is the notify warning's slot; two warnings must not race for it |
| 3 | 11 | context properties `inst`, `token` | `_instance`, `_token` (the old names) | the body moved with `git diff -w` readability; the semantics are the plan's (written by `_tokenReady`, read by `_launch`) |
| 5 (4 was dropped in the review: the plan itself puts the reaper driver at the root) | 11, 13 | the Instantiator model is a string id list assigned only on change | a `ListModel` of ids edited in place by `_setInstanceIds` (remove vanished, insert new, move reordered) | a reassigned JS-array model rebuilt every context on any add or remove (seen live: the first instance's `perKind.version.lastAt` changed on adding a second entry); with the in-place model it survived both an add and a remove unchanged |
| 6 | 11 | `_resetStore` clears `_notifyLog` | the per-shell ring is never cleared by a context | the ≤ 12-a-minute budget is the shell's |
| 7 | 12 | `resolveConfirm` closes with a status line and sends nothing when `svc.activeId !== c.instanceId` | the panel passes `c.instanceId` to `act`, and the context refuses with "Instance changed; nothing sent" (`wronginstance`); nothing is sent and, after the review, `lastAction` is untouched (deviation 12) | one path for the panel and any future caller; the status line is the same |
| 8 | 12 | the tooltip suffix built in `BarWidget.qml` | built in the service's `bar` (`Model.instanceTrouble`) and exposed as `status.bar.tooltip` | both monitors and `status` agree; the widget stays a renderer |
| 9 | 13 | a read-only second token (`sensitive` yes vs no) | the same token twice, then a dummy unreachable entry | no read-only token existed during the build; needs-human |
| 10 | 13 | `pgrep -a curl` empty 10 s after the removal | `pgrep -c curl` sampled five times over 10 s, all 0 | the same fact sampled repeatedly instead of once; `-a` would only add argv, which is the same `-q -S -K -` for every curl |
| 11 | 11, review | `_halt()` for both the unsafe mode and a released context | `_suspend()` for the unsafe mode (stop polling, kill requests, keep the store and the token, re-resolve once repaired, as before Phase 4) and `_halt()` (suspend + reset + drop the token) for a release | the first cut wiped the store behind the "Config unsafe" callout and refused actions as "not configured" (code 2) |
| 12 | 12, review | `resolveConfirm` leaves `lastAction` unchanged on a cross-instance refusal (plan step 12 verify) | `_refuse("wronginstance")` skips the `lastAction` write, so the plan's line holds through the delegated path (deviation 7) | the first cut wrote a refused `lastAction` on the new instance (ux 4, skeptic 1) |
| 13 | 11, review | the per-request log line carries `<id>/<kind>` | the failure, view-failure and reaper lines carry it too; `notify`, `recent`, `drain`, `logview` and `action` lines do not (the documented greps for those are unanchored on `coolwatch <word> `) | a failure could not be attributed to an instance in the log (skeptic 9, ux 7) |

## Review

Panel model `opus`; the three always-on reviewers plus the four situational analysts, spawned fresh against `e1a3225` (they read the plan and this record from disk). Findings and their disposition; the fix commits are `feda449` (security), `83ca23f` (data), `4fef763` (ops and ux) and `94c99ad` (code, perf and skeptic); the signer refused again between 11:44 and 12:03 and those two went in once it answered. The re-check round added `130b4f3` (the per-instance rate allowance, ops), `2e96af0` (`_suspend` settles killed requests, code), `dfd64e5` (`id` in the empty status, ux) and `d93db7e` (the jitter and panel-close sentence in the lock, skeptic).

| member | model | critical | warning | nit | fixed | deferred (reason) |
|---|---|---|---|---|---|---|
| security-analyst | opus | 0 | 3 | 0 | 3 (`feda449`: the permissions warning is file-wide; `recentPath` is empty for an unknown id and `_instanceIds` is assigned before the model edit; the store key is `Model.instanceKey`, a token fingerprint, never the token) | — |
| code-reviewer | opus | 0 | 3 | 1 | 3 (`_armRecent` clears `_lastRecentKey` on a path change; `_suspend()` keeps the store on an unsafe config and `act` answers `config unsafe` from the root's error; the inventory row and the commit-contents note corrected) | 1 nit: inactive contexts pay the panel-open cadence (noted) |
| skeptic | opus | 0 | 5 | 4 | 5 warnings (the cross-instance refusal leaves `lastAction` untouched; the step 11 comparison re-run against the current tree; the two-instance loop re-run from a quiet start and the lock wording reconciled; the two dropped step 13 verify lines added as needs-human; `recentPath`/ordering fixed in `feda449`); 3 nits (deviations 4 and 11 dropped, 10 reworded; the signer window end corrected; the failure and reaper log lines carry the id) | 1 nit partly: `notify`/`drain`/`logview`/`action` lines stay unprefixed (the documented greps are unanchored on them) |
| data-analyst | opus | 0 | 4 | 1 | 5 (`83ca23f`: an id-less recent file is accepted only by the first instance; `_emptyStatus` carries the full key set; two URLs `origin()` cannot key never match; `_rebuildCtxs` after a reorder; the ordering fix shared with security 2) | — |
| ux-api-designer | opus | 0 | 3 | 4 | 3 warnings (a switch while a panel is open acknowledges and kicks the new instance; the `ability` kind reads "token lacks an ability"; the architecture IPC bullet); 2 nits (the refusal no longer writes `lastAction`; the same-origin warning names ids) | 2 nits: chip overflow at ≥ 3 instances, unprefixed notify lines (noted) |
| ops-analyst | opus | 0 | 4 | 1 | 4 (both documented greps match the prefixed lines and allow capitals; architecture.md carries the per-instance ring, `requestsTotalLastMin`, the schedule cost, the IPC verbs and `lastAction.instance`; the rate lock names the startup burst; the ordering fix); 1 nit: the callout text recorded above with its precedence | — |
| perf-analyst | opus | 0 | 2 | 4 | 2 warnings (`_rebuildCtxs` on a reorder, in `83ca23f`; the lock wording and the quiet re-measurement); 3 nits (`_status()` serialises each context once; the context's standing `bar` binding replaced by an on-demand call; a switch runs `_panelOpened()`) | 1 nit: the panel-open cadence for inactive contexts (noted) |

Re-checks (one round; the code-reviewer took a second on its one new item): security 3/3 resolved; data 5/5; ops 4/4 plus one nit (the per-instance sentence lacked the panel-open allowance → `130b4f3`); ux 7/7 plus one comment nit (`id` in the empty status → `dfd64e5`); perf 6/6; skeptic 8/9 plus one nit (the lock still forbade a settled 20 and the post-panel 24 → `d93db7e`); code-reviewer 3/4 with one new warning (`_suspend`'s kill loop left `_inflightAction` and a drain in flight unsettled → `2e96af0`, then resolved). Nothing is open.

## Noticed, not done

- The panel-open cadences (`resourcesSec` 30, topology one block per 10 s on the first drain) apply to every context, not only the one on screen, because the panel registry is the root's (code 4, perf 4); per token it is the measured single-instance panel-open case, and the quiet two-instance run above shows both contexts at 24 once a panel had opened.
- With three or more instances the chip labels (24 characters) can overpaint their equal-width cells; the shell `Button` neither elides nor clips (ux 6). Two instances fit.
- The `notify`, `recent`, `drain`, `logview` and `action` log lines carry no instance id, so two contexts' toasts cannot be told apart in the log (ux 7); `status.instances[].notify` can.
- `Model.barState`'s "Deploying <app>" tooltip uses the raw `appName` (`xyhpwdxqu33omjgwuo6c7cjp-200537415987`), not `appLabel`, so an unnamed app's tooltip is the decorated string; pre-existing since Phase 1.
- The `git diff` of `Service.qml` is dominated by the two-space re-indent of the context body; `git diff -w` shows the moves.
- A removed instance's `recent-<id>.json` is left in place by design (documented); the test instance's file was removed by hand.
- The step 12 screenshots (`chips-cloud.png`, `chips-cloud2.png`) live in the session scratchpad, not the repo; grim's own "Screenshot saved" toasts landed in Dan's notification history (four of them).

## PR body

```
Phase 4 instances: one context per Coolify, chips, per-instance state

Service.qml gains an inline InstanceCtx: every store, timer, request, ledger, baseline,
pending map, notify state and recent file is per configured instance; the root keeps the
config file, the panel registry, the per-shell toast budget and the reaper, and mirrors
the active instance as snapshot/bar/views/pending so every panel and documented command
keeps working with one entry. Chips under the hero, h/l on the hero, middle-click on the
icon and `omarchy-shell … instance <id>` switch; the bar follows the current instance and
its tooltip names another's trouble; toast bodies name the instance; instances[0] keeps
recent.json and every further instance writes recent-<id>.json (files carry id). Config
rules: ids are one path segment and unique, a URL with credentials is an error, the same
origin twice is a warning. curl exit 60 is the named `tls` kind.

On top of phase-4-depth (2f2c4c2). Merge the hotfix, depth, then this.

Plan: docs/plans/phase-4-depth.md (steps 10–14)
Verification: 128 node tests, bin/check green at every step, a live two-entry config
(independent polling 17–19/min each, an auth failure isolated to one context, per-instance
recent files, add/remove without resetting the other), a dummy unreachable entry, toast
suffix verified
Needs human: a real self-hosted Coolify (tls, API-disabled, older-version 404), a read-only
second token (sensitive per token), cross-account isolation, the keyboard and mouse switch
paths and the confirm refused across a switch
```
