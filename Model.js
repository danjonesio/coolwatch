.pragma library
// Pure functions: parse, normalise, join, diff, label, format. No QML, no I/O.

var RS = "\u001e"
var US = "\u001f"

// ---- transport ---------------------------------------------------------------

// Splits curl stdout into one record per transfer. Each record is the body that
// precedes a trailer (see Api.TRAILER). An RS whose following text does not match
// the trailer grammar is body text and is skipped. The raw header blob is
// reduced to a whitelist here and never leaves this function.
var TRAILER_RE = /^(\d+) (\d{3}) ([\d.]+) (\d+) ([^\n]*)\n([\s\S]*?)\n?\u001f/

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
function parseVersion(text) {
  return String(text === undefined || text === null ? "" : text).trim().replace(/^"+|"+$/g, "").replace(/^v/i, "").trim()
}
