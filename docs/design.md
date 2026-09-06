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
   panel scrolls.

## Bar icon

`BarIconButton` with a Nerd Font glyph. Phase 1 uses the Material cloud outline
`󰅟` (U+F015F); a Coolify mark as a `Shape` (`Mark.qml`, like omasnitch) can replace it
later if the glyph reads badly at 13 px.

| State | Rendering | Tooltip |
|---|---|---|
| Not configured | `dimmed: true` | "Omarify — no config at ~/.config/omarify/config.json" |
| Offline / token rejected | `dimmed: true` | "Omarify — <error>" |
| Idle | normal | "Coolify Cloud — 3 servers · 14 resources" |
| Deploying | `active: true` (urgent colour). The glyph stays the cloud; `active` is the signal. A caption count ("2") appears beside it when more than one deployment is active. | "Deploying api (1m 20s)" |
| Failed, unacknowledged | `active: true` until the panel opens | "Deployment failed: api" |
| Unreachable server | `active: true` | "web-1 unreachable" |

Clicks: left toggles the panel, middle cycles instances, right opens the instance in
the browser. Wheel does nothing.

## Panel anatomy

Width `Style.space(380)`, height fitted to content and capped at `Style.space(640)`.
Card padding is the `KeyboardPanel` default. Column spacing `Style.space(12)`.

```
┌──────────────────────────────────────────────────┐
│ 󰅟  Coolify Cloud                     [ v4.3.17 ] │  PanelHero: title, detail pill
│     3 SERVERS · 14 RESOURCES · 1 DEPLOYING        │  meta line (uppercase caption)
│                                                   │
│ [ Cloud ] [ Homelab ]                             │  instance chips, only if > 1
│ ───────────────────────────────────────────────── │
│ DEPLOYMENTS                                       │  PanelSectionHeader
│ 󰦖 api          main · fix login redirect   1m 20s │  active: spinner, name, commit, elapsed
│ 󰔟 worker       queued                             │  queued
│ 󰄬 web          finished                    4m ago │  recent terminal (dimmed)
│ 󰅙 cron         failed                     12m ago │  failed in urgent
│ ───────────────────────────────────────────────── │
│ SERVERS                                           │
│ ● web-1        7 resources · proxy running        │  ● foreground = reachable
│ ○ build-1      build server                       │  ○ dim = unreachable/disabled
│ ───────────────────────────────────────────────── │
│ RESOURCES                        by project ▾     │  header + grouping toggle
│ ▾ storefront / production                    │  project / environment fold
│   ● api        running · healthy                  │  resource row
│   ● postgres   running                            │
│   ○ worker     exited                             │  exited → dim
│   ◐ web        restarting                         │  degraded/restarting → urgent
│     [Deploy] [Redeploy] [Restart] [Stop] [Open]   │  action row when expanded
│ ▸ sandbox / staging                               │
│ ───────────────────────────────────────────────── │
│ enter expand · d deploy · x cancel · r refresh    │  footer hints, caption, dim
└──────────────────────────────────────────────────┘
```

### Hero

`PanelHero` with `title` = instance name, `meta` = the summary line, `detail` = Coolify
version, `iconComponent` = the same glyph or mark as the bar. When there is an error,
`meta` becomes the error ("TOKEN REJECTED", "OFFLINE, RETRYING") and the icon opacity
drops to 0.45, exactly as omasnitch does for "daemon offline". `trailingControl` is a
refresh `PanelActionButton` (`󰑐`) that spins while a poll is in flight.

### Instance chips

Row of bordered `Button`s, one per instance, `selected` on the current one, hidden when
there is a single instance. `h`/`l` switch when the cursor is on the hero. Same
pattern as the agents provider switch.

### Deployments section

Rows are `CursorSurface`s. Left glyph by status: `󰦖` in progress (accent), `󰔟`
queued (dim), `󰄬` finished (dim), `󰅙` failed (urgent), `󰜺` cancelled (dim). Name in
body weight, commit message in caption dim, right-aligned elapsed or age. Expanded row
shows an action row: **Cancel** (only while queued or in progress, urgent hover),
**Logs** (Phase 4), **Open**. The section shows all active plus the last 5 terminal
deployments; "show more" is a Phase 4 concern.

Elapsed time ticks every second while the panel is open (a `Timer` on `root.opened`),
formatted `1m 20s`, `45s`, `2h 03m`.

### Servers section

