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
  cog: cp(0xF0493),            // md-cog: the footer's Edit config button
  dotOn: "●",             // ●
  dotOff: "○",            // ○
  dotUnknown: "◌",        // ◌
  foldOpen: "▾",          // ▾
  foldClosed: "▸",        // ▸
  back: "‹",              // ‹ U+2039: the overlay breadcrumb (Phase 4; JetBrains Mono Latin-1/punctuation block)
  tag: "#",               // a tag row's bullet (Phase 4; ASCII)
  dismiss: "×"            // × U+00D7: the clear control on a terminal deployment row (Phase 4b; Latin-1)
}
var GLYPHS = Object.keys(G).map(function (k) { return G[k] })

var TERMINAL = { finished: true, failed: true, "cancelled-by-user": true }
var ACTIVE = { queued: true, in_progress: true }
var RECENT_RENDER_CAP = 5
var RECENT_MAX_AGE_MS = 60 * 60 * 1000   // finished deployments leave the panel after an hour, except the newest, which stays until dismissed

// ---- actions (Phase 2) ---------------------------------------------------------------
// A uuid the service will act on must look like one before it reaches a path (SR3).
var UUID_RE = /^[A-Za-z0-9]{1,64}$/
// Coolify UI path segment per resource kind (application proven by deployment_url;
// service and database inferred, verified live).
var UI_SEGMENT = { application: "application", service: "service", database: "database" }
// A stop/start pending entry gains " · still pending" after the sweep (60 s) plus the
// panel-closed resources interval (60 s) plus margin; every entry is dropped at 300 s.
var PENDING_STALE_MS = 150 * 1000
var PENDING_DROP_MS = 300 * 1000
var GERUND = { deploy: "deploying", redeploy: "redeploying", rebuild: "rebuilding", restart: "restarting", stop: "stopping", start: "starting", validate: "validating", cancel: "cancelling", deployTag: "deploying" }
var RUNNING_STATES = { running: true, starting: true, restarting: true, degraded: true }
var STOPPED_STATES = { exited: true, paused: true }

// ---- config --------------------------------------------------------------------------

var POLL_DEFAULTS = { deploymentsSec: 4, resourcesSec: 60, serversSec: 120, topologySec: 600 }
// Phase 3 toggles. Every key defaults to true; a malformed value warns (never a config
// error: a quoted "false" must not stop polling and every alert) and keeps its default (SR22).
var NOTIFY_DEFAULTS = { deploymentQueued: true, deploymentStarted: true, deploymentFinished: true,
                        deploymentFailed: true, resourceStateChanged: true, serverReachability: true }
// An instance id names a state file (recent-<id>.json) and an IPC argument: one path
// segment, no dots, no slashes (SR32).
var ID_RE = /^[A-Za-z0-9_-]{1,32}$/

function normaliseConfig(text) {
  var out = { ok: false, error: "", warning: "", instancesWarning: "", instances: [], poll: pollDefaults(), notify: notifyDefaults() }
  var c
  try { c = typeof text === "string" ? JSON.parse(text) : text } catch (e) { out.error = "invalid JSON: " + String(e && e.message ? e.message : e); return out }
  if (!c || typeof c !== "object") { out.error = "config is not an object"; return out }
  if (!Array.isArray(c.instances) || c.instances.length === 0) { out.error = "instances must be a non-empty array"; return out }
  var ids = {}, origins = {}
  for (var i = 0; i < c.instances.length; i++) {
    var raw = c.instances[i] || {}
    var url = String(raw.url === undefined || raw.url === null ? "" : raw.url).trim()
    if (!/^https?:\/\/[^\s\/]+/i.test(url)) { out.error = "instances[" + i + "].url must start with http:// or https://"; return out }
    // credentials in the authority would reach browser argv and the shell's history files (SR33)
    if (/^https?:\/\/[^\/?#]*@/i.test(url)) { out.error = "instances[" + i + "].url must not carry credentials"; return out }
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
    if (!ID_RE.test(inst.id)) { out.error = "instances[" + i + "].id must be 1-32 characters of A-Z a-z 0-9 _ -"; return out }
    if (Object.prototype.hasOwnProperty.call(ids, inst.id)) { out.error = "instances[" + i + "].id \"" + inst.id + "\" is already used by instances[" + ids[inst.id] + "]"; return out }
    ids[inst.id] = i
    var org = origin(inst.url)
    // the same Coolify twice is allowed (a read-only second token is the acceptance setup) but
    // every toast and drain runs twice; the callout says so. A URL origin() cannot key (a query
    // or fragment) is never "the same" as another (review: data 4).
    if (org && Object.prototype.hasOwnProperty.call(origins, org)) { if (!out.instancesWarning) out.instancesWarning = "\"" + inst.id + "\" and \"" + out.instances[origins[org]].id + "\" are the same Coolify (" + hostOf(url) + "): notifications arrive twice" }
    else if (org) origins[org] = i
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
  if (Object.prototype.hasOwnProperty.call(c, "notify") && c.notify !== null && c.notify !== true) {
    if (c.notify === false) { for (var nk in NOTIFY_DEFAULTS) out.notify[nk] = false }
    else if (typeof c.notify !== "object" || Array.isArray(c.notify)) { out.warning = "notify must be an object or a boolean" }
    else {
      for (var nk2 in NOTIFY_DEFAULTS) {
        if (!Object.prototype.hasOwnProperty.call(c.notify, nk2)) continue
        if (typeof c.notify[nk2] === "boolean") out.notify[nk2] = c.notify[nk2]
        else if (!out.warning) out.warning = "notify." + nk2 + " must be a boolean"
      }
    }
  }
  out.ok = true
  return out
}

function pollDefaults() { var p = {}; for (var k in POLL_DEFAULTS) p[k] = POLL_DEFAULTS[k]; return p }
function notifyDefaults() { var p = {}; for (var k in NOTIFY_DEFAULTS) p[k] = NOTIFY_DEFAULTS[k]; return p }

// The reset decision in Service._configText compares configs without the live-applied
// parts: a notify-only edit must not reset the store.
function configSansNotify(cfg) {
  var o = {}
  for (var k in cfg) if (k !== "notify" && k !== "warning" && k !== "instancesWarning") o[k] = cfg[k]
  return o
}

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
  tls: "Certificate rejected",
  toolarge: "Response too large",
  http: "Coolify error",
  down: "Coolify not responding"     // render-time only: errorWithHealth, never errorFor (health before auth)
}

var OFFLINE_EXITS = { 6: true, 7: true, 28: true, 35: true }
// curl 60: the peer certificate failed verification. curl aborts before any request, so the
// Bearer header was never sent; retried like a transport error but named, because "offline"
// would hide a self-hosted instance's expired or self-signed certificate (SR36).
var TLS_EXIT = 60

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
    if (exit === TLS_EXIT) return makeError("tls", r.errmsg || "certificate verification failed", extra)
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

// ---- health before auth (2026-09-22) ------------------------------------------------------
// GET /api/v1/health is unauthenticated and answers the plain text "OK". It runs only when a
// poll fails with an HTTP answer (never while healthy, never at token-ready), on its own Req,
// and its verdict is combined with the poll's error at render time by errorWithHealth. The
// body is bounded here and never stored, logged or shown (SR26 shape).

// The health body, trimmed and capped: "OK" or not. Never JSON.parsed.
function parseHealth(body) {
  return elide(String(body === undefined || body === null ? "" : body).trim(), 16)
}

// One splitResponses record (or null) -> { state, httpCode, curlExit, at }. States:
//   ok       200 with body OK
//   absent   404: the route does not exist on this Coolify (older version), not proof of anything
//   blocked  401/403: something refused an unauthenticated request; never proof the token is fine
//   fail     any other HTTP answer (3xx, 4xx, 5xx, 2xx with a body that is not OK), or curl 63
//   unknown  429, a curl-level failure, a reap, or no record: changes nothing
function healthResult(r, nowMs) {
  var at = nowMs || Date.now()
  if (!r) return { state: "unknown", httpCode: 0, curlExit: 0, at: at }
  var exit = r.exit === undefined || r.exit === null ? 0 : Number(r.exit)
  var code = r.code === undefined || r.code === null ? 0 : Number(r.code)
  var state
  if (exit === 63) state = "fail"
  else if (exit !== 0) state = "unknown"
  else if (code === 200 && parseHealth(r.body) === "OK") state = "ok"
  else if (code === 404) state = "absent"
  else if (code === 401 || code === 403) state = "blocked"
  else if (code === 429) state = "unknown"
  else state = "fail"
  return { state: state, httpCode: code, curlExit: exit, at: at }
}

// The floor between two health requests per instance (Service._probeHealth), and therefore the
// window inside which a fresh failure is guaranteed a re-probe. errorWithHealth's staleness
// rule is measured against it: an OK older than the failure by more than this is not evidence.
var HEALTH_FLOOR_MS = 30000

// The probe gate: a poll error that came back as an HTTP answer and is one of the two kinds
// the health check can explain. Every other kind is excluded by construction (a recognised
// 403 is Coolify's own word, 429 is the limiter, a curl exit is a transport fact).
function healthWanted(e) {
  return !!e && (e.kind === "auth" || e.kind === "http") && Number(e.curlExit || 0) === 0
}

// Combine a poll error with the health verdict. Returns the same object when there is nothing
// to add; otherwise a fresh error (kind "down", or the same kind annotated with healthState /
// healthCode / healthExit for the body). Health only hardens a diagnosis:
//   auth: fail -> down; ok or blocked -> auth annotated (the button stays); absent -> as is
//   http: fail or blocked -> down; absent -> down only when the poll itself 404'd; ok -> annotated
//   anything else -> as is. An "ok" older than the failure it explains by more than the probe
//   floor is stale -> as is (a panel open or a probe tick re-stamps the failure within the floor,
//   and the floor refuses a re-probe there, so the standing OK is the freshest evidence possible).
function errorWithHealth(e, health) {
  if (!e || !health || health.state === "unknown") return e
  if (health.state === "ok" && (health.at || 0) < (e.at || 0) - HEALTH_FLOOR_MS) return e
  var kind = null
  if (e.kind === "auth") {
    if (health.state === "fail") kind = "down"
    else if (health.state === "ok" || health.state === "blocked") kind = "auth"
  } else if (e.kind === "http") {
    if (health.state === "fail" || health.state === "blocked") kind = "down"
    else if (health.state === "absent") { if (Number(e.httpCode) === 404) kind = "down" }
    else if (health.state === "ok") kind = "http"
  }
  if (!kind) return e
  var extra = { request: e.request, httpCode: e.httpCode, curlExit: e.curlExit, at: e.at, staleSince: e.staleSince,
                healthState: health.state, healthCode: health.httpCode || 0, healthExit: health.curlExit || 0 }
  if (e.notJson) extra.notJson = true
  return makeError(kind, kind === "down" ? "" : e.detail, extra)
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

// A timestamp is kept only as a non-empty string of at most the recent file's cap (40): the first
// bound in the normalise layer, and load-bearing twice: it keeps a 10 MB stamp out of recentEntry's
// redact() on every save and out of the per-tick parses in Panel.qml's right column. The file path
// stays different on purpose (recentEntry truncates and stringifies); durationOf's bounds guard it.
function tsField(v) {
  return typeof v === "string" && v && v.length <= RECENT_STRING_FIELDS.createdAt ? v : null
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
    createdAt: tsField(d.created_at),
    updatedAt: tsField(d.updated_at),
    finishedAt: tsField(d.finished_at),
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
  return envs.map(function (e) { e = e || {}; return { id: typeof e.id === "number" ? e.id : Number(e.id), name: String(e.name || ""), uuid: String(e.uuid || "") } })
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
        return { id: e.id, name: e.name, uuid: e.uuid || "", resourceUuids: uuids }
      })
    })
  })
  var left = (resources || []).filter(function (r) { return !placed[r.uuid] }).map(function (r) { return r.uuid })
  if (left.length) tree.push({ projectUuid: "", projectName: "Ungrouped", environments: [{ id: null, name: "", uuid: "", resourceUuids: left }] })
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
      e.resourceUuids.forEach(function (u) { env[u] = { projectUuid: p.projectUuid, projectName: p.projectName, environmentName: e.name, environmentUuid: e.uuid || null } })
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
    o.environmentUuid = e && e.environmentUuid ? e.environmentUuid : null
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

// ---- change detection (Phase 3) ---------------------------------------------------------
// Every diff takes the previous store list (still in hand when the _dispatch arm runs) and
// the next one; `first` is the kind's own _baseline flag captured before _markPoll, so a
// baseline poll yields no events (never _baselineDone: one broken kind must not silence
// everything). Events carry the diff-time object for STATE fields only; notifyPlan
// re-resolves the render object from the joined snapshot.
// event: { kind: deployment|resource|server, event, uuid, obj }

