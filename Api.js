.pragma library
// Pure functions: curl argv and per-block config text for each Coolify endpoint.
// Self-contained: never imports Model.js. The token only ever appears inside the
// string returned by config(), which Service.qml writes to curl's stdin.
//
// curl resets every per-transfer option at each `next`, so timeouts, size cap,
// protocol allowlist, headers and the write-out live in every block. argv holds
// only `-q` (first: ignore ~/.curlrc), `-S` (global) and `-K -`.

var RS = "\u001e"
var US = "\u001f"
var MAX_FILESIZE = 8388608
// One trailer per transfer: RS, exitcode, http_code, time_total, size_download,
// errormsg, newline, header_json (multi-line), US. The RS/US bytes are raw in the
// emitted text because "\x1e" is not a curl config escape.
var TRAILER = "\n" + RS + "%{exitcode} %{http_code} %{time_total} %{size_download} %{errormsg}\n%{header_json}\n" + US

// curl config double-quote escapes (man curl, -K): \\ \" \t \n \r \v
function quote(v) {
  return String(v === undefined || v === null ? "" : v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\v/g, "\\v")
}

function seg(v) { return encodeURIComponent(String(v === undefined || v === null ? "" : v)) }

function base(instance) {
  return String(instance && instance.url ? instance.url : "").replace(/\/+$/, "") + "/api/v1"
}

function argv() { return ["curl", "-q", "-S", "-K", "-"] }

// Method whitelist: the values are the constants emitted into the config, never the
// caller's string. Checked with hasOwnProperty so prototype keys never pass (SR1).
var METHODS = { GET: "GET", POST: "POST" }

// One config block per transfer. A POST block adds `request`, a JSON Content-Type and a
// constant empty body via data-raw (`data` would read a local file for a leading `@`).
// No `location`: curl must never follow a redirect with the Bearer header (SR2).
// Returns null for a method outside the whitelist; config() then returns null too.
function block(instance, token, req, maxTimeSec) {
  var m = req.method || "GET"
  if (!Object.prototype.hasOwnProperty.call(METHODS, m)) return null
  var s = "url = \"" + quote(base(instance) + req.path) + "\"\n" +
    "silent\n" +
    "connect-timeout = \"5\"\n" +
    "max-time = \"" + quote(maxTimeSec) + "\"\n" +
    "max-filesize = \"" + MAX_FILESIZE + "\"\n" +
    "proto = \"=https,http\"\n" +
    "header = \"Authorization: Bearer " + quote(token) + "\"\n" +
    "header = \"Accept: application/json\"\n" +
    "write-out = \"" + quote(TRAILER) + "\"\n"
  if (m !== "GET") {
    s += "request = \"" + METHODS[m] + "\"\n" +
      "header = \"Content-Type: application/json\"\n" +
      "data-raw = \"{}\"\n"
  }
  return s
}

function config(instance, token, reqs, maxTimeSec) {
  var list = Array.isArray(reqs) ? reqs : [reqs]
  var out = []
  for (var i = 0; i < list.length; i++) {
    var b = block(instance, token, list[i], maxTimeSec)
    if (b === null) return null
    out.push(b)
  }
  return out.join("next\n")
}

// Request descriptors: data only, no secrets.
function reqVersion()             { return { kind: "version", path: "/version", json: false } }
function reqDeployments()         { return { kind: "deployments", path: "/deployments" } }
function reqDeployment(uuid)      { return { kind: "deployment", path: "/deployments/" + seg(uuid), arg: uuid } }
function reqResources()           { return { kind: "resources", path: "/resources" } }
function reqServers()             { return { kind: "servers", path: "/servers" } }
function reqProjects()            { return { kind: "projects", path: "/projects" } }
function reqProject(uuid)         { return { kind: "project", path: "/projects/" + seg(uuid), arg: uuid } }
function reqServerResources(uuid) { return { kind: "serverResources", path: "/servers/" + seg(uuid) + "/resources", arg: uuid } }

// Action descriptors (Phase 2): every one is a POST with the constant empty body.
// `kind: "action"` is what Service._finish branches on; `verb` and `target` ride along
// for bookkeeping. The endpoint family comes from GROUP, checked with hasOwnProperty so
// an unknown kind can never be concatenated into a path (SR3).
var GROUP = { application: "applications", service: "services", database: "databases" }
var LIFECYCLE = { start: true, stop: true, restart: true }

function reqDeploy(uuid, force) {
  return { kind: "action", verb: force ? "redeploy" : "deploy", target: uuid, method: "POST",
           path: "/deploy?uuid=" + seg(uuid) + (force ? "&force=true" : "") }
}
function reqLifecycle(kind, uuid, verb) {
  if (!Object.prototype.hasOwnProperty.call(GROUP, kind)) return null
  if (!Object.prototype.hasOwnProperty.call(LIFECYCLE, verb)) return null
  return { kind: "action", verb: verb, target: uuid, method: "POST",
           path: "/" + GROUP[kind] + "/" + seg(uuid) + "/" + verb }
}
function reqCancel(uuid) {
  return { kind: "action", verb: "cancel", target: uuid, method: "POST", path: "/deployments/" + seg(uuid) + "/cancel" }
}
function reqValidate(uuid) {
  return { kind: "action", verb: "validate", target: uuid, method: "POST", path: "/servers/" + seg(uuid) + "/validate" }
}
