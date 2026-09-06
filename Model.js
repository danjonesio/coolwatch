.pragma library
// Pure functions: config, transport splitting, normalise, join, diff, error mapping,
// bar state, hero and callout copy, panel rows, formatting. No QML, no I/O.
// Colours are never named here: rows carry a `tone` the QML resolves.

var RS = "\u001e"
var US = "\u001f"

// ---- glyphs -----------------------------------------------------------------------
// Every glyph any function here can emit, by codepoint (all verified present in
// JetBrainsMono Nerd Font at advance 600). U+25D0 "◐" is NOT in the font.
function cp(n) { return String.fromCodePoint(n) }
var G = {
  cloud: cp(0xF015F),          // md-cloud (filled): configured
  cloudOutline: cp(0xF0163),   // md-cloud_outline: not configured
  cloudOff: cp(0xF0164),       // md-cloud_off_outline: offline / unreachable
  cloudAlert: cp(0xF09E0),     // md-cloud_alert: config / token / auth trouble
  failed: cp(0xF0159),         // md-close_circle
  progress: cp(0xF0996),       // md-progress_clock: deploying
  queued: cp(0xF051F),         // md-timer_sand
  finished: cp(0xF012C),       // md-check
  cancelled: cp(0xF073A),      // md-cancel
  half: cp(0xF1396),           // md-circle_half_full: starting / restarting / degraded
  refresh: cp(0xF0450),        // md-refresh
  dotOn: "●",             // ●
  dotOff: "○",            // ○
  dotUnknown: "◌",        // ◌
  foldOpen: "▾",          // ▾
  foldClosed: "▸"         // ▸
}
var GLYPHS = Object.keys(G).map(function (k) { return G[k] })

var TERMINAL = { finished: true, failed: true, "cancelled-by-user": true }
var ACTIVE = { queued: true, in_progress: true }
var RECENT_RENDER_CAP = 5
var RECENT_MAX_AGE_MS = 60 * 60 * 1000   // finished deployments leave the panel after an hour

// ---- config --------------------------------------------------------------------------

var POLL_DEFAULTS = { deploymentsSec: 4, resourcesSec: 60, serversSec: 120, topologySec: 600 }

function normaliseConfig(text) {
  var out = { ok: false, error: "", instances: [], poll: pollDefaults() }
  var c
  try { c = typeof text === "string" ? JSON.parse(text) : text } catch (e) { out.error = "invalid JSON: " + String(e && e.message ? e.message : e); return out }
  if (!c || typeof c !== "object") { out.error = "config is not an object"; return out }
  if (!Array.isArray(c.instances) || c.instances.length === 0) { out.error = "instances must be a non-empty array"; return out }
  for (var i = 0; i < c.instances.length; i++) {
    var raw = c.instances[i] || {}
    var url = String(raw.url === undefined || raw.url === null ? "" : raw.url).trim()
    if (!/^https?:\/\/[^\s\/]+/i.test(url)) { out.error = "instances[" + i + "].url must start with http:// or https://"; return out }
    var inst = {
      id: String(raw.id || ("instance" + i)),
      name: String(raw.name || raw.id || hostOf(url)),
      url: url.replace(/\/+$/, ""),
      token: raw.token === undefined || raw.token === null ? "" : String(raw.token),
      tokenCommand: null,
      plaintext: /^http:\/\//i.test(url)
    }
    if (raw.tokenCommand !== undefined && raw.tokenCommand !== null) {
      var cmd = raw.tokenCommand
      if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every(function (a) { return typeof a === "string" })) {
        out.error = "instances[" + i + "].tokenCommand must be an array of strings"; return out
      }
      if (cmd[0].charAt(0) === "-") { out.error = "instances[" + i + "].tokenCommand[0] must not start with -"; return out }
      inst.tokenCommand = cmd.slice()
    }
    if (!inst.token && !inst.tokenCommand) { out.error = "instances[" + i + "] needs token or tokenCommand"; return out }
    out.instances.push(inst)
  }
  if (c.poll && typeof c.poll === "object") {
    for (var k in POLL_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(c.poll, k)) {
        var n = c.poll[k]
        if (typeof n !== "number" || !isFinite(n)) { out.error = "poll." + k + " must be a number"; return out }
        out.poll[k] = Math.max(2, Math.round(n))
      }
    }
  }
  out.ok = true
  return out
}

function pollDefaults() { var p = {}; for (var k in POLL_DEFAULTS) p[k] = POLL_DEFAULTS[k]; return p }