// Every map keyed by a Coolify string is prototype-free: a resource named "toString" or a
// uuid "constructor" must neither read truthy before it is stored nor vanish (SR15).
function bare() { return Object.create(null) }
function byUuid(list) { var m = bare(); (list || []).forEach(function (x) { if (x && x.uuid) m[x.uuid] = x }); return m }

function diffDeployments(prevList, nextList, first) {
  var prev = byUuid(prevList)
  var out = { vanished: diffActive((prevList || []).map(function (d) { return d.uuid }), nextList).vanished, events: [] }
  if (first) return out
  ;(nextList || []).forEach(function (d) {
    if (!d || !d.uuid) return
    var p = prev[d.uuid], ev = null
    if (!p) {
      if (d.status === "queued") ev = d.restartOnly ? "restarting" : "queued"
      else if (d.status === "in_progress") ev = d.restartOnly ? "restarting" : "started"
    } else if (p.status === "queued" && d.status === "in_progress" && !d.restartOnly) ev = "started"
    if (ev) out.events.push({ kind: "deployment", event: ev, uuid: d.uuid, obj: d })
  })
  return out
}

// The terminal drain result -> one event, or null for a status that is not terminal.
function terminalEvent(d) {
  if (!d || !d.uuid) return null
  var ev = null
  if (d.status === "finished") ev = d.restartOnly ? "restarted" : "finished"
  else if (d.status === "failed") ev = "failed"
  else if (d.status === "cancelled-by-user") ev = "cancelled"
  return ev ? { kind: "deployment", event: ev, uuid: d.uuid, obj: d } : null
}

// Intra-session terminal dedupe: `recent` is already a uuid-keyed terminal set.
function hasTerminal(recent, uuid) {
  return (recent || []).some(function (d) { return !!d && d.uuid === uuid && Object.prototype.hasOwnProperty.call(TERMINAL, String(d.status)) })
}

// State prefix only, never health (docs/development.md prefix-match lock); unknown and paused on
// either side are a status-refresh gap or a deliberate act, not an event.
var STOP_FROM = { running: true, starting: true, restarting: true, degraded: true }
var DEGRADE_FROM = { running: true, starting: true, restarting: true }
var RECOVER_FROM = { exited: true, degraded: true }
var RECOVER_TO = { running: true, starting: true }

function resourceEvents(prevRaw, nextRaw, first) {
  if (first) return []
  var prev = byUuid(prevRaw), out = []
  ;(nextRaw || []).forEach(function (r) {
    if (!r || !r.uuid) return
    var p = prev[r.uuid]
    if (!p || p.state === r.state) return
    var ev = null
    if (r.state === "exited" && STOP_FROM[p.state]) ev = "stopped"
    else if (r.state === "degraded" && DEGRADE_FROM[p.state]) ev = "degraded"
    else if (RECOVER_TO[r.state] && RECOVER_FROM[p.state]) ev = "recovered"
    if (ev) out.push({ kind: "resource", event: ev, uuid: r.uuid, obj: r })
  })
  return out
}

function serverEvents(prevServers, nextServers, first) {
  if (first) return []
  var prev = byUuid(prevServers), out = []
  ;(nextServers || []).forEach(function (s) {
    if (!s || !s.uuid || s.disabled) return
    var p = prev[s.uuid]
    if (!p || p.reachable === s.reachable) return
    out.push({ kind: "server", event: s.reachable ? "reachable" : "unreachable", uuid: s.uuid, obj: s })
  })
  return out
}

// A uuid is not charset-validated at normalise; everything that reaches a log line goes
// through here so a hostile deployment_uuid cannot forge a second line (SR15).
function uuid8(uuid) { return String(uuid === undefined || uuid === null ? "" : uuid).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) }

// Coolify decorates git-sourced names as "<repo>:<branch>-<app uuid>" (44 chars, one
// unbreakable token wider than the toast). One rule for every toast headline.
function appLabel(name, uuid) {
  var n = String(name === undefined || name === null ? "" : name).trim().replace(/:[^:]*-[a-z0-9]{20,}$/, "")
  // An unnamed app is "<app uuid>-<digits>" (no colon): the first 8 of that uuid beats a
  // stub cut mid-timestamp, and matches the log lines. fqdn is never used (docs/development.md).
  if (/^[a-z0-9]{20,}-\d{6,}$/.test(n)) n = n.slice(0, 8)
  return elide(n || uuid8(uuid), 32)
}

// ---- notifications (Phase 3) -------------------------------------------------------------
// The copy table and every suppression rule live here so tests/run.js covers them. The
// only consumer is Service._flushNotify, which hands each argv to Util.execArgv unchanged.

var NOTIFY_MAX_HEADLINE = 72, NOTIFY_MAX_BODY = 96
var NOTIFY_CANCEL_WINDOW_MS = 300 * 1000   // the service's own Cancel already spoke on the status line
var NOTIFY_ACTION_WINDOW_MS = 180 * 1000   // a service/database restart's pending entry is gone before the container flaps
var NOTIFY_GRACE_MS = 120 * 1000           // containers settle after the deployment left the active list
var NOTIFY_COOLDOWN_MS = 300 * 1000        // per (kind, uuid, event): the flap bound
var NOTIFY_RECOVER_WINDOW_MS = 3600 * 1000 // "running again" only after a stopped/degraded toast this recent
var NOTIFY_RESOURCE_CAP = 3                // resource toasts per flush; the rest fold into one summary
var NOTIFY_PER_MIN = 12                    // non-critical toasts per rolling minute; critical is never capped

var NOTIFY_ROWS = {
  queued:      { toggle: "deploymentQueued",     glyph: "queued",    urgency: "low",      target: "deployment" },
  started:     { toggle: "deploymentStarted",    glyph: "progress",  urgency: "low",      target: "deployment" },
  restarting:  { toggle: "deploymentStarted",    glyph: "progress",  urgency: "low",      target: "deployment" },
  finished:    { toggle: "deploymentFinished",   glyph: "finished",  urgency: "normal",   target: "deployment" },
  restarted:   { toggle: "deploymentFinished",   glyph: "finished",  urgency: "normal",   target: "deployment" },
  failed:      { toggle: "deploymentFailed",     glyph: "failed",    urgency: "critical", target: "deployment" },
  cancelled:   { toggle: "deploymentFinished",   glyph: "cancelled", urgency: "low",      target: "deployment" },
  stopped:     { toggle: "resourceStateChanged", glyph: "failed",    urgency: "normal",   target: "resource" },
  degraded:    { toggle: "resourceStateChanged", glyph: "half",      urgency: "normal",   target: "resource" },
  recovered:   { toggle: "resourceStateChanged", glyph: "finished",  urgency: "low",      target: "resource" },
  summary:     { toggle: "resourceStateChanged", glyph: "failed",    urgency: "normal",   target: "" },
  unreachable: { toggle: "serverReachability",   glyph: "failed",    urgency: "critical", target: "server" },
  reachable:   { toggle: "serverReachability",   glyph: "finished",  urgency: "low",      target: "server" }
}
var NOTIFY_URGENCY_RANK = { critical: 0, normal: 1, low: 2 }
var NOTIFY_RULES = ["toggle", "selfCancel", "pending", "actionWindow", "activeDeployment", "postDeployGrace", "serverDown", "cooldown", "resourceCap", "minuteCap"]
function suppressedZero() { var o = {}; NOTIFY_RULES.forEach(function (r) { o[r] = 0 }); return o }

// Every positional handed to the notifier passes here (SR15): the helper keeps parsing
// options after the headline, so a Coolify string beginning with "-" would be read as one.
// Control characters go (a NUL would corrupt the click-argv encoding); all other Unicode
// survives; the cut happens before the dash guard so the guard sees the final string.
function notifySafe(text, max) {
  var t = elide(redact(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ""), max)
  return t.replace(/^-+/, function (m) { return m.replace(/-/g, "‑") })
}
// The toast body is StyledText in the shell; escape after the cut so it never lands mid-entity.
function notifyBody(text, max) {
  return notifySafe(text, max).replace(/&/g, "&amp;").replace(/</g, "&lt;")
}

// createdAt -> finishedAt (Coolify has no started_at, so a queue wait is inside it). Parse once and
// compute from the two numbers: "" when either end is unparseable, reversed (a fabricated "0s" is a metric
// the API did not give) or over the cap; "0s" for an equal pair (Coolify's stamps are second-granular).
var DURATION_MAX_MS = 7 * 24 * 3600 * 1000   // longer than this is not a deployment: caps the string the name column is sized against
function durationOf(d) {
  var a = Date.parse(d && d.createdAt), b = Date.parse(d && d.finishedAt)
  if (isNaN(a) || isNaN(b)) return ""
  var span = b - a
  if (span < 0 || span > DURATION_MAX_MS) return ""
  return span === 0 ? "0s" : elapsed(0, span)
}
function serverLabelFor(s, serverUuid) {
  if (!serverUuid) return ""
  var srv = (s && s.servers ? s.servers : []).filter(function (x) { return x.uuid === serverUuid })[0]
  return srv ? appLabel(srv.name, srv.uuid) : ""
}

// One event + its flush-time object -> the toast. `obj` is the joined record from the
// snapshot (falls back to the diff-time one), so a resource has serverUuid/projectUuid and a
// deployment has branch. Every fallback is stated: no commit, no branch, no duration, no
// server, empty name (-> uuid8).
function notifyCopy(ev, obj, s, ctx) {
  var row = NOTIFY_ROWS[ev.event]
  if (!row || !obj) return null
  var url = row.target ? openUrl(row.target, obj, ctx.origin) : ""
  // Phase 4b item 6: a failed build's click opens the panel on its log through the IPC verb,
  // unless the instance's token has no read:sensitive (ctx.logClick, a boolean the service
  // read from the context, never Coolify data); then the browser stays the target.
  var logUuid = ev.kind === "deployment" && ev.event === "failed" && ctx.logClick === true && UUID_RE.test(String(ev.uuid || "")) ? String(ev.uuid) : ""
  var head = "", body = ""
  if (ev.kind === "deployment") {
    var d = obj, A = appLabel(d.appName, d.uuid)
    var sub = [d.branch, d.commitMessage].filter(function (x) { return !!x }).join(" · "), dur = durationOf(d)
    switch (ev.event) {
      case "queued": head = "Queued " + A; body = sub; break
      case "started": head = "Building " + A; body = sub; break
      case "restarting": head = "Restarting " + A; body = d.serverName ? appLabel(d.serverName, "") : ""; break
      case "finished": head = "Deployed " + A; body = [dur, d.branch].filter(function (x) { return !!x }).join(" · "); break
      case "restarted": head = "Restarted " + A; body = dur; break
      case "failed": head = (d.restartOnly ? "Restart failed: " : "Deployment failed: ") + A
                     body = [dur, logUuid ? "click for the log" : url ? "click to open in Coolify" : d.branch].filter(function (x) { return !!x }).join(" · "); break
      case "cancelled": head = "Cancelled " + A; body = ""; break
      default: return null
    }
  } else if (ev.kind === "resource") {
    if (ev.event === "summary") { head = ev.count + " more resources stopped"; body = ev.serverLabel || ""; url = "" }
    else {
      var r = obj, srv = serverLabelFor(s, r.serverUuid)
      var word = { stopped: "stopped", degraded: "degraded", recovered: "running" }[ev.event]
      var state = { stopped: "exited", degraded: "degraded", recovered: "running" }[ev.event]
      head = appLabel(r.name, r.uuid) + " " + word
      body = [srv, state].filter(function (x) { return !!x }).join(" · ")
    }
  } else if (ev.kind === "server") {
    head = appLabel(obj.name, obj.uuid) + (ev.event === "unreachable" ? " unreachable" : " reachable")
    body = ev.event === "unreachable" && ev.down ? ev.down + " resources down" : ""
  } else return null
  // Two or more instances: the body names which one (the headline stays the resource's).
  if (ctx.instanceLabel) body = [body, String(ctx.instanceLabel)].filter(function (x) { return !!x }).join(" · ")
  return { toggle: row.toggle, glyph: G[row.glyph], urgency: row.urgency, targetType: row.target,
           headline: notifySafe(head, NOTIFY_MAX_HEADLINE), body: notifyBody(body, NOTIFY_MAX_BODY), url: url, logUuid: logUuid }
}

