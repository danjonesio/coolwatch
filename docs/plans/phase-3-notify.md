# Coolwatch Phase 3 — "notify" (change detection, toasts, toggles, recent.json)

Repo `/home/danjones/Projects/coolwatch`, base `master` at `b38379c`, branch `phase-3-notify`. Dan merges. Build with `/deej-stack:d-implement`.

## Context

Phases 1 and 2 poll Coolify and act on it; nothing tells the operator anything while the panel is closed. `docs/roadmap.md` Phase 3 turns the existing store into events: one desktop toast per real transition (deployment queued / building / deployed / failed / cancelled; a resource that stopped or degraded outside of a deployment or a user action; a server that became unreachable or reachable again), none on the baseline poll, none twice, per-event toggles under `notify{}` in the config file, click-to-open on every toast that has a Coolify page, and recent terminal deployments persisted to `~/.local/state/coolwatch/recent.json` so the panel's Recent section survives `omarchy restart shell`.

The panel found the docs are not buildable as written on four points, each with evidence in Findings: a plugin-id sender at `-u critical` is **silenced** under Do Not Disturb by the shell (`NotificationLogic.js:118-122`), so the AGENTS.md lock "critical bypasses DND" is false for the `--app-name` the same lock requires; `bin/check`'s SR9 gate fails the build the moment a notification argv contains `omarchy-launch-browser`; `_recent` is reassigned on every poll (`Service.qml:499`) and emptied by every config change (`:256`), so any writer bound to it is a write storm that truncates the file; and `omarchy-notification-send` keeps parsing options after the headline, so a Coolify commit message of `--app-name=omarchy-action` sets the sender name (demonstrated live against a shadowed `busctl`). This plan fixes each and reconciles the docs.

**Outcome.** After a `d` on api with the panel closed, up to three toasts arrive: "Queued <app>", "Building <app>", "Deployed <app> · 1m 42s · main" (or "Deployment failed: <app>" at critical), where `<app>` is the display name `Model.appLabel` derives from Coolify's decorated `application_name` (api's is `xyhpwdxqu33omjgwuo6c7cjp-200537415987`, so its label is that string elided; a git-sourced app such as `storefront:main-h0wx…` reads `storefront`). Each toast opens the deployment page in Coolify on click. A container stopped from the Coolify UI produces "<app> stopped · web-1 · exited" once, within 0–120 s, and "<app> running" once when it comes back. A restart or redeploy produces nothing but its own deployment toasts. `omarchy restart shell` mid-build replays nothing and still yields exactly one terminal toast. Flipping `notify.deploymentQueued` to false in the config file takes effect on the next poll with no store reset. After a restart, terminal deployments younger than `RECENT_MAX_AGE_MS` (1 h, open question 3) are back in the Recent section before the first poll answers; older ones stay in the file as the dedupe ledger. `bin/check` is green with new gates, and the idle request budget is unchanged.

## Brief