function hostOf(url) {
  var m = /^https?:\/\/([^\/:]+)/i.exec(String(url || ""))
  return m ? m[1] : ""
}

function modeBits(modeStr) {
  var s = String(modeStr === undefined || modeStr === null ? "" : modeStr).trim()
  if (!/^[0-7]{3,4}$/.test(s)) return null
  s = s.slice(-3)
  return { user: parseInt(s.charAt(0), 8), group: parseInt(s.charAt(1), 8), other: parseInt(s.charAt(2), 8) }
}

// group/other write bit, or a different owner
function configUnsafe(modeStr, owner, me) {
  var b = modeBits(modeStr)
  if (!b) return true
  if ((b.group & 2) || (b.other & 2)) return true
  if (owner !== undefined && owner !== null && me !== undefined && me !== null && String(owner) !== String(me)) return true
  return false
}

// group/other read bit
function configLoose(modeStr) {
  var b = modeBits(modeStr)
  if (!b) return true
  return !!((b.group & 4) || (b.other & 4))
}

// ---- transport ---------------------------------------------------------------------

var TRAILER_RE = /^(\d+) (\d{3}) ([\d.]+) (\d+) ([^\n]*)\n([\s\S]*?)\n?\u001f/

// Splits curl stdout into one record per transfer. Each record is the body that
// precedes a trailer (see Api.TRAILER). An RS whose following text does not match
// the trailer grammar is body text and is skipped. The raw header blob is reduced
// to a whitelist here and never leaves this function.
function splitResponses(text) {
  var s = String(text === undefined || text === null ? "" : text)
  var out = []
  var start = 0
  var pos = 0
  for (;;) {
    var i = s.indexOf(RS, pos)
    if (i < 0) break
    var m = TRAILER_RE.exec(s.slice(i + 1))
    if (!m) { pos = i + 1; continue }
    var body = s.slice(start, i)
    if (body.slice(-1) === "\n") body = body.slice(0, -1)
    out.push({
      body: body,
      exit: parseInt(m[1], 10),
      code: parseInt(m[2], 10),
      timeMs: Math.round(parseFloat(m[3]) * 1000),
      bytes: parseInt(m[4], 10),
      errmsg: m[5],
      headers: pickHeaders(m[6])
    })
    pos = start = i + 1 + m[0].length
  }
  return out
}

function pickHeaders(json) {
  var h = { retryAfter: null, rateLimitRemaining: null, rateLimitLimit: null }
  var obj = null
  try { obj = JSON.parse(json) } catch (e) { return h }
  function intHeader(k) {
    var v = obj ? obj[k] : undefined
    if (Array.isArray(v)) v = v[0]
    if (v === undefined || v === null) return null
    return /^\d+$/.test(String(v).trim()) ? parseInt(String(v).trim(), 10) : null
  }
  h.retryAfter = intHeader("retry-after")
  h.rateLimitRemaining = intHeader("x-ratelimit-remaining")
  h.rateLimitLimit = intHeader("x-ratelimit-limit")
  return h
}

function parseJson(text) {
  try { return { ok: true, value: JSON.parse(text) } } catch (e) { return { ok: false, value: null } }
}

// Anything that might be logged goes through here first.
function redact(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/\d+\|[A-Za-z0-9]{10,}/g, "«token»")
    .replace(/Bearer\s+\S+/g, "Bearer «token»")
    .replace(/:\/\/([^\/\s:@]+):([^\/\s@]+)@/g, "://«creds»@")
    .replace(/set-cookie[^\n]*/gi, "«cookie»")
}

// dropbox/Service.qml:90-93 shape: collapse whitespace, cut with an ellipsis.
function elide(text, max) {
  var t = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + "…"
}

// GET /version is text/html with a bare version string; never JSON.parse it.
// Bounded: it is the one API string that reaches the hero and `status` unparsed.
function parseVersion(text) {
  return elide(String(text === undefined || text === null ? "" : text).trim().replace(/^"+|"+$/g, "").replace(/^v/i, "").trim(), 32)
}

// ---- errors -------------------------------------------------------------------------

var META = {
  noconfig: "Not configured",
  configerror: "Config error",
  unsafe: "Config unsafe",
  tokencmd: "Token unavailable",
  waitingtoken: "Waiting for token",
  auth: "Token rejected",
  apidisabled: "API disabled",
  ipblocked: "IP not allowed",
  ability: "",
  ratelimited: "Rate limited",
  offline: "Offline · retrying",
  toolarge: "Response too large",
  http: "Coolify error"
}