// events -> { argvs, log, suppressed: {rule: n}, notified: [{key, at}], lastKind }.
// ctx = { notify, origin, dnd, pending, actionAt, lastNotified, sentLastMin, now, pluginId, instanceLabel, logClick }.
// Per-event drops first (first match wins), then critical-first ordering, then the caps.
function notifyPlan(events, s, ctx) {
  var out = { argvs: [], log: [], suppressed: {}, notified: [], lastKind: "", nonCritical: 0 }   // nonCritical: what the minute ring counts
  function drop(rule) { out.suppressed[rule] = (out.suppressed[rule] || 0) + 1 }
  function has(m, k) { return !!m && Object.prototype.hasOwnProperty.call(m, k) }
  var notify = ctx.notify || notifyDefaults(), now = ctx.now || Date.now()
  var pending = ctx.pending || {}, actionAt = ctx.actionAt || {}, last = ctx.lastNotified || {}
  function within(map, k, ms) { return has(map, k) && now - Number(map[k]) < ms }
  var resources = byUuid(s.resources), deployments = byUuid(s.deployments), servers = byUuid(s.servers), recent = byUuid(s.recent)
  var activeApp = bare(), activeName = bare(), lastFinish = bare(), downServers = bare(), downCount = bare()
  ;(s.deployments || []).forEach(function (d) { if (ACTIVE[d.status]) { if (d.appUuid) activeApp[d.appUuid] = true; if (d.appName) activeName[d.appName] = true } })
  ;(s.recent || []).forEach(function (d) {
    var t = Date.parse(d.finishedAt || d.updatedAt || ""); if (isNaN(t)) return
    ;[d.appUuid, d.appName].forEach(function (k) { if (k && !(lastFinish[k] >= t)) lastFinish[k] = t })
  })
  unreachableServers(s).forEach(function (x) { downServers[x.uuid] = true })
  ;(events || []).forEach(function (e) { if (e && e.kind === "server" && e.event === "unreachable") downServers[e.uuid] = true })
  ;(s.resources || []).forEach(function (r) { if (r.serverUuid && downServers[r.serverUuid]) downCount[r.serverUuid] = (downCount[r.serverUuid] || 0) + 1 })

  var survivors = []
  ;(events || []).forEach(function (e, i) {
    if (!e || !NOTIFY_ROWS[e.event] || e.event === "summary") return
    var row = NOTIFY_ROWS[e.event]
    var obj = (e.kind === "resource" ? resources[e.uuid] : e.kind === "deployment" ? (deployments[e.uuid] || recent[e.uuid]) : servers[e.uuid]) || e.obj
    if (!obj) return
    if (!notify[row.toggle]) return drop("toggle")
    if (e.event === "cancelled" && within(actionAt, e.uuid, NOTIFY_CANCEL_WINDOW_MS)) return drop("selfCancel")
    if (e.event === "stopped" || e.event === "degraded") {
      if (has(pending, e.uuid)) return drop("pending")
      if (within(actionAt, e.uuid, NOTIFY_ACTION_WINDOW_MS)) return drop("actionWindow")
      if (activeApp[e.uuid] || (obj.name && activeName[obj.name])) return drop("activeDeployment")
      var lf = Math.max(lastFinish[e.uuid] || 0, (obj.name && lastFinish[obj.name]) || 0)
      if (lf && now - lf < NOTIFY_GRACE_MS) return drop("postDeployGrace")
      if (obj.serverUuid && downServers[obj.serverUuid]) return drop("serverDown")
    }
    var key = e.kind + ":" + e.uuid + ":" + e.event
    if (within(last, key, NOTIFY_COOLDOWN_MS)) return drop("cooldown")
    if (e.event === "recovered" && !within(last, e.kind + ":" + e.uuid + ":stopped", NOTIFY_RECOVER_WINDOW_MS)
        && !within(last, e.kind + ":" + e.uuid + ":degraded", NOTIFY_RECOVER_WINDOW_MS)) return drop("cooldown")
    var ev = { kind: e.kind, event: e.event, uuid: e.uuid, obj: e.obj }
    if (e.kind === "server" && e.event === "unreachable") ev.down = downCount[e.uuid] || 0
    survivors.push({ e: ev, obj: obj, row: row, key: key, i: i })
  })
  survivors.sort(function (a, b) { return (NOTIFY_URGENCY_RANK[a.row.urgency] - NOTIFY_URGENCY_RANK[b.row.urgency]) || (a.i - b.i) })

  var emitted = [], over = [], kept = 0, budget = NOTIFY_PER_MIN - (ctx.sentLastMin || 0)
  survivors.forEach(function (v) {
    if (v.e.kind === "resource") { if (kept >= NOTIFY_RESOURCE_CAP) { over.push(v); drop("resourceCap"); return } kept++ }
    if (v.row.urgency !== "critical") { if (budget <= 0) return drop("minuteCap"); budget-- }
    emitted.push(v)
  })
  // The summary names stops only; an overflow "recovered" row is dropped under the cap without
  // inflating the count (low sorts after normal, so it is what overflows first).
  var overStopped = over.filter(function (v) { return v.e.event === "stopped" || v.e.event === "degraded" })
  if (overStopped.length) {
    var srvs = bare(); overStopped.forEach(function (v) { srvs[v.obj.serverUuid || ""] = true })
    var keys = Object.keys(srvs)
    var sum = { kind: "resource", event: "summary", uuid: "", obj: {}, count: overStopped.length, serverLabel: keys.length === 1 && keys[0] ? serverLabelFor(s, keys[0]) : "" }
    if (budget > 0) { budget--; emitted.push({ e: sum, obj: {}, row: NOTIFY_ROWS.summary, key: "" }) } else drop("minuteCap")
  }

  emitted.forEach(function (v) {
    var c = notifyCopy(v.e, v.obj, s, ctx)
    if (!c || !c.headline) return
    var appName = c.urgency === "critical" && ctx.dnd === true ? "omarchy-action" : String(ctx.pluginId || "")
    var a = ["omarchy-notification-send", "--app-name", appName, "-g", c.glyph, "-u", c.urgency, c.headline]
    if (c.body) a.push(c.body)
    var pid = notifySafe(String(ctx.pluginId || ""), 64), lu = notifySafe(c.logUuid || "", 64)
    if (lu) a = a.concat(["--exec", "omarchy-shell", pid, "log", lu])
    else if (c.url) a = a.concat(["--exec", "omarchy-launch-browser", c.url])
    out.argvs.push(a)
    if (c.urgency !== "critical") out.nonCritical += 1
    out.log.push((v.e.event + " " + uuid8(v.e.uuid)).trim())
    if (v.key) out.notified.push({ key: v.key, at: now })
    out.lastKind = v.e.event
  })
  return out
}

// ---- recent state file (Phase 3) -------------------------------------------------------------
// ~/.local/state/coolwatch/recent.json is untrusted input (SR18): whitelist, bound, validate,
// never throw. branch/appUuid are join products and are recomputed after load.

var RECENT_FILE_VERSION = 1
var RECENT_FILE_MAX_CHARS = 262144
var RECENT_FILE_MAX_AGE_MS = 7 * 24 * 3600 * 1000   // a Friday build is still the "last deployment" on Monday
var RECENT_CAP = 20
var RECENT_STRING_FIELDS = { appId: 32, appName: 120, serverName: 80, commit: 64, commitMessage: 200, createdAt: 40, updatedAt: 40, finishedAt: 40, url: 400 }
var RECENT_BOOL_FIELDS = ["restartOnly", "force", "isApi", "isWebhook", "dismissed"]   // dismissed: hidden from the panel, kept for dedupe

function recentEntry(d) {
  var o = { uuid: d.uuid, status: d.status, appUuid: null, branch: null }
  for (var k in RECENT_STRING_FIELDS) o[k] = d[k] === undefined || d[k] === null ? null : elide(redact(String(d[k])), RECENT_STRING_FIELDS[k])
  RECENT_BOOL_FIELDS.forEach(function (b) { o[b] = !!d[b] })
  return o
}

// `id` (Phase 4): the instance id that owns the file. A file that carries an `id` must match;
// a Phase 3 file carries none and is accepted only by the first instance (`first`), which is
// the one that keeps recent.json; any other instance rejects it (review: data 2).
function parseRecent(text, instanceKey, nowMs, id, first) {
  var out = { recent: [], loaded: false, rejected: false }
  if (text === undefined || text === null || text === "") return out
  if (!instanceKey || typeof text !== "string" || text.length > RECENT_FILE_MAX_CHARS) { out.rejected = true; return out }
  var p = parseJson(text), v = p.ok ? p.value : null
  if (!v || typeof v !== "object" || Array.isArray(v) || v.version !== RECENT_FILE_VERSION || v.instance !== instanceKey || !Array.isArray(v.recent)) {
    out.rejected = true; return out
  }
  if (v.id !== undefined && v.id !== null) { if (!id || v.id !== id) { out.rejected = true; return out } }
  else if (id && !first) { out.rejected = true; return out }
  var now = nowMs || Date.now(), seen = bare()
  for (var i = 0; i < v.recent.length && out.recent.length < RECENT_CAP; i++) {
    var d = v.recent[i]
    if (!d || typeof d !== "object" || typeof d.uuid !== "string" || !UUID_RE.test(d.uuid) || seen[d.uuid]) continue
    if (!Object.prototype.hasOwnProperty.call(TERMINAL, String(d.status))) continue
    var t = Date.parse(d.finishedAt || d.updatedAt || "")
    if (isNaN(t) || now - t > RECENT_FILE_MAX_AGE_MS) continue
    seen[d.uuid] = true
    out.recent.push(recentEntry(d))
  }
  out.loaded = true
  return out
}

// -> { text, key }: `key` omits savedAt so an unchanged list is a no-op write.
function serialiseRecent(recent, instanceKey, nowMs, id) {
  var list = (recent || []).filter(function (d) { return !!d && typeof d.uuid === "string" && UUID_RE.test(d.uuid) && Object.prototype.hasOwnProperty.call(TERMINAL, String(d.status)) })
    .slice(0, RECENT_CAP).map(recentEntry)
  list.forEach(function (e) { delete e.appUuid; delete e.branch })
  var head = { version: RECENT_FILE_VERSION, instance: instanceKey }
  if (id) head.id = String(id)                                   // Phase 3's parseRecent ignores unknown keys, so a rollback still reads it
  var keyObj = {}; for (var k in head) keyObj[k] = head[k]; keyObj.recent = list
  var textObj = {}; for (var k2 in head) textObj[k2] = head[k2]; textObj.savedAt = nowMs || Date.now(); textObj.recent = list
  return { text: JSON.stringify(textObj, null, 2) + "\n", key: JSON.stringify(keyObj) }
}

// Dismiss (`x`, the row's × or the strip's Dismiss on a terminal row) is an acknowledge:
// it clears that row and every older terminal entry (`recent` is newest first), so the
// section reads "Nothing deploying." rather than promoting the next build into the same
// place. Entries stay in `recent` for `hasTerminal` and the file. The same array back when
// nothing changed.
function dismissRecent(recent, uuid) {
  var list = recent || [], at = -1
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].uuid === uuid) { at = i; break }
  if (at < 0) return recent
  var hit = false
  var out = list.map(function (d, j) {
    if (!d || j < at || d.dismissed) return d
    hit = true
    var o = {}; for (var k in d) o[k] = d[k]; o.dismissed = true
    return o
  })
  return hit ? out : recent
}

function mergeRecent(memory, loaded) {
  var seen = bare(), out = []
  ;(memory || []).concat(loaded || []).forEach(function (d) { if (!d || !d.uuid || seen[d.uuid]) return; seen[d.uuid] = true; out.push(d) })
  function at(d) { var t = Date.parse(d.finishedAt || d.updatedAt || ""); return isNaN(t) ? 0 : t }
  out.sort(function (a, b) { return at(b) - at(a) })
  return out.slice(0, RECENT_CAP)
}

// ---- ui.json: grouping and folds (Phase 4b) ------------------------------------------------
// One file for every instance, keyed by instance id: { version, savedAt, instances: { <id>:
// { origin, groupBy, folded: [key, ...] } } }. Preference data, so a rejected file simply
// yields the defaults and the next gesture replaces it. `folded` lists the keys whose flag
// is true, so the tags fold (whose flag means "opened") round-trips unchanged and the
// meaning stays in panelRows. Every key must match one of the three shapes panelRows emits.
var UI_FILE_VERSION = 1
var UI_FILE_MAX_CHARS = 65536
var UI_FOLD_CAP = 500
var UI_GROUP_BY = { project: true, server: true }
var UI_FOLD_KEY_RE = /^fold:(tags|s:(unassigned|[A-Za-z0-9]{1,64})|p:[A-Za-z0-9]{1,64}\/[^\x00-\x1f\x7f]{0,64})$/

function uiDefaults() { return { groupBy: "project", folded: {} } }

// -> { groupBy, folded } for one instance: the entry's values when they were saved for the
// same origin, the defaults otherwise (a re-pointed id keeps its grouping, drops its folds).
function uiFor(ui, id, instanceOrigin) {
  var out = uiDefaults(), e = ui && ui[id]
  if (!e) return out
  if (UI_GROUP_BY[e.groupBy]) out.groupBy = e.groupBy
  if (!instanceOrigin || e.origin === instanceOrigin) for (var k in e.folded) if (e.folded[k] === true) out.folded[k] = true
  return out
}

