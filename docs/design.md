# Design

Coolwatch must be indistinguishable from a first-party Omarchy panel. That is achieved by
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
| 1 | Not configured | no config file | `󰅣` F0163 | yes | no | "Coolwatch — no config at ~/.config/coolwatch/config.json" |
| 2 | Config error / unsafe | bad JSON, invalid, or writable by others | `󰧠` F09E0 | yes | no | "Coolwatch — config error: <first line>" / "Coolwatch — config is writable by others" |
| 3 | Token unavailable | `tokenCommand` failed | `󰧠` | yes | no | "Coolwatch — token command failed (exit N)" |
| 4 | Waiting for token | `tokenCommand` running | `󰅟` | yes | no | "Coolwatch — waiting for token command" |
| 5 | Token rejected | 401 | `󰧠` | yes | no | "Coolwatch — token rejected" |
| 6 | API disabled / IP blocked | 403 | `󰧠` | yes | no | "Coolwatch — API disabled on this instance" / "Coolwatch — this IP is not allowed" |
| 7 | Offline | curl exit 6/7/28/35 | `󰅤` F0164 | yes | no | "Coolwatch — offline, retrying" |
| 7b | Certificate rejected (Phase 4) | curl exit 60 | `󰧠` | yes | no | "Coolwatch — certificate rejected, retrying" |
| 8 | Rate limited | 429 | `󰅟` | yes | no | "Coolwatch — rate limited, backing off Ns" |
| 9 | Starting | no baseline yet | `󰅟` | yes | no | "Coolwatch — starting" |
| 10 | Failed, unacknowledged | a failure landed while no panel was open | `󰅙` F0159 | no | **yes** | "Deployment failed: api" (+ " +N more") |
| 11 | Server unreachable | any reachable=false, not disabled | `󰅤` | no | **yes** | "web-1 unreachable" (+ " +N more") |
| 12 | Deploying | any queued / in_progress | `󰦖` F0996 | no | **yes** | "Deploying api" / "N deployments running" |
| 13 | Partial | one kind failing, data present | `󰅟` | no | no | "Coolify Cloud — 3 servers · 14 resources (servers unavailable)" |
| 14 | Idle | | `󰅟` | no | no | "Coolify Cloud — 3 servers · 14 resources" / "Coolify Cloud — no resources" |

Opening any panel acknowledges failures; a failure that lands while a panel is open is
already seen and never sets row 10.