var OFFLINE_EXITS = { 6: true, 7: true, 28: true, 35: true, 60: true }

function makeError(kind, detail, extra) {
  var e = { kind: kind, title: META[kind] || "", detail: elide(redact(detail === undefined || detail === null ? "" : detail), 140),
            httpCode: 0, curlExit: 0, request: "", at: 0, staleSince: 0 }
  if (extra) for (var k in extra) e[k] = extra[k]
  return e
}

function messageOf(body) {
  var p = parseJson(body)
  if (p.ok && p.value && typeof p.value === "object" && typeof p.value.message === "string") return p.value.message
  return ""
}

// Keyed on the per-transfer curl exit, then HTTP status, then `message`. Never reads
// a `success` field (the 403 API-disabled body says true). null when the transfer is fine.
function errorFor(r) {
  r = r || {}
  var exit = r.curlExit === undefined || r.curlExit === null ? 0 : Number(r.curlExit)
  var code = r.httpCode === undefined || r.httpCode === null ? 0 : Number(r.httpCode)
  var extra = { httpCode: code, curlExit: exit, request: r.request || "" }
  if (exit !== 0) {
    if (OFFLINE_EXITS[exit]) return makeError("offline", r.errmsg || ("curl " + exit), extra)
    if (exit === 63) return makeError("toolarge", r.errmsg || "response exceeded the size cap", extra)
    return makeError("http", "curl " + exit + (r.errmsg ? ": " + r.errmsg : ""), extra)
  }
  if (code < 400) return null
  var msg = messageOf(r.body)
  if (code === 401) return makeError("auth", msg, extra)
  if (code === 403) {
    if (/API is disabled/i.test(msg)) return makeError("apidisabled", msg, extra)
    if (/not allowed/i.test(msg)) return makeError("ipblocked", msg, extra)
    if (/permission/i.test(msg)) return makeError("ability", msg, extra)
    return makeError("http", msg || "Coolify returned 403", extra)
  }
  if (code === 429) return makeError("ratelimited", msg, extra)
  return makeError("http", msg || ("Coolify returned " + code), extra)
}

// A bare integer Retry-After clamped to [1, 300]; anything else falls back to the ladder.
function retryAfterSec(headers, attempt) {
  var v = headers ? headers.retryAfter : null
  if (typeof v === "number" && isFinite(v) && v === Math.floor(v)) return Math.min(300, Math.max(1, v))
  return (attempt === undefined || attempt === null || attempt <= 1) ? 30 : 60
}

// ---- normalise ------------------------------------------------------------------------

var STATES = { running: true, starting: true, restarting: true, degraded: true, paused: true, exited: true }

function parseStatus(s) {
  var raw = String(s === undefined || s === null ? "" : s).trim()
  var parts = raw.split(":")
  var state = parts[0] || "unknown"
  if (!STATES[state]) state = "unknown"
  var health = parts[1] || ""
  if (state === "exited") health = "unhealthy"
  if (health !== "healthy" && health !== "unhealthy") health = "unknown"
  return { state: state, health: health, raw: raw }
}

function bool(v, fallback) { return v === undefined || v === null ? !!fallback : !!v }

function normaliseServers(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map(function (s) {
    s = s || {}
    var st = s.settings || {}
    return {
      uuid: String(s.uuid || ""),
      name: String(s.name || s.uuid || ""),
      ip: String(s.ip || ""),
      reachable: s.is_reachable !== undefined && s.is_reachable !== null ? !!s.is_reachable : bool(st.is_reachable, false),
      usable: s.is_usable !== undefined && s.is_usable !== null ? !!s.is_usable : bool(st.is_usable, false),
      disabled: bool(st.force_disabled, false),
      buildServer: s.is_build_server !== undefined && s.is_build_server !== null ? !!s.is_build_server : bool(st.is_build_server, false),
      resourceCount: 0
    }
  })
}

function resourceKind(type) {
  var t = String(type || "")
  if (t === "application") return { kind: "application", type: "application" }
  if (t === "service") return { kind: "service", type: "service" }
  if (/^standalone-/.test(t)) return { kind: "database", type: t.replace(/^standalone-/, "") }
  return { kind: t || "unknown", type: t || "unknown" }
}

