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
instance in the browser (Phase 2). Wheel does nothing.

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

Rows are `CursorSurface`s. Left glyph by status: `󰦖` in progress (accent), `󰔟`
queued (dim), `󰄬` finished (dim), `󰅙` failed (urgent), `󰜺` cancelled (dim). Name in
body weight, "branch · commit message" in caption dim (the branch is the joined
application's `git_branch`; the first seven characters of the commit when the join
misses), right-aligned elapsed or age. Expanded row (Phase 2) shows an action row:
**Cancel** (only while queued or in progress, urgent hover), **Logs** (Phase 4),
**Open**. The section shows all active plus the newest 5 terminal deployments; "show
more" is a Phase 4 concern.

Elapsed time ticks every second while the panel is open (a `Timer` on `root.opened`),
formatted `1m 20s`, `45s`, `2h 03m`.

### Servers section

Row per server: dot glyph (`●` reachable and usable, `󱎖` reachable but not usable,
`○` unreachable or disabled), name, caption "<ip> · N resources" plus "unreachable"
in urgent, "disabled", "build server" as they apply. Unreachable and disabled servers
dim the whole row. Proxy status and `unreachable_count` need `GET /servers/{uuid}` per
server and arrive with Validate in Phase 2. Expanded row (Phase 2): **Validate**,
**Open**, and the resources on that server when grouping by server is off.

### Resources section

Header row pairs `PanelSectionHeader "RESOURCES"` with a right-aligned
`ButtonGroup { options: [by project, by server]; focusable: false }` (the network
panel's header-plus-control pairing, with the `topPadding / 2` vertical offset). `g`
toggles the same property. Grouping folds are `▾ / ▸` rows like omasnitch's System
fold; a resource whose environment is unknown lands in an "Ungrouped" fold. Resource
rows:

- Dot: `●` running (foreground), `󱎖` (U+F1396) starting/restarting/degraded (urgent),
  `○` exited/paused (dim), `◌` unknown. `◐` U+25D0 is not in JetBrainsMono Nerd Font.
- Name bold body, status words in caption: "running · healthy", "exited", "restarting",
  or (Phase 2) the pending verb in accent: "deploying…", "stopping…".
- Kind hint on the right in caption dim: `app`, `service`, `postgres`, `redis`.

Expanded row (Phase 2) shows the action row. Actions that do not apply are hidden, not disabled:
Stop hides when exited, Start hides when running, Redeploy only on applications.

### Action row (Phase 2)

`Row` of `Button { bordered: true; fontSize: Style.font.bodySmall }` with equal cell
width. `h`/`l` move between them when the cursor is on the expanded row; Enter
activates. Destructive buttons (Stop, Cancel, Redeploy) use `hoverColor: bar.urgent`.

### Confirm dialog (Phase 2)

`ConfirmDialog` inside the panel: "Stop api?" / "Rebuild api without cache?" with Cancel
and an urgent-tinted Confirm. Its `handleKey` runs first in the key catcher.

### Status line (Phase 2)

A single caption line under the hero, visible for 2.2 s after an action: "Deployment
queued", "Token lacks the deploy permission", "Coolify said: Application is not
running." Mirrors the tailscale `actionStatus`.

### Footer

Caption, dim: the three or four most useful keys for the current cursor position.
Phase 1: hero "enter refresh · j down · r refresh · esc close"; fold row "j/k move ·
enter fold · g group · r refresh · esc close"; leaf row "j/k move · g group · r refresh
· esc close".

## Keyboard map

`PanelKeyCatcher` owns the keys: `x` arrives as `deleteRequested`, Esc as
`closeRequested`, `h`/`l` as `moveRequested(±1, 0)`, Return as `returnRequested` then
`activateRequested` (handle only the latter). Never add a `Keys.onPressed`.

| Key | Where | Action |
|---|---|---|
| `j` / `k`, arrows | anywhere | move cursor down / up through hero, chips, rows; `k` from the first row lands on the hero |
| `h` / `l` | hero | previous / next instance (Phase 4) |
| `h` / `l` | expanded row | previous / next action button (Phase 2) |
| Enter, Space | fold row | expand / collapse |
| Enter, Space | hero | refresh |
| Enter, Space | leaf row | nothing in Phase 1; expand with the action row (Phase 2) |
| `d` | resource row | deploy (Phase 2) |
| `D` | resource row | redeploy without cache (confirm) (Phase 2) |
| `s` | resource row | stop (confirm) or start, whichever applies (Phase 2) |
| `t` | resource row | restart (Phase 2) |
| `x` | deployment row | cancel (confirm) (Phase 2, via `deleteRequested`) |
| `o` | any row | open in browser (Phase 2) |
| `g` | anywhere | toggle grouping |
| `r` | anywhere | refresh now |
| `v` | server row | validate (Phase 2) |
| Tab / Shift+Tab | anywhere | neighbouring bar panel |
| Esc | anywhere | close confirm (Phase 2), else collapse row (Phase 2), else close panel |

Mouse: hover moves the cursor (never colours from `containsMouse`), click activates,
right-click on a row opens it in the browser.

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
| 403 ability | normal | callout naming the missing ability (Phase 2: status line after an action) |
| curl failure | "OFFLINE · RETRYING" | last snapshot stays; "Showing data from N ago." |
| curl exit 63 | "RESPONSE TOO LARGE" | callout |
| 429 | "RATE LIMITED" | "Backing off Ns." |
| other ≥ 400 | "COOLIFY ERROR" | the redacted message |
| One kind failing, others fine | "<KIND> UNAVAILABLE · SHOWING LAST KNOWN" | callout with staleness |
| No deployments | — | "Nothing deploying." |
| No servers | — | "No servers on this team." |
| No resources | — | "No resources on this team." |
| Zero servers and resources with a valid token | "NO RESOURCES ON THIS TEAM" | — |

## Notifications

Toasts use Omarchy's notification style automatically. Copy is short and names the
thing:

| Event | Glyph | Headline | Body | Urgency |
|---|---|---|---|---|
| queued | `󰔟` | Queued api | main · fix login redirect | low |
| started | `󰦖` | Building api | main · fix login redirect | low |
| finished | `󰄬` | Deployed api | 1m 42s · main | normal |
| failed | `󰅙` | Deployment failed: api | 1m 12s · click to open logs | critical |
| cancelled | `󰜺` | Cancelled api | | low |
| resource exited | `󰅙` | api stopped | web-1 · exited | normal |
| server unreachable | `󰅙` | web-1 unreachable | | critical |
| server reachable | `󰄬` | web-1 reachable | | low |

Click action is `omarchy-launch-browser <deployment_url or resource url>`.

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
