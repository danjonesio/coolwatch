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

function block(instance, token, req, maxTimeSec) {
  return "url = \"" + quote(base(instance) + req.path) + "\"\n" +
    "silent\n" +
    "connect-timeout = \"5\"\n" +
    "max-time = \"" + quote(maxTimeSec) + "\"\n" +
    "max-filesize = \"" + MAX_FILESIZE + "\"\n" +
    "proto = \"=https,http\"\n" +
    "header = \"Authorization: Bearer " + quote(token) + "\"\n" +
    "header = \"Accept: application/json\"\n" +
    "write-out = \"" + quote(TRAILER) + "\"\n"
}

function config(instance, token, reqs, maxTimeSec) {
  var list = Array.isArray(reqs) ? reqs : [reqs]
  var out = []
  for (var i = 0; i < list.length; i++) out.push(block(instance, token, list[i], maxTimeSec))
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
