# Design

Omarify must be indistinguishable from a first-party Omarchy panel. That is achieved by
building only from `qs.Ui` and `qs.Commons`, taking every colour, size, radius and font
from the shell, and copying the interaction model of the tailscale, network and agents
panels. `docs/omarchy-shell-reference.md` is the component reference.

## Principles

1. **Nothing hardcoded.** Colours from `bar.foreground`, `bar.urgent`, `Color.accent`,
   `Color.popups.*`; sizes from `Style.space()` and `Style.spacing.*`; text from
   `Style.font.*`; radius from `Style.cornerRadius`; font family bound to
   `bar.fontFamily`. Secondary text is `Qt.darker(foreground, 1.4)` (labels) or `1.55`
   (dim).
2. **Status is a word plus a dot, not a colour scheme.** Omarchy themes have one accent
   and one urgent colour. Healthy is foreground, trouble is urgent, in-flight is accent
   with a spinner glyph. No green, no yellow.
3. **Keyboard first.** Everything reachable with j/k/h/l, Enter, letters, Esc. The
   mouse follows the same cursor.
4. **Honest empty states.** No data means a sentence saying why, never a blank.
5. **One panel.** No windows, no tabs beyond the instance chips. Sections stack; the
   panel scrolls. Elements marked "(Phase N)" are end-state spec and ship in that phase.

## Bar icon

`BarIconButton` with a Nerd Font glyph. The configured, healthy icon is the filled
Material cloud `󰅟` (U+F015F, `md-cloud`); the outline `󰅣` (U+F0163) is the
"not configured" ghost. A Coolify mark as a `Shape` (`Mark.qml`, like omasnitch) can
replace it later if the glyph reads badly at 13 px. The bar has one accent colour
(`bar.urgent`) and one opacity lever (`dimmed`), so the glyph is what tells the error
states apart. No count caption: `BarIconButton` has no badge slot and a hand-rolled row
loses the click registration that swaps panels. The count lives in the tooltip.

First matching row wins (`Model.barState`):

| # | State | Selector | Glyph | `dimmed` | `active` | Tooltip |
|---|---|---|---|---|---|---|
| 1 | Not configured | no config file | `󰅣` F0163 | yes | no | "Omarify — no config at ~/.config/omarify/config.json" |
| 2 | Config error / unsafe | bad JSON, invalid, or writable by others | `󰧠` F09E0 | yes | no | "Omarify — config error: <first line>" / "Omarify — config is writable by others" |
| 3 | Token unavailable | `tokenCommand` failed | `󰧠` | yes | no | "Omarify — token command failed (exit N)" |
| 4 | Waiting for token | `tokenCommand` running | `󰅟` | yes | no | "Omarify — waiting for token command" |
| 5 | Token rejected | 401 | `󰧠` | yes | no | "Omarify — token rejected" |
| 6 | API disabled / IP blocked | 403 | `󰧠` | yes | no | "Omarify — API disabled on this instance" / "Omarify — this IP is not allowed" |
| 7 | Offline | curl exit 6/7/28/35/60 | `󰅤` F0164 | yes | no | "Omarify — offline, retrying" |
| 8 | Rate limited | 429 | `󰅟` | yes | no | "Omarify — rate limited, backing off Ns" |
| 9 | Starting | no baseline yet | `󰅟` | yes | no | "Omarify — starting" |
| 10 | Failed, unacknowledged | a failure landed while no panel was open | `󰅙` F0159 | no | **yes** | "Deployment failed: api" (+ " +N more") |
| 11 | Server unreachable | any reachable=false, not disabled | `󰅤` | no | **yes** | "web-1 unreachable" (+ " +N more") |
| 12 | Deploying | any queued / in_progress | `󰦖` F0996 | no | **yes** | "Deploying api" / "N deployments running" |
| 13 | Partial | one kind failing, data present | `󰅟` | no | no | "Coolify Cloud — 3 servers · 14 resources (servers unavailable)" |
| 14 | Idle | | `󰅟` | no | no | "Coolify Cloud — 3 servers · 14 resources" / "Coolify Cloud — no resources" |