// A new map with one instance's entry replaced by `patch` ({ groupBy } and/or { folded }); the
// same map back when nothing changed, so an idle toggle never dirties the file.
function uiSet(ui, id, instanceOrigin, patch) {
  if (!id || !ID_RE.test(String(id)) || !patch) return ui
  var cur = uiFor(ui, id, instanceOrigin), next = { origin: instanceOrigin || "", groupBy: cur.groupBy, folded: {} }
  for (var k in cur.folded) next.folded[k] = true
  if (patch.groupBy !== undefined) { if (!UI_GROUP_BY[patch.groupBy]) return ui; next.groupBy = patch.groupBy }
  if (patch.folded !== undefined) { next.folded = {}; for (var f in patch.folded) if (patch.folded[f] === true && UI_FOLD_KEY_RE.test(f)) next.folded[f] = true }
  var prev = ui && ui[id]
  if (prev && prev.origin === next.origin && prev.groupBy === next.groupBy && sameKeys(prev.folded, next.folded)) return ui
  var out = {}; for (var i in ui || {}) out[i] = ui[i]; out[id] = next
  return out
}

function sameKeys(a, b) {
  var ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort()
  if (ka.length !== kb.length) return false
  for (var i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false
  return true
}

// -> { ui, loaded, rejected }. `ids` (the configured instance ids) filters the entries; an
// unknown groupBy or a malformed key drops that value, never the file. Bad shape rejects.
function parseUi(text, ids) {
  var out = { ui: {}, loaded: false, rejected: false }
  if (text === undefined || text === null || text === "") return out
  if (typeof text !== "string" || text.length > UI_FILE_MAX_CHARS) { out.rejected = true; return out }
  var p = parseJson(text), v = p.ok ? p.value : null
  if (!v || typeof v !== "object" || Array.isArray(v) || v.version !== UI_FILE_VERSION || !v.instances || typeof v.instances !== "object" || Array.isArray(v.instances)) {
    out.rejected = true; return out
  }
  var want = bare(); (ids || []).forEach(function (i) { want[String(i)] = true })
  for (var id in v.instances) {
    if (!want[id] || !ID_RE.test(id)) continue
    var e = v.instances[id]
    if (!e || typeof e !== "object" || Array.isArray(e)) continue
    var entry = { origin: typeof e.origin === "string" ? elide(e.origin, 400) : "", groupBy: UI_GROUP_BY[e.groupBy] ? e.groupBy : "project", folded: {} }
    var n = 0
    if (Array.isArray(e.folded)) for (var i = 0; i < e.folded.length && n < UI_FOLD_CAP; i++) {
      var k = e.folded[i]
      if (typeof k !== "string" || !UI_FOLD_KEY_RE.test(k) || entry.folded[k]) continue
      entry.folded[k] = true; n++
    }
    out.ui[id] = entry
  }
  out.loaded = true
  return out
}

// -> { text, key }: `key` omits savedAt so an unchanged map is a no-op write. Entries for ids
// no longer configured are pruned, so the file mirrors the config.
function serialiseUi(ui, ids, nowMs) {
  var inst = {}
  ;(ids || []).forEach(function (id) {
    var e = ui && ui[String(id)]
    if (!e) return
    var keys = Object.keys(e.folded || {}).filter(function (k) { return e.folded[k] === true && UI_FOLD_KEY_RE.test(k) }).sort().slice(0, UI_FOLD_CAP)
    inst[String(id)] = { origin: String(e.origin || ""), groupBy: UI_GROUP_BY[e.groupBy] ? e.groupBy : "project", folded: keys }
  })
  var keyObj = { version: UI_FILE_VERSION, instances: inst }
  var textObj = { version: UI_FILE_VERSION, savedAt: nowMs || Date.now(), instances: inst }
  return { text: JSON.stringify(textObj, null, 2) + "\n", key: JSON.stringify(keyObj) }
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
  if (!i) return "Coolwatch"
  return i.name || i.id || hostOf(i.url) || "Coolwatch"
}

function heroDetail(s) {
  var v = s && s.instance && s.instance.version
  return v ? "v" + v : ""
}

// Phase 4b: the trouble counts follow the totals so the hero and the bar tooltip (both
// read this) say where the trouble is. Stopped = exited or paused; unhealthy = running
// with an unhealthy health word, or degraded. Zero clauses drop.
function stoppedResources(s) { return (s && s.resources ? s.resources : []).filter(function (r) { return r.state === "exited" || r.state === "paused" }) }
function unhealthyResources(s) { return (s && s.resources ? s.resources : []).filter(function (r) { return r.state === "degraded" || (r.state === "running" && r.health === "unhealthy") }) }

function countsLine(s) {
  var parts = []
  var ns = s.servers ? s.servers.length : 0
  var nr = s.resources ? s.resources.length : 0
  var nd = activeDeployments(s).length
  var nx = stoppedResources(s).length
  var nu = unhealthyResources(s).length
  if (ns) parts.push(plural(ns, "server"))
  if (nr) parts.push(plural(nr, "resource"))
  if (nd) parts.push(nd + " deploying")
  if (nx) parts.push(nx + " stopped")
  if (nu) parts.push(nu + " unhealthy")
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
  if (!s) return dim(G.cloud, "Coolwatch — starting")
  if (ek === "noconfig") return dim(G.cloudOutline, "Coolwatch — no config at ~/.config/coolwatch/config.json")
  if (ek === "configerror") return dim(G.cloudAlert, "Coolwatch — config error: " + String(e.detail || "").split("\n")[0])
  if (ek === "unsafe") return dim(G.cloudAlert, "Coolwatch — config is writable by others")
  if (ek === "tokencmd") return dim(G.cloudAlert, "Coolwatch — token command failed (exit " + (e.curlExit || 0) + ")")
  if (ek === "waitingtoken") return dim(G.cloud, "Coolwatch — waiting for token command")
  if (ek === "auth") return dim(G.cloudAlert, "Coolwatch — token rejected")
  if (ek === "apidisabled") return dim(G.cloudAlert, "Coolwatch — API disabled on this instance")
  if (ek === "ipblocked") return dim(G.cloudAlert, "Coolwatch — this IP is not allowed")
  if (ek === "down") return dim(G.cloudOff, "Coolwatch — Coolify is not responding" + (e.healthCode ? " (" + e.healthCode + ")" : ""))
  if (ek === "offline") return dim(G.cloudOff, "Coolwatch — offline, retrying")
  if (ek === "tls") return dim(G.cloudAlert, "Coolwatch — certificate rejected, retrying")
  if (ek === "ratelimited") return dim(G.cloud, "Coolwatch — rate limited, backing off " + (s.backoffSec || 0) + "s")
  if (!s.baselineDone && !isPartial(s)) return dim(G.cloud, "Coolwatch — starting")
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
// The Coolify mark (Mark.qml) stands in for the filled cloud and the deploying glyph; the
// trouble glyphs (alert, off, outline, failed) stay, since the bar has only colour and
// opacity to tell states apart. `glyph` is kept beside it for the status output.
function barMark(b) { return !!b && (b.glyph === G.cloud || b.glyph === G.progress) }

// ---- instances (Phase 4) ------------------------------------------------------------------
// `list` is the service's per-instance summary: [{ id, name, error, failed, down }] (error = the
// instance's error kind or "", failed = unacknowledged failed builds, down = unreachable servers).

function instanceTroubleOf(x) {
  if (!x) return ""
  if (x.error === "ability") return "token lacks an ability"          // META.ability is empty by design (the callout composes it)
  if (x.error === "down") return "not responding"                     // META.down lowercased would read "coolify not responding"
  if (x.error) return META[x.error] ? META[x.error].replace(/ · .*$/, "").toLowerCase() : "error"
  if (x.failed > 0) return plural(x.failed, "failed build")
  if (x.down > 0) return plural(x.down, "server") + " unreachable"
  return ""
}

// What a context's store was built from: the entry with its token replaced by a
// fingerprint (length and a djb2 sum), so a token change still resets the context and
// the key holds no copy of the token (SR34).
function tokenFingerprint(token) {
  var s = String(token === undefined || token === null ? "" : token), h = 5381
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return s.length + ":" + h.toString(16)
}
function instanceKey(entry, poll) {
  var e = {}
  for (var k in entry) if (k !== "token") e[k] = entry[k]
  e.tokenFp = tokenFingerprint(entry ? entry.token : "")
  return JSON.stringify({ e: e, poll: poll || null })
}

// Chips exist only with two or more instances; one instance shows none.
function instanceChips(list, activeId) {
  list = list || []
  if (list.length < 2) return []
  return list.map(function (x) {
    return { id: String(x.id || ""), label: elide(String(x.name || x.id || ""), 24), selected: x.id === activeId, trouble: !!instanceTroubleOf(x) }
  })
}

// The bar icon follows the active instance; this names the first other instance in trouble,
// for the tooltip suffix. "" when none.
function instanceTrouble(list, activeId) {
  list = list || []
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === activeId) continue
    var t = instanceTroubleOf(list[i])
    if (t) return elide(String(list[i].name || list[i].id || ""), 24) + ": " + t
  }
  return ""
}

function failedName(s, uuid) {
  var all = (s.recent || []).concat(s.deployments || [])
  for (var i = 0; i < all.length; i++) if (all[i].uuid === uuid) return all[i].appName || uuid
  return uuid
}

var SAMPLE_CONFIG = '{ "version": 1, "instances": [\n  { "id": "cloud", "name": "Coolify Cloud", "url": "https://app.coolify.io", "token": "67|…" } ] }'
// The file "Edit config" creates when none exists (0600 in a 0700 directory, written by the
// service): the same shape with a placeholder the user replaces. It parses, so the next
// state is "token rejected", whose callout keeps the button. JSON has no comments, so the
// second-instance example rides a `_help` string (normaliseConfig ignores unknown keys);
// a real second entry would poll a made-up URL.
var SAMPLE_CONFIG_FILE = '{\n  "version": 1,\n  "_help": "One object per Coolify. Add a second one to instances for a self-hosted server, e.g. { \\"id\\": \\"homelab\\", \\"name\\": \\"Homelab\\", \\"url\\": \\"http://10.0.0.5:8000\\", \\"token\\": \\"...\\" }. Full reference: https://github.com/danjonesio/coolwatch#configuration",\n  "instances": [\n    { "id": "cloud", "name": "Coolify Cloud", "url": "https://app.coolify.io", "token": "paste-your-token-here" }\n  ]\n}\n'
// The footer's cog and `e` open the config at any time. The callouts the file can fix carry a
// second, spelled-out "Edit config" button as the call to action: the file is missing,
// unreadable, unsafe, readable by others, its token command failed or its token was
// rejected. Network, rate-limit and ability problems are not the file's.
var EDITABLE_ERRORS = { noconfig: true, configerror: true, unsafe: true, tokencmd: true, auth: true }
function calloutEditable(s) {
  if (!s) return false
  if (s.error) return !!EDITABLE_ERRORS[s.error.kind]
  return !!(s.warning && s.warning.kind === "permissions")
}

// The host in a callout body: the instance's url host, never fqdn (bin/check).
function hostWord(s) { return hostOf(s && s.instance ? s.instance.url : "") || "Coolify" }

// Bodies for the health-derived states (health before auth). Constant copy: only the host and a
// numeric code from the health answer ever appear; the health body itself never does.
function downBody(e, s) {
  var host = hostWord(s), c = Number(e.healthCode || 0)
  if (Number(e.healthExit) === 63) return host + " sent a page, not Coolify's health answer. Retrying."
  if (c >= 300 && c < 400) return host + " redirected Coolify's health check (" + c + "). Check the url in ~/.config/coolwatch/config.json: the scheme or the path is probably wrong."
  if (c === 404 || (c >= 200 && c < 300)) return "Nothing at " + host + " answers as Coolify. Check the url in ~/.config/coolwatch/config.json."   // a 2xx here is a page, not OK
  if (c === 401 || c === 403) return host + " refused Coolify's unauthenticated health check (" + c + "), so something in front of Coolify is blocking this machine. Retrying."
  if (c >= 500) return host + " answered " + c + " on Coolify's health check, so this is not a token problem. Retrying."
  return host + " did not answer Coolify's health check" + (c ? " (" + c + ")" : "") + ". Retrying."
}