Clicks: left toggles the panel; middle cycles instances (Phase 4); right opens the
instance in the browser. Wheel does nothing. With two or more instances the icon is the
**current** instance's row and the tooltip gains ` · <other instance>: <trouble>` for the
first other instance in trouble (its error kind's title, "N failed builds" or "N servers
unreachable"; `Model.instanceTrouble`); the panel opens on the current instance.

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
│   ● api        healthy                            │  resource row
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
"3 servers · 14 resources · 1 deploying · 1 stopped · 1 unhealthy" (zero clauses dropped;
stopped = exited or paused, unhealthy = running:unhealthy or degraded; the bar tooltip
carries the same line); empty account
"No resources on this team"; starting "Loading"; then per error kind: "Not configured",
"Config error", "Config unsafe", "Token unavailable", "Waiting for token",
"Token rejected", "API disabled", "IP not allowed", "Offline · retrying",
"Rate limited", "Response too large", "Coolify error"; partial
"<kind> unavailable · showing last known". Warnings never touch `meta`.

### Callout

A `BorderSurface` under the hero (the agents panel's callout tint), shown only when
there is an error or a warning, carrying the body text below and, when the data on
screen is stale, "Showing data from 3m ago." Healthy panels show no callout.

An **Edit config** button (bordered, `bodySmall`, no cursor ring; `e` from anywhere in
the list) sits under the body on the callouts the file can fix: no config, config error,
config unsafe, config readable by others, token command failed, token rejected
(`Model.calloutEditable`). It asks the service, which creates the directory (0700) and,
only when no file exists, a sample file (0600, `Model.SAMPLE_CONFIG_FILE`), then runs
`omarchy-launch-config-editor` on it: Omarchy's own low toast and default editor. The
file watcher clears the callout on save. The footer reads `e edit config · …` while the
button shows.

| Kind | Body |
|---|---|
| no config | "Create ~/.config/coolwatch/config.json (chmod 600):" + the three-line sample |
| config error | the parse or validation error, plain text |
| config unsafe | "Anyone on this machine can rewrite it. Run: chmod 600 ~/.config/coolwatch/config.json" |
| permissions (warning) | "Anyone on this machine can read your token. Run: chmod 600 ~/.config/coolwatch/config.json" |
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

Row of bordered `Button`s (`Style.font.bodySmall`), one per instance, `selected` on the
current one, hidden when there is a single instance and under a view. A chip whose
instance is in trouble carries a trailing ` ·` and a "Needs attention" tooltip. Chips never
take the cursor ring (the hero's refresh button owns it): `h`/`l` switch when the cursor is
on the hero, a click switches, a middle-click on the bar icon cycles, and
`omarchy-shell … instance <id>` switches from a terminal. A switch pops every open view and
collapses the expanded row; a confirm dialog left open across a switch is refused by the
service ("Instance changed; nothing sent"). Same pattern as the agents provider switch.

### Deployments section

Rows are `CursorSurface`s. Left glyph by status: `󰦖` in progress (`bar.urgent`, the bar's own signal colour), `󰔟`
queued (dim), `󰄬` finished (dim), `󰅙` failed (`Color.accent`: red in Aetheria while `bar.urgent` is yellow-green), `󰜺` cancelled (dim). Name in
body weight, "branch · commit message" in caption dim (the branch is the joined
application's `git_branch`; the first seven characters of the commit when the join
misses), right-aligned elapsed or age. Expanded row (Phase 2) shows an action row:
**Logs** first (Phase 4; `L` is the direct key, so Enter, Enter reaches the build log),
**Cancel** (only while queued or in progress; `foreground: root.urgent`) or **Dismiss** (a
terminal row; `x` does the same), **Open**. A pending cancel appends " · cancelling…" to the caption in accent. The section shows all active plus the newest 5 terminal deployments from the
last hour; older ones drop out on their own (Phase 3 persists them across restarts; the
history view below, reached from an application's strip, holds the rest). It never goes
blank while there is an outcome to show (Phase 4b): with nothing active and nothing under
an hour old, the newest terminal deployment stays with its age (`3h ago`, `2d ago`) until
it is dismissed. Every terminal row carries a `×` (`Model.G.dismiss`, U+00D7) at its right
edge, dim, foreground while the row has the cursor (`hasCursor`, never `containsMouse`);
one click on it, `x` on the row, or **Dismiss** in the strip acknowledges. Dismiss clears
that row **and every older terminal entry**, so the section reads "Nothing deploying."
rather than promoting the next build into the same place (Dan, 2026-09-13: a promotion
looks like nothing happened). It is local: no request, no pending, no `lastAction`; the
entries stay in `recent` for dedupe with `dismissed: true` and are hidden from the panel
at any age; the status line reads "Dismissed". The file keeps entries for seven days, so
a Friday build is still Monday's last deployment.

Elapsed time ticks every second while the panel is open (a `Timer` on `root.opened`),
formatted `1m 20s`, `45s`, `2h 03m`.

### Log view (Phase 4)

An overlay inside the key catcher that replaces the list while open (the confirm still
paints above it): its own `ListView` and `ListModel`, one `Text` per physical log line
(`Style.font.bodySmall`, `root.fontFamily`, `WrapAnywhere`, never a horizontal scroll),
appended by absolute entry index; the head is trimmed when the 2000-entry tail cap drops
entries. A breadcrumb in the header (`‹ api · failed · 12m ago`; a click pops) and a
body pinned at `Style.space(480)` so a filling log never resizes under the reader.
Command steps render as `$ …` in dim; output lines in the foreground; on a `failed`
build the failing step (the last stderr entry carrying a command before the
"Deployment failed" summary, hidden or not) is always shown, in urgent, under a `── failure ──` marker,
with the "Deployment failed" lines urgent too; every other hidden step is off until
`H`. The view follows the newest line until `k`, the wheel or a drag moves up (footer
`held`); `b` follows again. An active build's lines arrive from the deployments poll;
a terminal build's from the drain or one fetch. A full-fill `MouseArea` beneath the
overlay's list keeps hover and clicks off the rows underneath.

States, as the note under the lines: `Loading log…`, `Queued. Coolify has not started
this build yet.`, `Starting…`, `The log is empty.`, `This build log is larger than 3 MB.
Open it in Coolify.` (the parse refusal; the 4 MB transport cap has its own line), `… N earlier entries not shown. Open it in Coolify for the full
log.` (above the lines), `Coolify no longer has that deployment.`, `Offline · retrying.`,
`Rate limited · backing off Ns.`, `Busy · press r to retry` (a refetch refused because
the request slot is busy), and the `read:sensitive` sentence when the token lacks the
ability. The breadcrumb age is the deployment's own (`finished_at`, or elapsed time for a
running build), never the fetch time.

### Container log and picker (Phase 4)

The same overlay for the last 200 lines of a running application, database or service
container (`L` on the row, or **Logs** in its strip; a stopped container offers neither).
Breadcrumb `‹ api · last 200 lines · 12s ago` (the fetch age; plus the container name for
a service); `r` refetches (also in a history view and the picker); the view opens at the
newest line and does not follow. A service with
several containers first shows a picker (`‹ wordpress · pick a container`) of
`applications[].name` and `databases[].name`; Enter on a name fetches its tail; a
single container skips the picker (the service fetches it at once and the panel swaps the
view). States: `Loading containers…`, `Fetching the last 200 lines…`, `The container has
written nothing.`, `… earlier lines not shown.` (above 2000 lines), `<name> is not
running.` (Coolify's 404), `Pick a container.`, `This service has no containers.`, `Busy ·
press r to retry`, `Busy · try again` (the picker or a history page while its request slot
is busy).

### History view (Phase 4)

**History** in an application's strip opens `‹ <app> · N deployments`: ten rows newest
first, each `glyph · status word` over `branch` / `restart` / `deploy` (never the string
`HEAD`), right-aligned age from the row's timestamps; then `Show 10 more (10 of 39)`
until the count is reached. Enter on a row opens that build's log (a second view; `h`
returns to the history with the cursor still on that row). Pages are fetched on demand,
never on a timer, and never touch Recent. States: `Loading history…`, `No deployments
recorded for this application.`, `Coolify no longer has that application.`

### Tags fold (Phase 4)

A **TAGS** section after RESOURCES, only when `GET /tags` (fetched on panel open, at most
once a minute) returns names; a fold closed by default; one row per tag. The strip offers
**Deploy** alone (a tag has no page); the row's bullet is `#`. `d` (or Enter, Enter through
the strip) confirms: "Deploy everything tagged
<name>? Coolify decides what that is; the API cannot list it." (Cancel / Deploy). The
status line then reads `N queued` or `N queued, M refused (queue full)` and the row
shows `deploying…` until a named deployment is listed or finished.

### Servers section

Row per server: dot glyph (`●` reachable and usable, `󱎖` reachable but not usable,
`○` unreachable or disabled), name, caption "<ip> · N resources" plus "unreachable"
in urgent, "disabled", "build server" as they apply. Unreachable and disabled servers
dim the whole row. Proxy status and `unreachable_count` need `GET /servers/{uuid}` per
server (the list's `proxy` holds only `redirect_enabled`, verified 2026-09-12) and stay
deferred: one transfer per server per topology cycle, 5.6 KB each, mostly a Traefik config. Expanded row: **Validate**, **Open**. A pending
validate appends " · validating…" to the caption in accent and clears on the next
servers poll (the API exposes no result).

### Resources section

Header row pairs `PanelSectionHeader "RESOURCES"` with a right-aligned
`ButtonGroup { options: [by project, by server]; focusable: false }` (the network
panel's header-plus-control pairing, with the `topPadding / 2` vertical offset). `g`
toggles the same property. The grouping and the folded set are remembered per instance
across shell restarts and shared by every monitor's panel (Phase 4b, `ui.json`); switching
instance shows that instance's own grouping and folds. Grouping folds are `▾ / ▸` rows like
omasnitch's System fold; a resource whose environment is unknown lands in an "Ungrouped" fold, titled
"Ungrouped · loading" while the topology blocks are still arriving after a start (a
minute or so with a panel open, five with it closed). Resource rows:

- Dot: `●` running (foreground), `󱎖` (U+F1396) starting/restarting/degraded (urgent),
  `○` exited/paused (dim), `◌` unknown. `◐` U+25D0 is not in JetBrainsMono Nerd Font.
- Name bold body, through `Model.appLabel` (Phase 4b: `storefront`, never Coolify's
  `storefront:main-h0wx…`; an unnamed app shows its uuid's first 8; deployment rows
  the same; a name that still elides shows the full label in a `PanelToolTip` while the
  row has the cursor, deployment rows too), status words in caption: the health word
  alone on a running resource ("healthy", "unhealthy"; the dot carries the state, bare
  "running" only when Coolify sends no health word), otherwise "exited", "restarting",
  or the pending verb in accent with the half glyph: "deploying…", "rebuilding…",
  "restarting…", "stopping…", "starting…" ("stopping… · still pending" after 150 s).
- Kind hint on the right in caption dim: `app`, `service`, `postgres`, `redis`.

Enter (or `l`) on a leaf row emits a non-selectable action strip under it. Actions that
do not apply are hidden, not disabled: applications running → Redeploy · Restart ·
Stop · More, with Logs · History · Open on a second line once More is open (the no-cache
rebuild is keyboard-only, `D`, and confirms); applications stopped → Deploy · Start ·
History · Open (Deploy brings it up, Redeploy rebuilds a running one; both are
`POST /deploy`); services and databases → Restart · Stop · Logs · Open or Start · Open;
unknown state → History · Open or Open;
servers → Validate · Open; active deployments → Cancel · Open; terminal → Open. Open is
present only when a Coolify page URL can be built (it arrives with the topology, about
a minute after start).

### Action row (Phase 2)

A `Column` of two `Flow`s of `Button { bordered: true; focusable: false; fontSize:
Style.font.bodySmall }` with content-derived widths. Four buttons fit one line of the
fitted card; a strip of four or fewer shows all of them and nothing else. Above four
(`Model.STRIP_FIT`), the first line holds the lifecycle verbs (`primary` in
`Model.actionsFor`: Redeploy/Deploy, Restart, Stop/Start) and a **More** toggle painted
`root.dim`; the second line (Logs · History · Open) appears only while More is open and
the toggle reads **Less** (`Model.stripFor`). More is panel state (`moreOpen`, reset on
collapse, expand, close and an instance switch), never a verb: Enter or a click on it
re-emits the strip and keeps the ring on the toggle; the text keys (`L`, `o`) reach a
folded secondary regardless. `h`/`l` move through primary, More, then the revealed
secondaries (an id, not an index, so a button that disappears hands focus to the
first); Enter runs. While a button is ringed
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
| fold row | `j/k move · enter fold · g group · / filter · r refresh · esc close` |
| application row, running, collapsed | `enter actions · d redeploy · s stop · t restart · L logs · o open` |
| application row, stopped, collapsed | `enter actions · d deploy · s start · o open` |
| service/database row, collapsed | `enter actions · s stop · t restart · L logs · o open` (or `s start · o open`) |
| any row expanded, a button focused | `h/l pick · enter run · esc collapse` |
| any row expanded, focus back on the row | `l pick · enter collapse · esc collapse` |
| server row | `enter actions · v validate · o open` |
| active deployment row | `enter actions · x cancel · L logs · o open` |
| terminal deployment row | `enter actions · x dismiss · L logs · o open` |
| tag row | `enter actions · d deploy` |
| build log, following / held / paused | `following · j/k scroll · b newest · H steps · o open · h back` (`held`, `paused`; a terminal log drops the first word) |
| container log | `j/k scroll · b newest · r refetch · o open · h back` |
| history | `j/k move · enter log · o open · h back` |
| container picker | `j/k move · enter logs · h back` |
| row with no action and no page | `j/k move · g group · / filter · r refresh · esc close` |
| confirm open | `h/l pick · enter confirm · esc cancel` |

## Keyboard map

`PanelKeyCatcher` owns the keys: `x` arrives as `deleteRequested`, Esc as
`closeRequested`, `h`/`l` as `moveRequested(±1, 0)`, Return as `returnRequested` then
`activateRequested` (handle only the latter). Never add a `Keys.onPressed` to the panel; the
filter `TextField` carries its own, which is the catcher's inline-editor shape (weather's
location search) and only runs while `blocked` hands it the keys.

| Key | Where | Action |
|---|---|---|
| `j` / `k`, arrows | anywhere | move cursor down / up through hero and rows (chips never take the ring); `k` from the first row lands on the hero |
| `h` / `l` | hero | previous / next instance (Phase 4, two or more instances; the footer reads `h/l instance`) |
| `h` / `l` | fold row | fold / unfold |
| `l` | collapsed leaf row | expand and focus the first action |
| `h` / `l` | action button | previous / next button; `h` on the first returns to the row |
| Enter, Space | More / Less button | show / hide the strip's second line (Logs · History · Open); the footer reads `enter more` / `enter less` |
| `h` | expanded row, no button focused | collapse |
| Enter, Space | fold row | expand / collapse |
| Enter, Space | hero | refresh |
| Enter, Space | leaf row | expand (first button focused); on an expanded row: run the focused button, or collapse |
| `d` | application row | deploy a stopped application, redeploy a running one |
| `D` | running application row | rebuild without cache (confirm); the one case-sensitive pair |
| `s` / `S` | resource row | stop (confirm) or start, whichever applies |
| `t` / `T` | resource row | restart |
| `x` / `X` | active deployment row | cancel (confirm) (via `deleteRequested`) |
| `x` / `X` | terminal deployment row | dismiss: clears the row and everything older, no confirm (Phase 4b; the row's `×` and the strip's Dismiss do the same); a no-op elsewhere |
| `o` / `O` | any row with a page | open in browser |
| `g` | anywhere | toggle grouping |
| `/` | list or hero | open the filter field (Phase 4b): the text narrows resources and deployments live, folds with a match open, folds without one hide, tags hide; Enter, Tab or Down leaves the field for the list with the first match (a deployment or resource, never a server) selected and the text kept; Esc in the field clears and closes it |
| `r` | anywhere | refresh now |
| `v` / `V` | server row | validate |
| `L` | deployment row; running application/database/service row | the build log; the container log or picker (the catcher takes lowercase `l`) |
| `d`, Enter | tag row | deploy everything with the tag (confirm) |
| `j` / `k` | log view | scroll one line; `k` above the end releases the follow |
| `j` / `k` | history, picker | move the cursor |
| Enter | history row / `Show more` / container name | that build's log / the next page / that container's tail |
| `b` | log view | jump to the newest line and follow again |
| `H` | build log | show or hide Coolify's internal steps (the failing one is always shown) |
| `r` | container log | refetch (in a build log: refetch a non-active one) |
| `o` | any view with a page | open it in the browser |
| `h` | any view | back one view (through the Esc ladder) |
| Space | history, picker | as Enter (the catcher fires `activateRequested` for both) |
| `l`, Space in a log view, `g`, `x` | any view | nothing |
| Tab / Shift+Tab | anywhere, confirm closed | neighbouring bar panel (pops every view first) |
| Esc | anywhere | close confirm, else back one view, else clear the filter, else collapse row, else close panel; one rung per 250 ms |

Unavailable inside a view: `G` (bound to grouping with `g`), Home, End, PageUp and
PageDown (`PanelKeyCatcher` does not emit them and the panel may not add a `Keys.onPressed`),
and `/` (the filter belongs to the list underneath).

While the filter field has focus the catcher is `blocked` (its documented inline-editor
contract), so every key, `j`/`k`/`x` included, is typed; the field's own `Keys.onPressed`
handles Esc, Enter, Tab and Down (Tab switches bar panels only outside the field). The footer reads `type to narrow · enter list · esc clear`; a
dim `N matches` count sits at the field's right. The filter is panel-local, per monitor,
cleared when the panel closes, and never persisted.

Mouse: hover moves the cursor (never colours from `containsMouse`); a left click on a
leaf row opens its action strip (or closes the open one) and the strip's buttons are
clickable, More included; a click on a fold row folds; right-click on a row opens it in
the browser. Opening a strip never moves the list: the ListView's model is patched in
place by key (`Model.listPatch`), so the rows above keep their place and the strip is
only scrolled into view when it would fall below the card.

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
| No deployments (nothing active, every terminal entry dismissed or none recorded) | — | "Nothing deploying." |
| No servers | — | "No servers on this team." |
| No resources | — | "No resources on this team." |
| Zero servers and resources with a valid token | "NO RESOURCES ON THIS TEAM" | — |
| A view fetch fails (404, 400, offline, 429, too large) | unchanged | the note inside the view; never the callout, never the bar |
| The token lacks `read:sensitive` | unchanged | in the log view: "Logs need the read:sensitive ability. Create a new token under Security → API Tokens with read, read:sensitive and deploy, and swap it in." |

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
compact one-line toast. With two or more instances every body ends in ` · <instance
name>` (`Deployed api` / `21s · main · Coolify Cloud`); the headline never changes.

| Event | Toggle | Glyph | Headline | Body | Urgency | Click |
|---|---|---|---|---|---|---|
| queued | deploymentQueued | `󰔟` | Queued A | sub | low | deployment |
| started | deploymentStarted | `󰦖` | Building A | sub | low | deployment |
| restarting (`restart_only`) | deploymentStarted | `󰦖` | Restarting A | server | low | deployment |
| finished | deploymentFinished | `󰄬` | Deployed A | dur · branch | normal | deployment |
| restarted (`restart_only`) | deploymentFinished | `󰄬` | Restarted A | dur | normal | deployment |
| failed | deploymentFailed | `󰅙` | Deployment failed: A (Restart failed: A) | dur · click for the log (dur · click to open in Coolify when the token has no `read:sensitive`; dur · branch without a page) | **critical** | the build log in the panel |
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
as the notifier's `--exec` tail; no URL, no `--exec`. The one exception is a failed build
(Phase 4b item 6): its tail is `omarchy-shell io.github.danjonesio.coolwatch log <uuid>`,
the IPC verb that opens the panel on that build's log (the failing step visible, as `L` on
the row shows it), so a replayed critical toast after a shell restart still works. The
browser tail stays when the instance's token has no `read:sensitive` (the log would be
the ability message); the body says which.

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