Opening any panel acknowledges failures; a failure that lands while a panel is open is
already seen and never sets row 10.

Clicks: left toggles the panel; middle cycles instances (Phase 4); right opens the
instance in the browser. Wheel does nothing.

## Panel anatomy

Width `Style.space(380)`, height fitted to content and capped at `Style.space(640)`.
Card padding is the `KeyboardPanel` default. Column spacing `Style.space(12)`.

```
┌──────────────────────────────────────────────────┐
│ 󰅟  Coolify Cloud                     [ v4.3.17 ] │  PanelHero: title, detail pill
│     3 SERVERS · 14 RESOURCES · 1 DEPLOYING        │  meta line (uppercase caption)
│                                                   │
│ [ Cloud ] [ Homelab ]                             │  instance chips, only if > 1 (Phase 4)
│ ───────────────────────────────────────────────── │
│ DEPLOYMENTS                                       │  PanelSectionHeader
│ 󰦖 api          main · fix login redirect   1m 20s │  active: spinner, name, commit, elapsed
│ 󰔟 worker       queued                             │  queued
│ 󰄬 web          finished                    4m ago │  recent terminal (dimmed)
│ 󰅙 cron         failed                     12m ago │  failed in urgent
│ ───────────────────────────────────────────────── │
│ SERVERS                                           │
│ ● web-1        10.0.0.4 · 7 resources             │  ● foreground = reachable
│ ○ build-1      build server                       │  ○ dim = unreachable/disabled
│ ───────────────────────────────────────────────── │
│ RESOURCES              [by project][by server]    │  header + ButtonGroup toggle
│ ▾ storefront / production                    │  project / environment fold
│   ● api        running · healthy                  │  resource row
│   ● postgres   running                            │
│   ○ worker     exited                             │  exited → dim
│   󱎖 web        restarting                         │  degraded/restarting → urgent
│     [Deploy] [Redeploy] [Restart] [Stop] [Open]   │  action row when expanded (Phase 2)
│ ▸ sandbox / staging                               │
│ ───────────────────────────────────────────────── │
│ j/k move · enter fold · g group · r refresh       │  footer hints, caption, dim (Phase 1 keys)
└──────────────────────────────────────────────────┘
```

### Hero

`PanelHero` with `title` = instance name, `meta` = the summary line, `detail` = Coolify
version, `iconComponent` = the same glyph or mark as the bar. When there is an error,
`meta` becomes the error ("TOKEN REJECTED", "OFFLINE · RETRYING") and the icon opacity
drops to 0.45, exactly as omasnitch does for "daemon offline". `trailingControl` is a
refresh `Button { bordered: false; iconText: "󰑐"; iconSpinning: busy }` (the component
already has the spin; `PanelActionButton` does not) with `hasCursor` bound to the hero
cursor and `onHovered` focusing it, so `k` from the first row lands somewhere visible.

Hero `meta` per state (mixed case; the component uppercases): healthy
"3 servers · 14 resources · 1 deploying" (zero clauses dropped); empty account
"No resources on this team"; starting "Loading"; then per error kind: "Not configured",
"Config error", "Config unsafe", "Token unavailable", "Waiting for token",
"Token rejected", "API disabled", "IP not allowed", "Offline · retrying",
"Rate limited", "Response too large", "Coolify error"; partial
"<kind> unavailable · showing last known". Warnings never touch `meta`.

### Callout