function calloutBody(e, s) {
  switch (e.kind) {
    case "noconfig": return "Create ~/.config/coolwatch/config.json (chmod 600):\n" + SAMPLE_CONFIG
    case "configerror": return e.detail || "Config could not be read."
    case "unsafe": return "Anyone on this machine can rewrite it. Run: chmod 600 ~/.config/coolwatch/config.json"
    case "tokencmd": return "The token command exited " + (e.curlExit || 0) + ". Its output is never logged; run it yourself to see why."
    case "waitingtoken": return "Running the token command…"
    case "auth":
      if (e.healthState === "ok") return "Coolify is up and rejected this token. Create a new one in Coolify → Security → API Tokens with the read ability."
      if (e.healthState === "blocked") return hostWord(s) + " also refused Coolify's unauthenticated health check (" + (e.healthCode || 0) + "), so something in front of Coolify may be blocking this machine. If the proxy is expected, the token may have been revoked."
      return "Create a token in Coolify → Security → API Tokens with the read ability."
    case "apidisabled": return "Enable it in Settings → Advanced → API Access."
    case "ipblocked": return "Add this machine's IP to the token's allowed list in Coolify → Security → API Tokens."
    case "ability": return "The token is missing the " + (abilityOf(e.detail) || "required") + " ability."
    case "ratelimited": return "Backing off " + ((s && s.backoffSec) || e.backoffSec || 30) + "s."
    case "offline": return "Nothing answered at " + hostWord(s) + ". Retrying."
    case "down": return downBody(e, s)
    case "tls": return "curl could not verify this instance's certificate; nothing was sent. Fix the certificate (or trust its CA on this machine). Retrying."
    case "toolarge": return "Coolify's response exceeded 8 MB and was dropped."
    case "http":
      if (e.healthState === "ok") {
        if (e.notJson) return "Coolify is up, but the API returned something that is not JSON (" + (e.httpCode || 0) + ")."
        var synthetic = e.detail === "Coolify returned " + (e.httpCode || 0)   // errorFor's fallback when Coolify sent no message
        return "Coolify is up, but the API returned " + (e.httpCode || 0) + "." + (e.detail && !synthetic ? "\n" + e.detail : "")
      }
      return e.detail || ("Coolify returned " + (e.httpCode || 0) + ".")
    default: return e.detail || ""
  }
}

function abilityOf(msg) {
  var m = /permissions?:\s*([a-z:]+)/i.exec(String(msg || ""))
  return m ? m[1] : ""
}

function warningBody(w) {
  if (!w) return ""
  if (w.kind === "permissions") return "Anyone on this machine can read your token. Run: chmod 600 ~/.config/coolwatch/config.json"
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
    title = w.kind === "permissions" ? "Config is readable by others" : (w.kind === "plaintext" ? "Plaintext instance" : (w.title || "Warning"))
    body = warningBody(w)
  }
  return { title: title, body: body, edit: calloutEditable(s) }
}

var NOTES = { deployments: "Nothing deploying.", servers: "No servers on this team.", resources: "No resources on this team.", nomatch: "No match." }
var NOT_LOADED = "Not loaded yet."
function noteFor(s, section) { return (s.error || !s.baselineDone) && (s.lastPollAt || {})[section] === 0 ? NOT_LOADED : NOTES[section] }

// ---- type-to-filter (Phase 4b) --------------------------------------------------------------
// `/` opens a field; its text narrows resources and deployments (never servers; tags hide).
// Space-separated terms all match (the shell menu's convention), case-insensitive, against
// the row's display name plus its status, kind and caption words. Panel-local, never persisted.
var FILTER_MAX_TERMS = 8
var FILTER_MAX_TERM = 64

function filterTerms(text) {
  return String(text || "").toLowerCase().trim().split(/\s+/).filter(function (t) { return t.length > 0 })
    .slice(0, FILTER_MAX_TERMS).map(function (t) { return t.slice(0, FILTER_MAX_TERM) })
}

function rowMatches(row, terms) {
  if (!terms || !terms.length) return true
  var hay = [row.name, row.statusWords, row.kindHint, row.sub, row.status].filter(function (x) { return !!x }).join(" ").toLowerCase()
  for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false
  return true
}

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

// Phase 4b: the dot already carries the state, so a running resource shows only its
// health word ("healthy", "unhealthy"); with no health word the state stays so the
// caption is never empty. Every other state is its own word.
function statusWords(res) {
  if (res.state === "unknown") return res.status || "unknown"
  if (res.state === "running" && res.health !== "unknown") return res.health
  return res.state
}

var KIND_HINT = { application: "app", service: "service", postgresql: "postgres", mysql: "mysql", mariadb: "mariadb", mongodb: "mongo", redis: "redis", keydb: "keydb", dragonfly: "dragonfly", clickhouse: "clickhouse" }

function kindHint(res) {
  if (res.kind === "application") return "app"
  if (res.kind === "service") return "service"
  return KIND_HINT[res.type] || res.type || ""
}

// ---- browser URLs (SR9) -------------------------------------------------------------------
// Every browser URL is the configured instance origin plus a path built here. The only
// returned string ever used is a deployment's relative `deployment_url`; it must start
// with exactly one "/" and carry no scheme. Resource and server paths are built from
// uuids only. "" means "no page": the Open button is absent and `o` does nothing.