**Ask (user's words):** "phase 3 opus 5 sub agents".

**Assumptions (stated, not asked):**
- Single instance (`instances[0]`), as in Phases 1 and 2.
- `recent.json` holds the in-memory `recent` list (cap 20) and nothing else. The tracked active set is **not** persisted (rejected alternative below). A deployment that finishes while the shell is down is never toasted; it appears in Recent at the next fetch.
- "Outside of a user action" = no `_pending` entry for the uuid, no action on it within 180 s (`_actionAt`), no active or recently finished (120 s) deployment for its application, and its server not unreachable. A `restart_only` deployment is a deployment.
- Click targets: deployment toast → deployment page; resource toast → resource page (only once topology has loaded, when `openUrl` can build it); server toast → server page; `Model.openUrl` returning `""` → no `--exec` at all.
- State dir `$XDG_STATE_HOME/coolwatch` (fallback `~/.local/state/coolwatch`) created and chmod'ed `0700` by the service before the first write; the file is umask-mode (FileView has no mode API); it holds names, branches, commit messages and the instance URL, never a token.
- No UI for the toggles; config file only. A `notify`-only config edit applies live with no `_resetStore`. A malformed `notify` value warns (panel callout) and falls back to its default; it never stops polling.
- DND: the hybrid (open question 1's default, to be answered before Change 3): the plugin id for every toast, except a critical event while DND is on, which is sent as `omarchy-action` so it is shown. The deviation and the security-analyst's dissent are recorded.

**Out of scope:** Phase 4 (logs, history, chips, tag deploy, `read:sensitive`), Phase 5, webhooks, notification action buttons beyond click-to-open, a panel UI for notify settings, controlling DND from the plugin, sounds, persisting the tracked active set or `_failedUnacked`, health-only transitions (`running:healthy → running:unhealthy`, open question 2), changing `RECENT_MAX_AGE_MS` (open question 3), a compensating poll, a new endpoint, a new shipped file, `-r`/`-p` toast replacement (a detached process cannot return the printed id), a CI workflow, editing `/usr/share/omarchy`.

## Findings from exploration

Verified by the panel against `b38379c`, `/usr/share/omarchy/shell`, Quickshell 0.3.1 and live runs of `omarchy-notification-send`.

- **Every diff already has its previous value in hand.** In `_dispatch` (`Service.qml:421-479`) each arm assigns the store after it could read the old value, and `_markPoll(kind)` (`:481-487`) runs after that; so at diff time `root._baseline[kind] === false` means "first successful poll of this kind". `diffActive` (`Model.js:460`) already exploits this. No `_tracked*` mirrors are needed.
- **`_baselineDone` is the wrong gate.** It latches only when all four of `deployments/resources/servers/version` have polled (`:484-486`). A self-hosted `/version` that never succeeds would silence every notification forever. `_baseline[kind]` is per kind and already exists (`:57`).
- **`diff.vanished` is empty on a baseline poll** (`prevUuids` is `[]`), so `_terminalQueue` only fills after the baseline and the `deployment` arm needs no gate of its own.
- **The raw store lists are unjoined.** `normaliseResources` (`Model.js:312-336`) sets `serverUuid`, `projectUuid`, `environmentName` to null and never sets `environmentUuid`; only `applyJoins` (`:407-427`) writes them, into `_resources`, never `_resourcesRaw`. `normaliseDeployment` (`:337-359`) sets `branch: null`, `appUuid: null`; only `joinBranch` (`:429-443`) fills them. `openUrl("resource", …)` requires `projectUuid && environmentUuid && uuid` (`:679-682`). `_finish` runs `_rejoin()`/`_joinDeployments()` **after** `_dispatch` (`Service.qml:412-414`), so the joined lists exist at the end of `_finish`, which is where the flush runs. An event built from the raw list must therefore be re-resolved against the joined snapshot at flush time or it never gets a URL, a server name or a server correlation.
- **`_recent` is reassigned 15–30 times a minute.** `_finish` calls `_joinDeployments()` for every deployments block (`:414`) and `_rejoin()` for resources/servers/topology (`:494`); both do `root._recent = Model.joinBranch(root._recent, root._resources)` (`:499`), and `joinBranch` maps to fresh objects unconditionally. `_resetStore()` (`:254-271`) sets `_recent = []` on startup (`_configText:230`, `_cfg` null) and on every differing config text. A writer bound to `_recent` would write per poll and truncate the file at every start and every config edit.
- **The terminal record is unjoined at dispatch time.** `_finish` joins for `p.kind === "deployments"` only (`:413-414`); the `deployment` arm (`:444-455`) unshifts a record with `branch === null`, `appUuid === null` until the next deployments poll.
- **`_drainTerminal` drops the uuid before launching** (`:542-550`, `q.shift()` then `_launch`). Four paths lose it for good: an empty curl stream (`:393` → `_fail` → next uuid), a per-block non-404 error such as 429/500/502 (`:405`, `_fail`, no `_dispatch`), a 404 (`:405`, skips both), a reap (`:888`). `pauseTimer` (`:856`) resumes the drain after a 429 but the uuid is no longer queued. In Phase 2 that cost a Recent row; in Phase 3 it is the only source of the Deployed/Failed toast.
- **`p.arg` is the request pipeline's.** `_launch` sets `p.arg = list` (the Api descriptor array, `:378`) and feeds it to `Api.config`; `_finish` bounds its loop with `p.arg.length` (`:400`) and calls `_dispatch(p.arg[i], …)` (`:408`), which switches on `req.kind`. `Api.reqDeployment(uuid)` carries the uuid as `descriptor.arg` (`Api.js:79`). The `Req` component (`Service.qml:335-359`) already holds per-request properties; `_inflightAction` (`:640-644`) is the existing "in-flight descriptor held off `p.arg`" idiom.
- **`_expirePending` drops a service/database restart on the first resources poll after the action** (`:770-772`), before the container has necessarily flapped; `_pending` alone cannot explain a user action for the resource diff. `_expirePending` runs on the 5 s reaper only (`:894`) and early-returns on an empty map (`:743-744`).
- **A dead server flips every resource on it in one `/resources` poll.** `unreachableServers` (`Model.js:475`) and `serverUuid` from `applyJoins` (`:424`) give the correlation at flush time.
- **`Util.execArgv` costs ≈115 ms per call**: `bash -lc` (login shell, `~/.bash_profile` sourced) 109 ms, `omarchy-notification-send` 2 ms, `jq -Rsc` 2.5 ms, `busctl` 3 ms (measured on this machine). Detached, so the QML thread is not blocked, but N toasts are N concurrent login shells.
- **DND:** `/usr/share/omarchy/shell/plugins/notifications/NotificationLogic.js:118-122` `shouldBypassDnd` returns true only for `appName === "omarchy-action"` (the `notify-send` arm is dead: `Service.qml:173` calls it with one argument). `plugins/notifications/Service.qml:173-181`: everything else under DND goes to `writeSilenced` and returns. `isEphemeral` (`:148-153`) is consulted only inside that silenced branch, so a *shown* `omarchy-action` toast is archived to history normally (`:145`, `:528-556`) with `app: "omarchy-action"`; `docs/omarchy-shell-reference.md:791-793` says ephemeral apps are never written to history and is wrong. The shell's comment at `Service.qml:170-172` says the rule exists because "chat apps abuse urgency=critical". `omarchy-action` has exactly three consumers in the shell (`NotificationLogic.js:120`, `:126`, `Service.qml:687`); nothing else keys off the name. DND is readable from the service: `Service.qml:12` already declares `property var shell: null`, `shell.qml:306` injects it, and `shell.serviceFor("omarchy.notifications").doNotDisturb` (`plugins/notifications/Service.qml:80`) is a readonly alias. `omarchy-shell notifications dndState` prints `on`/`off`; `toggleDnd` flips it. Live popups exist as JSON files directly in `~/.local/state/omarchy/notifications/` for as long as they are on screen (`plugins/notifications/Service.qml:28-31`); history keeps the newest 10 across all apps (`historyLimit: 10`, `:96`), files at 0644 with `summary`, `body`, `app`, `execArgv`.
- **`omarchy-notification-send` parses options before and after the headline** (`:85-98`, `known_flag` `:100-115`, `parse_omarchy_option` accepts `--flag=value` `:29-33`). Demonstrated with `busctl` shadowed: description `--app-name=omarchy-action` → the Notify call carried app name `omarchy-action`; `--image=file:///etc/passwd` → `image-path` hint set (the shell then copies that file into `~/.local/state/omarchy/notifications/images/`, `NotificationLogic.js:319-351`); headline `--urgency=critical api stopped` → `exit 1`, no toast. `--exec` is safe: detected only after both positionals (`:117-129`), NUL-encoded via `jq -Rsc` (`:180`), and swallows the rest of argv. `--exec omarchy-launch-browser ""` is accepted by both sides and launches a browser with an empty argument. An empty *program* exits 1 and kills the toast.
- **Toast rendering:** summary `Text.PlainText` (`NotificationCard.qml:161`), `WordWrap` + `ElideRight` + `maximumLineCount: 2`, text box 304 px at `Style.space(380)` (`:66,101-113`); body `Text.StyledText` with hyperlinks enabled (`:183`, `plugins/notifications/Service.qml:936-937`), only `<img>` stripped (`NotificationLogic.js:55-90`). Critical urgency never expires (`durationFor` `:102-105`) and persisted popups are replayed on shell start (`:840-852`). Empty description → `singleLineToast` compact layout (`NotificationCard.qml:40,105-107`). The glyph renders in `shell.bar.fontFamily` (`plugins/notifications/Service.qml:1052`).
- **Real names are decorated.** `application_name` and `resources[].name` are `storefront:main-h0wxyg40kc0lz727dom9l03i` (44 chars) for git-sourced apps, `worker` for a plain one, `xyhpwdxqu33omjgwuo6c7cjp-200537415987` for api (`tests/fixtures/resources.json`, `deployments-active.json`). `Deployment failed: storefront:main-h0wx…` measures 459 px in Liberation Sans Bold 14 against a 304 px box, and `WordWrap` cannot break inside the token. `normaliseDeployment` defaults `appName` to `""` (`Model.js:343`); every other name path falls back to the uuid (`:293`, `:321`, `:697`). `server_name` and `commit_message` are present on the active `/deployments` list.
- **`Model.origin` accepts userinfo** (`Model.js:665-670`: `https://u:p@host` passes) and `openUrl`'s output never passes `redact`. Today that is transient argv; Phase 3 writes it into the shell's history files. `normaliseConfig`'s url check (`:65`) also accepts it; making that a config error would turn a working install into `configerror` on upgrade (`Service.qml:243-247`, `_cfg = null`, no polling).
- **FileView (Quickshell 0.3.1, `/usr/lib/qt6/qml/Quickshell/Io/quickshell-io.qmltypes:343-508`):** `atomicWrites`, `watchChanges`, `printErrors`, `setText`, signals `loaded`/`loadFailed`/`saved`/`saveFailed`, `waitForJob()` (undocumented). No file-mode and no size property; atomic write is temp + rename, so a `chmod` on the target does not survive. `strings /usr/bin/quickshell` shows `QDir::mkpath` and "Could not create parent directories of file.", so the write path may create the directory at an unspecified mode, and `mkdir -m 700 -p` on an *existing* directory changes nothing. `onLoaded` can fire more than once at startup (`plugins/notifications/Service.qml:812-818`); without an `onLoadFailed` branch a missing file is never created (`:786-790`). `Component.onDestruction` (`Service.qml:901-910`) flushes nothing. First-party shapes: `plugins/agents/Main.qml:348-354,403-412` write-only `FileView { atomicWrites: true; watchChanges: false; printErrors: false }` written only after a `mkdir -p` Process `onExited`; `plugins/notifications/Service.qml:781-840` adds a `settingsLoaded` guard and runs `ensureDirsProc` then `Qt.callLater` before touching the file.
- **`~/.local/state/coolwatch/` does not exist.** `mkdirProc` (`Service.qml:176-184`) runs `mkdir -m 700 -p <configDir>` at `Component.onCompleted` (`:899`) and from `_selfHeal()`; its `onExited` ignores the exit code and starts `statProc` via `Qt.callLater`. `_tokenReady` (`:321`) is downstream of `_applyStat` ← `statProc` ← `mkdirProc.onExited`, but for a `tokenCommand` it waits on a subprocess (`timeout -k 2 30`, `:312`) that can take seconds. `_instance` is assigned in `_configText` (`:246-247`) before `_stat()`. `XDG_STATE_HOME` is `/home/danjones/.local/state` here; `plugins/agents/Main.qml:16` uses `Quickshell.env("XDG_STATE_HOME") || HOME + "/.local/state"`.
- **Config:** `_configText` (`:223-252`) short-circuits only when the re-normalised config is byte-identical to `_cfg` (`:228`, and that early return leaves `_acceptStamp`, `_needToken`, `_ready` untouched so `_tokenReady` does not re-fire), else `_resetStore()`. `notify{}` is not read anywhere today. `poll` validation (`Model.js:85-96`) hard-fails the config on a wrong type; `pollDefaults()` (`:98`). `_warning` (`Service.qml:38`, kinds `plaintext`/`permissions`, `:294-296`) is the existing non-fatal channel and renders as a callout while polling continues.
- **Panel:** `RECENT_MAX_AGE_MS = 1 h` (`Model.js:36`); `panelRows` keeps a recent entry when its `finishedAt || updatedAt` is unparseable **or** under an hour old (`:908-911`). `deploymentRow.sub` is `[d.branch, d.commitMessage].filter(Boolean).join(" · ")` (`:697`). `elapsed(iso, nowMs)` (`:1023`) falls back to `Date.now()` when `nowMs` is falsy or NaN (`:1026`), so the caller must guard an unparseable `finishedAt`. `deploymentGlyph` (`:623`) returns the five design-table glyphs; `G.half` (`0xF1396`) is the degraded dot. All in JetBrainsMono Nerd Font (Phase 1 check).
- **`bin/check` SR9** (`:33-37`) scans `"$root"/*.qml` only (comments stripped with `sed 's#//.*##'`), requires every `omarchy-launch-browser` line to be `Util.execArgv(["omarchy-launch-browser", <one identifier>])`, floor ≥ 1; `:38` bans `fqdn` in QML; `Model.js` is not scanned; `root` is hard-coded at `:4`.
- **Tests/fixtures:** 69 tests; `diffActive` test at `tests/run.js:449`; `normaliseConfig` tests at `:298,310`; `loadedSnap()` (`:68-79`) builds a fully joined snapshot from the fixtures; no cancelled-deployment fixture; `fx()` `JSON.parse`s, `fixture()` returns raw text (`:25-28`).
- **Ship list** (`bin/dev-sync:24-27,34`) and `tests/run.js:13-23`: a new `.js` file would neither ship nor be tested, and `Model.js` is `.pragma library` (`Model.js:1`), which cannot import another JS library, so a separate `Notify.js` could not reach `redact`, `elide`, `origin`, `openUrl`, `elapsed` or `G`. `Service.qml` does not import `qs.Commons` (`:1-5`); first-party services do (`plugins/notifications/Service.qml:9`, `plugins/lock/Service.qml`).
- **`_status()`** (`:913-946`) exposes `baselineDone`, `terminalQueue`, `counts.recent`, `pending`, `pendingStale`, `perKind`, `requestsLastMin`, `topologyLoaded`; per-reason breakdowns are its convention. `_actionLog` (`:85`, written at `:643` as filter-push-reassign, read by `_actionsLastMin` `:617`) is the bare-timestamp idiom; `_requestLog` (`:607-609`) the same.
- **Budget:** deploying steady state ≈ 37.5/min; a full 20-uuid drain in one window ≈ 57/min, three under the 60 line; `_fail("deployment")` sets a kind-wide 30 s then 60 s backoff (`:579-581`) that `_drainTerminal` honours (`:544`), so retries serialise and cannot burst. The 20 cap on `_terminalQueue` (`:435`) is load-bearing. Resource-stop latency is honestly 0–120 s (Coolify sweep ≤ 60 s + resources interval 60 s closed / 30 s open / 15 s deploying); AGENTS.md bars a compensating poll.
- **Phase 2 record:** api deployments lived ~10–20 s (`docs/plans/phase-2-act.build.md:81`); `omarchy restart shell` can outlast that, so a restart-mid-deploy test needs a precondition read; mouse paths were needs-human (`wtype` has no pointer, `:34,140`); the queued-cancel outcome is open (`:86`).
- Prerequisites present: `/usr/bin/busctl`, `/usr/bin/jq`, `/usr/share/omarchy/bin/omarchy-notification-send`, `omarchy-launch-browser`. DND currently `off`. Rollback target `b38379c`.

## Design

### Caller's usage first

Nothing in `Panel.qml` or `BarWidget.qml` changes. The call sites are inside the service:

```qml
// Service.qml, _dispatch "deployments" arm — root._deployments still holds the previous poll
var first = !root._baseline.deployments
var diff = Model.diffDeployments(root._deployments, norm, first)     // { vanished: [uuid], events: [event] }
/* existing _terminalQueue push from diff.vanished (bare uuids, dedupe, cap 20), store writes, _markPoll */
root._queueNotify(diff.events)                                        // [] when first

// Service.qml, _dispatch "deployment" arm (terminal drain result), inside the existing `if (d.uuid)`
var d = Model.joinBranch([Model.normaliseDeployment(r.value)], root._resources)[0]
delete root._drainTries[d.uuid]
if (!Model.hasTerminal(root._recent, d.uuid)) root._queueNotify([Model.terminalEvent(d)])   // null for a non-terminal status is filtered
/* existing dedupe + unshift + slice(0, 20); then */ root._saveRecent()

// Service.qml, _dispatch "resources" arm — root._resourcesRaw still holds the previous poll
root._queueNotify(Model.resourceEvents(root._resourcesRaw, next, !root._baseline.resources))

// Service.qml, _dispatch "servers" arm
root._queueNotify(Model.serverEvents(root._servers, next, !root._baseline.servers))

// Service.qml, _finish: the last statement, after _rejoin()/_joinDeployments(), on every path that dispatched
root._flushNotify()
```

The one emitter, the only new process spawn in the plugin:

```qml
function _queueNotify(evs) { root._notifyQueue = root._notifyQueue.concat((evs || []).filter(Boolean)) }

function _flushNotify() {
  var q = root._notifyQueue; if (!q.length) return
  root._notifyQueue = []
  var now = Date.now()
  var log = root._notifyLog.filter(function (t) { return now - t < 60000 })          // the :643 idiom
  var ctx = { notify: root._cfg ? root._cfg.notify : Model.notifyDefaults(),
              origin: root._instance ? Model.origin(root._instance.url) : "",
              dnd: root._dnd(), pending: root._pending, actionAt: root._actionAt,
              lastNotified: root._lastNotified, sentLastMin: log.length, now: now, pluginId: root.pluginId }
  var out = Model.notifyPlan(q, root.snapshot, ctx)   // { argvs, log, suppressed: {rule: n}, notified: [{key, at}], lastKind }
  out.notified.forEach(function (n) { root._lastNotified[n.key] = n.at }); root._lastNotified = root._lastNotified
  out.log.forEach(function (l) { console.log("coolwatch notify " + l) })              // "<event> <uuid8>" only, at intent
  for (var i = 0; i < out.argvs.length; i++) { Util.execArgv(out.argvs[i]); log.push(now) }
  root._notifyLog = log
  for (var k in out.suppressed) root._suppressed[k] = (root._suppressed[k] || 0) + out.suppressed[k]
  root._suppressed = root._suppressed
  if (out.argvs.length) root._lastEvent = { kind: out.lastKind, at: now }
}
function _dnd() {                                     // true | false | null (notifications service unreachable)
  var n = root.shell && root.shell.serviceFor ? root.shell.serviceFor("omarchy.notifications") : null
  if (!n || typeof n.doNotDisturb !== "boolean") return null
  return n.doNotDisturb
}
```

Config (`docs/architecture.md:66-74`, unchanged shape), read with a fallback everywhere:

```json
"notify": { "deploymentQueued": true, "deploymentStarted": true, "deploymentFinished": true,
            "deploymentFailed": true, "resourceStateChanged": true, "serverReachability": true }
```

`"notify": false` → all six false; `true`, `null`, absent → all defaults; any other non-object, or a non-boolean key value → that key (or the block) takes its default **and** `normaliseConfig` returns `warning: "notify.<k> must be a boolean"` (or `"notify must be an object or a boolean"`), which the service surfaces through the existing `_warning` callout; polling continues. Unknown keys are ignored. A `notify`-only edit applies live (no reset).

```sh
omarchy-shell io.github.danjonesio.coolwatch status | jq '{notify, baseline, recentPersisted, recentRejected, terminalQueue, drainRetries}'
quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E '^coolwatch (notify|recent|drain)'   # "coolwatch notify finished vdyasty4"
```

### Data shapes

New service state (plain `_`-properties; **none in `snapshot`**, the `_pending` precedent at `Service.qml:91`):

```
_notifyQueue    : [event]              // drained at the end of every _finish
_actionAt       : { uuid: ms }         // written by _setPending (resource uuid; deployment uuid for cancel); pruned > 300 s on the reaper
_lastNotified   : { "<kind>:<uuid>:<event>": ms }   // dedupe for every kind; pruned > 3600 s on the reaper; mutate-then-self-assign
_notifyLog      : [ms]                 // bare timestamps; filter-push-reassign (:643); cleared in _resetStore
_suppressed     : { toggle, selfCancel, pending, actionWindow, activeDeployment, postDeployGrace, serverDown, cooldown, resourceCap, minuteCap }  // cumulative; cleared in _resetStore
_lastEvent      : null | { kind, at }
_drainTries     : { uuid: n }          // terminal-fetch attempts; deleted on success, 404 or give-up
_drainRetries   : int                  // cumulative, for status
_stateDirReady  : bool                 // set in mkdirProc.onExited
_recentLoaded   : bool                 // arms _saveRecent; false until the FileView reported loaded or loadFailed
_recentKey      : string               // Model.origin(instance.url) the loaded file was checked against; "" = never arm
_lastRecentKey  : string               // stamp-free guard key of the last write
_recentPersisted: int                  // entries accepted from the file at the last load
_recentRejected : bool                 // the file existed and was rejected
```

`deploymentReq` gains `property var inflight: null` (`{ uuid }` of the terminal fetch in flight; the `tokenCmd { property int seq; property string key }` precedent at `Service.qml:197-199`). `_terminalQueue` keeps its bare-uuid element shape, its dedupe and its cap 20.

Event (built in `Model.js`; `obj` is the diff-time value and is used for **state fields only**; `notifyPlan` re-resolves the render object by uuid from the joined snapshot):

```
{ kind: "deployment" | "resource" | "server",
  event: "queued" | "started" | "restarting" | "finished" | "restarted" | "failed" | "cancelled"
       | "stopped" | "degraded" | "recovered" | "unreachable" | "reachable",
  uuid: string, obj: <normalised deployment | resource | server at event time> }
```

`recent.json` at `<stateDir>/recent.json` (`stateDir = (XDG_STATE_HOME || HOME + "/.local/state") + "/coolwatch"`):

```json
{ "version": 1, "instance": "https://app.coolify.io", "savedAt": 1757000000000,
  "recent": [ { "uuid": "…", "appId": "…", "appName": "…", "serverName": "…", "status": "finished",
                "commit": "…", "commitMessage": "…", "createdAt": "…", "updatedAt": "…", "finishedAt": "…",
                "url": "/project/…/deployment/…", "restartOnly": false, "force": false, "isApi": false, "isWebhook": false } ] }
```

Field whitelist only: every string passes `redact` + `elide` on the way out; `branch` and `appUuid` are join products, recomputed by `joinBranch` after load, never trusted from disk; `url` stays the relative `deployment_url` and passes `openUrl`'s validation on every use. Max 20 entries; an entry with no parseable `finishedAt`/`updatedAt`, or older than 24 h, or with a `status` outside `Model.TERMINAL`, or without a uuid matching `UUID_RE`, is dropped at load. Raw text over 262 144 bytes is rejected before `JSON.parse` (this bounds what is parsed and stored; FileView reads the whole file first and has no size limit). An empty instance key never matches and never writes. `_failedUnacked` is **not** persisted (a lost clear-write would leave a permanently red bar).

### Module map

| path | status | owns |
|---|---|---|
| `Model.js` | edit | `NOTIFY_DEFAULTS`/`notifyDefaults()` + `normaliseConfig` `notify` handling (`warning`, never `error`); `configSansNotify`; `origin` rejects userinfo; `diffDeployments` (wraps `diffActive`); `terminalEvent`; `hasTerminal`; `resourceEvents`; `serverEvents`; `appLabel`; `notifySafe`; `notifyBody`; `notifyCopy` (the copy table); `notifyPlan` (indexes, per-event drops, ordering, caps, argv, log lines, per-rule suppressed counts); `parseRecent`/`serialiseRecent`/`mergeRecent`; `uuid8` |
| `Service.qml` | edit | `import qs.Commons`; `pluginId`, `stateDirPath`, `recentPath`; `mkdirProc` command creates and chmods the state dir and sets `_stateDirReady`; `recentFile` FileView + `_armRecent`/`_loadRecent`/`_saveRecent`; `_configText` live-apply for notify-only edits and the `notify` warning; the four `_dispatch` hooks; `_queueNotify`/`_flushNotify`/`_dnd`; `_actionAt` in `_setPending`; `deploymentReq.inflight` + `_drainTries` + one re-queue helper called from `_finish` and the reaper; reaper prunes; `_resetStore` additions; `_status()` fields |
| `bin/check` | edit | `root=${COOLWATCH_ROOT:-…}` override; SR16 gates over `Model.js` (launcher and notifier shape, rollback-safe) and the notifier ban in QML; SR9 QML gate untouched |
| `tests/run.js`, `tests/fixtures/deployment-cancelled.json`, `tests/fixtures/state-recent.json`, `tests/fixtures/state-recent-corrupt.txt` | edit/new | tests below; the cancelled fixture is recorded from the Phase 2 cancel uuid if it still resolves, else hand-derived with `_note` |
| `manifest.json` | edit | `version: "0.3.0"` |
| `AGENTS.md`, `README.md`, `docs/{product,architecture,design,roadmap,omarchy-shell-reference}.md`, `docs/plans/phase-2-act.build.md` | edit | reconciled in Change 9 |

No new QML or JS file. `Api.js`, `Panel.qml`, `BarWidget.qml` untouched.

### Interfaces

`Model.js` (pure, no `Api` reference, all node-tested):

```js
var NOTIFY_DEFAULTS = { deploymentQueued: true, deploymentStarted: true, deploymentFinished: true,
                        deploymentFailed: true, resourceStateChanged: true, serverReachability: true }
function notifyDefaults()                                      // fresh copy, the pollDefaults() idiom
// normaliseConfig: out.notify = notifyDefaults(); raw.notify === false → all false; true/null/absent → defaults;
//   other non-object → defaults + out.warning = "notify must be an object or a boolean";
//   object: for k in NOTIFY_DEFAULTS, if k in raw.notify: boolean → take it, else default + out.warning = "notify." + k + " must be a boolean"
//   (first warning wins; out.ok stays true; the url regex at :65 is unchanged)
function configSansNotify(cfg)                                 // shallow copy without `notify` and `warning`, for the reset decision
function origin(instanceUrl)                                   // now "" when the authority contains "@"

function diffDeployments(prevList, nextList, first)            // -> { vanished: [uuid], events: [event] }
//   vanished = diffActive(prev uuids, next).vanished (always); events = [] when first, else via a prev-by-uuid map:
//   uuid new at queued → "queued" ("restarting" when restartOnly); new at in_progress → "started" ("restarting" when restartOnly);
//   tracked queued → in_progress → "started" (nothing when restartOnly)
function terminalEvent(d)                                      // finished → "finished" | "restarted"(restartOnly); failed → "failed"; cancelled-by-user → "cancelled"; else null
function hasTerminal(recent, uuid)                             // true when an entry with that uuid and TERMINAL status exists
function resourceEvents(prevRaw, nextRaw, first)               // [] when first; per uuid present in both: from ∈ {running,starting,restarting,degraded} → exited = "stopped";
//   from ∈ {running,starting,restarting} → degraded = "degraded"; from ∈ {exited,degraded} → running|starting = "recovered";
//   unknown/paused on either side → nothing; state prefix only, never health
function serverEvents(prevServers, nextServers, first)         // [] when first; skips disabled and servers absent from prev; reachable true→false "unreachable", false→true "reachable"

function appLabel(name, uuid)                                  // strips a trailing ":<branch>-<20+ lowercase alnum>" Coolify suffix, elide(…, 32); "" → uuid.slice(0, 8)
function uuid8(uuid)                                           // String(uuid).replace(/[^A-Za-z0-9]/g, "").slice(0, 8)
function notifySafe(text, max)                                 // redact → remove /[\x00-\x1f\x7f-\x9f]/g → elide(max) → a leading "-" run becomes U+2011; all other Unicode survives; "" stays ""
//   applied to the FINAL composed positional (headline, body), not only to its parts
function notifyBody(text, max)                                 // notifySafe, then "&"→"&amp;", "<"→"&lt;" (StyledText body only; escape after elide)
function notifyCopy(ev, obj, s, ctx)                           // -> { toggle, glyph, urgency, headline, body, targetType }  (the table below; obj is the flush-time resolved object)
function notifyPlan(events, s, ctx)                            // -> { argvs, log, suppressed: {rule: n}, notified: [{key, at}], lastKind }
//   ctx = { notify, origin, dnd, pending, actionAt, lastNotified, sentLastMin, now, pluginId }
//   builds once at entry: byUuid over s.resources / s.deployments / s.servers / s.recent, the set of app uuids and app names with an active deployment,
//   newest finishedAt||updatedAt per app over s.recent, unreachableServers(s) plus servers with an "unreachable" event in this batch

function parseRecent(text, instanceKey, nowMs)                 // -> { recent: [deployment], loaded: bool, rejected: bool }; text null/"" → {[], false, false}; any rejection → {[], false, true}; instanceKey "" → rejected
function serialiseRecent(recent, instanceKey, nowMs)           // -> { text, key }: text is the JSON (2-space, trailing "\n"; strings redacted + elided; 20 cap); key is JSON of {version, instance, recent} without savedAt
function mergeRecent(memory, loaded)                           // dedupe by uuid (memory wins), newest first by finishedAt||updatedAt, 20 cap
```

**Copy table** (`notifyCopy`; `obj` is the flush-time object resolved by uuid from the joined snapshot, falling back to `ev.obj`; `A = appLabel(d.appName, d.uuid)` for deployments and `appLabel(r.name, r.uuid)` / `appLabel(srv.name, srv.uuid)` for resources and servers, one rule for every toast; `dur = (Date.parse(d.createdAt) && Date.parse(d.finishedAt)) ? elapsed(d.createdAt, Date.parse(d.finishedAt)) : ""` (the guard is the caller's; `elapsed` falls back to now on NaN); `sub = [d.branch, d.commitMessage].filter(Boolean).join(" · ")`; headline `notifySafe(…, 72)`; body `notifyBody(…, 96)`; `srv` = the `s.servers` entry for `obj.serverUuid` → its label, else `""`; `down` = count of resources whose `serverUuid` is this server):

| event | toggle | glyph | urgency | headline | body | `--exec` target |
|---|---|---|---|---|---|---|
| queued | deploymentQueued | `G.queued` | low | `Queued A` | `sub` | deployment |
| started | deploymentStarted | `G.progress` | low | `Building A` | `sub` | deployment |
| restarting | deploymentStarted | `G.progress` | low | `Restarting A` | `appLabel(d.serverName)` | deployment |
| finished | deploymentFinished | `G.finished` | normal | `Deployed A` | `[dur, d.branch].filter(Boolean).join(" · ")` | deployment |
| restarted | deploymentFinished | `G.finished` | normal | `Restarted A` | `dur` | deployment |
| failed | deploymentFailed | `G.failed` | **critical** | `Deployment failed: A` (`Restart failed: A` when restartOnly) | `[dur, url ? "click to open in Coolify" : d.branch].filter(Boolean).join(" · ")` | deployment |
| cancelled | deploymentFinished | `G.cancelled` | low | `Cancelled A` | `""` | deployment |
| stopped | resourceStateChanged | `G.failed` | normal | `A stopped` | `[srv, "exited"].filter(Boolean).join(" · ")` | resource |
| degraded | resourceStateChanged | `G.half` | normal | `A degraded` | `[srv, "degraded"].filter(Boolean).join(" · ")` | resource |
| recovered | resourceStateChanged | `G.finished` | low | `A running` | `[srv, "running"].filter(Boolean).join(" · ")` | resource |
| resources summary | resourceStateChanged | `G.failed` | normal | `<n> more resources stopped` | `srv` when all share one server, else `""` | none |
| unreachable | serverReachability | `G.failed` | **critical** | `A unreachable` | `down ? down + " resources down" : ""` | server |
| reachable | serverReachability | `G.finished` | low | `A reachable` | `""` | server |

`restarting`/`restarted`/`degraded`/`recovered` and the summary row are additions to `docs/design.md`'s eight rows (recorded in Change 9): a `restart_only` deployment reading "Deployed" would be wrong, `degraded` is owed by `docs/product.md:79`, `recovered` pairs the resource events the way the server events already pair, and the summary is the bound SR21 needs. `recovered` fires only when `ctx.lastNotified` holds a `stopped` or `degraded` for that uuid (so it never fires unpaired and adds no baseline noise).

Argv, exactly (body omitted when `""`; `--exec` triple omitted when `openUrl` returns `""`; `--exec` always last; the URL is one element; built as `a = a.concat(["--exec", "omarchy-launch-browser", url])`, the array-literal form the gate pins):

```
["omarchy-notification-send", "--app-name", <appName>, "-g", <glyph>, "-u", <urgency>, <headline>[, <body>][, "--exec", "omarchy-launch-browser", <url>]]
```

`<appName>` = `ctx.pluginId`, except `"omarchy-action"` when `urgency === "critical" && ctx.dnd === true` (open question 1, default; `null` counts as not-DND). `<url>` = `openUrl(targetType, obj, ctx.origin)` and nothing else.

**`notifyPlan`, in order.** Per-event drops (first match wins; every drop increments `suppressed.<rule>`):

1. `toggle`: the row's toggle is off.
2. `selfCancel`: `cancelled` where `ctx.actionAt[uuid]` is within 300 s (the service cancelled it; the status line already said so; open question 6).
3. `pending`: `stopped`/`degraded` where `ctx.pending[uuid]` exists (`hasOwnProperty`).
4. `actionWindow`: `stopped`/`degraded` where `ctx.actionAt[uuid]` is within 180 s (a service/database restart's `_pending` is gone by then).
5. `activeDeployment`: `stopped`/`degraded` where an active deployment matches the app (`appUuid === uuid || appName === obj.name`).
6. `postDeployGrace`: `stopped`/`degraded` where the newest `recent` deployment matching the app has `finishedAt || updatedAt` within 120 s.
7. `serverDown`: `stopped`/`degraded` where `obj.serverUuid` names a server that is unreachable or has an `unreachable` event in this batch (the server toast carries the count).
8. `cooldown`: `ctx.lastNotified["<kind>:<uuid>:<event>"]` within 300 s (every kind, deployments included: a uuid that leaves and re-enters the active list must not toast "Building" twice); `recovered` additionally requires a `stopped`/`degraded` key for the uuid within 3600 s.

Then, over the survivors, ordered critical → normal → low (critical events are never capped or summarised):

9. `resourceCap`: more than 3 resource events → keep the first 3, append one "resources summary" row (the summary row is not itself capped).
10. `minuteCap`: `ctx.sentLastMin + emitted` may not exceed 12 non-critical toasts in the rolling minute; the rest are dropped and counted (no summary toast; `_notifyLog` is the ledger).

`log` entries are `"<event> <uuid8(uuid)>"` only. `notified` lists the `lastNotified` keys to stamp for every emitted toast. `lastKind` is the last emitted row's event name.

**Baseline and no-replay.** `first` for each diff is the kind's own `!_baseline[kind]`, captured before `_markPoll`. No replay after a restart or a config change comes from two existing facts: `GET /deployments` lists only active deployments, and the post-baseline `vanished` set is empty, so a deployment that finished while the shell was down never reaches the drain; an in-flight one is part of the baseline set and yields one terminal toast when it vanishes. `hasTerminal(_recent, uuid)` before the unshift is the **intra-session** dedupe (a uuid drained twice via a retry or a list hiccup), and rule 8 covers non-terminal repeats. `recent.json` persists the panel's Recent section and extends `hasTerminal` across a restart; it is not what prevents a replay.

**DND (the resolved tension).** With `--app-name io.github.danjonesio.coolwatch` a critical toast is silenced under DND by the shell. Chosen default: the plugin id for every toast, except that a critical event arriving while `_dnd()` is `true` is sent as `--app-name omarchy-action`, the one name the shell shows through DND; a shown toast is archived to history with `app: "omarchy-action"`, so the history listing for one plugin mixes two app names (expected in runbook step 8). When `_dnd()` is `null` (service unreachable) the plugin id is used and the toast is silenced; `status.notify.dnd` reports `null` so the degradation is visible. The security-analyst dissents on contract grounds (the shell's comment says the rule exists to stop urgency abuse) and confirmed in wave 2 that the hybrid opens no hole beyond identity loss: the app-name slot is one of two compile-time constants chosen by a boolean the service read from another QML service, and `notifySafe` keeps every Coolify byte out of it. Option (a) also removes `_dnd()`, the `shell` dependency, SR23 and one status field. Recorded as open question 1, to be answered before Change 3.

`Service.qml` additions:

```qml
import qs.Commons                                   // Util.execArgv; first-party services import it (plugins/notifications/Service.qml:9)
readonly property string pluginId: "io.github.danjonesio.coolwatch"
readonly property string stateDirPath: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/coolwatch"
readonly property string recentPath: stateDirPath + "/recent.json"
// mkdirProc.command becomes ["bash", "-c", 'mkdir -m 700 -p "$1" "$2" && chmod 700 "$2"', "bash", root.configDirPath, root.stateDirPath]
//   (-m is create-only; the chmod repairs an existing 0755 dir; paths are positional, never interpolated);
//   onExited additionally sets root._stateDirReady = true and calls root._armRecent(); the exit code stays unread
Req { id: deploymentReq; property var inflight: null }

FileView { id: recentFile; path: ""; watchChanges: false; atomicWrites: true; printErrors: false
  onLoaded: root._loadRecent(text()); onLoadFailed: function (err) { root._loadRecent(null) }
  onSaveFailed: function (err) { console.log("coolwatch recent save failed") } }

function _armRecent() {                // called from _configText (after _instance is set) and from mkdirProc.onExited; needs both
  if (!root._stateDirReady || !root._instance) return
  var key = Model.origin(root._instance.url)
  if (key === root._recentKey && recentFile.path === root.recentPath) return
  root._recentKey = key; root._recentLoaded = false
  if (recentFile.path === root.recentPath) recentFile.reload(); else recentFile.path = root.recentPath
}
function _loadRecent(text) {           // idempotent: onLoaded may fire twice
  var r = Model.parseRecent(text, root._recentKey, Date.now())
  root._recent = Model.joinBranch(Model.mergeRecent(root._recent, r.recent), root._resources)
  root._recentPersisted = r.recent.length; root._recentRejected = r.rejected; root._recentLoaded = true
  console.log(r.rejected ? "coolwatch recent rejected" : "coolwatch recent loaded " + r.recent.length)
}
function _saveRecent() {               // called from the "deployment" arm only
  if (!root._recentLoaded || !root._stateDirReady || root._recentKey === "") return
  var out = Model.serialiseRecent(root._recent, root._recentKey, Date.now())
  if (out.key === root._lastRecentKey) return
  root._lastRecentKey = out.key; recentFile.setText(out.text)
}
function _requeueDrain(uuid) {         // the one re-queue site; called from _finish (deployment kind, no successful dispatch, code ≠ 404) and the reaper
  var n = (root._drainTries[uuid] || 0) + 1
  if (n > 2) { delete root._drainTries[uuid]; console.log("coolwatch drain gave up " + Model.uuid8(uuid)); return }
  root._drainTries[uuid] = n; root._drainRetries++
  var q = root._terminalQueue.slice(); if (q.indexOf(uuid) < 0 && q.length < 20) q.push(uuid); root._terminalQueue = q   // back of the queue
}
```

- `_configText`: after `again` is normalised and `again.ok`, if `root._cfg && JSON.stringify(Model.configSansNotify(again)) === JSON.stringify(Model.configSansNotify(root._cfg))` → `root._cfg = again; root._setWarning(again.warning ? {kind: "notify", …} : <existing warning>); root._stat(); return` (live apply, no reset; `_stat()` reaches `_applyStat`'s stamp bookkeeping exactly as the byte-identical short-circuit does; `_tokenReady` does not re-fire, so `recentFile` is not reloaded, which is correct). The byte-identical short-circuit stays first. On the reset path, `_armRecent()` is called right after `_instance` is assigned (`:246-247`), so a `tokenCommand` user's Recent does not wait on the vault. `again.warning` for `notify` surfaces via the existing `_warning` channel on both paths.
- `_resetStore` sets `_recentLoaded = false`, `_recentKey = ""`, clears `_notifyQueue`, `_actionAt`, `_lastNotified`, `_notifyLog`, `_suppressed`, `_drainTries`, `_lastRecentKey`, `deploymentReq.inflight`; never writes.
- `_setPending(a, …)`: `root._actionAt[a.uuid] = Date.now(); root._actionAt = root._actionAt` (for cancel, `a.uuid` is the deployment uuid).
- Reaper tick (`:894`, beside `_expirePending`): prune `_actionAt` > 300 s and `_lastNotified` > 3600 s, each with the `_expirePending` empty-map early return, mutate and self-assign only when something was removed. The reaper's deployment reap (`:888`) calls `_requeueDrain(deploymentReq.inflight.uuid)` before `_drainTerminal()` when `inflight` is set.
- `_drainTerminal`: unchanged except `deploymentReq.inflight = { uuid: uuid }` before `_launch(deploymentReq, Api.reqDeployment(uuid), 6)`; `p.arg` stays the descriptor list.
- `_finish`, for `p.kind === "deployment"` after the block loop: if no `deployment` dispatch succeeded and the record's code was not 404, `_requeueDrain(deploymentReq.inflight.uuid)`; on a 404 `delete _drainTries[uuid]` and log `coolwatch drain 404 <uuid8>`; then `deploymentReq.inflight = null`. A 429 re-queues like any other failure (the existing `_pauseFor` and the `deployment` backoff already gate the next launch; nothing new escalates).
- `_status()` gains `notify: { enabled: {…six}, sentLastMin, suppressed: {…ten}, queued, lastEvent, dnd: "on"|"off"|null }`, `baseline: {deployments, resources, servers, version}`, `recentPersisted`, `recentRejected`, `drainRetries`.
- Log lines (all through `Model.uuid8`, never a name, message, path or URL): `coolwatch notify <event> <uuid8>` at intent; `coolwatch recent loaded <n>`; `coolwatch recent rejected`; `coolwatch recent save failed`; `coolwatch drain 404 <uuid8>`; `coolwatch drain gave up <uuid8>`.
- `Component.onDestruction`: nothing new to stop (no new timer).

### Rejected alternatives

- **Persist the tracked active set** so a deployment that finished while the shell was down still toasts. Rejected: needs a write per deployments poll or is stale; the first tick after start would fire `GET /deployments/{uuid}` per stale uuid outside the schedule; a machine suspended for a day would toast ancient terminals on wake. Chosen: `recent` only.
- **Write `recent.json` from `onRecentChanged`.** Rejected: `_recent` is reassigned 15–30 times a minute and emptied by `_resetStore`. Chosen: `_saveRecent()` from the `deployment` arm, armed after a load and after the state dir exists, no-op when the stamp-free key is unchanged.
- **Reset the store on a `notify` toggle edit and rehydrate.** Rejected: kills in-flight requests, emits "Action interrupted by a config change", forces a new baseline and can lose the Deployed toast of a build in progress. Chosen: live-apply via `configSansNotify`; the rehydrate after other resets is kept.
- **A non-boolean toggle as a hard config error.** Rejected in wave 2: `ok:false` sets `_cfg = null` and stops all polling, the panel and every alert (`Service.qml:231-242`), so a quoted `"false"` produces fewer critical alerts than a warning would. Chosen: warning + default true, consistent with "every read has a fallback".
- **Rejecting userinfo in `normaliseConfig`.** Rejected: a working install would go `configerror` on upgrade. Chosen: `origin()` alone returns `""`, which removes the URL from every argv and file; an empty key never writes.
- **`_baselineDone` as the notify gate.** Rejected: one broken kind silences everything. Chosen: per-kind `_baseline[kind]`.
- **A separate `_notified` set for terminal dedupe.** Rejected: `_recent` already is a uuid-keyed terminal set and is what gets persisted. Chosen: `hasTerminal(_recent, uuid)` plus rule 8 for non-terminal repeats.
- **Carrying the retry count in `p.arg`.** Rejected: `p.arg` is the descriptor list `_finish`/`_dispatch`/`Api.config` depend on. Chosen: `deploymentReq.inflight` + `_drainTries`, one `_requeueDrain` site; retried uuids go to the back so one failing uuid does not stall the healthy ones twice.
- **Build the notification argv in `Service.qml`.** Rejected: untestable in node, and the QML SR9 gate fails on the line. Chosen: `Model.notifyPlan` returns argvs; `Service.qml` holds no launcher or notifier string.
- **A `Notify.js` file.** Rejected: `Model.js` is `.pragma library` and cannot import another library, so the copy code could not reach `redact`, `elide`, `origin`, `openUrl`, `elapsed` or `G` without duplicating them (the ship-list and test-loader edits would be trivial).
- **`--app-name omarchy-action` for every critical toast** (architect, ops). Rejected as the default: surrenders identity in history even with DND off. Kept as open question 1's option (b).
- **`--app-name notify-send`.** Rejected: ephemeral, and its DND arm is dead code in the shell.
- **Relaxing the SR9 regex.** Rejected: throws away the one-identifier guarantee. Chosen: anchored gates over `Model.js` and a ban on the notifier string in QML.
- **A `chmod 600` Process after every save.** Rejected: the atomic rename defeats it. Chosen: the 0700 directory (created and chmod'ed before the first write) is the control; acceptance line (h) reworded.
- **A per-flush cap of 5 with a "more changes" summary.** Rejected in wave 2: unreachable once resources are capped at 3 and a dead server is folded into its server toast; and "keep the first N" could drop a critical. Chosen: critical-first ordering, critical exempt, and a 12-per-minute ceiling read from `_notifyLog`.
- **A resources kick after a Deployed toast or a server flip.** Rejected: the compensating poll AGENTS.md bars.
- **Raising `_terminalQueue`'s cap.** Rejected: 20 already reaches ≈57/min in the worst window.
- **Health-only transitions.** Rejected for Phase 3: AGENTS.md prefix-match lock; open question 2.

## Reuse

- `Service.qml:430-441` deployments arm: `diff.added` already computed; `root._deployments` still holds the previous list at diff time (Change 5).
- `Service.qml:444-455` deployment arm: the single place a terminal record exists; the existing `if (d.uuid)`, uuid dedupe, `unshift`, `slice(0, 20)` and `_failedUnacked` push stay (Change 5, 7).
- `Service.qml:412-414` `_rejoin()`/`_joinDeployments()` run before the flush: the joined snapshot is the render source for every toast at zero extra cost (Change 3, 5).
- `Service.qml:542-550` `_drainTerminal` + `_terminalQueue` (`:49`, `:435`): unchanged shape; `Api.js:79` carries the uuid as `descriptor.arg` (Change 6). `Service.qml:335-359` `component Req` and `:197-199` `tokenCmd { property int seq; property string key }`: per-process bookkeeping off `p.arg`; `:640-644` `_inflightAction` the same idea (Change 6).
- `Service.qml:481-487` `_markPoll` / `_baseline` (`:57`): the per-kind first-poll flags (Change 5).
- `Service.qml:176-184` `mkdirProc`, re-run by `_selfHeal()`: one command, now also the state dir and its chmod; `plugins/agents/Main.qml:403-412` and `plugins/notifications/Service.qml:833-840` the mkdir-before-write ordering (Change 7).
- `Service.qml:158-172` config FileView pair: the reader idiom (`onLoaded`/`onLoadFailed`); `plugins/agents/Main.qml:348-354` the write-only shape; `plugins/notifications/Service.qml:781-836` the `settingsLoaded` guard and the "onLoaded fires twice" note (Change 7).
- `Service.qml:228` `JSON.stringify(a) === JSON.stringify(b)`: the change check, reused for `configSansNotify` and the `_lastRecentKey` guard (Change 4, 7). `Service.qml:38, 294-296` `_warning`: the non-fatal config channel for `notify` (Change 1, 4).
- `Service.qml:725` `_setPending`: the hook for `_actionAt` (Change 5). `Service.qml:742-779` `_expirePending`: stays reaper-only; the prunes sit beside it (`:894`) with its empty-map early return (`:743-744`).
- `Service.qml:643` / `:607-609`: the filter-push-reassign bare-timestamp ring for `_notifyLog`; `:617` `_actionsLastMin` the reader shape; `:564` `root._perKind = root._perKind` mutate-then-self-assign for the maps (Change 5).
- `Service.qml:12` `property var shell`: injected by `shell.qml:306`; `shell.serviceFor("omarchy.notifications").doNotDisturb` (Change 5).
- `Model.js:54-98` `POLL_DEFAULTS`/`pollDefaults()`/the validation loop: the shape for `notify` (Change 1).
- `Model.js:460-471` `diffActive`: wrapped by `diffDeployments`; `Model.js:414-415, 927` the `byUuid` keyed-map idiom (Change 2, 3).
- `Model.js:429-443` `joinBranch`: applied to the single terminal record and after load (Change 5, 7). `Model.js:337-359` `normaliseDeployment`: the load-side validator shape. `Model.js:293, 321, 697` the `name || uuid` fallback `appLabel` copies.
- `Model.js:183-197` `redact`/`elide`: the chokepoint `notifySafe` wraps; `Model.js:697` the `sub` expression; `Model.js:1023` `elapsed(iso, nowMs)` as a duration; `Model.js:623` `deploymentGlyph` / `G`; `Model.js:475` `unreachableServers`; `Model.js:665-691` `origin`/`openUrl`, the only URL source (Change 2, 3).
- `Model.js:833-869` `actionOutcome`: the copy-table-as-pure-function idiom `notifyCopy` copies (Change 3).
- `Model.js:178` `parseJson` `{ok, value}`: reused by `parseRecent`. `/usr/share/omarchy/shell/plugins/notifications/NotificationLogic.js:259-273, 367-382`: the fail-closed parse idiom (Change 3).
- `bin/check:17-24, 33-37`: gate style; SR9 stays as-is (Change 8). `bin/record-fixture:17`: the scrub regex for the cancelled fixture.
- `tests/run.js:25-28, 55-79` `fixture`/`fx`/`trailer`/`snap`/`loadedSnap` (the joined-snapshot harness for every `notifyPlan` test); `tests/fixtures/deployments-active.json`, `deployment-finished.json`, `deployment-failed.json`, `resources.json`, `servers.json` (Change 2, 3).
- `plugins/notifications/Service.qml:28-31` the live-popup file directory: turns "no popups" into a command output (Change 10). `docs/plans/phase-2-act.build.md:30,33,81`: the sampling loop, `ps` sampler and needs-human table format (Change 10).

Not reused, with reason: `plugins/clipboard/Clipboard.qml` `watchChanges: true` on its own file (reload-loop risk); Tailscale `recentMullvadRegions` (`shell.json`); `waitForJob()` (undocumented, blocking).

## Security requirements

Numbering continues from Phases 1–2 (SR1–SR14).

15. **No Coolify string becomes an option or a control sequence.** Every final positional handed to `omarchy-notification-send` passes `Model.notifySafe` (redact → remove `/[\x00-\x1f\x7f-\x9f]/g` → elide → leading `-` run → U+2011); the body additionally passes `notifyBody` (escape `&`, `<`, after elide). Log lines use `uuid8`, which strips everything outside `[A-Za-z0-9]`. Tests: `--app-name=omarchy-action`, `--image=file:///etc/passwd`, `--urgency=critical`, `-g`, a NUL, an ESC, an accented and a CJK name unchanged, an ordinary headline with a space and an internal hyphen unchanged, a 300-char message, `<a href>`, `a & b`, a token-shaped string under a short `max` (redact before elide), a uuid containing a newline yielding one log entry. Change 3.
16. **argv[0] and the launcher keep a checked shape.** In `Model.js` (comments stripped) `omarchy-notification-send` appears at most once and, when present, opens an array literal (`["omarchy-notification-send", `); `omarchy-launch-browser` appears at most once and, when present, on a line matching `"--exec", "omarchy-launch-browser", [A-Za-z_.]+\]`; neither string appears in any `*.qml`; the QML SR9 gate is unchanged with its floor. A node test asserts `argvs.every(a => a[0] === "omarchy-notification-send")` across every copy-table row. The "at most once" form is rollback-safe (a Phase 2 `Model.js` passes). Change 8.
17. **`--exec` is last, holds one URL element, and is absent when there is no page.** `openUrl` `""` → no `--exec`. An empty body is omitted, never passed as `""`. Tests. Change 3.
18. **`recent.json` is untrusted input.** `parseRecent` bounds the parsed text (262 144 bytes), requires `version === 1` and a non-empty matching instance key, whitelists fields, checks `uuid` against `UUID_RE` and `status` against `TERMINAL`, caps at 20, drops unparseable timestamps and entries older than 24 h, never throws, accepts `null`/`""`; `branch`/`appUuid` are recomputed; `url` passes `openUrl` on every use. Loading never notifies and never touches `_failedUnacked` or `_activeUuids`. Tests: hostile `url` values, bad JSON, non-array, 5 MB text, 10 000 entries, wrong version, wrong and empty instance key, `null`. Change 3, 7.
19. **No secret and no credential reaches a toast, the state file, the shell's history or the log.** `serialiseRecent` and `notifyCopy` run `redact` on every string; `Model.origin` rejects userinfo (so `openUrl` can never carry `user:pass@`); log lines carry event + uuid8 only; the state dir is created **and chmod'ed** `0700` before the first write and `_saveRecent` refuses until `_stateDirReady`. Tests: `origin("https://u:p@host") === ""`; a token-shaped commit message redacted in the serialised text. Change 1, 3, 7.
20. **No new request, no new escalation, no compensating poll.** Phase 3 adds zero endpoints, never touches `_fail`'s classification, `_backoff`, `_probeMode` or `_pauseFor`; the drain retry only re-enters the existing queue, honours the existing `deployment` backoff and pause, and is capped at 2 per uuid. Re-measured in Verification. Change 5, 6.
21. **Bounded toast volume.** ≤ 3 resource toasts per flush plus one summary, a 12-per-minute ceiling on non-critical toasts, per-(kind,uuid,event) 300 s cooldown, server-outage correlation, `sentLastMin` and per-rule `suppressed` in `status`; critical never dropped by a cap. Tests: a 20-resource flip → 3 + summary; 4 low + 1 failed in one flush → the failed one emitted at critical; 200 distinct resources over 20 flushes → ≤ 12/min; a 10-minute flap → 2 toasts. Change 3.
22. **Config safety.** A malformed `notify` value warns and falls back to its default (never `ok:false`, never truthiness-coerced: `"false"` yields the default `true` with a callout naming the key); unknown keys ignored; a `notify`-only edit never resets the store. Tests. Change 1, 4.
23. **DND honesty.** The sender name is `omarchy-action` only when `urgency === "critical" && ctx.dnd === true`, decided in `notifyPlan` from a boolean the service read from the shell, never from Coolify data; `null` means plugin id. Tests. Change 3.
24. **Verification hygiene.** No builder or reviewer runs `bin/dev-sync` or any `--delete` tool against a real path (staging only via `COOLWATCH_DEST=$(mktemp -d)/plugin`); nobody prints `config.json`; reviewers never run `omarchy restart shell` or an IPC action verb; the `ps`/log needle asserts token count 0 only and **fails loudly when the needle is empty** (a `tokenCommand` config); names, branches and URLs legitimately appear in notification argv and in the shell's 0644 history files. Change 10.

## Changes

### 1. `Model.js`: config `notify{}`, `configSansNotify`, `origin` userinfo

Files: `Model.js`, `tests/run.js`.

`NOTIFY_DEFAULTS`, `notifyDefaults()`, the `normaliseConfig` branch per Interfaces (warning, never error; `out.warning` is a new optional string field), `configSansNotify(cfg)`, and `origin()` returning `""` when the authority part (between `//` and the first `/`, `?` or `#`) contains `@`. `normaliseConfig`'s url regex is untouched.

**Verify**: `node tests/run.js` → the two existing `normaliseConfig` tests pass unchanged plus: absent `notify` → six trues, no warning; `{deploymentFailed: false}` → that key false, five true; `{deploymentFailed: "false"}` → `ok:true`, that key `true`, `warning` names `notify.deploymentFailed`; `{bogus: 1}` ignored; `notify: false` → six falses; `notify: "false"` → defaults + `warning`; `configSansNotify` of two configs differing only in `notify`/`warning` stringify equal, differing in `poll` unequal; `origin("https://u:p@host")` and `openUrl("deployment", {url:"/x"}, "https://u:p@host")` → `""`; `normaliseConfig` with `url: "https://u:p@host"` still `ok:true`.

### 2. `Model.js`: the diffs and the event builders

Files: `Model.js`, `tests/run.js`.

`diffDeployments` (wrapping `diffActive`; keyed maps; `first` → `events: []`), `terminalEvent`, `hasTerminal`, `resourceEvents` (incl. `recovered`), `serverEvents`, `uuid8`, `appLabel` per Interfaces. The existing `diffActive` test stays; the deployments arm's call site moves in Change 5.

**Verify**: `node tests/run.js` → from `deployments-active.json`: prev empty + next → the expected `queued`/`started` events, `first: true` → none; `queued → in_progress` → one `started`; `in_progress → in_progress` → nothing; `restart_only` → `restarting` once, never `started`; `terminalEvent` on `deployment-finished.json`/`deployment-failed.json`/`deployment-cancelled.json` → `finished`/`failed`/`cancelled`, `restartOnly` finished → `restarted`, `in_progress` → `null`; `hasTerminal` true/false/active-status-false; `resourceEvents` from `resources.json` with one uuid flipped `running:healthy → exited` → one `stopped`; `exited → running` → `recovered`; `exited → exited`, `unknown → exited`, `running → unknown`, `running → paused`, `healthy → unhealthy`, absent-from-prev → nothing; `running → degraded` → `degraded`; `serverEvents` from `servers.json`: both flips, `disabled` never, absent never; `appLabel`: `storefront:main-h0wxyg40kc0lz727dom9l03i` → `storefront`, `worker` → `worker`, `xyhpwdxqu33omjgwuo6c7cjp-200537415987` unchanged (no `:`) then elided to 32, `""` → the uuid's first 8; `uuid8("ab\ncd…")` has no newline; a 2 000-resource synthetic diff completes under 50 ms in node.

### 3. `Model.js`: copy, sanitiser, plan, recent (de)serialiser; fixtures

Files: `Model.js`, `tests/run.js`, `tests/fixtures/deployment-cancelled.json` (`bin/record-fixture deployment-cancelled /deployments/<uuid of the Phase 2 cancel>` if it still resolves; else hand-derived from `deployment-failed.json` with `status: "cancelled-by-user"` and `_note`), `tests/fixtures/state-recent.json` (a valid `version: 1` file with two entries, instance `https://app.coolify.io`), `tests/fixtures/state-recent-corrupt.txt` (truncated JSON; read with `fixture()`).

Precondition: open question 1 answered (default (c) if Dan says nothing). `notifySafe`, `notifyBody`, `notifyCopy` (the table; names through `appLabel`), `notifyPlan` (indexes built once at entry; the eight per-event drops; critical-first ordering; rules 9–10; argv assembly with the `concat` literal; `log`; `notified`; `lastKind`; per-rule `suppressed`), `parseRecent`, `serialiseRecent` (`{text, key}`), `mergeRecent`.

**Verify**: `node tests/run.js` passes every case under "Tests to add" tagged Change 3, every `notifyPlan` case built over `loadedSnap()`; a 2 000-event `notifyPlan` completes under 50 ms; `bin/check --no-shell` → `ok` (fixture-secret grep passes on the three new fixtures).

### 4. `Service.qml`: config live-apply and the `notify` warning

Files: `Service.qml`.

In `_configText`, after `again` is normalised and `again.ok`: if `root._cfg && JSON.stringify(Model.configSansNotify(again)) === JSON.stringify(Model.configSansNotify(root._cfg))` → `root._cfg = again`, refresh `_warning` (a `notify` warning replaces none; an existing `plaintext`/`permissions` warning is kept when there is no notify warning), `root._stat(); return`. The byte-identical short-circuit stays first. On the reset path the same `_warning` refresh runs after `_cfg` is assigned.

**Verify**: `bin/check` → `ok`. `bin/dev-sync && omarchy restart shell`; record `status | jq '{baselineDone, counts, inflightAction}'`; edit `notify.deploymentQueued` to `false` in an editor (never print the file); within 5 s `status | jq '{configState, baselineDone, counts, inflightAction, queued: .notify.enabled.deploymentQueued}'` shows `"ok"`, the same three values, `false`; set it to `"false"` (quoted) → `configState "ok"`, `queued: true`, the panel shows a warning callout naming `notify.deploymentQueued`, polling continues (`requestsLastMin` non-zero); restore `true`.

### 5. `Service.qml`: diff hooks, queue, flush, DND, action ledger, status

Files: `Service.qml`.

`import qs.Commons`; `pluginId`; `_notifyQueue`, `_actionAt`, `_lastNotified`, `_notifyLog`, `_suppressed`, `_lastEvent`; the deployments arm (`first` captured before `_markPoll`, `Model.diffDeployments`, `_queueNotify(diff.events)`); the deployment arm (`joinBranch` on the single record inside the existing `if (d.uuid)`, `hasTerminal` before the unshift, `_queueNotify([Model.terminalEvent(d)])`); the resources and servers arms; `_queueNotify`; `_flushNotify()` as the last statement of `_finish` after `_rejoin()`/`_joinDeployments()`, reached on every path that ran `_dispatch`; `_dnd()`; `_setPending` writes `_actionAt`; reaper prunes; `_resetStore` clears the new state; `_status()` additions; the log lines.

**Verify**: `bin/check` → `ok` (qmllint resolves `qs.Commons`). `bin/dev-sync && omarchy restart shell`; `quickshell log -p /usr/share/omarchy/shell --tail 50` shows no component error and the bar icon is present (a failed `qs.Commons` import removes the service: fallback is inlining `Quickshell.execDetached(["bash","-lc",'exec "$@"',"bash"].concat(argv))`, recorded as a deviation). Within 60 s `status | jq '{baseline, notify}'` → all baseline flags true, `sentLastMin 0`, `dnd "off"`, every `suppressed` counter 0, `queued 0`; `quickshell log … | grep -c '^coolwatch notify'` → 0. Then, panel closed, `omarchy-shell io.github.danjonesio.coolwatch deploy xyhpwdxqu33omjgwuo6c7cjp` → within 5 s a "Queued <label>" or "Building <label>" toast, then "Deployed <label>" when it finishes; `grep '^coolwatch notify'` shows exactly those lines with an 8-char uuid and nothing else; `status | jq .notify.sentLastMin` matches; `ls ~/.local/state/omarchy/notifications/history/` gained the same number of files, each with `"app": "io.github.danjonesio.coolwatch"` and `execArgv[1]` beginning `https://app.coolify.io/project/`.

### 6. `Service.qml`: terminal-drain retry

Files: `Service.qml`.

`deploymentReq.inflight`, `_drainTries`, `_drainRetries`, `_requeueDrain`, the `_finish` deployment-kind epilogue (re-queue on any non-404 failure, 404 drop + log, clear `inflight`), the reaper's re-queue before its `_drainTerminal()`, the deployment arm's `delete _drainTries[uuid]`, `_status().drainRetries`.

**Verify**: `node tests/run.js` unchanged; `bin/check` → `ok`; `bin/dev-sync && omarchy restart shell`; deploy api with the panel closed: during the build `status | jq .terminalQueue` reads 0 or 1, after it finishes `counts.recent` incremented by one, exactly one terminal toast, `drainRetries` 0 on a healthy network. The retry path itself is not forceable without a network fault and is recorded as needs-human; its logic is the node-free reasoning above, reviewed.

### 7. `Service.qml`: `recent.json`

Files: `Service.qml`.

`stateDirPath`, `recentPath`, the new `mkdirProc` command and `onExited` (`_stateDirReady`, `_armRecent()`); `recentFile` FileView; `_armRecent` (called from `_configText` after `_instance` and from `mkdirProc.onExited`), `_loadRecent`, `_saveRecent`, the guard fields; `_saveRecent()` called only from the deployment arm after the slice; `_resetStore` additions (never writes). Ordering note for the builder: do not hoist the path assignment to `Component.onCompleted`; `_armRecent` requires `_stateDirReady`.

**Verify**: `bin/check` → `ok`. Pre-create `~/.local/state/coolwatch` at 0755 (`mkdir -m 755 -p`), then `bin/dev-sync && omarchy restart shell`; `stat -c '%a %U' ~/.local/state/coolwatch` → `700 danjones` (the chmod repaired it); `quickshell log … | grep 'coolwatch recent'` → `loaded 0` once or twice; after one deployment finishes: `jq '{version, instance, n: (.recent|length)}' ~/.local/state/coolwatch/recent.json` → `1`, `https://app.coolify.io`, ≥ 1; `grep -cE '[0-9]+\|[A-Za-z0-9]{20,}' ~/.local/state/coolwatch/recent.json` → 0; `stat -c %Y` of the file sampled every 10 s for 2 idle minutes does not change; `omarchy restart shell` → `status | jq '{recentPersisted, recentRejected, counts}'` shows the persisted count within 2 s (the load does not wait on the token); `grep -c '^coolwatch notify'` → 0 after the restart; `printf 'x' > ~/.local/state/coolwatch/recent.json` then restart → `recentPersisted 0`, `recentRejected true`, `coolwatch recent rejected` in the log, no error callout, no crash line; the next finished deployment rewrites a valid file; a `poll.resourcesSec` edit (a reset) followed by `status | jq .recentPersisted` shows the file was re-read.

### 8. `bin/check`: root override, SR16 gates, self-test

Files: `bin/check`.

`root=${COOLWATCH_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}` at `:4`. After the SR9 block, before the `--no-shell` exit: (a) launcher in `Model.js` (comments stripped): count ≤ 1 and, if 1, the line matches `"--exec", "omarchy-launch-browser", [A-Za-z_.]+\]`; (b) notifier in `Model.js`: count ≤ 1 and, if 1, the line contains `["omarchy-notification-send", `; (c) `grep -l 'omarchy-notification-send' *.qml` empty; (d) the existing SR9 QML gate untouched with its floor ≥ 1. No comment in `Model.js` may mention either program name.

**Verify**: `bin/check --no-shell` → `ok`; `d=$(mktemp -d); cp -r . "$d"` then on the copy: append `Util.execArgv(["omarchy-notification-send", "x"])` to `Service.qml` → `COOLWATCH_ROOT=$d bin/check --no-shell` fails (c); revert and add a second `omarchy-launch-browser` literal to `Model.js` → fails (a); `git checkout b38379c -- Model.js` in the copy → passes (rollback-safe); `rm -rf "$d"` (the copy only, never the repo).

### 9. Docs and version

Files: `manifest.json` (`0.3.0`), `AGENTS.md`, `README.md`, `docs/product.md`, `docs/architecture.md`, `docs/design.md`, `docs/roadmap.md`, `docs/omarchy-shell-reference.md`, `docs/plans/phase-2-act.build.md`.

- `AGENTS.md`: status → Phase 3 built; the critical/DND lock reworded per open question 1 with the `NotificationLogic.js:118-122` citation; "Don't" gains "Don't write `recent.json` from a property change or from `_resetStore`", "Don't gate a notification on `_baselineDone`", "Don't put a Coolify string into `omarchy-notification-send`'s argv without `Model.notifySafe`", "Don't put anything but the Api descriptor list in `Req.arg`"; Commands gains the `status` notify fields and the log grep; the rollback line → `git checkout b38379c -- …`; Omarchy facts gain "critical toasts never expire and are replayed by the notifications plugin after a shell restart; history keeps the newest 10 across all apps at 0644; the toast body is StyledText; `--exec` must be last; `mkdir -m` is create-only; `_notifyLog` is filter-push-reassign like `_actionLog`".
- `README.md`: Phase 3 status; the `notify{}` block with the `false` shorthand, "booleans, unquoted; a bad value warns and defaults to true", "cancelled rides `deploymentFinished`"; the state file and its directory mode; the DND behaviour; "Recent shows the last hour".
- `docs/architecture.md`: §Configuration (`notify` handling, `warning`, live-apply); §Change detection rewritten (per-kind baseline, the event table, the eight drops + two caps and their constants, the drain retry with its ~90 s worst-case latency, the honest no-replay statement, the DND resolution, the app-name rule); §State model (`recent.json` schema, the load rules, "not persisted: tracked set, `_failedUnacked`", "uuids are not charset-validated at normalise; `uuid8` filters"); §Runtime paths (state dir 0700 created and chmod'ed, file umask); Security items 15–24; a line that names, branches, commit messages and instance URLs appear in notification argv and in the shell's 0644 history files by design.
- `docs/design.md`: the Notifications table replaced by the copy table above (with `appLabel`, the four added rows, the summary row, "click to open in Coolify", "· N resources down"); the resource-toast latency (0–120 s) and the no-URL-before-topology note.
- `docs/roadmap.md`: Phase 3 built; acceptance lines reworded: "Do Not Disturb silences everything but critical" → per open question 1; "`docker stop` on a server" → "a container stopped outside the plugin (Coolify UI or `docker stop`)"; "recent.json exists 0600" → "the directory is 0700".
- `docs/omarchy-shell-reference.md:791-793`: correct the ephemeral/history claim.
- `docs/plans/phase-2-act.build.md`: the queued-cancel needs-human row closed if Change 10 answers it.

**Verify**: `grep -n 'bypasses Do Not Disturb' AGENTS.md docs/architecture.md` shows only the reworded lines; `grep -n '"version"' manifest.json` → `0.3.0`; `grep -n 'click to open logs' docs/design.md` empty; `bin/check` → `ok`.

### 10. Live acceptance runbook (Coolify Cloud, api = `xyhpwdxqu33omjgwuo6c7cjp`)

Files: none. Preconditions: `SCRATCH=/tmp/claude-1000/-home-danjones-Projects-coolwatch/<session>/scratchpad; mkdir -p "$SCRATCH"`; one installed build for the whole runbook; every panel closed unless a step opens one; DND off (`omarchy-shell notifications dndState` → `off`); a history snapshot `ls ~/.local/state/omarchy/notifications/history/ > "$SCRATCH/hist-N"` before each step (history is trimmed to 10 across apps); `needle() { jq -r '.instances[0].token // empty' ~/.config/coolwatch/config.json | cut -c1-12; }; n=$(needle); [[ -n $n ]] || { echo "needle empty (tokenCommand): run the command into the substitution instead"; exit 1; }`. Evidence channels: `quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E '^coolwatch (notify|recent|drain)'`; the history JSON (`jq -c '{app,summary,body,urgency,execArgv}'`); live popups as files: `ls ~/.local/state/omarchy/notifications/*.json`; the sampling loop `for i in $(seq 18); do omarchy-shell io.github.danjonesio.coolwatch status | jq -c '{t: now|floor, requestsLastMin, baseline, terminalQueue, counts, notify}'; sleep 10; done | tee "$SCRATCH/step-N.log"`; reduce with `jq -s 'map(.requestsLastMin) | max' "$SCRATCH/step-N.log"`. `<label>` below is `Model.appLabel` of the resource's name (for api, `xyhpwdxqu33omjgwuo6c7cjp-200537415987` elided).

1. **Silent baseline.** `bin/dev-sync && omarchy restart shell`, loop for 60 s: zero `coolwatch notify` lines, zero new history files, every `baseline` flag true within 10 s, `notify.dnd "off"`.
2. **One deploy → Queued, Building, Deployed.** `d` on api from the panel, then close it. Expect exactly `queued`, `started`, `finished` log lines (a build under one poll interval may skip `queued`; the roadmap's "Queued (optional)" covers it: record which), matching history files with the plugin id, urgencies low/low/normal, `execArgv[1]` the deployment page; `grim` screenshot of the Deployed toast; the click (mouse) is needs-human. No fourth toast in the following 3 min.
3. **Restart mid-deployment (two-branch).** `t` on api (a restart deployment lives longer than a plain build), then within 3 s `omarchy restart shell`. First `status | jq '{d: .counts.deployments, terminalQueue}'` after the restart decides the branch: `d ≥ 1` → the build survived, expect exactly one `restarted` log line when it finishes and zero `restarting` after the restart; `d == 0` and no terminal line → the build completed while the shell was down, the step proved nothing, re-run. Restart again after it finished → nothing.
4. **Deploy-caused restart is silent.** `t` on api: the deployment toasts only; `notify.suppressed.activeDeployment + .postDeployGrace` increases by the number of resource flips observed (may be 0 if no poll saw the flip); zero `stopped` lines across 3 min.
5. **User action is silent.** `s` Stop, confirm; wait 150 s; `s` Start. Zero `stopped` lines; `suppressed.pending + .actionWindow` ≥ 1 if a flip was observed; then within 150 s after Start no `recovered` line either (rule 8 requires a prior `stopped` toast).
6. **Unexpected stop and recovery.** Stop api's container from the **Coolify UI** (not the plugin; `docker stop` over SSH is equivalent if Dan has it, open question 4). Expect exactly one `stopped` line within 150 s, "<label> stopped · <server label> · exited", and none afterwards while it stays down; `execArgv[1]` is the resource page when `status.topologyLoaded` is true, absent otherwise (record which). Start it again from the UI → exactly one `recovered` line within 150 s.
7. **Failed deployment (needs Dan).** Only with permission (open question 5): a temporary build-command edit in the Coolify UI, deploy, revert. Expect one `failed` line, a critical toast "Deployment failed: <label> · <dur> · click to open in Coolify", the bar alert, the toast persisting until dismissed; a still-open critical toast is replayed by the notifications plugin after a shell restart (not an Coolwatch re-notify: `sentLastMin` stays 0).
8. **DND.** `omarchy-shell notifications toggleDnd`; `status | jq .notify.dnd` → `"on"` (if `null`, the DND branch is inert: record and stop); repeat step 2: history files gained, `ls ~/.local/state/omarchy/notifications/*.json` stays empty (no popup). Then the critical path per open question 1: with the hybrid, a `failed` (step 7) or a server-unreachable event shows a popup whose history entry has `app: "omarchy-action"` (expected mix); if step 7 is declined, the critical-under-DND half is needs-human. `toggleDnd` back; `dndState` → `off`; `status | jq .notify.dnd` → `"off"`.
9. **Toggle.** `deploymentQueued: false` in the config (editor, never printed): `status.notify.enabled.deploymentQueued` false within 5 s, `baselineDone` still true, counts unchanged, `inflightAction` unchanged; a deploy yields `started` + `finished` only. Restore.
10. **Persistence.** Change 7's checks repeated on the final build; after a restart within an hour of a deployment, `status | jq .counts.recent` ≥ 1 within 2 s and a `grim` screenshot of the panel's Recent section shows the rows (only deployments under `RECENT_MAX_AGE_MS` = 1 h render, open question 3).
11. **Argv hygiene.** The Phase 2 `ps -eww -o args=` 200 ms sampler across step 2: needle occurrences 0 in `ps`, in `quickshell log -t 100000` and in `recent.json`; record that `omarchy-notification-send` argv lines carry the label, branch, commit message and URL (expected).
12. **Budget.** Panel closed, 12 × 10 s: `jq -s 'map(.requestsLastMin) | max'` ≤ 19; during step 2 `< 60`.
13. **Queued cancel (Phase 2 needs-human).** `d`, then `x` while the row still reads queued: record whether `GET /deployments/{uuid}` returns the deployment (→ no `cancelled` toast because rule 2 suppresses the service's own cancel; a Recent row) or 404 (→ `coolwatch drain 404`, nothing); fixture `deployment-cancelled.json` recorded from a real cancel if not already.
14. **Dedupe.** Not forceable live without a network fault; covered by the `hasTerminal` and rule 8 node tests; recorded as needs-human ("a uuid drained twice").

**Verify**: every item ticked in the build record with its command output, screenshot or needs-human row; roadmap acceptance mapping: line 1 ← steps 2/3 (the no-replay half is proven by the active-only list and the baseline, exercised in step 3's first branch); line 2 ← steps 4/5/6; line 3 ← step 8's non-critical half, the critical-under-DND half needs-human unless open question 5 is answered yes.

Rollback: `git checkout b38379c -- manifest.json Service.qml BarWidget.qml Panel.qml Model.js Api.js && bin/dev-sync && omarchy restart shell` (config format unchanged; a `notify{}` block is ignored by Phase 2; `recent.json` is ignored; the new `bin/check` passes on the rolled-back tree).

## Verification

```sh
bin/check                                   # tests, fixture secrets, PlainText/font gates, SR9, SR16, staged validate, qmllint
bin/check --no-shell                        # CI subset
omarchy-shell io.github.danjonesio.coolwatch status | jq '{baseline, notify, recentPersisted, recentRejected, terminalQueue, drainRetries, requestsLastMin}'
quickshell log -p /usr/share/omarchy/shell --tail 300 | grep -E '^coolwatch (notify|recent|drain)'
needle() { jq -r '.instances[0].token // empty' ~/.config/coolwatch/config.json | cut -c1-12; }
n=$(needle); [[ -n $n ]] || { echo "needle empty"; exit 1; }
quickshell log -p /usr/share/omarchy/shell -t 100000 | grep -cFf <(needle) || true        # 0
grep -cFf <(needle) ~/.local/state/coolwatch/recent.json || true                             # 0
stat -c '%a %U' ~/.local/state/coolwatch                                                     # 700 danjones
```

Done end to end: the three Phase 3 acceptance lines (as reworded in Change 9) pass via Change 10 with outputs in the build record, needs-human rows named up front; `bin/check` green; docs match the code; idle budget ≤ 19/min unchanged.

## Tests to add

`tests/run.js`, one `test()` each, named by function and requirement:

- `Model.normaliseConfig` notify: absent → six true, no warning; one false; `"false"` → default true + `warning` naming the key, `ok:true`; unknown key ignored; `notify: false` → six false; `notify: "false"` → defaults + warning; `notify: true`/`null` → defaults (SR22). Change 1.
- `Model.configSansNotify`: equal when only `notify`/`warning` differ; unequal on `poll`. Change 1.
- `Model.origin` / `openUrl` reject userinfo; `normaliseConfig` still accepts the url (SR19). Change 1.
- `Model.diffDeployments`: the `diffActive` cases carried over via `vanished`; `first` → no events; queued/started/restarting transitions; timing case. Change 2.
- `Model.terminalEvent` × 4 statuses incl. `restartOnly` and `in_progress → null`; `Model.hasTerminal` × 3. Change 2.
- `Model.resourceEvents` × 10 transitions (fires: running→exited, starting→exited, degraded→exited, running→degraded, exited→running `recovered`; silent: exited→exited, unknown→exited, running→unknown, running→paused, healthy→unhealthy, absent-from-prev); `first` → `[]`. Change 2.
- `Model.serverEvents` × 4. Change 2.
- `Model.appLabel` × 5 incl. the empty-name fallback; `Model.uuid8` strips a newline and non-alphanumerics. Change 2.
- `Model.notifySafe`: `--app-name=omarchy-action`, `--image=file:///etc/passwd`, `--urgency=critical`, `-g` → first char not `-`; NUL and ESC removed; `Émilie`, `部署` unchanged; `Deployment failed: storefront` unchanged; token redacted under a short max; `""` → `""` (SR15). Change 3.
- `Model.notifyBody`: `<a href="x">y</a>` contains no `<`; `a & b` → `a &amp; b`; escape happens after elide (a cut never lands mid-entity); the headline path leaves `<` alone. Change 3.
- `Model.notifyCopy` × 13 rows over `loadedSnap()`: headline, body, glyph ∈ `GLYPHS`, urgency, toggle; `stopped` body contains the server label; `unreachable` body `N resources down`; fallbacks: no commit message, no branch, unparseable `finishedAt` → `dur` `""`, `serverName` missing, empty `appName`, `restartOnly` finished/failed. Change 3.
- `Model.notifyPlan` resolution: a `stopped` event whose `obj` is the raw (unjoined) resource yields a non-empty `--exec` URL and a server label when the joined snapshot has them; absent from the snapshot → falls back to `obj` (no `--exec`). Change 3.
- `Model.notifyPlan` argv shape: `argvs.every(a => a[0] === "omarchy-notification-send")`; `--exec` last with one URL element equal to `openUrl`; absent when `openUrl` is `""`; body omitted when empty; `--app-name` plugin id for every non-critical under `dnd: true`, for critical under `dnd: false` and under `dnd: null`; `omarchy-action` only for critical + `dnd: true` (SR16, SR17, SR23). Change 3.
- `Model.notifyPlan` drops × 8 rules, each with a just-inside and just-outside case where a window applies (300 s, 180 s, 120 s, 300 s); rule 7 fires for a resource on an unreachable server and for one whose server has an `unreachable` event in the same batch; rule 8 drops a second `started` for the same uuid within 300 s; `recovered` requires a prior `stopped` key; `suppressed` counts per rule. Change 3.
- `Model.notifyPlan` ordering and caps: 20 resources flip → 3 + one summary; 4 low + 1 `failed` in one flush → the `failed` argv present at `-u critical`; 200 distinct resources over 20 flushes with `sentLastMin` carried → ≤ 12 non-critical per minute, criticals always emitted; a 10-minute flap at 60 s → 2 toasts; `notified` keys stamped for every emitted toast (SR21). Change 3.
- `Model.notifyPlan` log lines: `"<event> <uuid8>"` only, no names; a uuid with a newline → one entry. Change 3.
- `Model.parseRecent`/`serialiseRecent`/`mergeRecent`: round-trip through `state-recent.json`; `state-recent-corrupt.txt` → `rejected:true`; `null`/`""` → `loaded:false, rejected:false`; wrong version; wrong instance key; empty instance key → rejected; non-array; 5 MB text; 10 000 entries → 20; null timestamps dropped; 25 h entry dropped; `url` of `https://evil/x`, `//evil/x`, `javascript:x`, `-private` → `openUrl` `""` after a round-trip; a token-shaped commit message redacted in `text`; `serialiseRecent` with two different `nowMs` → same `key`, different `text`; `mergeRecent` dedupe (memory wins) and ordering (SR18, SR19). Change 3.
- Cancelled fixture: `normaliseDeployment(fx("deployment-cancelled.json")).status === "cancelled-by-user"` and `terminalEvent` → `cancelled`. Change 3.
- `Model.GLYPHS` still contains every glyph `notifyCopy` can emit. Change 3.

## Risks and open questions

Risks accepted:
- A deployment that finishes while the shell is down is never toasted (it appears in Recent at the next fetch). Deliberate: the alternative replays.
- A non-`notify` config edit (`poll`, `url`, token) while a terminal fetch is in flight clears `_terminalQueue` and loses that one terminal toast; persisting the queue is rejected above.
- A failed terminal fetch stalls the drain for the existing 30/60 s `deployment` backoff; a Deployed toast can arrive up to ~90 s late; the retry adds ≤ 2 requests per uuid and cannot burst.
- The 120 s post-terminal grace and the 180 s action window are guesses; steps 4/5 tune them, and a wrong guess costs one spurious or one missed "stopped" toast, never a crash or a duplicate.
- Resource-stop latency is 0–120 s with the panel closed; no kick is added.
- Critical toasts never expire and the shell replays an open one after a restart; the runbook says so.
- The toast argv and the shell's 0644 history files carry labels, branches, commit messages and the instance URL by design; the token never does.
- `omarchy-action` (hybrid) shows as the sender in history for a critical toast delivered under DND.
- With a dead notifications plugin `busctl` fails inside a detached shell; the plugin cannot observe it; the log line is at intent.
- A `_terminalQueue` beyond 20 in one poll drops uuids silently (documented; implausible on a personal account).
- Recent only renders the last hour (`RECENT_MAX_AGE_MS`); a morning restart shows an empty Recent even with a full file; open question 3.
- The toast label diverges from the panel's raw name for git-sourced apps until `appLabel` is applied to the panel (not in scope; recorded in the build record).

Open questions (each with the builder's default; **1 must be answered before Change 3 starts**):
1. **Do Not Disturb.** (a) plugin id everywhere, critical silenced under DND, locks reworded (also deletes `_dnd()`, the `shell` dependency, SR23 and one status field); (b) `omarchy-action` for every critical toast; (c) hybrid: `omarchy-action` only for a critical event while DND is on. **Default: (c).** The security-analyst prefers (a) on contract grounds; confirmed no hole beyond identity loss.
2. **Health-only transitions** (`running:healthy → running:unhealthy`) as a seventh toggle? **Default: no** (prefix-match lock).
3. **`RECENT_MAX_AGE_MS`** stays 1 h now that Recent survives restarts, or rises (24 h)? **Default: stays**; the file keeps 24 h either way; step 10 must run within an hour of a deployment.
4. **Does Dan have SSH to api's server** for a literal `docker stop`? **Default: stop it from the Coolify UI** (equivalent from the plugin's viewpoint).
5. **May the runbook break a api build once** (temporary build-command edit, reverted) to show the critical toast live? **Default: no**; the failed path ships verified by fixture and node tests and is a needs-human row, and roadmap acceptance line 3's critical half stays needs-human.
6. **Self-initiated cancel toast**: suppressed for 300 s after the service's own Cancel (default) or always shown?
7. **Server-outage story**: `"web-1 unreachable · 7 resources down"` (default: the per-resource toasts are folded in, so the count is the only place that information survives) or the bare headline?

## Out of scope

Phase 4 (logs, history, chips, tag deploy, `read:sensitive`), Phase 5, webhooks, notification action buttons, a panel UI for notify settings, controlling DND, sounds, persisting the tracked set or `_failedUnacked`, health-only transitions, changing `RECENT_MAX_AGE_MS`, applying `appLabel` to the panel, a compensating poll, a new endpoint, a new shipped file, a CI workflow, editing `/usr/share/omarchy`, `-r`/`-p` toast replacement.

## Panel record

| member | model | wave | findings | accepted | rejected (reason) |
|---|---|---|---|---|---|
| architect | opus | 1 | 10 (4 crit, 5 warn, 1 nit) | 9 | `omarchy-action` for every critical toast (kept as open question 1's option (b)) |
| reuse-scout | opus | 1 | 12 (3 crit, 7 warn, 2 nit) | 11 | F7 "accept the reset on a notify edit and rehydrate" (live-apply chosen; the rehydrate after other resets is kept); scout agreed in wave 2 |
| security-analyst | opus | 1 | 12 (3 crit, 7 warn, 2 nit) | 12 | — (F7 "never spoof" → open question 1 with dissent recorded; F11 hard error superseded by wave 2) |
| data-analyst | opus | 1 | 12 (3 crit, 6 warn, 3 nit) | 12 | — |
| ux-api-designer | opus | 1 | 15 (4 crit, 10 warn, 1 nit) | 15 | — (non-boolean → silent default rejected in v1, then adopted as warning + default in v2) |
| ops-analyst | opus | 1 | 15 (5 crit, 8 warn, 2 nit) | 15 | — |
| perf-analyst | opus | 1 | 11 (3 crit, 6 warn, 2 nit) | 11 | — |
| code-reviewer | opus | 2 | 12 (2 crit, 8 warn, 2 nit) | 12 | — |
| skeptic | opus | 2 | 12 (2 crit, 8 warn, 2 nit) | 11 | F7 "drop the restarting/restarted rows" (kept: a restart_only deployment reading "Deployed" is wrong; recorded as an addition in Change 9); F9's "blocking question" adopted as "answer before Change 3" with the default kept |
| security-analyst | opus | 2 | 8 (0 crit, 4 warn, 4 nit) | 8 | — |
| reuse-scout | opus | 2 | 6 (1 crit, 3 warn, 2 nit) | 6 | — |
| data-analyst | opus | 2 | 10 (1 crit, 4 warn, 5 nit) | 10 | — |
| ux-api-designer | opus | 2 | 7 (2 crit, 4 warn, 1 nit) | 7 | — |
| ops-analyst | opus | 2 | 12 (3 crit, 8 warn, 1 nit) | 12 | — |
| perf-analyst | opus | 2 | 7 (1 crit, 4 warn, 2 nit) | 7 | — |

Panel: the five minimum plus `data-analyst` (persistence), `ux-api-designer` (copy and config contract), `ops-analyst` (config, rollout, runbook), `perf-analyst` (budget lock, toast cost). Panel model Opus (named in the ask). Deviation: wave-2 members read draft v1 from the plan file (70 KB) rather than receiving it inline, as in the Phase 2 run. No third loop: every wave-2 critical was step-level (flush-time object resolution, the `p.arg` contract, cap ordering, the config warning channel, runbook preconditions), not a design change; the one design-level disagreement (DND) is open question 1 with a default.