function normaliseResources(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map(function (r) {
    r = r || {}
    var k = resourceKind(r.type)
    var st = parseStatus(r.status)
    return {
      id: r.id === undefined || r.id === null ? null : r.id,
      uuid: String(r.uuid || ""),
      name: String(r.name || r.uuid || ""),
      kind: k.kind,
      type: k.type,
      status: st.raw,
      state: st.state,
      health: st.health,
      fqdn: typeof r.fqdn === "string" ? r.fqdn : null,
      environmentId: typeof r.environment_id === "number" ? r.environment_id : (r.environment_id ? Number(r.environment_id) : null),
      serverId: typeof r.server_id === "number" ? r.server_id : null,
      destinationId: typeof r.destination_id === "number" ? r.destination_id : null,
      gitBranch: typeof r.git_branch === "string" && r.git_branch ? r.git_branch : null,
      serverUuid: null, projectUuid: null, projectName: null, environmentName: null
    }
  })
}

function normaliseDeployment(d) {
  d = d || {}
  return {
    uuid: String(d.deployment_uuid || ""),
    appId: d.application_id === undefined || d.application_id === null ? "" : String(d.application_id),
    appUuid: null,
    appName: String(d.application_name || ""),
    serverName: String(d.server_name || ""),
    branch: null,
    status: String(d.status || ""),
    commit: String(d.commit || ""),
    commitMessage: String(d.commit_message || "").split("\n")[0],
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
    finishedAt: d.finished_at || null,
    url: typeof d.deployment_url === "string" ? d.deployment_url : null,
    restartOnly: !!d.restart_only,
    force: !!d.force_rebuild,
    isApi: !!d.is_api,
    isWebhook: !!d.is_webhook
  }
}

function normaliseDeployments(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map(normaliseDeployment)
}

function normaliseProjects(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map(function (p) { p = p || {}; return { uuid: String(p.uuid || ""), name: String(p.name || p.uuid || "") } })
}

function environmentsOf(detail) {
  var envs = detail && Array.isArray(detail.environments) ? detail.environments : []
  return envs.map(function (e) { e = e || {}; return { id: typeof e.id === "number" ? e.id : Number(e.id), name: String(e.name || "") } })
}

function serverResourceUuids(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map(function (r) { return String((r && r.uuid) || "") }).filter(function (u) { return u.length > 0 })
}

// ---- join ------------------------------------------------------------------------------

function buildTree(projects, envsByProject, resources) {
  var tree = []
  var placed = {}
  ;(projects || []).forEach(function (p) {
    var envs = (envsByProject && envsByProject[p.uuid]) || []
    tree.push({
      projectUuid: p.uuid, projectName: p.name,
      environments: envs.map(function (e) {
        var uuids = (resources || []).filter(function (r) { return r.environmentId !== null && r.environmentId === e.id })
          .map(function (r) { placed[r.uuid] = true; return r.uuid })
        return { id: e.id, name: e.name, resourceUuids: uuids }
      })
    })
  })
  var left = (resources || []).filter(function (r) { return !placed[r.uuid] }).map(function (r) { return r.uuid })
  if (left.length) tree.push({ projectUuid: "", projectName: "Ungrouped", environments: [{ id: null, name: "", resourceUuids: left }] })
  return tree
}

function buildByServer(map) {
  var out = {}
  if (map) for (var k in map) out[k] = (map[k] || []).slice()
  return out
}

function applyJoins(resources, tree, byServer, servers) {
  var env = {}
  ;(tree || []).forEach(function (p) {
    p.environments.forEach(function (e) {
      e.resourceUuids.forEach(function (u) { env[u] = { projectUuid: p.projectUuid, projectName: p.projectName, environmentName: e.name } })
    })
  })
  var srv = {}
  if (byServer) for (var s in byServer) byServer[s].forEach(function (u) { srv[u] = s })
  return (resources || []).map(function (r) {
    var o = {}
    for (var k in r) o[k] = r[k]
    var e = env[r.uuid]
    o.projectUuid = e ? e.projectUuid : null
    o.projectName = e ? e.projectName : null
    o.environmentName = e ? e.environmentName : null
    o.serverUuid = srv[r.uuid] || null
    return o
  })
}

function joinBranch(deployments, resources) {
  var byId = {}, byName = {}
  ;(resources || []).forEach(function (r) {
    if (r.id !== null && r.id !== undefined) byId[String(r.id)] = r
    byName[r.name] = r
  })
  return (deployments || []).map(function (d) {
    var o = {}
    for (var k in d) o[k] = d[k]
    var app = (d.appId && byId[d.appId]) || byName[d.appName] || null
    o.appUuid = app ? app.uuid : null
    o.branch = app && app.gitBranch ? app.gitBranch : (d.commit ? d.commit.slice(0, 7) : "")
    return o
  })
}