function origin(instanceUrl) {
  var u = String(instanceUrl === undefined || instanceUrl === null ? "" : instanceUrl).trim().replace(/\/+$/, "")
  // scheme + host, optional path prefix; no query, no fragment, no userinfo (a URL with
  // credentials would otherwise reach browser argv and the shell's history files, SR19)
  return /^https?:\/\/[^\/\s?#@]+(\/[^\s?#]*)?$/.test(u) ? u : ""
}

function enc(v) { return encodeURIComponent(String(v === undefined || v === null ? "" : v)) }

function openUrl(targetType, obj, originStr) {
  var o = origin(originStr)
  if (!o || !obj) return ""
  if (targetType === "deployment") {
    var p = typeof obj.url === "string" ? obj.url : ""
    if (!/^\/(?!\/)/.test(p)) return ""
    if (/^[^\/]*:/.test(p.slice(1))) return ""
    return o + p
  }
  if (targetType === "resource") {
    if (!obj.projectUuid || !obj.environmentUuid || !obj.uuid) return ""
    if (!Object.prototype.hasOwnProperty.call(UI_SEGMENT, obj.kind)) return ""
    return o + "/project/" + enc(obj.projectUuid) + "/environment/" + enc(obj.environmentUuid) + "/" + UI_SEGMENT[obj.kind] + "/" + enc(obj.uuid)
  }
  if (targetType === "server") {
    if (!obj.uuid) return ""
    return o + "/server/" + enc(obj.uuid)
  }
  return ""
}

function deploymentRow(d, originStr) {
  var g = deploymentGlyph(d)
  return {
    type: "deployment", key: "dep:" + d.uuid, uuid: d.uuid, glyph: g.glyph, tone: g.tone,
    name: appLabel(d.appName, d.uuid), sub: [d.branch, d.commitMessage].filter(function (x) { return !!x }).join(" · "),   // Phase 4b: the toast label, not Coolify's decorated name
    createdAt: d.createdAt, updatedAt: d.updatedAt, terminal: !!TERMINAL[d.status], status: d.status,
    finishedAt: d.finishedAt || null,
    url: openUrl("deployment", d, originStr), pendingVerb: ""
  }
}

// The IPC verb `log <uuid>` (Phase 4b item 6) hands the panel a deployment row for
// openLogsFor: the active list first, then recent (both already joined), else a bare row
// (uuid8 as the name) so the view opens and the fetch reports in-view.
function logRequestRow(s, uuid, originStr) {
  uuid = String(uuid === undefined || uuid === null ? "" : uuid)
  if (!UUID_RE.test(uuid)) return null
  var d = byUuid(s && s.deployments)[uuid] || byUuid(s && s.recent)[uuid] || null
  var row = d ? deploymentRow(d, originStr) : { type: "deployment", uuid: uuid, name: uuid8(uuid), url: "", status: "", createdAt: "", updatedAt: "" }
  row.finishedAt = d && d.finishedAt ? d.finishedAt : ""
  return row
}

function serverRow(x, originStr) {
  var bits = [x.ip]
  bits.push(plural(x.resourceCount || 0, "resource"))
  if (!x.reachable && !x.disabled) bits.push("unreachable")
  if (x.disabled) bits.push("disabled")
  if (x.buildServer) bits.push("build server")
  var dot = x.disabled || !x.reachable ? G.dotOff : (x.usable ? G.dotOn : G.half)
  var tone = !x.reachable && !x.disabled ? "urgent" : (x.disabled ? "dim" : (x.usable ? "fg" : "urgent"))
  return { type: "server", key: "srv:" + x.uuid, uuid: x.uuid, dot: dot, tone: tone, name: x.name,
           sub: bits.filter(function (b) { return !!b }).join(" · "), dim: !x.reachable || x.disabled,
           url: openUrl("server", x, originStr), pendingVerb: "" }
}

function resourceRow(r, indent, originStr) {
  var d = statusDot(r)
  return { type: "resource", key: "res:" + r.uuid, uuid: r.uuid, dot: d.dot, tone: d.tone, name: appLabel(r.name, r.uuid),   // Phase 4b: `storefront`, not `storefront:main-h0wx…`
           statusWords: statusWords(r), kindHint: kindHint(r), dim: r.state === "exited" || r.state === "paused", indent: indent || 0,
           kind: r.kind, state: r.state, health: r.health, url: openUrl("resource", r, originStr), pendingVerb: "" }
}

// ---- pending (Phase 2) ------------------------------------------------------------------
// The service owns the pending map; rows render it. A resource row's status words are
// replaced by the verb; deployment and server rows keep their caption and gain it.

function gerund(verb) { return GERUND[verb] || String(verb || "") }
function pendingVerb(verb, stale) { return gerund(verb) + "…" + (stale ? " · still pending" : "") }

function withPending(row, entry) {
  if (!entry) return row
  var o = {}
  for (var k in row) o[k] = row[k]
  var v = pendingVerb(entry.verb, !!entry.stale)
  if (row.type === "resource") o.statusWords = v
  else o.sub = (row.sub ? row.sub + " · " : "") + v
  o.tone = "accent"
  o.dot = G.half
  o.pendingVerb = v
  return o
}

// ---- applicability (Phase 2) --------------------------------------------------------------
// THE table: which buttons a row offers, in order. Hidden, never disabled. Every other
// applicability decision (keys, IPC, the confirm) is a lookup over this list (SR3).

// `primary` marks the lifecycle verbs that stay on the strip's first line when it folds
// behind More (Redeploy/Deploy, Restart, Stop/Start); everything else is secondary.
function act(id, label, destructive, confirm, button, primary) { return { id: id, label: label, destructive: !!destructive, confirm: !!confirm, button: button !== false, primary: !!primary } }
var OPEN = act("open", "Open", false, false)
function buttons(list) { return list.filter(function (a) { return a.button }) }

// The strip folds only when it would wrap: STRIP_FIT buttons sit on one line of the
// fitted card. Above that, the primary verbs plus a More toggle make the first line and
// the rest appear beneath when More is open. `actions` is the h/l order (primary, more,
// then the revealed secondaries); `primary`/`secondary` are the two rendered lines.
var STRIP_FIT = 4
var MORE_ID = "more"
function stripFor(row, moreOpen) {
  var list = buttons(actionsFor(row))
  var primary = list.filter(function (a) { return a.primary }), secondary = list.filter(function (a) { return !a.primary })
  if (list.length <= STRIP_FIT || !primary.length || !secondary.length) return { actions: list, primary: list, secondary: [] }
  var more = act(MORE_ID, moreOpen ? "Less" : "More", false, false)
  var shown = moreOpen ? secondary : []
  return { actions: primary.concat([more], shown), primary: primary.concat([more]), secondary: shown }
}

function actionsFor(row) {
  if (!row) return []
  var out = []
  if (row.type === "resource") {
    var running = !!RUNNING_STATES[row.state], stopped = !!STOPPED_STATES[row.state]
    if (running || stopped) {
      // One button follows the state: Deploy brings a stopped application up, Redeploy
      // rebuilds a running one (both POST /deploy). The no-cache rebuild (`D`) is
      // keyboard-only and confirms.
      if (row.kind === "application") {
        if (running) { out.push(act("redeploy", "Redeploy", false, false, true, true)); out.push(act("rebuild", "Rebuild", true, true, false)) }
        else out.push(act("deploy", "Deploy", false, false, true, true))
      }
      if (running) { out.push(act("restart", "Restart", false, false, true, true)); out.push(act("stop", "Stop", true, true, true, true)) }
      else out.push(act("start", "Start", false, false, true, true))
      // Phase 4: the container tail needs a running container (a stopped one is 404).
      if (running) out.push(act("logs", "Logs"))
    }
    if (row.kind === "application") out.push(act("history", "History"))
  } else if (row.type === "server") {
    out.push(act("validate", "Validate"))
  } else if (row.type === "deployment") {
    // Phase 4: Logs first, on every deployment row, so Enter, Enter reaches the build log.
    out.push(act("logs", "Logs"))
    if (ACTIVE[row.status]) out.push(act("cancel", "Cancel", true, true))
    else if (TERMINAL[row.status]) out.push(act("dismiss", "Dismiss"))   // local: hides the row, no request (Phase 4b)
  } else if (row.type === "tag") {
    // Phase 4: a fan-out the API cannot enumerate, so it always confirms (SR35).
    out.push(act("deployTag", "Deploy", false, true))
  } else return []
  if (row.url) out.push(OPEN)
  return out
}

// `s` resolves to stop or start, `d`/`deploy` to deploy or redeploy, `D` to rebuild;
// canonical ids pass through.
function actionFor(row, verb) {
  var list = actionsFor(row)
  var running = !!RUNNING_STATES[row && row.state]
  var want = verb === "s" ? (running ? "stop" : "start")
           : (verb === "d" || verb === "deploy") ? (row && row.type === "tag" ? "deployTag" : (running ? "redeploy" : "deploy"))
           : (verb === "D" ? "rebuild" : (verb === "L" ? "logs" : verb))
  for (var i = 0; i < list.length; i++) if (list[i].id === want) return list[i]
  return null
}

var TARGET_TYPE = { resource: "resource", server: "server", deployment: "deployment", tag: "tag" }
function targetTypeOf(row) { return (row && TARGET_TYPE[row.type]) || "" }

// The single gate for panel and IPC: is this uuid in the store, and does this verb apply?
// Returns no Api descriptor (Model never imports Api); the service builds it from `kind`.
function actionRequest(s, verb, uuid) {
  uuid = String(uuid === undefined || uuid === null ? "" : uuid)
  if (NAV_VERBS[verb]) return { ok: false, why: "nav" }
  if (!UUID_RE.test(uuid)) return { ok: false, why: "invalid" }
  s = s || {}
  var o = origin(s.instance && s.instance.url)
  var row = null, obj = null
  ;(s.resources || []).forEach(function (r) { if (!row && r.uuid === uuid) { obj = r; row = resourceRow(r, 0, o) } })
  ;(s.deployments || []).forEach(function (d) { if (!row && d.uuid === uuid) { obj = d; row = deploymentRow(d, o) } })
  ;(s.servers || []).forEach(function (x) { if (!row && x.uuid === uuid) { obj = x; row = serverRow(x, o) } })
  // Phase 4: a tag is keyed by its Coolify uuid; the name (TAG_RE-validated at normalise)
  // is what reaches the query string (SR28, SR35).
  ;(s.tags || []).forEach(function (t) { if (!row && t.uuid === uuid) { obj = t; row = tagRow(t) } })
  if (!row) return { ok: false, why: "unknown" }
  var a = actionFor(row, verb)
  if (!a) return { ok: false, why: "notapplicable" }
  return { ok: true, verb: a.id, uuid: uuid, name: row.name, targetType: targetTypeOf(row),
           kind: row.type === "resource" ? row.kind : null, confirm: a.confirm, destructive: a.destructive,
           status: row.type === "resource" ? obj.status : null }
}

var IPC_ARG_MAX = 64          // the IPC argument's own bound: UUID_RE's ceiling and _refuse's echo bound (not FILTER_MAX_TERM: a filter term is a different input)
var UUID_SHAPED_RE = /^[a-z0-9]{20,}$/   // what appLabel treats as a Coolify uuid (the {20,} runs above); a miss on this shape is a uuid miss
// The four lists actionRequest scans, by presence only. Kept beside the gate rather than
// extracted from it so the single gate stays byte-for-byte; a fifth list goes in both.
function holdsUuid(s, uuid) {
  return [s.resources, s.deployments, s.servers, s.tags].some(function (l) {
    return (l || []).some(function (x) { return !!x && x.uuid === uuid })
  })
}
// Turns an IPC argument into a store uuid, in front of actionRequest (which stays the gate).
// Uuid first, over every list the gate scans, so an existing uuid never changes meaning; then
// the resource label the panel shows (appLabel on both sides: whitespace collapses, a pasted
// decorated name and a 32+-char name both elide the same way; appLabel's regexes are
// lowercase-only, so an upper-cased decorated paste does not resolve while an upper-cased
// label does), exact first, then case-folded. Resources only: a deployment's label is its
// application's, no verb applies to a server, and a tag name would fan out unconfirmed (SR35).
// A row whose uuid fails UUID_RE is invisible (normalise does not charset-check uuids; the
// same drop normaliseTags makes), so a name never resolves to a string that would fail the
// gate's re-test and reach stdout, the log or status through _refuse (SR15).
function resolveActionTarget(s, arg) {
  var a = String(arg === undefined || arg === null ? "" : arg).trim()
  if (!a || a.length > IPC_ARG_MAX) return { ok: false, why: "unknownname" }
  s = s || {}
  if (UUID_RE.test(a) && holdsUuid(s, a)) return { ok: true, uuid: a, by: "uuid" }
  var label = appLabel(a, ""), want = label.toLowerCase(), exact = [], folded = []
  if (want) (s.resources || []).forEach(function (r) {
    if (!r || !UUID_RE.test(r.uuid)) return
    var l = appLabel(r.name, r.uuid)
    if (l === label && exact.indexOf(r.uuid) < 0) exact.push(r.uuid)
    if (l.toLowerCase() === want && folded.indexOf(r.uuid) < 0) folded.push(r.uuid)
  })
  var hits = exact.length ? exact : folded
  if (hits.length === 1) return { ok: true, uuid: hits[0], by: "name" }
  if (hits.length) return { ok: false, why: "ambiguousname" }
  return { ok: false, why: UUID_SHAPED_RE.test(a) ? "unknown" : "unknownname" }
}

// "" when the action may launch now (SR6).
function canAct(pending, inflight, uuid, nowMs, lastLaunchAt) {
  if ((pending && Object.prototype.hasOwnProperty.call(pending, uuid)) || (inflight && inflight.uuid === uuid)) return "already pending"
  if (inflight) return "busy"
  if (lastLaunchAt && (nowMs || Date.now()) - lastLaunchAt < 1000) return "busy"
  return ""
}

function confirmCopy(verb, name) {
  var n = String(name || "it")
  switch (verb) {
    case "stop": return { message: "Stop " + n + "?", cancelText: "Cancel", confirmText: "Stop" }
    case "rebuild": return { message: "Rebuild " + n + " without cache?", cancelText: "Cancel", confirmText: "Rebuild" }
    case "cancel": return { message: "Cancel the deployment of " + n + "?", cancelText: "Keep it", confirmText: "Cancel it" }
    case "deployTag": return { message: "Deploy everything tagged " + n + "? Coolify decides what that is; the API cannot list it.", cancelText: "Cancel", confirmText: "Deploy" }
    default: return { message: gerund(verb) + " " + n + "?", cancelText: "Cancel", confirmText: "Confirm" }
  }
}

var TARGET_WORD = { resource: "resource", deployment: "deployment", server: "server", tag: "tag" }
var OK_TEXT = { deploy: "Deployment queued", redeploy: "Redeploy queued", rebuild: "Rebuild queued", stop: "Stop requested", start: "Start requested",
                cancel: "Deployment cancelled", validate: "Validation started" }

// One classified error -> one sentence. Shared by the action status line and the Phase 4
// view fetches (fetchOutcome), so the ability/offline/429 copy exists once. Never echoes a body.
function errorText(e, rec, targetType) {
  var ab
  switch (e.kind) {
    case "ability": ab = abilityOf(e.detail); return ab ? "Token lacks the " + ab + " permission" : "Coolify said: " + elide(e.detail, 110)
    case "apidisabled": return "Coolify's API is disabled on this instance"
    case "ipblocked": return "This IP is not allowed by the token"
    case "auth": return "Token rejected"
    case "ratelimited": return "Rate limited · try again in " + retryAfterSec(rec ? rec.headers : null, 1) + "s"
    case "offline": return "Coolify is unreachable"
    case "toolarge": return "Coolify's response was too large"
    default:
      if (e.curlExit) return "Coolify returned nothing (curl " + e.curlExit + ")"
      if (e.httpCode === 404) return "Coolify no longer has that " + (TARGET_WORD[targetType] || "resource")
      var m = messageOf(rec ? rec.body : "")
      return m ? "Coolify said: " + elide(redact(m), 110) : "Coolify returned " + e.httpCode
  }
}

// One splitResponses record (or the service's empty-stream fallback) -> the status line.
// errorFor classifies; only the sink differs from polling (SR4, SR10). Never echoes a body.
function actionOutcome(verb, targetType, rec) {
  if (!rec || typeof rec !== "object" || rec.code === undefined) rec = { exit: 1, code: 0, body: "", errmsg: "", headers: null }
  var e = errorFor({ curlExit: rec.exit, httpCode: rec.code, body: rec.body, errmsg: rec.errmsg, request: "action" })
  var out = { ok: false, text: "", tone: "urgent", deploymentUuid: null, deploymentUuids: [], queued: 0, refused: 0, error: e }
  if (e) { out.text = errorText(e, rec, targetType); return out }
  var body = parseJson(rec.body)
  var v = body.ok && body.value && typeof body.value === "object" ? body.value : {}
  if (verb === "deployTag") {
    // Phase 4: one entry per tagged resource. Live on 4.3.19 the body is
    // {details: [{resource_uuid, deployment_uuid}], message: [..]} (docs/coolify-api.md said
    // `deployments`; both are read). An item without a deployment uuid, a 429 status or a
    // queue-full message is a refusal, reported as a count, never as a bare success (SR35).
    var items = Array.isArray(v.details) ? v.details : (Array.isArray(v.deployments) ? v.deployments : [])
    items.forEach(function (it) {
      if (!it || typeof it !== "object") return
      var dep = typeof it.deployment_uuid === "string" && UUID_RE.test(it.deployment_uuid) ? it.deployment_uuid : null
      if (!dep || Number(it.status) === 429 || /queue_full|queue is full/i.test(String(it.message || ""))) { out.refused += 1; return }
      out.queued += 1
      out.deploymentUuids.push(dep)
    })
    out.ok = true; out.error = null; out.tone = out.refused ? "urgent" : "dim"
    out.deploymentUuid = out.deploymentUuids[0] || null
    out.text = out.queued + " queued" + (out.refused ? ", " + out.refused + " refused (queue full)" : "")
    return out
  }
  var item = Array.isArray(v.deployments) && v.deployments.length ? (v.deployments[0] || {}) : null
  if (item && (Number(item.status) === 429 || /queue_full/i.test(String(item.message || "")))) {
    out.error = makeError("http", String(item.message || "queue_full"), { httpCode: 429, request: "action" })
    out.error.kind = "http"
    out.text = "Coolify's build queue is full"
    return out
  }
  var dep = item && typeof item.deployment_uuid === "string" ? item.deployment_uuid : (typeof v.deployment_uuid === "string" ? v.deployment_uuid : null)
  out.ok = true; out.tone = "dim"; out.error = null; out.deploymentUuid = dep || null
  if (verb === "restart") out.text = dep ? "Restart queued" : "Restart requested"
  else out.text = OK_TEXT[verb] || (gerund(verb) + " requested")
  return out
}

// Keyboard focus inside the action strip; an id no longer in the list counts as the first.
function nextAction(actions, id, dx) {
  var ids = (actions || []).map(function (a) { return a.id })
  if (!ids.length) return ""
  var i = ids.indexOf(id)
  if (i < 0) i = 0
  if (dx < 0 && i === 0) return ""
  var j = Math.max(0, Math.min(ids.length - 1, i + (dx < 0 ? -1 : 1)))
  return ids[j]
}

// The non-selectable `actions` row directly after the expanded leaf, if it still exists.
function spliceActions(rows, ui) {
  if (!ui || !ui.expandedKey) return rows
  var i = indexOfKey(rows, ui.expandedKey)
  if (i < 0) return rows
  var row = rows[i]
  var strip = stripFor(row, !!ui.moreOpen)
  if (!strip.actions.length) return rows
  rows.splice(i + 1, 0, { type: "actions", key: "act:" + row.key, parentKey: row.key, uuid: row.uuid,
                          targetType: targetTypeOf(row), name: row.name, actions: strip.actions, primary: strip.primary, secondary: strip.secondary })
  return rows
}

// In-place edits that take a ListModel holding `prev` (by key) to `next`, in order:
// { op: "remove", i, n } | { op: "insert", i, rows } | { op: "set", i, row }. A row whose
// key survives is `set` only when its rowRev changed; a reorder is a remove and a later
// insert. Indices are valid at the moment each op is applied, in sequence. Replacing the
// model wholesale would reset the ListView's scroll and rebuild every delegate.
function listPatch(prev, next) {
  var cur = (prev || []).slice(), ops = [], i = 0
  var pos = {}
  for (var j = 0; j < next.length; j++) pos[next[j].key] = j
  function remove(at, n) {
    var last = ops.length ? ops[ops.length - 1] : null
    if (last && last.op === "remove" && last.i === at) last.n += n
    else ops.push({ op: "remove", i: at, n: n })
    cur.splice(at, n)
  }
  for (j = 0; j < next.length; j++) {
    var row = next[j], key = row.key
    // Old rows here that are gone, or belong earlier (a duplicate already placed), go first.
    while (i < cur.length && cur[i].key !== key && !(pos[cur[i].key] > j)) remove(i, 1)
    if (i < cur.length && cur[i].key === key) {
      if (rowRev(cur[i]) !== rowRev(row)) { ops.push({ op: "set", i: i, row: row }); cur[i] = row }
      i++
      continue
    }
    var k = -1
    for (var m = i + 1; m < cur.length; m++) if (cur[m].key === key) { k = m; break }
    if (k > i) { remove(i, k - i); ops.push({ op: "set", i: i, row: row }); cur[i] = row; i++; continue }
    var last = ops.length ? ops[ops.length - 1] : null
    if (last && last.op === "insert" && last.i + last.rows.length === i) last.rows.push(row)
    else ops.push({ op: "insert", i: i, rows: [row] })
    cur.splice(i, 0, row); i++
  }
  if (i < cur.length) remove(i, cur.length - i)
  return ops
}

function panelRows(s, ui) {
  ui = ui || {}
  var nowMs = ui.nowMs || Date.now()
  var folded = ui.folded || {}
  var groupBy = ui.groupBy === "server" ? "server" : "project"
  var pending = ui.pending || {}
  var terms = filterTerms(ui.filter), filtering = terms.length > 0
  var rows = []
  s = s || {}
  var o = origin(s.instance && s.instance.url)
  function pend(row) { return withPending(row, Object.prototype.hasOwnProperty.call(pending, row.uuid) ? pending[row.uuid] : null) }
  var sep = 0
  // DEPLOYMENTS
  rows.push({ type: "section", key: "sec:deployments", title: "DEPLOYMENTS", control: null })
  var active = activeDeployments(s)
  var kept = (s.recent || []).filter(function(d) { return !!d && !d.dismissed })
  var recent = kept.filter(function(d) {
    var t = Date.parse(d.finishedAt || d.updatedAt || "")
    return isNaN(t) || nowMs - t <= RECENT_MAX_AGE_MS
  }).slice(0, RECENT_RENDER_CAP)
  // Phase 4b: the section never goes blank while there is an outcome to show. With nothing
  // active and nothing under an hour old, the newest undismissed terminal deployment stays,
  // whatever its age, until `x` / Dismiss hides it.
  if (!active.length && !recent.length && kept.length) recent = [kept[0]]
  var depRows = active.concat(recent).map(function (d) { return pend(deploymentRow(d, o)) })
  if (filtering) depRows = depRows.filter(function (r) { return rowMatches(r, terms) })
  if (!depRows.length) rows.push({ type: "note", key: "note:deployments", text: filtering ? NOTES.nomatch : noteFor(s, "deployments") })
  depRows.forEach(function (r) { rows.push(r) })
  rows.push({ type: "separator", key: "sep:" + (++sep) })
  // SERVERS
  rows.push({ type: "section", key: "sec:servers", title: "SERVERS", control: null })
  var servers = s.servers || []
  if (!servers.length) rows.push({ type: "note", key: "note:servers", text: noteFor(s, "servers") })
  servers.forEach(function (x) { rows.push(pend(serverRow(x, o))) })
  rows.push({ type: "separator", key: "sep:" + (++sep) })
  // TAGS (Phase 4): only when the account has tags; a fold, closed by default, after the
  // resources. Placed here so both returns below carry it.
  function tagsSection() {
    var tags = s.tags || []
    if (!tags.length || filtering) return                  // a filter narrows resources and deployments; tags step aside
    rows.push({ type: "separator", key: "sep:" + (++sep) })
    rows.push({ type: "section", key: "sec:tags", title: "TAGS", control: null })
    var open = folded["fold:tags"] === true      // closed by default, so for this one fold the flag means "opened" (toggleFold flips undefined -> true)
    rows.push({ type: "fold", key: "fold:tags", title: "Tags", open: open, count: tags.length, indent: 0 })
    if (open) tags.forEach(function (t) { rows.push(pend(tagRow(t))) })
  }
  // RESOURCES
  rows.push({ type: "section", key: "sec:resources", title: "RESOURCES", control: "groupBy" })
  var resources = s.resources || []
  if (!resources.length) { rows.push({ type: "note", key: "note:resources", text: noteFor(s, "resources") }); tagsSection(); return spliceActions(rows, ui) }
  var byUuid = {}
  resources.forEach(function (r) { byUuid[r.uuid] = r })
  var foldsShown = 0
  function fold(key, title, uuids, indent) {
    var open = !folded[key]
    var leaves = uuids.filter(function (u) { return !!byUuid[u] }).map(function (u) { return pend(resourceRow(byUuid[u], (indent || 0) + 1, o)) })
    if (filtering) {                                       // a fold with a match is forced open (the persisted flag is untouched); one without disappears
      leaves = leaves.filter(function (r) { return rowMatches(r, terms) })
      if (!leaves.length) return
      open = true
    }
    foldsShown++
    rows.push({ type: "fold", key: key, title: title, open: open, count: filtering ? leaves.length : uuids.length, indent: indent || 0 })
    if (open) leaves.forEach(function (r) { rows.push(r) })
  }
  if (groupBy === "project") {
    var tree = s.tree && s.tree.length ? s.tree : [{ projectUuid: "", projectName: "Ungrouped", environments: [{ id: null, name: "", resourceUuids: resources.map(function (r) { return r.uuid }) }] }]
    tree.forEach(function (p) {
      p.environments.forEach(function (e) {
        if (!e.resourceUuids.length) return
        var title = e.name ? p.projectName + " / " + e.name : p.projectName
        // The leftover fold reads "loading" while stage-2 blocks are still queued; the
        // key is unchanged so its open/closed state survives the rename.
        if (!p.projectUuid && p.projectName === "Ungrouped" && !s.topologyFetched) title = "Ungrouped · loading"
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
  if (filtering && !foldsShown) rows.push({ type: "note", key: "note:resources", text: NOTES.nomatch })
  tagsSection()
  return spliceActions(rows, ui)
}

// history/more/pick are overlay row types; the cursor helpers are pure over any row array.
var SELECTABLE = { fold: true, deployment: true, server: true, resource: true, tag: true, history: true, more: true, pick: true }

function rowRev(r) {
  return [r.type, r.glyph || r.dot || "", r.tone || "", r.name || r.title || r.text || "", r.sub || r.statusWords || "",
          r.open === undefined ? "" : String(r.open), r.count === undefined ? "" : String(r.count),
          r.dim === undefined ? "" : String(r.dim), r.kindHint || "", r.terminal === undefined ? "" : String(r.terminal), r.control || "",
          r.pendingVerb || "", r.url ? "u" : "", r.actions ? r.actions.map(function (a) { return a.id }).join(",") : "",
          r.finishedAt || ""].join("")   // the right column renders it (rowTime); set once per uuid, unlike updatedAt
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

// The row Enter lands on when leaving the filter field: the first deployment or resource.
function firstMatchIndex(rows) {
  rows = rows || []
  for (var i = 0; i < rows.length; i++) if (rows[i].type === "deployment" || rows[i].type === "resource") return i
  return -1
}

function firstSelectableInSection(rows, title) {
  rows = rows || []
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type === "section" && rows[i].title === title) return nextSelectable(rows, i, 1)
  }
  return -1
}

var HINT_KEY = { deployTag: "d deploy", deploy: "d deploy", redeploy: "d redeploy", stop: "s stop", start: "s start", restart: "t restart", validate: "v validate", cancel: "x cancel", dismiss: "x dismiss", logs: "L logs", open: "o open" }
var HINT_ORDER = ["deployTag", "deploy", "redeploy", "stop", "start", "restart", "validate", "cancel", "dismiss", "logs", "open"]

// Phase 4: the footer while an overlay view is open. `o open` only when the view has a page.
function viewHints(view) {
  var back = "h back"
  if (view.kind === "history") return ["j/k move", "enter log"].concat(view.hasUrl ? ["o open"] : []).concat([back]).join(" · ")
  if (view.kind === "servicepick") return ["j/k move", "enter logs", back].join(" · ")
  var bits = []
  if (view.paused) bits.push("paused")
  else if (view.kind === "buildlog" && !view.terminal) bits.push(view.following ? "following" : "held")
  bits.push("j/k scroll")
  bits.push("b newest")
  if (view.kind === "buildlog") bits.push("H steps")
  if (view.kind === "containerlog") bits.push("r refetch")
  if (view.hasUrl) bits.push("o open")
  bits.push(back)
  return bits.join(" · ")
}

function footerHints(focusSection, row, ui) {
  ui = ui || {}
  if (ui.confirmOpen) return "h/l pick · enter confirm · esc cancel"
  if (ui.view) return viewHints(ui.view)
  if (ui.filterFocus) return "type to narrow · enter list · esc clear"
  if (focusSection === "hero") return (ui.instances > 1 ? "h/l instance · " : "") + "enter refresh · j down · r refresh · e config · esc close"
  if (ui.editConfig && !row) return "e edit config · enter refresh · r refresh · esc close"
  if (row && row.type === "fold") return "j/k move · enter fold · g group · / filter · r refresh · esc close"
  if (ui.expanded && ui.actionFocus === MORE_ID) return "h/l pick · enter " + (ui.moreOpen ? "less" : "more") + " · esc collapse"
  if (ui.expanded && ui.actionFocus) return "h/l pick · enter run · esc collapse"
  if (ui.expanded) return "l pick · enter collapse · esc collapse"
  var list = buttons(actionsFor(row))
  if (!list.length) return "j/k move · g group · / filter · r refresh · esc close"
  var ids = {}
  list.forEach(function (a) { ids[a.id] = true })
  var bits = HINT_ORDER.filter(function (id) { return ids[id] }).map(function (id) { return HINT_KEY[id] })
  if (list.length === 1 && ids.open) return "o open · j/k move"
  return ["enter actions"].concat(bits).join(" · ")
}

// ---- depth (Phase 4): build logs, container logs, history, tags --------------------------
// Log text is view-only: it lives in the service's view slices and the panel's overlay
// model, never in snapshot, _status(), recent.json, a console line or a toast (SR26).
// Every parsed entry is validated and bounded (SR27).

var LOG_MAX_ENTRIES = 2000     // tail kept; `dropped` counts what fell off the head
var LOG_MAX_OUTPUT = 4000      // chars per entry output
var LOG_MAX_COMMAND = 320      // the real failing command is 162 chars; base64 echo blobs are 4 600
var LOG_MAX_CHARS = 3145728    // a logs string above this is refused, not parsed (the transport cap is 4 MB)
var LOG_MAX_OUTPUT_LINES = 200 // physical lines kept per entry (tail); real outputs are 2-4 lines
var LOG_MAX_LINES = 5000       // physical lines kept per log (tail): the ListModel row budget, applied by dropping head entries
// notifySafe's control-character class minus \t and \n, which a log line keeps.
var LOG_CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
// One query value: no whitespace, no URL structure, no comma (Coolify's multi-tag separator).
var TAG_RE = /^[^\s\/?#&=,]{1,64}$/
// Verbs the panel navigates on; they never reach act() or an IPC handler.
var NAV_VERBS = { open: true, logs: true, history: true, dismiss: true }   // the panel's, never an HTTP action
// Every overlay row carries the union of keys, each with a typed placeholder: a ListModel
// fixes a role's type on the first append, and a null there would drop every later string.
var VIEW_DEFAULTS = { rowType: "", type: "", key: "", uuid: "", appUuid: "", i: -1, text: "", tone: "", hidden: false, glyph: "", name: "", sub: "",
                      createdAt: "", updatedAt: "", finishedAt: "", terminal: false, status: "", url: "", pendingVerb: "", shown: 0, total: 0, loading: false, dim: false }
var VIEW_KEYS = Object.keys(VIEW_DEFAULTS)

function logText(v, max) {
  var t = String(v === undefined || v === null ? "" : v).replace(LOG_CTRL_RE, "")
  return t.length > max ? t.slice(0, max) : t
}
// Keeps the head and the tail: `docker exec … 'docker compose … pull'` survives, a
// right-elide would lose the verb that names the failing step.
function elideMiddle(s, max) {
  s = String(s === undefined || s === null ? "" : s)
  if (s.length <= max) return s
  var keep = max - 1, head = Math.ceil(keep / 2), tail = keep - head
  return s.slice(0, head) + "…" + s.slice(s.length - tail)
}

// The `logs` value of a deployment row: JSON text of an array of {command, output, type,
// timestamp, hidden, batch, order}. `order` is absent on entry 0 on 4.3.19, so the array
// index is the identity and `seq` is display only. Never throws; a non-array is an empty log.
function parseBuildLog(logsString) {
  var raw = String(logsString === undefined || logsString === null ? "" : logsString)
  var out = { entries: [], dropped: 0, truncated: false, refused: false, bytes: raw.length }
  if (raw.length > LOG_MAX_CHARS) { out.refused = true; out.truncated = true; return out }
  if (!raw) return out
  var p = parseJson(raw)
  var arr = p.ok ? p.value : null
  if (typeof arr === "string") { p = parseJson(arr); arr = p.ok ? p.value : null }
  if (!Array.isArray(arr)) return out
  var start = Math.max(0, arr.length - LOG_MAX_ENTRIES)
  out.dropped = start; out.truncated = start > 0
  for (var i = start; i < arr.length; i++) {
    var e = arr[i]
    if (!e || typeof e !== "object" || Array.isArray(e)) continue
    var ord = typeof e.order === "number" && isFinite(e.order) ? e.order : i + 1
    var output = logText(e.output, LOG_MAX_OUTPUT)
    var parts = output.split("\n")
    if (parts.length > LOG_MAX_OUTPUT_LINES) output = parts.slice(parts.length - LOG_MAX_OUTPUT_LINES).join("\n")
    out.entries.push({
      i: i, seq: ord, hidden: e.hidden === true, stream: e.type === "stderr" ? "stderr" : "stdout",
      command: typeof e.command === "string" && e.command ? elideMiddle(String(e.command).replace(LOG_CTRL_RE, ""), LOG_MAX_COMMAND) : null,
      output: output,
      at: typeof e.timestamp === "string" ? e.timestamp : null
    })
  }
  // The row budget: physical lines summed from the tail; head entries beyond it are dropped
  // like the entry cap, so a newline-heavy log cannot hand the ListModel a million rows.
  var lines = 0, keep = out.entries.length
  for (var k = out.entries.length - 1; k >= 0; k--) {
    var en = out.entries[k]
    lines += (en.command !== null ? 1 : 0) + (en.output === "" ? 0 : en.output.split("\n").length)
    if (lines > LOG_MAX_LINES) { keep = out.entries.length - 1 - k; break }
  }
  if (keep < out.entries.length) { out.dropped = out.entries[out.entries.length - keep].i; out.entries = out.entries.slice(out.entries.length - keep); out.truncated = true }
  return out
}

// Digits and colons only: it reaches _status() (SR26).
function buildLogRev(entries, dropped) {
  if (!entries || !entries.length) return ""
  var last = entries[entries.length - 1]
  return entries.length + ":" + (Date.parse(last.at) || 0) + ":" + last.output.length + ":" + (dropped || 0)
}

// On a failed build the step that failed is a hidden stderr entry carrying a command,
// before the visible "Deployment failed: …" summary; stderr on its own means nothing (a
// successful build ends in stderr ssh noise).
function failingEntry(entries, status) {
  if (status !== "failed" || !entries) return null
  var found = null
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    if (e.command === null && /^Deployment failed/.test(e.output)) break
    if (e.command !== null && e.stream === "stderr") found = e
  }
  return found
}

function viewRow(rowType, fields) {
  var r = {}
  for (var k = 0; k < VIEW_KEYS.length; k++) r[VIEW_KEYS[k]] = VIEW_DEFAULTS[VIEW_KEYS[k]]
  r.rowType = rowType
  r.type = rowType                       // the cursor helpers (SELECTABLE, nextSelectable) key on `type`
  if (fields) for (var f in fields) if (Object.prototype.hasOwnProperty.call(fields, f)) {
    if (!Object.prototype.hasOwnProperty.call(VIEW_DEFAULTS, f)) continue      // an unknown key would add a role later rows lack
    var v = fields[f], d = VIEW_DEFAULTS[f]
    if (v === undefined || v === null) { r[f] = d; continue }
    // Coerce by the placeholder's type: a ListModel fixes a role's type on the first append.
    if (typeof d === "string") r[f] = String(v)
    else if (typeof d === "boolean") r[f] = !!v
    else { var n = Number(v); r[f] = isFinite(n) ? Math.floor(n) : d }
  }
  return r
}
function noteRow(key, text, tone) { return viewRow("note", { key: key, text: text, tone: tone || "dim" }) }

// One row per physical line: "$ command" for a step, then one per newline-separated
// chunk of output. The failing entry is always rendered (urgent) and is preceded by a
// marker; other hidden entries only with showHidden, in dim.
function buildLogLines(entries, opts) {
  opts = opts || {}
  var out = [], failing = opts.failing || null, uuid = String(opts.uuid || "")
  for (var k = 0; k < (entries || []).length; k++) {
    var e = entries[k], isFail = !!(failing && e.i === failing.i)
    if (e.hidden && !opts.showHidden && !isFail) continue
    var n = 0, base = isFail ? "urgent" : (e.hidden ? "dim" : "fg")
    if (isFail) { var mark = noteRow(uuid + ":" + e.i + ":mark", "── failure ──", "urgent"); mark.i = e.i; out.push(mark) }   // carries the index so a head trim drops it with its entry
    if (e.command !== null) out.push(viewRow("line", { key: uuid + ":" + e.i + ":" + (n++), i: e.i, text: "$ " + e.command, tone: isFail ? "urgent" : "dim", hidden: e.hidden }))
    if (e.output !== "") {
      var chunks = e.output.split("\n")
      for (var c = 0; c < chunks.length; c++) {
        var tone = isFail || /^Deployment failed/.test(chunks[c]) ? "urgent" : base
        out.push(viewRow("line", { key: uuid + ":" + e.i + ":" + (n++), i: e.i, text: chunks[c], tone: tone, hidden: e.hidden }))
      }
    }
  }
  return out
}

// GET /{applications,databases,services}/{uuid}/logs -> {logs: "<text>"}: one line per
// newline, no trailing newline, no timestamps (show_timestamps=false), ANSI already stripped.
function parseContainerLog(json) {
  var v = json
  if (typeof v === "string") { var p = parseJson(v); v = p.ok ? p.value : null }
  var text = v && typeof v === "object" && typeof v.logs === "string" ? v.logs : ""
  if (!text) return { lines: [], truncated: false }
  var all = text.replace(LOG_CTRL_RE, "").split("\n")
  var start = Math.max(0, all.length - LOG_MAX_ENTRIES)
  return { lines: all.slice(start).map(function (l) { return l.length > LOG_MAX_OUTPUT ? l.slice(0, LOG_MAX_OUTPUT) : l }), truncated: start > 0 }
}

// GET /deployments/applications/{uuid} -> {count, deployments[]} (the openapi's
// Application[] is wrong); rows share the active-list row shape.
function normaliseHistory(json) {
  var v = json && typeof json === "object" ? json : {}
  var n = Number(v.count)
  return { count: isFinite(n) && n >= 0 ? Math.floor(n) : 0, rows: normaliseDeployments(v.deployments) }
}

// deploymentRow plus the history identity; the sub never renders the string "HEAD" (every
// api row carries commit "HEAD" and no message). Rows carry timestamps, not ages.
function historyRow(d, appUuid, originStr) {
  var r = deploymentRow(d, originStr)
  r.type = "history"; r.key = "hist:" + d.uuid; r.appUuid = appUuid || null
  r.sub = d.restartOnly ? "restart" : (d.branch && d.branch !== "HEAD" ? d.branch : "deploy")
  return viewRow("history", r)
}
function moreRow(page, take) {
  if (!page || !Array.isArray(page.rows) || page.rows.length >= page.count) return null
  var shown = page.rows.length, n = Math.min(take || 10, page.count - shown)
  return viewRow("more", { key: "more:" + page.appUuid, appUuid: page.appUuid, shown: shown, total: page.count, loading: !!page.loading,
                           text: page.loading ? "Loading…" : "Show " + n + " more (" + shown + " of " + page.count + ")" })
}
function pickRow(uuid, name) { return viewRow("pick", { key: "pick:" + uuid + ":" + name, uuid: uuid, name: name, text: name }) }

// GET /tags -> [{uuid, name, created_at, updated_at}]. No membership exists anywhere in the
// API, so a tag row is a name and nothing else.
function normaliseTags(arr) {
  if (!Array.isArray(arr)) return []
  var out = []
  for (var i = 0; i < arr.length; i++) {
    var t = arr[i]
    if (!t || typeof t !== "object") continue
    var uuid = String(t.uuid || ""), name = typeof t.name === "string" ? t.name : ""
    if (!UUID_RE.test(uuid) || !TAG_RE.test(name)) continue
    out.push({ uuid: uuid, name: name })
  }
  return out
}
function tagRow(t) {
  return { type: "tag", key: "tag:" + t.uuid, uuid: t.uuid, name: t.name, sub: "", dot: G.tag, glyph: null, tone: "dim", dim: false, url: "", pendingVerb: "" }
}

// Missing read:sensitive is silent (200 with `logs` absent), so it is detected from a
// terminal row: an in-progress row may honestly have no log yet (SR37).
function sensitiveState(raw) {
  if (!raw || typeof raw !== "object") return "unknown"
  if (typeof raw.logs === "string") return "yes"
  if (TERMINAL[String(raw.status || "")] && (raw.logs === undefined || raw.logs === null)) return "no"
  return "unknown"
}

// The deployments cadence with a byte-aware guard: 2 s while a build runs unless the last
// body was large (SR30). Steps at 256 KB, 1 MB, 4 MB. With every panel closed and nothing
// deploying the poll idles at IDLE_DEPLOYMENTS_SEC (or `deploymentsSec` when that is
// larger); a panel open runs at `deploymentsSec` (Dan, 2026-09-13).
var IDLE_DEPLOYMENTS_SEC = 8
function deploymentsInterval(deploying, cfgSec, lastBytes, panelOpen) {
  if (!deploying) return panelOpen ? cfgSec : Math.max(cfgSec, IDLE_DEPLOYMENTS_SEC)
  var b = Number(lastBytes) || 0
  if (b > 4194304) return 15
  if (b > 1048576) return 8
  if (b > 262144) return 4
  return 2
}

// A view fetch's outcome: text for the overlay, never a panel-wide error (SR29).
// `label` is the resource or application name for the not-running copy.
var FETCH_TOOLARGE = { buildlog: "This build log is larger than 4 MB. Open it in Coolify.", history: "This history page is larger than 4 MB. Open it in Coolify." }
function fetchOutcome(kind, rec, label) {
  if (!rec || typeof rec !== "object" || rec.code === undefined) rec = { exit: 1, code: 0, body: "", errmsg: "", headers: null }
  var e = errorFor({ curlExit: rec.exit, httpCode: rec.code, body: rec.body, errmsg: rec.errmsg, request: kind })
  if (!e) return null
  var out = { text: "", tone: "urgent", error: e }, msg = messageOf(rec.body)
  if (e.httpCode === 404 && /Container not found/i.test(msg)) out.text = (label || "The container") + " is not running."
  else if (e.httpCode === 400 && /Sub service name/i.test(msg)) out.text = "Pick a container."
  else if (e.httpCode === 404 && kind === "history") out.text = "Coolify no longer has that application."
  else if (e.httpCode === 404 && kind === "buildlog") out.text = "Coolify no longer has that deployment."
  else if (e.httpCode === 404 && kind === "service") out.text = "Coolify no longer has that service."
  else if (e.kind === "toolarge") out.text = FETCH_TOOLARGE[kind] || "Coolify's response was too large. Open it in Coolify."
  else if (e.kind === "ratelimited") out.text = "Rate limited · backing off " + retryAfterSec(rec.headers, 1) + "s."
  else if (e.kind === "offline") out.text = "Offline · retrying."
  else out.text = errorText(e, rec, kind)
  return out
}

// What _status() may say about a view: counts and a digits-only rev, never text (SR26).
function logViewStatus(view, rec) {
  if (!view) return null
  return { kind: view.kind, uuid8: uuid8(view.uuid), entries: rec && rec.entries ? rec.entries.length : (rec && rec.lines ? rec.lines.length : 0),
           dropped: rec ? (rec.dropped || 0) : 0, rev: rec ? (rec.rev || "") : "", bytes: rec ? (rec.bytes || 0) : 0,
           source: rec ? (rec.source || "") : "", terminal: rec ? !!rec.terminal : false }
}

// ---- format -------------------------------------------------------------------------------------

function pad2(n) { return (n < 10 ? "0" : "") + n }

function elapsed(iso, nowMs) {
  var t = typeof iso === "number" ? iso : Date.parse(iso)   // fetchedAt is a number; age() takes both too
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

// The right column of a deployment or a history row. A running section row shows the ticking
// elapsed; a terminal row shows the duration Coolify gives (createdAt -> finishedAt; there is
// no started_at, so a queue wait is inside it) beside how long ago it ended. A history row
// that is not terminal keeps its age. No duration: the row reads exactly the age it read before.
// age() || age() rather than age(a || b): a non-empty unparseable stamp must fall through, and a
// finishedAt that durationOf rejected (reversed, over the cap) must not drive the age either: a
// days-old row would read "Just now" off a year-3000 stamp. Then the row reads today's updatedAt age.
function credibleFinish(t) {
  var b = Date.parse(t.finishedAt)
  if (isNaN(b)) return false
  var a = Date.parse(t.createdAt)
  if (!isNaN(a)) return b - a >= 0 && b - a <= DURATION_MAX_MS
  var u = Date.parse(t.updatedAt)   // no start (an old recent.json entry): the record's own last write must sit within a deployment's duration (DURATION_MAX_MS) of the finish
  return isNaN(u) || Math.abs(u - b) <= DURATION_MAX_MS
}
function rowTime(r, nowMs) {
  var t = r || {}
  if (t.type === "deployment" && !t.terminal) return elapsed(t.createdAt, nowMs)
  var dur = t.terminal ? durationOf(t) : ""
  var ago = (credibleFinish(t) ? age(t.finishedAt, nowMs) : "") || age(t.updatedAt, nowMs) || age(t.createdAt, nowMs)
  return [dur, ago].filter(function (x) { return !!x }).join(" · ")
}