A `BorderSurface` under the hero (the agents panel's callout tint), shown only when
there is an error or a warning, carrying the body text below and, when the data on
screen is stale, "Showing data from 3m ago." Healthy panels show no callout.

| Kind | Body |
|---|---|
| no config | "Create ~/.config/omarify/config.json (chmod 600):" + the three-line sample |
| config error | the parse or validation error, plain text |
| config unsafe | "Anyone on this machine can rewrite it. Run: chmod 600 ~/.config/omarify/config.json" |
| permissions (warning) | "Anyone on this machine can read your token. Run: chmod 600 ~/.config/omarify/config.json" |
| plaintext (warning) | "This instance is http://, so the token crosses the network in the clear." |
| token command failed | "The token command exited N. Its output is never logged; run it yourself to see why." |
| waiting for token | "Running the token command…" |
| 401 | "Create a token in Coolify → Security → API Tokens with the read ability." |
| 403 API disabled | "Enable it in Settings → Advanced → API Access." |
| 403 IP | "Add this machine's IP to the token's allowed list in Coolify → Security → API Tokens." |
| 403 ability | "The token is missing the <ability> ability." |
| 429 | "Backing off Ns." |
| offline | "Retrying." |
| too large | "Coolify's response exceeded 8 MB and was dropped." |
| other HTTP | the redacted Coolify message, else "Coolify returned <code>." |
| partial | "<kind> is unavailable." |

### Instance chips (Phase 4)

Row of bordered `Button`s, one per instance, `selected` on the current one, hidden when
there is a single instance. `h`/`l` switch when the cursor is on the hero. Same
pattern as the agents provider switch.

### Deployments section

Rows are `CursorSurface`s. Left glyph by status: `󰦖` in progress (`bar.urgent`, the bar's own signal colour), `󰔟`
queued (dim), `󰄬` finished (dim), `󰅙` failed (`Color.accent`: red in Aetheria while `bar.urgent` is yellow-green), `󰜺` cancelled (dim). Name in
body weight, "branch · commit message" in caption dim (the branch is the joined
application's `git_branch`; the first seven characters of the commit when the join
misses), right-aligned elapsed or age. Expanded row (Phase 2) shows an action row:
**Cancel** (only while queued or in progress; `foreground: root.urgent`), **Logs** (Phase 4),
**Open**. A pending cancel appends " · cancelling…" to the caption in accent. The section shows all active plus the newest 5 terminal deployments from the
last hour; older ones drop out on their own (Phase 3 persists them across restarts, Phase 4
adds history and "show more").

Elapsed time ticks every second while the panel is open (a `Timer` on `root.opened`),
formatted `1m 20s`, `45s`, `2h 03m`.

### Servers section

Row per server: dot glyph (`●` reachable and usable, `󱎖` reachable but not usable,
`○` unreachable or disabled), name, caption "<ip> · N resources" plus "unreachable"
in urgent, "disabled", "build server" as they apply. Unreachable and disabled servers
dim the whole row. Proxy status and `unreachable_count` need `GET /servers/{uuid}` per
server and are deferred to Phase 4. Expanded row: **Validate**, **Open**. A pending
validate appends " · validating…" to the caption in accent and clears on the next
servers poll (the API exposes no result).

### Resources section

Header row pairs `PanelSectionHeader "RESOURCES"` with a right-aligned
`ButtonGroup { options: [by project, by server]; focusable: false }` (the network
panel's header-plus-control pairing, with the `topPadding / 2` vertical offset). `g`
toggles the same property. Grouping folds are `▾ / ▸` rows like omasnitch's System
fold; a resource whose environment is unknown lands in an "Ungrouped" fold, titled
"Ungrouped · loading" while the topology blocks are still arriving after a start (a
minute or so with a panel open, five with it closed). Resource rows:

- Dot: `●` running (foreground), `󱎖` (U+F1396) starting/restarting/degraded (urgent),
  `○` exited/paused (dim), `◌` unknown. `◐` U+25D0 is not in JetBrainsMono Nerd Font.
- Name bold body, status words in caption: "running · healthy", "exited", "restarting",
  or the pending verb in accent with the half glyph: "deploying…", "rebuilding…",
  "restarting…", "stopping…", "starting…" ("stopping… · still pending" after 150 s).
- Kind hint on the right in caption dim: `app`, `service`, `postgres`, `redis`.

Enter (or `l`) on a leaf row emits a non-selectable action strip under it. Actions that
do not apply are hidden, not disabled: applications running → Redeploy · Restart ·
Stop · Open (the no-cache rebuild is keyboard-only, `D`, and confirms); applications
stopped → Deploy · Start · Open (Deploy brings it up, Redeploy rebuilds a running one;
both are `POST /deploy`); services and databases → Restart · Stop · Open or Start ·
Open; unknown state → Open;
servers → Validate · Open; active deployments → Cancel · Open; terminal → Open. Open is
present only when a Coolify page URL can be built (it arrives with the topology, about
a minute after start).

### Action row (Phase 2)

`Row` of `Button { bordered: true; focusable: false; fontSize: Style.font.bodySmall }`
with content-derived widths. `h`/`l` move between them (an id, not an index, so a
button that disappears hands focus to the first); Enter runs. While a button is ringed
the parent row paints `CursorSurface.current`. Destructive buttons (Stop, Cancel,
Redeploy) use `foreground: root.urgent`, which tints the label and the hover fill;
`Button` has no hover-colour property.

### Confirm dialog (Phase 2)

`ConfirmDialog` as a sibling of the key catcher inside the `KeyboardPanel` (it fills the
card above every row): "Stop api?" (Cancel / Stop), "Rebuild api without cache?"
(Cancel / Rebuild), "Cancel the deployment of api?" (Keep it / Cancel it). Cancel is
preselected on open and again when the dialog arms 250 ms later (the component moves
selection on hover); Enter resolves it only once armed. It is driven from the catcher's
signals (`h`/`l` toggle, Enter resolves, Esc cancels, every other key is swallowed);
its raw key-event function is never called.

### Status line (Phase 2)

A single caption line between the hero and the callout, dim for 2.2 s after a success
("Deployment queued", "Stop requested", "Deployment cancelled", "Validation started")
or a dim refusal ("api is already stopping", "Busy, try again", "Nothing to start" when a
verb does not apply to the target, which the CLI can trigger), urgent for 6 s after a
failure ("Coolify no longer has that resource|deployment|server" when the target vanished
before dispatch, "Too many requests · try again shortly", "Rate limited · backing off Ns",
"Not configured", "Config is unsafe", "Token rejected") or after a Coolify answer ("Token lacks the deploy permission", "Coolify said: Deployment cannot be
cancelled. Current status: finished", "Coolify's build queue is full", "Coolify is
unreachable", "Sent, but Coolify did not answer"). Mirrors the tailscale
`actionStatus`. A 403 ability from a poll still uses the callout; from an action it is
only this line.

### Footer

Caption, dim: the most useful keys for the current cursor position (`Model.footerHints`;
`o open` only when the row has a page URL).

| Cursor position | Hint |
|---|---|
| hero | `enter refresh · j down · r refresh · esc close` |
| fold row | `j/k move · enter fold · g group · r refresh · esc close` |
| application row, running, collapsed | `enter actions · d redeploy · s stop · t restart · o open` |
| application row, stopped, collapsed | `enter actions · d deploy · s start · o open` |
| service/database row, collapsed | `enter actions · s stop · t restart · o open` (or `s start`) |
| any row expanded, a button focused | `h/l pick · enter run · esc collapse` |
| any row expanded, focus back on the row | `l pick · enter collapse · esc collapse` |
| server row | `enter actions · v validate · o open` |
| active deployment row | `enter actions · x cancel · o open` |
| terminal deployment row | `o open · j/k move` |
| row with no action and no page | `j/k move · g group · r refresh · esc close` |
| confirm open | `h/l pick · enter confirm · esc cancel` |

## Keyboard map

`PanelKeyCatcher` owns the keys: `x` arrives as `deleteRequested`, Esc as
`closeRequested`, `h`/`l` as `moveRequested(±1, 0)`, Return as `returnRequested` then
`activateRequested` (handle only the latter). Never add a `Keys.onPressed`.

| Key | Where | Action |
|---|---|---|
| `j` / `k`, arrows | anywhere | move cursor down / up through hero, chips, rows; `k` from the first row lands on the hero |
| `h` / `l` | hero | previous / next instance (Phase 4) |
| `h` / `l` | fold row | fold / unfold |
| `l` | collapsed leaf row | expand and focus the first action |
| `h` / `l` | action button | previous / next button; `h` on the first returns to the row |
| `h` | expanded row, no button focused | collapse |
| Enter, Space | fold row | expand / collapse |
| Enter, Space | hero | refresh |
| Enter, Space | leaf row | expand (first button focused); on an expanded row: run the focused button, or collapse |
| `d` | application row | deploy a stopped application, redeploy a running one |
| `D` | running application row | rebuild without cache (confirm); the one case-sensitive pair |
| `s` / `S` | resource row | stop (confirm) or start, whichever applies |
| `t` / `T` | resource row | restart |
| `x` / `X` | active deployment row | cancel (confirm) (via `deleteRequested`; a no-op elsewhere) |
| `o` / `O` | any row with a page | open in browser |
| `g` | anywhere | toggle grouping |
| `r` | anywhere | refresh now |
| `v` / `V` | server row | validate |
| Tab / Shift+Tab | anywhere, confirm closed | neighbouring bar panel |
| Esc | anywhere | close confirm, else collapse row, else close panel; one rung per 250 ms |

Mouse: hover moves the cursor (never colours from `containsMouse`); a left click on a
leaf row opens its action strip (or closes the open one) and the strip's buttons are
clickable; a click on a fold row folds; right-click on a row opens it in the browser.

## Loading, empty and error states

Bodies are in the Callout table above. Precedence: config > token > auth > network >
partial > loading > healthy.

| Situation | Hero meta | Body |
|---|---|---|
| Starting, no poll finished | "LOADING" | sections render with what is known; spinner in hero |
| No config file | "NOT CONFIGURED" | callout: path and a three-line sample |
| Config unreadable / bad JSON / invalid | "CONFIG ERROR" | callout: the error, plain text |
| Config writable by others or foreign-owned | "CONFIG UNSAFE" | callout; polling stops |
| Config readable by others, inline token | healthy meta | warning callout; polling continues |
| `tokenCommand` running | "WAITING FOR TOKEN" | callout |
| `tokenCommand` failed | "TOKEN UNAVAILABLE" | callout with the exit code |
| 401 | "TOKEN REJECTED" | "Create a token in Coolify → Security → API Tokens with the read ability." |
| 403 API disabled | "API DISABLED" | "Enable it in Settings → Advanced → API Access." |
| 403 IP not allowed | "IP NOT ALLOWED" | callout |
| 403 ability | normal | from a poll: callout naming the missing ability; from an action: the status line only |
| curl failure | "OFFLINE · RETRYING" | last snapshot stays; "Showing data from N ago." |
| curl exit 63 | "RESPONSE TOO LARGE" | callout |
| 429 | "RATE LIMITED" | "Backing off Ns." |
| other ≥ 400 | "COOLIFY ERROR" | the redacted message |
| One kind failing, others fine | "<KIND> UNAVAILABLE · SHOWING LAST KNOWN" | callout with staleness |
| A section that has never loaded while an error is up | — | "Not loaded yet." |
| No deployments | — | "Nothing deploying." |
| No servers | — | "No servers on this team." |
| No resources | — | "No resources on this team." |
| Zero servers and resources with a valid token | "NO RESOURCES ON THIS TEAM" | — |

## Notifications

Toasts use Omarchy's notification style automatically. Copy is short and names the
thing:

`A` is `Model.appLabel(name, uuid)`: Coolify's generated `:<branch>-<uuid>` suffix
stripped (`storefront:main-h0wx…` → `storefront`), elided to 32, the uuid's
first 8 characters when the name is empty or is Coolify's generated `<uuid>-<digits>`
shape for an unnamed app (`xyhpwdxqu33omjgwuo6c7cjp-200537415987` → `xyhpwdxq`, which
matches the log lines). One rule for every toast; the panel still shows the raw name. `dur` is `createdAt → finishedAt` ("1m 42s"), empty when either is
unparseable; `sub` is the panel's `branch · commit message`. Headlines are elided at 72,
bodies at 96 (the toast text box is 304 px). An empty body is omitted, which gives the
compact one-line toast.

| Event | Toggle | Glyph | Headline | Body | Urgency | Click |
|---|---|---|---|---|---|---|
| queued | deploymentQueued | `󰔟` | Queued A | sub | low | deployment |
| started | deploymentStarted | `󰦖` | Building A | sub | low | deployment |
| restarting (`restart_only`) | deploymentStarted | `󰦖` | Restarting A | server | low | deployment |
| finished | deploymentFinished | `󰄬` | Deployed A | dur · branch | normal | deployment |
| restarted (`restart_only`) | deploymentFinished | `󰄬` | Restarted A | dur | normal | deployment |
| failed | deploymentFailed | `󰅙` | Deployment failed: A (Restart failed: A) | dur · click to open in Coolify (dur · branch without a page) | **critical** | deployment |
| cancelled | deploymentFinished | `󰜺` | Cancelled A | | low | deployment |
| resource stopped | resourceStateChanged | `󰅙` | A stopped | server · exited | normal | resource page, once topology has loaded |
| resource degraded | resourceStateChanged | `󱎖` | A degraded | server · degraded | normal | resource |
| resource recovered | resourceStateChanged | `󰄬` | A running | server · running | low | resource |
| resources summary | resourceStateChanged | `󰅙` | N more resources stopped | server when all share one | normal | none |
| server unreachable | serverReachability | `󰅙` | A unreachable | N resources down | **critical** | server |
| server reachable | serverReachability | `󰄬` | A reachable | | low | server |

The restart rows, `degraded`, `recovered` and the summary row are Phase 3 additions to
the original eight (a `restart_only` deployment reading "Deployed" would be wrong;
`degraded` is owed by the product brief; `recovered` pairs the resource events the way
the server events pair and fires only after a stopped/degraded toast within the hour;
the summary is the volume bound). A resource toast has no click target until the
topology join has given the resource a project and environment (minutes after a start);
the server toast's "N resources down" and the server-down correlation depend on the same
join, so before it completes an unreachable toast has no body and per-resource stops are
not folded into it.
A "stopped" toast lands 0–120 s after the container stopped with the panel closed
(Coolify's status sweep plus the resources interval). Under Do Not Disturb every toast
goes to history unshown, except a critical one, which is sent as `omarchy-action` and
shown (see `docs/architecture.md`). Critical toasts never expire, and the notifications
plugin replays one still on screen after a shell restart.

Click action is `omarchy-launch-browser <url>` with the URL from `Model.openUrl`, passed
as the notifier's `--exec` tail; no URL, no `--exec`.

## Sizes and tokens used

- Panel width `Style.space(380)`, desired height `Style.space(480)`, cap `Style.space(640)`, via `KeyboardPanel.fittedContentHeight`.
- Row height: content + `Style.spacing.rowPaddingX` (every first-party row; `spacing.xl` is card padding); inset `Style.space(8)`; inner gap `Style.space(10)`.
- Section header `PanelSectionHeader`; separators `PanelSeparator`.
- Meters (Phase 5 utilisation): the agents `Meter`, track `Style.selectedFillFor`, fill
  foreground, height `max(space(4), controlHeight * 0.14)`.
- Fonts: hero title `Style.font.title`, rows `Style.font.body`, captions
  `Style.font.caption`, glyphs `Style.font.title` in a `Style.space(22)` box.

## Theme check

Verify against at least three shipped themes (one light, one high-contrast, one with
`cornerRadius: 0`) and with `[font] base-size = 14`. Nothing may clip and no colour may
come from anywhere but the tokens above.