Row per server: dot glyph, name, caption "N resources · proxy running". Unreachable
and disabled servers dim the whole row; unreachable adds "unreachable" in urgent.
Expanded row: **Validate**, **Open**, and the resources on that server when grouping by
server is off.

### Resources section

Header row pairs `PanelSectionHeader "RESOURCES"` with a right-aligned `Dropdown`-less
toggle text "by project ▾ / by server ▾" (it is a `Button` with `bordered: false`).
Grouping folds are `▾ / ▸` rows like omasnitch's System fold. Resource rows:

- Dot: `●` running (foreground), `◐` starting/restarting/degraded (urgent), `○`
  exited/paused (dim), `◌` unknown.
- Name bold body, status words in caption: "running · healthy", "exited", "restarting",
  or the pending verb in accent: "deploying…", "stopping…".
- Kind hint on the right in caption dim: `app`, `service`, `postgres`, `redis`.

Expanded row shows the action row. Actions that do not apply are hidden, not disabled:
Stop hides when exited, Start hides when running, Redeploy only on applications.

### Action row

`Row` of `Button { bordered: true; fontSize: Style.font.bodySmall }` with equal cell
width. `h`/`l` move between them when the cursor is on the expanded row; Enter
activates. Destructive buttons (Stop, Cancel, Redeploy) use `hoverColor: bar.urgent`.

### Confirm dialog

`ConfirmDialog` inside the panel: "Stop api?" / "Rebuild api without cache?" with Cancel
and an urgent-tinted Confirm. Its `handleKey` runs first in the key catcher.

### Status line

A single caption line under the hero, visible for 2.2 s after an action: "Deployment
queued", "Token lacks the deploy permission", "Coolify said: Application is not
running." Mirrors the tailscale `actionStatus`.

### Footer

Caption, dim: the three or four most useful keys for the current cursor position.

## Keyboard map

| Key | Where | Action |
|---|---|---|
| `j` / `k`, arrows | anywhere | move cursor down / up through hero, chips, rows |
| `h` / `l` | hero | previous / next instance |
| `h` / `l` | expanded row | previous / next action button |
| Enter, Space | row | expand / collapse; on a button, press it |
| `d` | resource row | deploy |
| `D` | resource row | redeploy without cache (confirm) |
| `s` | resource row | stop (confirm) or start, whichever applies |
| `t` | resource row | restart |
| `x` | deployment row | cancel (confirm) |
| `o` | any row | open in browser |
| `g` | resources header | toggle grouping |
| `r` | anywhere | refresh now |
| `v` | server row | validate |
| Tab / Shift+Tab | anywhere | neighbouring bar panel |
| Esc | anywhere | close confirm, else collapse row, else close panel |

Mouse: hover moves the cursor (never colours from `containsMouse`), click activates,
right-click on a row opens it in the browser.

## Loading, empty and error states

| Situation | Hero meta | Body |
|---|---|---|
| First poll after open | "LOADING" | sections render with what is known; spinner in hero |
| No config file | "NOT CONFIGURED" | one paragraph: path, and a three-line sample |
| Config unreadable / bad JSON | "CONFIG ERROR" | the parse error, plain text |
| 401 | "TOKEN REJECTED" | "Create a token in Coolify → Security → API Tokens with read and deploy." |
| 403 API disabled | "API DISABLED" | "Enable it in Settings → Advanced → API Access." |
| 403 ability | normal | inline status line naming the missing ability when an action fails |
| curl failure | "OFFLINE · RETRYING" | last snapshot stays, ages shown |
| 429 | "RATE LIMITED" | "Backing off 30 s." |
| No deployments | — | "Nothing deploying." |
| No resources | — | "No resources on this team." |

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

- Panel width `Style.space(380)`, cap `Style.space(640)`.
- Row height: content + `Style.spacing.xl`; inset `Style.space(8)`; inner gap `Style.space(10)`.
- Section header `PanelSectionHeader`; separators `PanelSeparator`.
- Meters (Phase 5 utilisation): the agents `Meter`, track `Style.selectedFillFor`, fill
  foreground, height `max(space(4), controlHeight * 0.14)`.
- Fonts: hero title `Style.font.title`, rows `Style.font.body`, captions
  `Style.font.caption`, glyphs `Style.font.title` in a `Style.space(22)` box.

## Theme check

Verify against at least three shipped themes (one light, one high-contrast, one with
`cornerRadius: 0`) and with `[font] base-size = 14`. Nothing may clip and no colour may
come from anywhere but the tokens above.