function resourceCounts(byServer) {
  var out = {}
  if (byServer) for (var k in byServer) out[k] = byServer[k].length
  return out
}

// Raise the topology interval so (1 + P + S) requests per cycle cost at most 3/min.
function topologyIntervalSec(configured, P, S) {
  var perCycle = 1 + (P || 0) + (S || 0)
  var need = Math.ceil(perCycle / 3) * 60
  return Math.max(Number(configured) || 0, need)
}

// ---- diff -------------------------------------------------------------------------------

function diffActive(prevUuids, next) {
  var prev = {}, seen = {}
  ;(prevUuids || []).forEach(function (u) { prev[u] = true })
  var added = [], vanished = []
  ;(next || []).forEach(function (d) {
    seen[d.uuid] = true
    if (!prev[d.uuid]) added.push(d.uuid)
  })
  ;(prevUuids || []).forEach(function (u) { if (!seen[u] && vanished.indexOf(u) < 0) vanished.push(u) })
  return { added: added, vanished: vanished }
}

// ---- bar + hero + callout ---------------------------------------------------------------

function activeDeployments(s) { return (s && s.deployments ? s.deployments : []).filter(function (d) { return ACTIVE[d.status] }) }
function unreachableServers(s) { return (s && s.servers ? s.servers : []).filter(function (x) { return !x.reachable && !x.disabled }) }
function hasData(s) { return !!(s && ((s.servers && s.servers.length) || (s.resources && s.resources.length) || (s.deployments && s.deployments.length))) }
function isPartial(s) { return !!(s && s.error && (s.error.kind === "http" || s.error.kind === "toolarge") && s.baselineDone && hasData(s)) }

function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s") }

var KIND_WORDS = { serverResources: "topology", project: "topology", projects: "topology", topology: "topology", deployment: "deployments" }
function kindWord(k) { return KIND_WORDS[k] || k || "data" }

function heroTitle(s) {
  var i = s && s.instance
  if (!i) return "Omarify"
  return i.name || i.id || hostOf(i.url) || "Omarify"
}

function heroDetail(s) {
  var v = s && s.instance && s.instance.version
  return v ? "v" + v : ""
}

function countsLine(s) {
  var parts = []
  var ns = s.servers ? s.servers.length : 0
  var nr = s.resources ? s.resources.length : 0
  var nd = activeDeployments(s).length
  if (ns) parts.push(plural(ns, "server"))
  if (nr) parts.push(plural(nr, "resource"))
  if (nd) parts.push(nd + " deploying")
  return parts.join(" · ")
}

function heroMeta(s) {
  if (!s) return "Loading"
  var e = s.error
  if (e && e.kind !== "ability") {
    if (isPartial(s)) return kindWord(e.request) + " unavailable · showing last known"
    if (META[e.kind]) return META[e.kind]
  }
  if (!s.baselineDone) return "Loading"
  var line = countsLine(s)
  return line || "No resources on this team"
}

function barState(s) {
  var name = heroTitle(s)
  var r = { glyph: G.cloud, dimmed: false, active: false, tooltip: "" }
  var e = s ? s.error : null
  var ek = e ? e.kind : ""
  function dim(glyph, tip) { r.glyph = glyph; r.dimmed = true; r.tooltip = tip; return r }
  if (!s) return dim(G.cloud, "Omarify — starting")
  if (ek === "noconfig") return dim(G.cloudOutline, "Omarify — no config at ~/.config/omarify/config.json")
  if (ek === "configerror") return dim(G.cloudAlert, "Omarify — config error: " + String(e.detail || "").split("\n")[0])
  if (ek === "unsafe") return dim(G.cloudAlert, "Omarify — config is writable by others")
  if (ek === "tokencmd") return dim(G.cloudAlert, "Omarify — token command failed (exit " + (e.curlExit || 0) + ")")
  if (ek === "waitingtoken") return dim(G.cloud, "Omarify — waiting for token command")
  if (ek === "auth") return dim(G.cloudAlert, "Omarify — token rejected")
  if (ek === "apidisabled") return dim(G.cloudAlert, "Omarify — API disabled on this instance")
  if (ek === "ipblocked") return dim(G.cloudAlert, "Omarify — this IP is not allowed")
  if (ek === "offline") return dim(G.cloudOff, "Omarify — offline, retrying")
  if (ek === "ratelimited") return dim(G.cloud, "Omarify — rate limited, backing off " + (s.backoffSec || 0) + "s")
  if (!s.baselineDone && !isPartial(s)) return dim(G.cloud, "Omarify — starting")
  var failed = s.failedUnacked || []
  if (failed.length) {
    var first = failedName(s, failed[0])
    r.glyph = G.failed; r.active = true
    r.tooltip = "Deployment failed: " + elide(first, 40) + (failed.length > 1 ? " +" + (failed.length - 1) + " more" : "")
    return r
  }
  var down = unreachableServers(s)
  if (down.length) {
    r.glyph = G.cloudOff; r.active = true
    r.tooltip = elide(down[0].name, 40) + " unreachable" + (down.length > 1 ? " +" + (down.length - 1) + " more" : "")
    return r
  }
  var act = activeDeployments(s)
  if (act.length) {
    r.glyph = G.progress; r.active = true
    r.tooltip = act.length === 1 ? "Deploying " + elide(act[0].appName, 40) : act.length + " deployments running"
    return r
  }
  var counts = countsLine(s)
  if (isPartial(s)) { r.tooltip = name + " — " + (counts || "no resources") + " (" + kindWord(e.request) + " unavailable)"; return r }
  r.tooltip = name + " — " + (counts || "no resources")
  return r
}

