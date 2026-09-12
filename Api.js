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
// Log-bearing GETs: with `read:sensitive` every deployment row carries its full build
// log, so the body is sized by build verbosity, not by row count. 4 MB is the largest
// cap a 12 s max-time can deliver at the slowest measured throughput to Cloud
// (0.19 MB/s -> 2.3 MB; 0.35 MB/s -> 4 MB); a larger cap would never fire because the
// reaper's timeout would fire first (SR30). Descriptors opt in with `maxBytes`.
var MAX_FILESIZE_LOG = 4194304
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
    "max-filesize = \"" + (req.maxBytes || MAX_FILESIZE) + "\"\n" +
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
function reqDeployments()         { return { kind: "deployments", path: "/deployments", maxBytes: MAX_FILESIZE_LOG } }
function reqDeployment(uuid)      { return { kind: "deployment", path: "/deployments/" + seg(uuid), arg: uuid, maxBytes: MAX_FILESIZE_LOG } }
function reqResources()           { return { kind: "resources", path: "/resources" } }
function reqServers()             { return { kind: "servers", path: "/servers" } }
function reqProjects()            { return { kind: "projects", path: "/projects" } }
function reqProject(uuid)         { return { kind: "project", path: "/projects/" + seg(uuid), arg: uuid } }
function reqServerResources(uuid) { return { kind: "serverResources", path: "/servers/" + seg(uuid) + "/resources", arg: uuid } }

// Depth descriptors (Phase 4). Query integers are module constants, never a caller's
// number (SR28); every Coolify-supplied value goes through seg; the container endpoint
// family comes from a hasOwnProperty whitelist like GROUP (SR3).
var HISTORY_TAKE = 10
var CONTAINER_LINES = 200
var CONTAINER_GROUP = { application: "applications", database: "databases", service: "services" }

function reqBuildLog(uuid)        { return { kind: "buildlog", path: "/deployments/" + seg(uuid), arg: uuid, maxBytes: MAX_FILESIZE_LOG } }
function reqHistory(uuid, skip) {
  var s = Number(skip); s = isFinite(s) ? Math.max(0, Math.floor(s)) : 0
  return { kind: "history", path: "/deployments/applications/" + seg(uuid) + "?skip=" + s + "&take=" + HISTORY_TAKE, arg: uuid, maxBytes: MAX_FILESIZE_LOG }
}
function reqContainerLog(kind, uuid, sub) {
  if (!Object.prototype.hasOwnProperty.call(CONTAINER_GROUP, kind)) return null
  var q = "?lines=" + CONTAINER_LINES + "&show_timestamps=false" + (kind === "service" ? "&sub_service_name=" + seg(sub) : "")
  return { kind: "containerlog", path: "/" + CONTAINER_GROUP[kind] + "/" + seg(uuid) + "/logs" + q, arg: uuid }
}
function reqService(uuid)         { return { kind: "service", path: "/services/" + seg(uuid), arg: uuid } }
function reqTags()                { return { kind: "tags", path: "/tags" } }
// Same block shape as reqDeploy: block() emits the constant data-raw, so no body field here.
function reqDeployTag(name)       { return { kind: "action", verb: "deployTag", target: name, method: "POST", path: "/deploy?tag=" + seg(name) } }

// Action descriptors (Phase 2): every one is a POST with the constant empty body.
// `kind: "action"` is what Service._finish branches on; `verb` and `target` ride along
// for bookkeeping. The endpoint family comes from GROUP, checked with hasOwnProperty so
// an unknown kind can never be concatenated into a path (SR3).
var GROUP = { application: "applications", service: "services", database: "databases" }
var LIFECYCLE = { start: true, stop: true, restart: true }

function reqDeploy(uuid, force) {
  return { kind: "action", verb: force ? "rebuild" : "deploy", target: uuid, method: "POST",
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