function failedName(s, uuid) {
  var all = (s.recent || []).concat(s.deployments || [])
  for (var i = 0; i < all.length; i++) if (all[i].uuid === uuid) return all[i].appName || uuid
  return uuid
}

var SAMPLE_CONFIG = '{ "version": 1, "instances": [\n  { "id": "cloud", "name": "Coolify Cloud", "url": "https://app.coolify.io", "token": "67|…" } ] }'

function calloutBody(e, s) {
  switch (e.kind) {
    case "noconfig": return "Create ~/.config/omarify/config.json (chmod 600):\n" + SAMPLE_CONFIG
    case "configerror": return e.detail || "Config could not be read."
    case "unsafe": return "Anyone on this machine can rewrite it. Run: chmod 600 ~/.config/omarify/config.json"
    case "tokencmd": return "The token command exited " + (e.curlExit || 0) + ". Its output is never logged; run it yourself to see why."
    case "waitingtoken": return "Running the token command…"
    case "auth": return "Create a token in Coolify → Security → API Tokens with the read ability."
    case "apidisabled": return "Enable it in Settings → Advanced → API Access."
    case "ipblocked": return "Add this machine's IP to the token's allowed list in Coolify → Security → API Tokens."
    case "ability": return "The token is missing the " + (abilityOf(e.detail) || "required") + " ability."
    case "ratelimited": return "Backing off " + ((s && s.backoffSec) || e.backoffSec || 30) + "s."
    case "offline": return "Retrying."
    case "toolarge": return "Coolify's response exceeded 8 MB and was dropped."
    case "http": return e.detail || ("Coolify returned " + (e.httpCode || 0) + ".")
    default: return e.detail || ""
  }
}

function abilityOf(msg) {
  var m = /permissions?:\s*([a-z:]+)/i.exec(String(msg || ""))
  return m ? m[1] : ""
}

function warningBody(w) {
  if (!w) return ""
  if (w.kind === "permissions") return "Anyone on this machine can read your token. Run: chmod 600 ~/.config/omarify/config.json"
  if (w.kind === "plaintext") return "This instance is http://, so the token crosses the network in the clear."
  return w.detail || ""
}

function callout(s, nowMs) {
  if (!s) return null
  var e = s.error, w = s.warning
  if (!e && !w) return null
  var title = "", body = ""
  if (e) {
    title = isPartial(s) ? kindWord(e.request) + " unavailable" : (META[e.kind] || "Error")
    body = isPartial(s) ? kindWord(e.request) + " is unavailable." : calloutBody(e, s)
    if (e.staleSince) body += (body ? "\n" : "") + "Showing data from " + age(e.staleSince, nowMs || Date.now()) + "."
    if (w) body += (body ? "\n" : "") + warningBody(w)
  } else {
    title = w.kind === "permissions" ? "Config is readable by others" : (w.kind === "plaintext" ? "Plaintext instance" : "Warning")
    body = warningBody(w)
  }
  return { title: title, body: body }
}

var NOTES = { deployments: "Nothing deploying.", servers: "No servers on this team.", resources: "No resources on this team." }
var NOT_LOADED = "Not loaded yet."
function noteFor(s, section) { return (s.error || !s.baselineDone) && (s.lastPollAt || {})[section] === 0 ? NOT_LOADED : NOTES[section] }

// ---- panel rows -----------------------------------------------------------------------------

function deploymentGlyph(d) {
  switch (d.status) {
    // In flight paints the bar's signal colour (`urgent`, the same token the bar icon
    // uses when active); failed paints the theme accent so it reads differently.
    case "in_progress": return { glyph: G.progress, tone: "urgent" }
    case "queued": return { glyph: G.queued, tone: "dim" }
    case "finished": return { glyph: G.finished, tone: "dim" }
    case "failed": return { glyph: G.failed, tone: "accent" }
    case "cancelled-by-user": return { glyph: G.cancelled, tone: "dim" }
    default: return { glyph: G.dotUnknown, tone: "dim" }
  }
}

function statusDot(res) {
  switch (res.state) {
    case "running": return { dot: G.dotOn, tone: "fg" }
    case "starting": case "restarting": case "degraded": return { dot: G.half, tone: "urgent" }
    case "exited": case "paused": return { dot: G.dotOff, tone: "dim" }
    default: return { dot: G.dotUnknown, tone: "dim" }
  }
}

function statusWords(res) {
  if (res.state === "unknown") return res.status || "unknown"
  if (res.state === "running" && res.health !== "unknown") return "running · " + res.health
  return res.state
}

var KIND_HINT = { application: "app", service: "service", postgresql: "postgres", mysql: "mysql", mariadb: "mariadb", mongodb: "mongo", redis: "redis", keydb: "keydb", dragonfly: "dragonfly", clickhouse: "clickhouse" }

function kindHint(res) {
  if (res.kind === "application") return "app"
  if (res.kind === "service") return "service"
  return KIND_HINT[res.type] || res.type || ""
}

function deploymentRow(d) {
  var g = deploymentGlyph(d)
  return {
    type: "deployment", key: "dep:" + d.uuid, uuid: d.uuid, glyph: g.glyph, tone: g.tone,
    name: d.appName || d.uuid, sub: [d.branch, d.commitMessage].filter(function (x) { return !!x }).join(" · "),
    createdAt: d.createdAt, updatedAt: d.updatedAt, terminal: !!TERMINAL[d.status], status: d.status
  }
}

function serverRow(x) {
  var bits = [x.ip]
  bits.push(plural(x.resourceCount || 0, "resource"))
  if (!x.reachable && !x.disabled) bits.push("unreachable")
  if (x.disabled) bits.push("disabled")
  if (x.buildServer) bits.push("build server")
  var dot = x.disabled || !x.reachable ? G.dotOff : (x.usable ? G.dotOn : G.half)
  var tone = !x.reachable && !x.disabled ? "urgent" : (x.disabled ? "dim" : (x.usable ? "fg" : "urgent"))
  return { type: "server", key: "srv:" + x.uuid, uuid: x.uuid, dot: dot, tone: tone, name: x.name,
           sub: bits.filter(function (b) { return !!b }).join(" · "), dim: !x.reachable || x.disabled }
}

function resourceRow(r, indent) {
  var d = statusDot(r)
  return { type: "resource", key: "res:" + r.uuid, uuid: r.uuid, dot: d.dot, tone: d.tone, name: r.name,
           statusWords: statusWords(r), kindHint: kindHint(r), dim: r.state === "exited" || r.state === "paused", indent: indent || 0 }
}

function panelRows(s, ui) {
  ui = ui || {}
  var nowMs = ui.nowMs || Date.now()
  var folded = ui.folded || {}
  var groupBy = ui.groupBy === "server" ? "server" : "project"
  var rows = []
  s = s || {}
  var sep = 0
  // DEPLOYMENTS
  rows.push({ type: "section", key: "sec:deployments", title: "DEPLOYMENTS", control: null })
  var active = activeDeployments(s)
  var recent = (s.recent || []).filter(function(d) {
    var t = Date.parse(d.finishedAt || d.updatedAt || "")
    return isNaN(t) || nowMs - t <= RECENT_MAX_AGE_MS
  }).slice(0, RECENT_RENDER_CAP)
  if (!active.length && !recent.length) rows.push({ type: "note", key: "note:deployments", text: noteFor(s, "deployments") })
  active.forEach(function (d) { rows.push(deploymentRow(d)) })
  recent.forEach(function (d) { rows.push(deploymentRow(d)) })
  rows.push({ type: "separator", key: "sep:" + (++sep) })
  // SERVERS
  rows.push({ type: "section", key: "sec:servers", title: "SERVERS", control: null })
  var servers = s.servers || []
  if (!servers.length) rows.push({ type: "note", key: "note:servers", text: noteFor(s, "servers") })
  servers.forEach(function (x) { rows.push(serverRow(x)) })
  rows.push({ type: "separator", key: "sep:" + (++sep) })
  // RESOURCES
  rows.push({ type: "section", key: "sec:resources", title: "RESOURCES", control: "groupBy" })
  var resources = s.resources || []
  if (!resources.length) { rows.push({ type: "note", key: "note:resources", text: noteFor(s, "resources") }); return rows }
  var byUuid = {}
  resources.forEach(function (r) { byUuid[r.uuid] = r })
  function fold(key, title, uuids, indent) {
    var open = !folded[key]
    rows.push({ type: "fold", key: key, title: title, open: open, count: uuids.length, indent: indent || 0 })
    if (open) uuids.forEach(function (u) { if (byUuid[u]) rows.push(resourceRow(byUuid[u], (indent || 0) + 1)) })
  }
  if (groupBy === "project") {
    var tree = s.tree && s.tree.length ? s.tree : [{ projectUuid: "", projectName: "Ungrouped", environments: [{ id: null, name: "", resourceUuids: resources.map(function (r) { return r.uuid }) }] }]
    tree.forEach(function (p) {
      p.environments.forEach(function (e) {
        if (!e.resourceUuids.length) return
        var title = e.name ? p.projectName + " / " + e.name : p.projectName
        fold("fold:p:" + p.projectUuid + "/" + e.name, title, e.resourceUuids, 0)
      })
    })
  } else {
    var placed = {}
    servers.forEach(function (x) {
      var uuids = ((s.byServer && s.byServer[x.uuid]) || []).filter(function (u) { return !!byUuid[u] })
      uuids.forEach(function (u) { placed[u] = true })
      fold("fold:s:" + x.uuid, x.name, uuids, 0)
    })
    var left = resources.filter(function (r) { return !placed[r.uuid] }).map(function (r) { return r.uuid })
    if (left.length) fold("fold:s:unassigned", "Unassigned", left, 0)
  }
  return rows
}

var SELECTABLE = { fold: true, deployment: true, server: true, resource: true }

function rowRev(r) {
  return [r.type, r.glyph || r.dot || "", r.tone || "", r.name || r.title || r.text || "", r.sub || r.statusWords || "",
          r.open === undefined ? "" : String(r.open), r.count === undefined ? "" : String(r.count),
          r.dim === undefined ? "" : String(r.dim), r.kindHint || "", r.terminal === undefined ? "" : String(r.terminal), r.control || ""].join("")
}

function sameRows(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (var i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return false
    if (rowRev(a[i]) !== rowRev(b[i])) return false
  }
  return true
}

function indexOfKey(rows, key) {
  for (var i = 0; i < (rows || []).length; i++) if (rows[i].key === key) return i
  return -1
}

function nextSelectable(rows, index, dir) {
  rows = rows || []
  var step = dir < 0 ? -1 : 1
  var i = index + step
  while (i >= 0 && i < rows.length) {
    if (SELECTABLE[rows[i].type]) return i
    i += step
  }
  return -1
}

function firstSelectableInSection(rows, title) {
  rows = rows || []
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type === "section" && rows[i].title === title) return nextSelectable(rows, i, 1)
  }
  return -1
}

function footerHints(focusSection, row) {
  if (focusSection === "hero") return "enter refresh · j down · r refresh · esc close"
  if (row && row.type === "fold") return "j/k move · enter fold · g group · r refresh · esc close"
  return "j/k move · g group · r refresh · esc close"
}

// ---- format -------------------------------------------------------------------------------------

function pad2(n) { return (n < 10 ? "0" : "") + n }

function elapsed(iso, nowMs) {
  var t = Date.parse(iso)
  if (isNaN(t)) return ""
  var sec = Math.max(0, Math.floor(((nowMs || Date.now()) - t) / 1000))
  if (sec < 60) return sec + "s"
  var m = Math.floor(sec / 60), s = sec % 60
  if (m < 60) return m + "m " + s + "s"
  var h = Math.floor(m / 60)
  return h + "h " + pad2(m % 60) + "m"
}

// dropbox/Model.js relativeTime shape
function age(iso, nowMs) {
  var t = typeof iso === "number" ? iso : Date.parse(iso)
  if (isNaN(t)) return ""
  var sec = Math.max(0, Math.floor(((nowMs || Date.now()) - t) / 1000))
  if (sec < 60) return "Just now"
  var m = Math.floor(sec / 60)
  if (m < 60) return m + "m ago"
  var h = Math.floor(m / 60)
  if (h < 24) return h + "h ago"
  return Math.floor(h / 24) + "d ago"
}
