// Node runner for Model.js and Api.js. Each file is `.pragma library` QML JS;
// the pragma is stripped and the file is evaluated in its own vm context, so a
// cross-dependency between the two would fail here as it would in QML.
//
// Each test names the plan item it covers: SR<n> = Security requirement n in the
// Phase 1 plan; otherwise the Model/Api function under test.
const fs = require("fs")
const path = require("path")
const vm = require("vm")

const root = path.join(__dirname, "..")

function load(name) {
  const p = path.join(root, name)
  if (!fs.existsSync(p)) return null
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(p, "utf8").replace(/^\.pragma library\s*/, ""), ctx, { filename: name })
  return ctx
}

const M = load("Model.js")
const A = load("Api.js")

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
}
function fx(name) { return JSON.parse(fixture(name)) }

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log("ok   " + name)
  } catch (e) {
    failed++
    console.log("FAIL " + name + "\n     " + (e && e.stack ? e.stack : e))
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed") }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + ": " : "") + JSON.stringify(a) + " !== " + JSON.stringify(b))
}
function count(hay, needle) { return hay.split(needle).length - 1 }

const RS = "\u001e"
const US = "\u001f"
const inst = { id: "cloud", name: "Coolify Cloud", url: "https://app.coolify.io" }
const TOK = "67|FAKETOKENFAKETOKENFAKETOKEN"
const NOW = Date.parse("2026-09-06T22:00:00Z")

// A trailer exactly as curl emits it for Api.TRAILER.
function trailer(exit, code, time, bytes, errmsg, headersJson) {
  return "\n" + RS + exit + " " + code + " " + time + " " + bytes + " " + errmsg + "\n" + headersJson + "\n" + US
}

// A snapshot in the Service.qml shape, with overrides.
function snap(o) {
  const s = {
    instance: { id: "cloud", name: "Coolify Cloud", url: "https://app.coolify.io", version: "4.3.14", plaintext: false },
    error: null, warning: null, servers: [], resources: [], deployments: [], recent: [], tree: [], byServer: {},
    failedUnacked: [], lastPollAt: {}, busy: false, openPanels: 0, baselineDone: true, backoffSec: 0
  }
  return Object.assign(s, o || {})
}
function loadedSnap(o) {
  const servers = M.normaliseServers(fx("servers.json"))
  const resources0 = M.normaliseResources(fx("resources.json"))
  const projects = M.normaliseProjects(fx("projects.json"))
  const envs = {}; envs[projects[0].uuid] = M.environmentsOf(fx("project-detail.json"))
  const tree = M.buildTree(projects, envs, resources0)
  const byServer = {}; byServer[servers[0].uuid] = M.serverResourceUuids(fx("server-resources.json"))
  const resources = M.applyJoins(resources0, tree, byServer, servers)
  const counts = M.resourceCounts(byServer)
  servers.forEach(x => { x.resourceCount = counts[x.uuid] || 0 })
  return snap(Object.assign({ servers, resources, tree, byServer }, o || {}))
}

// ---- Api.js ---------------------------------------------------------------------

test("Api.quote escapes every curl config metacharacter (SR1)", () => {
  eq(A.quote('a"b'), 'a\\"b')
  eq(A.quote('a\nurl = "http://evil"'), 'a\\nurl = \\"http://evil\\"')
  eq(A.quote("a\\b"), "a\\\\b")
  eq(A.quote("t\tr\rv\v"), "t\\tr\\rv\\v")
  eq(A.quote(null), "")
})

test("Api.seg percent-encodes one path segment (SR1)", () => {
  eq(A.seg("a/../servers"), "a%2F..%2Fservers")
  eq(A.seg("prod?x=1"), "prod%3Fx%3D1")
  eq(A.seg("prod\u00e9"), "prod%C3%A9")
  assert(A.seg("a/b").indexOf("/") < 0, "no raw slash")
})

test("Api.argv is curl -q -S -K - and nothing else (SR2)", () => {
  eq(JSON.stringify(A.argv()), JSON.stringify(["curl", "-q", "-S", "-K", "-"]))
  eq(A.argv()[1], "-q")
})

test("Api.config: hostile url and env name yield one url and one write-out line per block (SR1)", () => {
  const evil = { url: 'https://x.test/"\nurl = "http://evil/' }
  const cfg = A.config(evil, TOK, [A.reqProject('a"\nurl = "http://evil/'), A.reqServers()], 6)
  const urlLines = cfg.split("\n").filter(l => l.indexOf("url = ") === 0)
  eq(urlLines.length, 2, "exactly one url line per block")
  eq(cfg.split("\n").filter(l => l.indexOf("write-out = ") === 0).length, 2)
  assert(cfg.split("\n").every(l => l.indexOf("http://evil") !== 0), "the injected url never starts a line")
  assert(urlLines[0].indexOf('\\nurl = \\"http://evil') > 0, "injected text is escaped inside the url value")
})

test("Api.config: three descriptors repeat every per-transfer option and carry raw RS/US (SR3)", () => {
  const cfg = A.config(inst, TOK, [A.reqVersion(), A.reqServers(), A.reqResources()], 10)
  eq(count(cfg, "url = "), 3)
  eq(count(cfg, "write-out = "), 3)
  eq(count(cfg, 'max-time = "10"'), 3)
  eq(count(cfg, "max-filesize = \"8388608\""), 3)
  eq(count(cfg, 'proto = "=https,http"'), 3)
  eq(count(cfg, "header = \"Authorization: Bearer " + TOK + "\""), 3)
  eq(count(cfg, "header = \"Accept: application/json\""), 3)
  eq(count(cfg, "silent\n"), 3)
  eq(count(cfg, "next\n"), 2)
  eq(count(cfg, RS), 3, "raw RS byte per block")
  eq(count(cfg, US), 3, "raw US byte per block")
  assert(cfg.indexOf("\\x1e") < 0, "no \\x1e text")
  assert(cfg.indexOf("https://app.coolify.io/api/v1/version") >= 0)
  assert(cfg.indexOf('write-out = "\\n' + RS) >= 0, "trailer newline is a config escape, RS is raw")
})

test("Api.base strips trailing slashes", () => {
  eq(A.base({ url: "https://app.coolify.io///" }), "https://app.coolify.io/api/v1")
})

// ---- Api.js: Phase 2 action blocks ------------------------------------------------

test("Api.block GET output is byte-identical for every Phase 1 descriptor (SR1)", () => {
  const gets = [A.reqVersion(), A.reqDeployments(), A.reqDeployment("u1"), A.reqResources(), A.reqServers(), A.reqProjects(), A.reqProject("p1"), A.reqServerResources("s1")]
  for (const r of gets) {
    const b = A.block(inst, TOK, r, 6)
    const want = 'url = "' + A.quote(A.base(inst) + r.path) + '"\nsilent\nconnect-timeout = "5"\nmax-time = "6"\nmax-filesize = "' + (r.maxBytes || A.MAX_FILESIZE) + '"\nproto = "=https,http"\nheader = "Authorization: Bearer ' + TOK + '"\nheader = "Accept: application/json"\nwrite-out = "' + A.quote(A.TRAILER) + '"\n'
    eq(b, want, "byte-identical Phase 1 block for " + r.kind)
    eq(count(b, "request = "), 0, "no method line on a GET")
    eq(count(b, "data-raw"), 0)
    eq(count(b, "Content-Type"), 0)
    eq(b.split("\n").filter(l => l.length).length, 9, "nine lines per GET block")
  }
})

test("Api.block max-filesize is per descriptor: 4 MB for log-bearing kinds, 8 MB otherwise (SR30)", () => {
  eq(A.MAX_FILESIZE_LOG, 4194304)
  eq(count(A.block(inst, TOK, A.reqDeployments(), 12), 'max-filesize = "4194304"'), 1, "deployments list carries build logs")
  eq(count(A.block(inst, TOK, A.reqDeployment("u1"), 12), 'max-filesize = "4194304"'), 1, "deployment detail carries a build log")
  eq(count(A.block(inst, TOK, A.reqResources(), 10), 'max-filesize = "8388608"'), 1, "resources keep the default")
  eq(count(A.block(inst, TOK, A.reqDeploy("u1", false), 10), 'max-filesize = "8388608"'), 1, "actions keep the default")
  eq(A.block(inst, TOK, A.reqDeployments(), 12).split("\n").filter(l => l.length).length, 9, "still nine lines per GET block")
})

test("Api.block POST shape: one request, one Content-Type, one constant data-raw, all nine GET lines (SR1)", () => {
  const b = A.block(inst, TOK, A.reqLifecycle("application", "u1", "stop"), 10)
  eq(count(b, 'request = "POST"'), 1)
  eq(count(b, 'header = "Content-Type: application/json"'), 1)
  eq(count(b, 'data-raw = "{}"'), 1)
  eq(count(b, "url = "), 1)
  eq(count(b, "write-out = "), 1)
  eq(count(b, 'max-time = "10"'), 1)
  eq(count(b, 'proto = "=https,http"'), 1)
  eq(count(b, "header = \"Authorization: Bearer " + TOK + "\""), 1)
  eq(count(b, "silent\n"), 1)
  assert(b.indexOf("https://app.coolify.io/api/v1/applications/u1/stop") >= 0)
})

test("Api.config: two GETs around one POST carry request once; no location anywhere (SR1, SR2)", () => {
  const cfg = A.config(inst, TOK, [A.reqServers(), A.reqCancel("d1"), A.reqResources()], 8)
  eq(count(cfg, "request = "), 1)
  eq(count(cfg, "data-raw"), 1)
  eq(count(cfg, "url = "), 3)
  eq(count(cfg, "write-out = "), 3)
  eq(count(cfg, "next\n"), 2)
  assert(cfg.indexOf("location") < 0, "no location line")
  assert(cfg.indexOf("proto-redir") < 0, "no proto-redir line")
  eq(count(cfg, 'proto = "=https,http"'), 3)
})

test("Api.block / Api.config reject unknown and prototype methods with null (SR1)", () => {
  for (const m of ["DELETE", "toString", "constructor", "valueOf", "__proto__"]) {
    const r = { kind: "action", path: "/x", method: m }
    eq(A.block(inst, TOK, r, 6), null, "block null for " + m)
    eq(A.config(inst, TOK, [A.reqServers(), r], 6), null, "config null for " + m)
  }
  assert(A.block(inst, TOK, { kind: "x", path: "/x", method: "GET" }, 6) !== null)
})

test("Api.reqDeploy: hostile uuid is percent-encoded in the query; force only when true; one url line (SR1)", () => {
  const d = A.reqDeploy("a/../b?x=1", true)
  const b = A.block(inst, TOK, d, 10)
  eq(count(b, "url = "), 1)
  assert(b.indexOf("uuid=a%2F..%2Fb%3Fx%3D1&force=true") >= 0, b)
  eq(d.verb, "rebuild"); eq(d.kind, "action"); eq(d.method, "POST")
  const plain = A.reqDeploy("u1", false)
  eq(plain.path, "/deploy?uuid=u1"); eq(plain.verb, "deploy")
})

test("Api.reqLifecycle / reqCancel / reqValidate: families and verbs; unknown or prototype kind and verb are null (SR3)", () => {
  eq(A.reqLifecycle("application", "u1", "stop").path, "/applications/u1/stop")
  eq(A.reqLifecycle("database", "u1", "restart").path, "/databases/u1/restart")
  eq(A.reqLifecycle("service", "u/1", "start").path, "/services/u%2F1/start")
  eq(A.reqLifecycle("unknown", "u1", "stop"), null)
  eq(A.reqLifecycle("constructor", "u1", "stop"), null)
  eq(A.reqLifecycle("toString", "u1", "stop"), null)
  eq(A.reqLifecycle("application", "u1", "delete"), null)
  eq(A.reqLifecycle("application", "u1", "hasOwnProperty"), null)
  eq(A.reqCancel("d/1").path, "/deployments/d%2F1/cancel")
  eq(A.reqValidate("s1").path, "/servers/s1/validate")
  eq(A.reqValidate("s1").verb, "validate"); eq(A.reqCancel("d1").verb, "cancel")
})

// ---- Model.js: transport ----------------------------------------------------------

test("Model.splitResponses: single 200 with whitelisted headers (SR4)", () => {
  const h = '{\n"content-type":["application/json"],\n"set-cookie":["a=b; path=/"],\n"x-ratelimit-remaining":["199"],\n"x-ratelimit-limit":["200"],\n"retry-after":["30"]\n}'
  const r = M.splitResponses('{"a":1}' + trailer(0, 200, "0.078", 7, "", h))
  eq(r.length, 1)
  eq(r[0].body, '{"a":1}')
  eq(r[0].code, 200); eq(r[0].exit, 0); eq(r[0].timeMs, 78); eq(r[0].bytes, 7); eq(r[0].errmsg, "")
  eq(JSON.stringify(Object.keys(r[0].headers).sort()), JSON.stringify(["rateLimitLimit", "rateLimitRemaining", "retryAfter"]))
  eq(r[0].headers.rateLimitRemaining, 199); eq(r[0].headers.rateLimitLimit, 200); eq(r[0].headers.retryAfter, 30)
  assert(JSON.stringify(r[0]).indexOf("set-cookie") < 0, "raw header blob discarded")
})

test("Model.splitResponses: real Cloud 2xx headers yield the rate-limit integers (SR4)", () => {
  const r = M.splitResponses("4.3.14" + trailer(0, 200, "0.08", 6, "", fixture("headers-2xx.json")))
  eq(r.length, 1)
  assert(r[0].headers.rateLimitLimit > 0, "limit parsed"); assert(r[0].headers.rateLimitRemaining >= 0, "remaining parsed")
  eq(r[0].headers.retryAfter, null)
})

test("Model.splitResponses: body without trailing newline keeps its last char", () => {
  const r = M.splitResponses("4.3.17" + trailer(0, 200, "0.05", 6, "", "{}"))
  eq(r[0].body, "4.3.17")
})

test("Model.splitResponses: 000 empty body with curl exit 7 and errmsg", () => {
  const r = M.splitResponses(trailer(7, "000", "0.001", 0, "Failed to connect to 127.0.0.1:9", "{}"))
  eq(r.length, 1); eq(r[0].exit, 7); eq(r[0].code, 0); eq(r[0].body, ""); eq(r[0].errmsg, "Failed to connect to 127.0.0.1:9")
})

test("Model.splitResponses: body whose last line is three digits is not a trailer", () => {
  const r = M.splitResponses("abc\n200" + trailer(0, 200, "0.05", 7, "", "{}"))
  eq(r.length, 1); eq(r[0].body, "abc\n200")
})

test("Model.splitResponses: a stray RS inside a body is body text", () => {
  const r = M.splitResponses("a" + RS + "b" + trailer(0, 200, "0.05", 3, "", "{}"))
  eq(r.length, 1); eq(r[0].body, "a" + RS + "b")
})

test("Model.splitResponses: recorded three-block batch (batch-stream.txt) in order, failed middle block", () => {
  const r = M.splitResponses(fixture("batch-stream.txt"))
  eq(r.length, 3)
  eq(r[0].body, '{"a":1}'); eq(r[0].code, 200); eq(r[0].exit, 0); eq(r[0].bytes, 7)
  eq(r[1].exit, 7); eq(r[1].code, 0); eq(r[1].body, ""); assert(/Failed to connect/.test(r[1].errmsg))
  eq(r[2].body, '{"bb":2}'); eq(r[2].code, 200); eq(r[2].bytes, 8)
})

test("Model.splitResponses: garbage yields no records", () => {
  eq(M.splitResponses("").length, 0)
  eq(M.splitResponses("just some text").length, 0)
  eq(M.splitResponses(null).length, 0)
  eq(M.splitResponses("x" + RS + "not a trailer").length, 0)
})

test("Model.splitResponses: non-integer headers become null (SR4)", () => {
  const r = M.splitResponses("" + trailer(0, 429, "0.05", 0, "", '{"retry-after":["Wed, 21 Oct 2026 07:28:00 GMT"],"x-ratelimit-remaining":["abc"]}'))
  eq(r[0].headers.retryAfter, null); eq(r[0].headers.rateLimitRemaining, null); eq(r[0].headers.rateLimitLimit, null)
})

test("Model.parseVersion strips v, quotes and whitespace and never JSON.parses", () => {
  eq(M.parseVersion("4.3.17"), "4.3.17")
  eq(M.parseVersion("v4.3.17\n"), "4.3.17")
  eq(M.parseVersion('"4.3.17"'), "4.3.17")
  eq(M.parseVersion("  V4.3.17  "), "4.3.17")
  eq(M.parseVersion(fixture("version.txt")), "4.3.14")
  eq(M.parseVersion("v" + "9".repeat(500)).length, 32, "bounded")
  eq(M.parseVersion(null), "")
})

test("Model.redact hides tokens, bearer values, creds and cookies; uuids untouched (SR8)", () => {
  eq(M.redact("token 67|abcdefghijklmnopqrstuvwxyz0123 x"), "token «token» x")
  eq(M.redact("Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg"), "Authorization: Bearer «token»")
  eq(M.redact("postgres://user:pw@host/db"), "postgres://«creds»@host/db")
  eq(M.redact("set-cookie: HCLBSTICKY=abc; path=/\nnext"), "«cookie»\nnext")
  eq(M.redact("uuid a8b9c0d1-e2f3-4a5b-8c6d-7e8f9a0b1c2d"), "uuid a8b9c0d1-e2f3-4a5b-8c6d-7e8f9a0b1c2d")
})

test("Model.elide collapses whitespace and cuts at max with an ellipsis", () => {
  const s139 = "x".repeat(139), s140 = "x".repeat(140), s141 = "x".repeat(141)
  eq(M.elide(s139, 140), s139)
  eq(M.elide(s140, 140), s140)
  eq(M.elide(s141, 140).length, 140)
  eq(M.elide(s141, 140).slice(-1), "\u2026")
  eq(M.elide("a  \n\t b ", 140), "a b")
})

// ---- Model.js: config -------------------------------------------------------------------

test("Model.normaliseConfig: valid config with defaults, clamp and plaintext (SR3, SR7)", () => {
  const c = M.normaliseConfig(JSON.stringify({ version: 1, instances: [{ id: "cloud", name: "Coolify Cloud", url: "https://app.coolify.io/", token: "67|x" }] }))
  eq(c.ok, true); eq(c.instances.length, 1); eq(c.instances[0].url, "https://app.coolify.io"); eq(c.instances[0].plaintext, false)
  eq(c.poll.deploymentsSec, 4); eq(c.poll.resourcesSec, 60); eq(c.poll.serversSec, 120); eq(c.poll.topologySec, 600)
  const p = M.normaliseConfig({ instances: [{ url: "http://10.0.0.1:8000", token: "t" }], poll: { deploymentsSec: 1, topologySec: 900 } })
  eq(p.ok, true); eq(p.instances[0].plaintext, true); eq(p.poll.deploymentsSec, 2); eq(p.poll.topologySec, 900); eq(p.instances[0].name, "10.0.0.1")
  assert(!M.normaliseConfig({ instances: [{ url: "https://x", token: "t" }], poll: { deploymentsSec: null } }).ok, "null poll value is an error, not 2 s")
  assert(!M.normaliseConfig({ instances: [{ url: "https://x", token: "t" }], poll: { deploymentsSec: "4" } }).ok, "string poll value is an error")
  const tc = M.normaliseConfig({ instances: [{ url: "https://x", tokenCommand: ["op", "read", "op://x"] }] })
  eq(tc.ok, true); eq(JSON.stringify(tc.instances[0].tokenCommand), JSON.stringify(["op", "read", "op://x"]))
})

test("Model.normaliseConfig: rejects string tokenCommand, dash-first argv, missing url, ftp url, bad JSON", () => {
  assert(!M.normaliseConfig({ instances: [{ url: "https://x", tokenCommand: "op read x" }] }).ok, "string tokenCommand")
  assert(!M.normaliseConfig({ instances: [{ url: "https://x", tokenCommand: ["-x"] }] }).ok, "dash-first")
  assert(!M.normaliseConfig({ instances: [{ token: "t" }] }).ok, "missing url")
  assert(!M.normaliseConfig({ instances: [{ url: "ftp://x", token: "t" }] }).ok, "ftp")
  assert(!M.normaliseConfig({ instances: [{ url: "https://x" }] }).ok, "no token at all")
  assert(!M.normaliseConfig("{not json").ok, "bad json")
  assert(/invalid JSON/.test(M.normaliseConfig("{not json").error))
  assert(!M.normaliseConfig({ instances: [] }).ok, "empty instances")
})

test("Model.configUnsafe / configLoose (SR7)", () => {
  eq(M.configUnsafe("600", "dan", "dan"), false); eq(M.configLoose("600"), false)
  eq(M.configUnsafe("644", "dan", "dan"), false); eq(M.configLoose("644"), true)
  eq(M.configUnsafe("664", "dan", "dan"), true); eq(M.configUnsafe("666", "dan", "dan"), true)
  eq(M.configUnsafe("600", "root", "dan"), true, "foreign owner")
  eq(M.configUnsafe("", "dan", "dan"), true, "unknown mode is unsafe")
  eq(M.configLoose("640"), true); eq(M.configLoose("0600"), false)
})

// ---- Model.js: Phase 3 config ------------------------------------------------------------

test("Model.normaliseConfig: notify{} defaults, false shorthand, warning on a bad value, unknown key ignored (SR22)", () => {
  const base = { instances: [{ url: "https://x", token: "t" }] }
  const none = M.normaliseConfig(base)
  eq(none.ok, true); eq(none.warning, "")
  for (const k of Object.keys(M.NOTIFY_DEFAULTS)) eq(none.notify[k], true, k)
  const one = M.normaliseConfig(Object.assign({ notify: { deploymentFailed: false } }, base))
  eq(one.notify.deploymentFailed, false); eq(one.notify.deploymentQueued, true); eq(one.warning, "")
  const quoted = M.normaliseConfig(Object.assign({ notify: { deploymentFailed: "false" } }, base))
  eq(quoted.ok, true, "a quoted boolean is not a config error"); eq(quoted.notify.deploymentFailed, true, "default kept"); eq(quoted.warning, "notify.deploymentFailed must be a boolean")
  const bogus = M.normaliseConfig(Object.assign({ notify: { bogus: 1 } }, base))
  eq(bogus.ok, true); eq(bogus.warning, ""); eq(bogus.notify.deploymentQueued, true)
  const off = M.normaliseConfig(Object.assign({ notify: false }, base))
  for (const k of Object.keys(M.NOTIFY_DEFAULTS)) eq(off.notify[k], false, k)
  const str = M.normaliseConfig(Object.assign({ notify: "false" }, base))
  eq(str.ok, true); eq(str.notify.deploymentFailed, true); eq(str.warning, "notify must be an object or a boolean")
  for (const v of [true, null]) { const c = M.normaliseConfig(Object.assign({ notify: v }, base)); eq(c.notify.deploymentFailed, true); eq(c.warning, "") }
})

test("Model.configSansNotify: equal when only notify/warning differ, unequal on poll", () => {
  const base = { instances: [{ url: "https://x", token: "t" }] }
  const a = M.normaliseConfig(Object.assign({ notify: { deploymentQueued: false } }, base))
  const b = M.normaliseConfig(Object.assign({ notify: { deploymentQueued: "no" } }, base))
  eq(JSON.stringify(M.configSansNotify(a)), JSON.stringify(M.configSansNotify(b)))
  const c = M.normaliseConfig(Object.assign({ poll: { deploymentsSec: 9 } }, base))
  assert(JSON.stringify(M.configSansNotify(a)) !== JSON.stringify(M.configSansNotify(c)), "poll differs")
})

test("Model.origin / openUrl reject userinfo; normaliseConfig rejects the url too since Phase 4 (SR19, SR33)", () => {
  eq(M.origin("https://u:p@host"), ""); eq(M.origin("https://u@host/x"), "")
  eq(M.openUrl("deployment", { url: "/x" }, "https://u:p@host"), "")
  eq(M.origin("https://app.coolify.io/"), "https://app.coolify.io")
  const c = M.normaliseConfig({ instances: [{ url: "https://u:p@host", token: "t" }] })
  eq(c.ok, false); assert(/credentials/.test(c.error), c.error)
})

// ---- Model.js: normalise ----------------------------------------------------------------

test("Model.parseStatus: all nine strings; bare exited equals exited:unhealthy; unknown", () => {
  eq(JSON.stringify(M.parseStatus("running:healthy")), JSON.stringify({ state: "running", health: "healthy", raw: "running:healthy" }))
  eq(M.parseStatus("running:unhealthy").health, "unhealthy")
  eq(M.parseStatus("running:unknown").health, "unknown")
  eq(M.parseStatus("starting:unknown").state, "starting")
  eq(M.parseStatus("restarting:unknown").state, "restarting")
  eq(M.parseStatus("degraded:unhealthy").state, "degraded")
  eq(M.parseStatus("paused:unknown").state, "paused")
  const bare = M.parseStatus("exited"), full = M.parseStatus("exited:unhealthy")
  eq(bare.state, full.state); eq(bare.health, full.health); eq(bare.state, "exited")
  eq(M.parseStatus("wibble").state, "unknown"); eq(M.parseStatus(null).state, "unknown")
})

test("Model.normaliseDeployments: uuid from deployment_uuid; restart_only/force_rebuild mapping", () => {
  const ds = M.normaliseDeployments(fx("deployments-active.json"))
  eq(ds.length, 2)
  eq(ds[0].uuid, "activeinprogress0000001"); eq(ds[0].status, "in_progress"); eq(ds[1].status, "queued")
  eq(ds[0].appId, "75897"); assert(ds[0].commitMessage.indexOf("\n") < 0, "first line only")
  eq(ds[0].restartOnly, false); eq(ds[0].force, false); eq(ds[0].isApi, true)
  const synth = M.normaliseDeployment({ deployment_uuid: "u", restart_only: true, force_rebuild: true, status: "queued" })
  eq(synth.restartOnly, true); eq(synth.force, true); eq(synth.uuid, "u")
  eq(M.normaliseDeployments(fx("deployments-empty.json")).length, 0)
  eq(M.normaliseDeployments([fx("deployment-failed.json")])[0].status, "failed")
})

test("Model.joinBranch: match by application id gives git_branch; miss gives sha7", () => {
  const rs = M.normaliseResources(fx("resources.json"))
  const ds = M.joinBranch(M.normaliseDeployments(fx("deployments-active.json")), rs)
  eq(ds[0].branch, "main"); eq(ds[0].appUuid, "h0wxyg40kc0lz727dom9l03i")
  eq(ds[1].branch, ds[1].commit.slice(0, 7)); eq(ds[1].appUuid, null)
  eq(ds[1].branch.length, 7)
})

test("Model.normaliseServers: reachability from top level and settings; force_disabled -> disabled", () => {
  const s = M.normaliseServers(fx("servers.json"))
  eq(s.length, 1); eq(s[0].name, "hetzner-1"); eq(s[0].reachable, true); eq(s[0].usable, true); eq(s[0].disabled, false); eq(s[0].buildServer, false)
  const t = M.normaliseServers([{ uuid: "a", name: "a", settings: { is_reachable: false, is_usable: false, force_disabled: true, is_build_server: true } }])
  eq(t[0].reachable, false); eq(t[0].disabled, true); eq(t[0].buildServer, true)
  eq(M.normaliseServers(null).length, 0)
})

test("Model.normaliseResources: kinds, types, status split, git_branch, ids", () => {
  const rs = M.normaliseResources(fx("resources.json"))
  eq(rs.length, 7)
  const app = rs.find(r => r.uuid === "h0wxyg40kc0lz727dom9l03i")
  eq(app.kind, "application"); eq(app.gitBranch, "main"); eq(app.state, "running"); eq(app.health, "healthy"); eq(app.environmentId, 15640); eq(app.id, 75897)
  const svc = rs.find(r => r.kind === "service")
  eq(svc.gitBranch, null); eq(typeof svc.serverId, "number")
  const db = M.normaliseResources([{ uuid: "d", name: "pg", type: "standalone-postgresql", status: "running:healthy" }])[0]
  eq(db.kind, "database"); eq(db.type, "postgresql"); eq(M.kindHint(db), "postgres")
  eq(M.kindHint(app), "app"); eq(M.kindHint(svc), "service")
  const exited = rs.find(r => r.status === "exited")
  eq(exited.state, "exited"); eq(exited.health, "unhealthy")
})

test("Model.buildTree + applyJoins + resourceCounts: env join, Ungrouped, byServer", () => {
  const s = loadedSnap()
  const named = s.tree.filter(p => p.projectName !== "Ungrouped")
  eq(named.length, 5)
  const prod = s.tree[0].environments[0]
  eq(prod.name, "production"); eq(prod.id, 15640); eq(prod.resourceUuids.length, 2)
  const ungrouped = s.tree.find(p => p.projectName === "Ungrouped")
  assert(ungrouped, "Ungrouped fold exists for resources in environments not fetched")
  eq(ungrouped.environments[0].resourceUuids.length, 5)
  const app = s.resources.find(r => r.uuid === "h0wxyg40kc0lz727dom9l03i")
  eq(app.projectUuid, s.tree[0].projectUuid); eq(app.environmentName, "production"); eq(app.serverUuid, s.servers[0].uuid)
  eq(s.servers[0].resourceCount, M.serverResourceUuids(fx("server-resources.json")).length)
  assert(s.servers[0].resourceCount > 0)
})

test("Model.topologyIntervalSec caps the topology fan-out at 3 req/min", () => {
  eq(M.topologyIntervalSec(600, 3, 3), 600)
  eq(M.topologyIntervalSec(600, 40, 5), 960)
  eq(M.topologyIntervalSec(1200, 40, 5), 1200)
})

// ---- Model.js: errors -------------------------------------------------------------------

test("Model.errorFor: every error fixture maps to its kind and meta; success:true ignored", () => {
  const e401 = M.errorFor({ httpCode: 401, body: fixture("error-401.json") })
  eq(e401.kind, "auth"); eq(e401.title, "Token rejected"); eq(e401.httpCode, 401)
  const eDis = M.errorFor({ httpCode: 403, body: fixture("error-403-api-disabled.json") })
  eq(eDis.kind, "apidisabled"); eq(eDis.title, "API disabled")
  const eAb = M.errorFor({ httpCode: 403, body: fixture("error-403-ability.json") })
  eq(eAb.kind, "ability"); eq(eAb.title, "")
  const eIp = M.errorFor({ httpCode: 403, body: '{"message":"You are not allowed to access this resource."}' })
  eq(eIp.kind, "ipblocked")
  const e429 = M.errorFor({ httpCode: 429, body: fixture("error-429.json") })
  eq(e429.kind, "ratelimited"); eq(e429.title, "Rate limited")
  eq(M.errorFor({ httpCode: 500, body: "boom" }).kind, "http")
  eq(M.errorFor({ httpCode: 500, body: "boom" }).title, "Coolify error")
  eq(M.errorFor({ httpCode: 200, body: "{}" }), null)
})

test("Model.errorFor: curl exits 6/7/28 -> offline, 63 -> toolarge, other -> http with errmsg", () => {
  eq(M.errorFor({ curlExit: 6 }).kind, "offline"); eq(M.errorFor({ curlExit: 7 }).kind, "offline"); eq(M.errorFor({ curlExit: 28 }).kind, "offline")
  eq(M.errorFor({ curlExit: 63 }).kind, "toolarge")
  const e = M.errorFor({ curlExit: 22, errmsg: "weird" })
  eq(e.kind, "http"); eq(e.detail, "curl 22: weird"); eq(e.curlExit, 22)
  eq(M.errorFor({ curlExit: 7, request: "servers" }).request, "servers")
})

test("Model.errorFor never puts a token in detail (SR8)", () => {
  const e = M.errorFor({ httpCode: 500, body: '{"message":"bad Bearer 67|abcdefghijklmnopqrstuv"}' })
  assert(e.detail.indexOf("67|") < 0, "token redacted"); assert(e.detail.indexOf("«token»") >= 0)
})

test("Model.retryAfterSec: header clamp and ladder fallback (SR4)", () => {
  eq(M.retryAfterSec({ retryAfter: 30 }, 1), 30)
  eq(M.retryAfterSec({ retryAfter: 2147483647 }, 1), 300)
  eq(M.retryAfterSec({ retryAfter: 0 }, 1), 1)
  eq(M.retryAfterSec({ retryAfter: null }, 1), 30)
  eq(M.retryAfterSec({ retryAfter: null }, 2), 60)
  eq(M.retryAfterSec({ retryAfter: null }, 9), 60)
  eq(M.retryAfterSec(null, 1), 30)
})

test("Model.diffActive: added, vanished, eight vanishing at once, a uuid vanishing twice queued once", () => {
  const d = M.diffActive(["a", "b"], [{ uuid: "b" }, { uuid: "c" }])
  eq(JSON.stringify(d.added), JSON.stringify(["c"])); eq(JSON.stringify(d.vanished), JSON.stringify(["a"]))
  const eight = M.diffActive(["1", "2", "3", "4", "5", "6", "7", "8"], [])
  eq(eight.vanished.length, 8); eq(new Set(eight.vanished).size, 8)
  const twice = M.diffActive(["a", "a"], [])
  eq(twice.vanished.length, 1)
})

// ---- Model.js: Phase 3 change detection ---------------------------------------------------

function dep(o) { return Object.assign({ uuid: "d1", status: "queued", restartOnly: false, appName: "api" }, o || {}) }
function res(o) { return Object.assign({ uuid: "r1", name: "api", state: "running", health: "healthy", kind: "application" }, o || {}) }

test("Model.diffDeployments: vanished carried over, first poll yields no events, queued/started/restarting transitions", () => {
  const active = M.normaliseDeployments(fx("deployments-active.json"))
  const fresh = M.diffDeployments([], active, false)
  eq(fresh.events.length, active.length); eq(fresh.events[0].kind, "deployment"); eq(fresh.events[0].obj.uuid, active[0].uuid)
  assert(fresh.events.every(e => e.event === "started" || e.event === "queued"), "new active entries")
  eq(M.diffDeployments([], active, true).events.length, 0, "baseline")
  const v = M.diffDeployments([dep({ uuid: "a" }), dep({ uuid: "b" })], [dep({ uuid: "b" }), dep({ uuid: "c" })], false)
  eq(JSON.stringify(v.vanished), JSON.stringify(["a"])); eq(v.events.length, 1); eq(v.events[0].event, "queued"); eq(v.events[0].uuid, "c")
  const started = M.diffDeployments([dep({ status: "queued" })], [dep({ status: "in_progress" })], false)
  eq(started.events.length, 1); eq(started.events[0].event, "started")
  eq(M.diffDeployments([dep({ status: "in_progress" })], [dep({ status: "in_progress" })], false).events.length, 0)
  const r1 = M.diffDeployments([], [dep({ status: "queued", restartOnly: true })], false)
  eq(r1.events[0].event, "restarting")
  eq(M.diffDeployments([dep({ status: "queued", restartOnly: true })], [dep({ status: "in_progress", restartOnly: true })], false).events.length, 0, "restart never yields started")
  eq(M.diffDeployments([], [dep({ status: "in_progress", restartOnly: true })], false).events[0].event, "restarting")
  // O(N) guard: 20 000 rows run in a few ms; a quadratic diff would take seconds. The bound
  // is loose on purpose (a 50 ms bound on 2 000 rows failed on a shared CI runner, 2026-09-13).
  const big = []; for (let i = 0; i < 20000; i++) big.push(dep({ uuid: "u" + i, status: "in_progress" }))
  const t0 = Date.now(); M.diffDeployments(big.map(d => dep({ uuid: d.uuid })), big, false); assert(Date.now() - t0 < 1500, "O(N) diff")
})

test("Model.terminalEvent / hasTerminal: finished, restarted, failed, cancelled, in_progress -> null", () => {
  eq(M.terminalEvent(M.normaliseDeployment(fx("deployment-finished.json"))).event, "finished")
  eq(M.terminalEvent(M.normaliseDeployment(fx("deployment-failed.json"))).event, "failed")
  eq(M.terminalEvent(dep({ status: "finished", restartOnly: true })).event, "restarted")
  eq(M.terminalEvent(dep({ status: "cancelled-by-user" })).event, "cancelled")
  eq(M.terminalEvent(dep({ status: "in_progress" })), null)
  eq(M.terminalEvent(null), null)
  eq(M.hasTerminal([dep({ uuid: "x", status: "finished" })], "x"), true)
  eq(M.hasTerminal([dep({ uuid: "x", status: "finished" })], "y"), false)
  eq(M.hasTerminal([dep({ uuid: "x", status: "in_progress" })], "x"), false, "an active entry is not terminal")
})

test("Model.resourceEvents: ten transitions, first poll yields nothing", () => {
  const raw = M.normaliseResources(fx("resources.json"))
  const flipped = raw.map(r => r.uuid === "h0wxyg40kc0lz727dom9l03i" ? Object.assign({}, r, { state: "exited", health: "unhealthy", status: "exited" }) : r)
  const ev = M.resourceEvents(raw, flipped, false)
  eq(ev.length, 1); eq(ev[0].event, "stopped"); eq(ev[0].uuid, "h0wxyg40kc0lz727dom9l03i"); eq(ev[0].kind, "resource")
  eq(M.resourceEvents(raw, flipped, true).length, 0, "baseline")
  const one = (from, to) => M.resourceEvents([res({ state: from })], [res({ state: to })], false)
  eq(one("running", "exited")[0].event, "stopped"); eq(one("starting", "exited")[0].event, "stopped"); eq(one("degraded", "exited")[0].event, "stopped")
  eq(one("running", "degraded")[0].event, "degraded"); eq(one("exited", "running")[0].event, "recovered"); eq(one("degraded", "starting")[0].event, "recovered")
  eq(one("exited", "exited").length, 0); eq(one("unknown", "exited").length, 0); eq(one("running", "unknown").length, 0); eq(one("running", "paused").length, 0)
  eq(M.resourceEvents([res({ health: "healthy" })], [res({ health: "unhealthy" })], false).length, 0, "health-only is silent")
  eq(M.resourceEvents([], [res({ state: "exited" })], false).length, 0, "absent from prev")
})

test("Model.serverEvents: both flips, disabled never, absent never, first poll nothing", () => {
  const srv = M.normaliseServers(fx("servers.json"))
  const down = srv.map(s => Object.assign({}, s, { reachable: false }))
  eq(M.serverEvents(srv, down, false)[0].event, "unreachable"); eq(M.serverEvents(down, srv, false)[0].event, "reachable")
  eq(M.serverEvents(srv, down, true).length, 0)
  eq(M.serverEvents(srv, down.map(s => Object.assign({}, s, { disabled: true })), false).length, 0)
  eq(M.serverEvents([], down, false).length, 0)
})

test("Model.appLabel / uuid8: Coolify suffix stripped, plain names kept, empty -> uuid8, newline filtered", () => {
  eq(M.appLabel("storefront:main-h0wxyg40kc0lz727dom9l03i", "h0wx"), "storefront")
  eq(M.appLabel("worker", "u"), "worker"); eq(M.appLabel("umami-prod", "u"), "umami-prod"); eq(M.appLabel("Storefront Prod WP", "u"), "Storefront Prod WP")
  eq(M.appLabel("xyhpwdxqu33omjgwuo6c7cjp-200537415987", "xyhpwdxqu33omjgwuo6c7cjp"), "xyhpwdxq", "an unnamed app's generated name falls back to uuid8")
  eq(M.appLabel("abcdefghijklmnopqrstuv-123456", "zz"), "abcdefgh", "the generated shape yields the first 8 of its own uuid")
  eq(M.appLabel("umami-prod", "u"), "umami-prod", "a short uuid never masks a real name")
  eq(M.appLabel("", "abcdefghijkl"), "abcdefgh"); eq(M.appLabel(null, "abcdefghijkl"), "abcdefgh")
  eq(M.appLabel("a".repeat(60), "u").length, 32)
  eq(M.uuid8("ab\ncd-ef gh!ijklmnop"), "abcdefgh"); eq(M.uuid8(null), "")
})

// ---- Model.js: Phase 3 notifications ------------------------------------------------------------

const NAPP = "h0wxyg40kc0lz727dom9l03i"          // joined: project + environment + server
const NSRV = "qo4go8kswocog0gg0ckk8kk8"          // hetzner-1
function nctx(o) {
  return Object.assign({ notify: M.notifyDefaults(), origin: "https://app.coolify.io", dnd: false, pending: {}, actionAt: {}, lastNotified: {}, sentLastMin: 0, now: NOW, pluginId: "io.github.danjonesio.coolwatch" }, o || {})
}
function nsnap(o) {
  const s = loadedSnap({ deployments: [], recent: [] })
  return Object.assign(s, o || {})
}
function rawRes(uuid, state) { return { uuid, name: "x", kind: "application", state: state || "exited", health: "unknown", serverUuid: null, projectUuid: null } }
function stopEv(uuid) { return { kind: "resource", event: "stopped", uuid, obj: rawRes(uuid) } }
function argvOf(plan, i) { return plan.argvs[i || 0] }
function execUrl(a) { const i = a.indexOf("--exec"); return i < 0 ? null : a.slice(i) }

test("Model.notifySafe: option-shaped strings, control chars, Unicode, ordinary text, redact before elide (SR15)", () => {
  for (const bad of ["--app-name=omarchy-action", "--image=file:///etc/passwd", "--urgency=critical", "-g", "-u critical"]) {
    const s = M.notifySafe(bad, 72); assert(s.charAt(0) !== "-", bad + " -> " + s); eq(s.length, bad.length, "same length, dash swapped")
  }
  eq(M.notifySafe("a bcde", 72), "abcde")
  eq(M.notifySafe("Émilie", 72), "Émilie"); eq(M.notifySafe("部署 完成", 72), "部署 完成")
  eq(M.notifySafe("Deployment failed: storefront", 72), "Deployment failed: storefront")
  const tok = "deploy with 67|" + "a".repeat(40)
  const r = M.notifySafe(tok, 24); assert(r.indexOf("«token»") >= 0, "redacted before the cut: " + r); assert(!/67\|a{5}/.test(r))
  eq(M.notifySafe("", 72), ""); eq(M.notifySafe(null, 72), "")
  eq(M.notifySafe("x".repeat(100), 72).length, 72)
})

test("Model.notifyBody: escapes & and < after the cut; the headline path leaves < alone", () => {
  assert(M.notifyBody('<a href="x">y</a>', 96).indexOf("<") < 0); eq(M.notifyBody("a & b", 96), "a &amp; b")
  const cut = M.notifyBody("<".repeat(100), 96); eq(cut.indexOf("<"), -1); assert(cut.endsWith("…"), "cut then escaped")
  eq(M.notifySafe("<b>", 72), "<b>")
})

test("Model.notifyCopy: thirteen rows, glyphs in GLYPHS, urgency, toggle, fallbacks", () => {
  const s = nsnap(); const ctx = nctx()
  const fin = M.joinBranch([M.normaliseDeployment(fx("deployment-finished.json"))], s.resources)[0]
  const c = M.notifyCopy({ kind: "deployment", event: "finished", uuid: fin.uuid }, fin, s, ctx)
  eq(c.headline, "Deployed storefront"); eq(c.body, "2m 21s · main"); eq(c.urgency, "normal"); eq(c.toggle, "deploymentFinished"); assert(c.url.startsWith("https://app.coolify.io/project/"))
  const fail = M.joinBranch([M.normaliseDeployment(fx("deployment-failed.json"))], s.resources)[0]
  const f = M.notifyCopy({ kind: "deployment", event: "failed", uuid: fail.uuid }, fail, s, ctx)
  eq(f.headline, "Deployment failed: storefront"); eq(f.body, "1m 4s · click to open in Coolify"); eq(f.urgency, "critical")
  eq(M.notifyCopy({ kind: "deployment", event: "failed", uuid: "u" }, Object.assign({}, fail, { restartOnly: true, url: null }), s, ctx).headline, "Restart failed: storefront")
  eq(M.notifyCopy({ kind: "deployment", event: "failed", uuid: "u" }, Object.assign({}, fail, { url: null }), s, ctx).body, "1m 4s · main", "no url -> branch")
  const can = M.normaliseDeployment(fx("deployment-cancelled.json"))
  const cc = M.notifyCopy({ kind: "deployment", event: "cancelled", uuid: can.uuid }, can, s, ctx)
  eq(cc.headline, "Cancelled xyhpwdxq"); eq(cc.body, ""); eq(cc.urgency, "low"); eq(cc.toggle, "deploymentFinished")
  const act = M.joinBranch(M.normaliseDeployments(fx("deployments-active.json")), s.resources)
  eq(M.notifyCopy({ kind: "deployment", event: "started", uuid: act[0].uuid }, act[0], s, ctx).headline, "Building storefront")
  eq(M.notifyCopy({ kind: "deployment", event: "started", uuid: act[0].uuid }, act[0], s, ctx).body, "main · Merge pull request #117 from example/feature/checkout")
  eq(M.notifyCopy({ kind: "deployment", event: "queued", uuid: act[1].uuid }, act[1], s, ctx).headline, "Queued worker")
  eq(M.notifyCopy({ kind: "deployment", event: "queued", uuid: "u" }, dep({ appName: "", uuid: "abcdefghijk", commitMessage: "", branch: null }), s, ctx).headline, "Queued abcdefgh", "empty name -> uuid8")
  eq(M.notifyCopy({ kind: "deployment", event: "queued", uuid: "u" }, dep({ appName: "api", commitMessage: "", branch: null }), s, ctx).body, "", "no commit, no branch")
  eq(M.notifyCopy({ kind: "deployment", event: "restarting", uuid: "u" }, dep({ restartOnly: true, serverName: "hetzner-1" }), s, ctx).headline, "Restarting api")
  eq(M.notifyCopy({ kind: "deployment", event: "restarting", uuid: "u" }, dep({ restartOnly: true, serverName: "hetzner-1" }), s, ctx).body, "hetzner-1")
  eq(M.notifyCopy({ kind: "deployment", event: "restarted", uuid: "u" }, dep({ status: "finished", restartOnly: true, createdAt: "2026-09-06T21:00:00Z", finishedAt: "2026-09-06T21:00:09Z" }), s, ctx).headline, "Restarted api")
  eq(M.notifyCopy({ kind: "deployment", event: "restarted", uuid: "u" }, dep({ status: "finished", restartOnly: true, createdAt: "2026-09-06T21:00:00Z", finishedAt: "2026-09-06T21:00:09Z" }), s, ctx).body, "9s")
  eq(M.notifyCopy({ kind: "deployment", event: "finished", uuid: "u" }, dep({ status: "finished", createdAt: "2026-09-06T21:00:00Z", finishedAt: "garbage", branch: "main" }), s, ctx).body, "main", "unparseable finishedAt -> no duration")
  const app = s.resources.find(r => r.uuid === NAPP)
  const st = M.notifyCopy({ kind: "resource", event: "stopped", uuid: NAPP }, app, s, ctx)
  eq(st.headline, "storefront stopped"); eq(st.body, "hetzner-1 · exited"); eq(st.urgency, "normal"); eq(st.toggle, "resourceStateChanged"); assert(st.url.indexOf("/application/" + NAPP) > 0)
  eq(M.notifyCopy({ kind: "resource", event: "degraded", uuid: NAPP }, app, s, ctx).headline, "storefront degraded")
  eq(M.notifyCopy({ kind: "resource", event: "recovered", uuid: NAPP }, app, s, ctx).body, "hetzner-1 · running")
  eq(M.notifyCopy({ kind: "resource", event: "stopped", uuid: "r" }, rawRes("r"), s, ctx).body, "exited", "no server join -> state only")
  eq(M.notifyCopy({ kind: "resource", event: "summary", uuid: "", count: 4, serverLabel: "hetzner-1" }, {}, s, ctx).headline, "4 more resources stopped")
  const srv = s.servers[0]
  const un = M.notifyCopy({ kind: "server", event: "unreachable", uuid: NSRV, down: 7 }, srv, s, ctx)
  eq(un.headline, "hetzner-1 unreachable"); eq(un.body, "7 resources down"); eq(un.urgency, "critical"); eq(un.url, "https://app.coolify.io/server/" + NSRV)
  eq(M.notifyCopy({ kind: "server", event: "unreachable", uuid: NSRV, down: 0 }, srv, s, ctx).body, "")
  eq(M.notifyCopy({ kind: "server", event: "reachable", uuid: NSRV }, srv, s, ctx).headline, "hetzner-1 reachable")
  for (const ev of Object.keys(M.NOTIFY_ROWS)) assert(M.GLYPHS.indexOf(M.G[M.NOTIFY_ROWS[ev].glyph]) >= 0, ev + " glyph in GLYPHS")
})

test("Model.notifyPlan: resolves the joined object at flush time; raw event still gets URL and server (wave-2 critical)", () => {
  const s = nsnap()
  const p = M.notifyPlan([stopEv(NAPP)], s, nctx())
  eq(p.argvs.length, 1); const a = argvOf(p)
  eq(a[7], "storefront stopped"); eq(a[8], "hetzner-1 · exited")
  eq(JSON.stringify(execUrl(a)), JSON.stringify(["--exec", "omarchy-launch-browser", "https://app.coolify.io/project/iwo4oo0cw0kc8s4g8s0og88c/environment/vokooc88s8cssgow0ww44ssw/application/" + NAPP]))
  const q = M.notifyPlan([stopEv("notinsnapshot")], s, nctx())
  eq(q.argvs.length, 1); eq(execUrl(argvOf(q)), null, "fallback to the raw obj: no page"); eq(argvOf(q)[8], "exited")
})

test("Model.notifyPlan: argv shape, argv[0], --exec last, body omitted, app-name rule (SR16, SR17, SR23)", () => {
  const s = nsnap()
  const fin = M.joinBranch([M.normaliseDeployment(fx("deployment-finished.json"))], s.resources)[0]
  const fail = M.joinBranch([M.normaliseDeployment(fx("deployment-failed.json"))], s.resources)[0]
  const evs = [{ kind: "deployment", event: "finished", uuid: fin.uuid, obj: fin }, { kind: "deployment", event: "failed", uuid: fail.uuid, obj: fail },
               { kind: "server", event: "unreachable", uuid: NSRV, obj: s.servers[0] }, { kind: "server", event: "reachable", uuid: NSRV, obj: s.servers[0] }]
  const p = M.notifyPlan(evs, s, nctx({ dnd: true }))
  eq(p.argvs.length, 4)
  assert(p.argvs.every(a => a[0] === "omarchy-notification-send"), "argv[0]")
  for (const a of p.argvs) {
    eq(a[1], "--app-name"); eq(a[3], "-g"); eq(a[5], "-u")
    const i = a.indexOf("--exec"); assert(i > 0 && i === a.length - 3, "--exec is the third from last"); eq(a[i + 1], "omarchy-launch-browser"); assert(/^https:\/\/app\.coolify\.io\//.test(a[i + 2]))
  }
  const byHead = {}; p.argvs.forEach(a => { byHead[a[7]] = a })
  eq(byHead["Deployment failed: storefront"][2], "omarchy-action", "critical under DND"); eq(byHead["hetzner-1 unreachable"][2], "omarchy-action")
  eq(byHead["Deployed storefront"][2], "io.github.danjonesio.coolwatch", "non-critical keeps the plugin id under DND"); eq(byHead["hetzner-1 reachable"][2], "io.github.danjonesio.coolwatch")
  eq(byHead["hetzner-1 reachable"].length, 11, "empty body omitted: 8 + exec triple")
  for (const d of [false, null]) {
    const q = M.notifyPlan(evs, s, nctx({ dnd: d }))
    assert(q.argvs.every(a => a[2] === "io.github.danjonesio.coolwatch"), "plugin id when dnd=" + d)
  }
  const noUrl = M.notifyPlan([{ kind: "deployment", event: "finished", uuid: "u1", obj: dep({ uuid: "u1", status: "finished", url: null }) }], s, nctx())
  eq(noUrl.argvs[0].indexOf("--exec"), -1); eq(noUrl.argvs[0][7], "Deployed api")
  eq(p.lastKind, "reachable"); eq(p.notified.length, 4); eq(p.notified[0].key, "deployment:" + fail.uuid + ":failed", "critical first")
})

test("Model.notifyPlan / notifyCopy / logRequestRow: a failed toast's click runs the IPC log verb; every other tail is unchanged (Phase 4b item 6)", () => {
  const s = nsnap()
  const fin = M.joinBranch([M.normaliseDeployment(fx("deployment-finished.json"))], s.resources)[0]
  const fail = M.joinBranch([M.normaliseDeployment(fx("deployment-failed.json"))], s.resources)[0]
  const evs = [{ kind: "deployment", event: "finished", uuid: fin.uuid, obj: fin }, { kind: "deployment", event: "failed", uuid: fail.uuid, obj: fail },
               { kind: "server", event: "unreachable", uuid: NSRV, obj: s.servers[0] }]
  const p = M.notifyPlan(evs, s, nctx({ logClick: true }))
  eq(p.argvs.length, 3)
  const byHead = {}; p.argvs.forEach(a => { byHead[a[7]] = a })
  byHead["storefront stopped"] = M.notifyPlan([stopEv(NAPP)], s, nctx({ logClick: true })).argvs[0]   // apart: the unreachable server above would drop it (serverDown)
  const f = byHead["Deployment failed: storefront"]
  eq(f[8], "1m 4s · click for the log")
  eq(JSON.stringify(f.slice(9)), JSON.stringify(["--exec", "omarchy-shell", "io.github.danjonesio.coolwatch", "log", fail.uuid]), "the shell tail, --exec last")
  for (const h of ["Deployed storefront", "hetzner-1 unreachable", "storefront stopped"]) {
    const a = byHead[h]; const i = a.indexOf("--exec"); assert(i === a.length - 3, h + ": browser tail"); eq(a[i + 1], "omarchy-launch-browser")
  }
  // The DND sender rule is untouched: the tail carries the verb either way.
  const d = M.notifyPlan([evs[1]], s, nctx({ logClick: true, dnd: true })).argvs[0]
  eq(d[2], "omarchy-action"); eq(d[d.length - 2], "log"); eq(d[d.length - 1], fail.uuid)
  // No read:sensitive (logClick false or absent): the browser tail and the old copy.
  for (const lc of [false, undefined, "yes"]) {
    const b = M.notifyPlan([evs[1]], s, nctx({ logClick: lc })).argvs[0]
    eq(b[8], "1m 4s · click to open in Coolify", "logClick=" + lc); eq(b[b.length - 2], "omarchy-launch-browser")
  }
  // A restart failure and a failed build without a page both still reach the log.
  const rf = M.notifyPlan([{ kind: "deployment", event: "failed", uuid: "u9", obj: Object.assign({}, fail, { uuid: "u9", restartOnly: true, url: null }) }], s, nctx({ logClick: true })).argvs[0]
  eq(rf[7], "Restart failed: storefront"); eq(rf[8], "1m 4s · click for the log"); eq(rf[rf.length - 1], "u9")
  // A uuid outside UUID_RE never becomes a positional: the browser tail (or nothing) instead.
  const bad = M.notifyPlan([{ kind: "deployment", event: "failed", uuid: "-x y", obj: Object.assign({}, fail, { uuid: "-x y", url: null }) }], s, nctx({ logClick: true })).argvs[0]
  eq(bad.indexOf("omarchy-shell"), -1); eq(bad.indexOf("--exec"), -1)
  // logRequestRow: the active list, then recent, then a bare row; a bad uuid is null.
  const act = M.joinBranch(M.normaliseDeployments(fx("deployments-active.json")), s.resources)
  const snap = Object.assign({}, s, { deployments: act, recent: [fail] })
  const r1 = M.logRequestRow(snap, act[0].uuid, "https://app.coolify.io")
  eq(r1.type, "deployment"); eq(r1.uuid, act[0].uuid); eq(r1.name, "storefront"); assert(r1.url.startsWith("https://app.coolify.io/"), "url from origin"); eq(r1.finishedAt, "")
  const r2 = M.logRequestRow(snap, fail.uuid, "https://app.coolify.io")
  eq(r2.status, "failed"); eq(r2.finishedAt, fail.finishedAt); eq(r2.name, "storefront")
  const r3 = M.logRequestRow(snap, "zzzzzzzzzzzz1234", "https://app.coolify.io")
  eq(r3.name, "zzzzzzzz"); eq(r3.url, ""); eq(r3.status, ""); eq(r3.uuid, "zzzzzzzzzzzz1234")
  eq(M.logRequestRow(snap, "-bad", ""), null); eq(M.logRequestRow(snap, "", ""), null); eq(M.logRequestRow(null, act[0].uuid, "").name, "activein", "no snapshot -> the bare row")
})

test("Model.notifyPlan: the eight per-event drops with just-inside and just-outside cases; suppressed per rule", () => {
  const s = nsnap()
  const run = (ctx, events, snap) => M.notifyPlan(events || [stopEv(NAPP)], snap || s, nctx(ctx))
  eq(run({ notify: Object.assign(M.notifyDefaults(), { resourceStateChanged: false }) }).suppressed.toggle, 1)
  const canEv = [{ kind: "deployment", event: "cancelled", uuid: "c1", obj: dep({ uuid: "c1", status: "cancelled-by-user" }) }]
  eq(run({ actionAt: { c1: NOW - 299000 } }, canEv).suppressed.selfCancel, 1); eq(run({ actionAt: { c1: NOW - 301000 } }, canEv).argvs.length, 1)
  eq(run({ pending: { [NAPP]: { verb: "stop" } } }).suppressed.pending, 1)
  eq(run({ actionAt: { [NAPP]: NOW - 179000 } }).suppressed.actionWindow, 1); eq(run({ actionAt: { [NAPP]: NOW - 181000 } }).argvs.length, 1)
  const act = M.joinBranch(M.normaliseDeployments(fx("deployments-active.json")), s.resources)
  eq(run({}, null, nsnap({ deployments: act })).suppressed.activeDeployment, 1, "active deployment for the app (appUuid)")
  eq(run({}, [stopEv("qkyqt4xzvclreyhdutkrib9p")], nsnap({ deployments: [dep({ status: "in_progress", appName: "landing:main-qkyqt4xzvclreyhdutkrib9p" })] })).suppressed.activeDeployment, 1, "by appName")
  const rec = (ms) => nsnap({ recent: [Object.assign(M.normaliseDeployment(fx("deployment-finished.json")), { appUuid: NAPP, finishedAt: new Date(NOW - ms).toISOString() })] })
  eq(run({}, null, rec(119000)).suppressed.postDeployGrace, 1); eq(run({}, null, rec(121000)).argvs.length, 1)
  const down = nsnap({ servers: s.servers.map(x => Object.assign({}, x, { reachable: false })) })
  eq(run({}, null, down).suppressed.serverDown, 1, "server already unreachable")
  const batch = run({}, [stopEv(NAPP), { kind: "server", event: "unreachable", uuid: NSRV, obj: s.servers[0] }])
  eq(batch.suppressed.serverDown, 1, "server flips in the same batch"); eq(batch.argvs.length, 1); eq(batch.argvs[0][8], "7 resources down")
  eq(run({ lastNotified: { ["resource:" + NAPP + ":stopped"]: NOW - 299000 } }).suppressed.cooldown, 1); eq(run({ lastNotified: { ["resource:" + NAPP + ":stopped"]: NOW - 301000 } }).argvs.length, 1)
  const st2 = [{ kind: "deployment", event: "started", uuid: "d9", obj: dep({ uuid: "d9", status: "in_progress" }) }]
  eq(run({ lastNotified: { "deployment:d9:started": NOW - 10000 } }, st2).suppressed.cooldown, 1, "a re-entering uuid does not toast Building twice")
  const rc = [{ kind: "resource", event: "recovered", uuid: NAPP, obj: rawRes(NAPP, "running") }]
  eq(run({}, rc).suppressed.cooldown, 1, "recovered needs a prior stopped"); eq(run({ lastNotified: { ["resource:" + NAPP + ":stopped"]: NOW - 3599000 } }, rc).argvs.length, 1)
  eq(run({ lastNotified: { ["resource:" + NAPP + ":degraded"]: NOW - 3601000 } }, rc).suppressed.cooldown, 1)
})

test("Model.notifyPlan: critical-first ordering, resource cap + summary, minute cap, flap bound, notified keys (SR21)", () => {
  const s = nsnap()
  const many = []; for (let i = 0; i < 20; i++) many.push(stopEv("res" + i))
  const p = M.notifyPlan(many, s, nctx())
  eq(p.argvs.length, 4); eq(p.suppressed.resourceCap, 17); eq(p.argvs[3][7], "17 more resources stopped")
  const fail = M.joinBranch([M.normaliseDeployment(fx("deployment-failed.json"))], s.resources)[0]
  const low = []; for (let i = 0; i < 4; i++) low.push({ kind: "deployment", event: "queued", uuid: "q" + i, obj: dep({ uuid: "q" + i }) })
  const mixed = M.notifyPlan(low.concat([{ kind: "deployment", event: "failed", uuid: fail.uuid, obj: fail }]), s, nctx({ sentLastMin: 12 }))
  eq(mixed.argvs.length, 1); eq(mixed.argvs[0][6], "critical", "critical emitted when the minute budget is spent"); eq(mixed.suppressed.minuteCap, 4)
  const ordered = M.notifyPlan(low.concat([{ kind: "deployment", event: "failed", uuid: fail.uuid, obj: fail }]), s, nctx())
  eq(ordered.argvs[0][6], "critical", "critical first"); eq(ordered.argvs.length, 5)
  let sent = 0, total = 0
  for (let f = 0; f < 20; f++) {
    const evs = []; for (let i = 0; i < 10; i++) evs.push(stopEv("flush" + f + "res" + i))
    const r = M.notifyPlan(evs, s, nctx({ sentLastMin: sent })); sent += r.argvs.length; total += r.argvs.length
  }
  assert(total <= 12, "≤ 12 non-critical per minute, got " + total)
  const ln = {}; let toasts = 0
  for (let t = 0; t <= 600000; t += 60000) {
    const r = M.notifyPlan([stopEv(NAPP)], s, nctx({ now: NOW + t, lastNotified: ln })); toasts += r.argvs.length
    r.notified.forEach(n => { ln[n.key] = n.at })
  }
  eq(toasts, 3, "a flap at 60 s toasts once per 300 s window: 0, 300, 600")
  eq(p.notified.length, 3, "summary row stamps no key"); assert(p.notified.every(n => /^resource:res\d+:stopped$/.test(n.key)))
  const crit = []; for (let i = 0; i < 20; i++) crit.push({ kind: "server", event: "unreachable", uuid: "srv" + i, obj: { uuid: "srv" + i, name: "s" + i, reachable: false, disabled: false } })
  const burst = M.notifyPlan(crit, s, nctx())
  eq(burst.argvs.length, 20, "critical never capped"); eq(burst.nonCritical, 0, "critical toasts do not charge the minute ring")
  const mix = M.notifyPlan([stopEv("n0"), stopEv("n1"), { kind: "resource", event: "recovered", uuid: "m0", obj: rawRes("m0", "running") }, { kind: "resource", event: "recovered", uuid: "m1", obj: rawRes("m1", "running") }, { kind: "resource", event: "recovered", uuid: "m2", obj: rawRes("m2", "running") }, stopEv("n2"), stopEv("n3")], s,
    nctx({ lastNotified: { "resource:m0:stopped": NOW - 1000, "resource:m1:stopped": NOW - 1000, "resource:m2:stopped": NOW - 1000 } }))
  eq(mix.argvs.length, 4, "3 resource toasts + one summary"); eq(mix.argvs[3][7], "1 more resources stopped", "the summary counts stops only, never recoveries"); eq(mix.suppressed.resourceCap, 4)
  const proto = M.notifyPlan([{ kind: "resource", event: "stopped", uuid: "toString", obj: rawRes("toString") }], nsnap({ deployments: [dep({ status: "in_progress", appName: "constructor" })] }), nctx())
  eq(proto.argvs.length, 1, "a resource named toString is not swallowed by a prototype key"); eq(M.hasTerminal([dep({ uuid: "x", status: "constructor" })], "x"), false)
  eq(M.mergeRecent([{ uuid: "valueOf", status: "finished", finishedAt: "2026-09-06T21:00:00Z" }], []).length, 1)
  const after = M.notifyPlan([stopEv(NAPP)], s, nctx({ sentLastMin: burst.nonCritical }))
  eq(after.argvs.length, 1, "a non-critical toast right after a critical burst is not dropped"); eq(after.nonCritical, 1)
  const big = [], bigRes = [], bigDeps = [], bigRecent = []
  for (let i = 0; i < 2000; i++) {
    big.push(stopEv("big" + i)); bigRes.push(Object.assign(rawRes("big" + i), { serverUuid: NSRV, projectUuid: "p", environmentUuid: "e" }))
    bigDeps.push(dep({ uuid: "bd" + i, status: "in_progress", appUuid: "other" + i, appName: "o" + i }))
    bigRecent.push(dep({ uuid: "br" + i, status: "finished", appUuid: "old" + i, appName: "r" + i, finishedAt: new Date(NOW - 3600000 - i).toISOString() }))
  }
  const bigSnap = nsnap({ resources: bigRes, deployments: bigDeps, recent: bigRecent })
  const t0 = Date.now(); const bigPlan = M.notifyPlan(big, bigSnap, nctx()); const dt = Date.now() - t0
  assert(dt < 50, "notifyPlan builds its indexes once: 2 000 events over a 2 000-entry snapshot under 50 ms (took " + dt + " ms; rebuilding per event costs ~1.4 s)")
  eq(bigPlan.argvs.length, 4, "2 000 stops -> 3 + summary")
})

test("Model.notifyPlan: log lines are event + uuid8 only; a hostile uuid cannot forge a line (SR15)", () => {
  const s = nsnap()
  const p = M.notifyPlan([stopEv(NAPP), stopEv("ab\ncoolwatch notify forged aaaaaaaa")], s, nctx())
  eq(p.log.length, 2); eq(p.log[0], "stopped h0wxyg40"); eq(p.log[1].indexOf("\n"), -1); eq(p.log[1], "stopped abcoolwa")
  for (const l of p.log) assert(l.indexOf("refresh") < 0 && l.indexOf("hetzner") < 0, "no names")
})

test("Model.parseRecent / serialiseRecent / mergeRecent: round-trip, corrupt, null, version, key, bounds, hostile url, redact (SR18, SR19)", () => {
  const KEY = "https://app.coolify.io"
  const good = M.parseRecent(fixture("state-recent.json"), KEY, NOW)
  eq(good.loaded, true); eq(good.rejected, false); eq(good.recent.length, 2); eq(good.recent[0].uuid, "vdyasty4cmgyoekplcarxpfh"); eq(good.recent[0].status, "finished")
  eq(good.recent[0].branch, null); eq(good.recent[0].appUuid, null); eq(good.recent[1].force, true); eq(good.recent[1].isWebhook, true)
  assert(M.openUrl("deployment", good.recent[0], KEY).startsWith("https://app.coolify.io/project/"))
  const rt = M.serialiseRecent(good.recent, KEY, NOW); const back = M.parseRecent(rt.text, KEY, NOW)
  eq(JSON.stringify(back.recent), JSON.stringify(good.recent), "round-trip"); assert(rt.text.endsWith("\n"))
  eq(M.serialiseRecent(good.recent, KEY, NOW + 5000).key, rt.key, "key ignores savedAt"); assert(M.serialiseRecent(good.recent, KEY, NOW + 5000).text !== rt.text)
  const corrupt = M.parseRecent(fixture("state-recent-corrupt.txt"), KEY, NOW); eq(corrupt.rejected, true); eq(corrupt.loaded, false); eq(corrupt.recent.length, 0)
  for (const t of [null, "", undefined]) { const r = M.parseRecent(t, KEY, NOW); eq(r.loaded, false); eq(r.rejected, false); eq(r.recent.length, 0) }
  eq(M.parseRecent(rt.text, "", NOW).rejected, true, "empty instance key never matches")
  eq(M.parseRecent(rt.text, "https://other", NOW).rejected, true)
  eq(M.parseRecent(rt.text.replace('"version": 1', '"version": 2'), KEY, NOW).rejected, true)
  eq(M.parseRecent('{"version":1,"instance":"' + KEY + '","recent":{}}', KEY, NOW).rejected, true, "non-array")
  eq(M.parseRecent("[]", KEY, NOW).rejected, true); eq(M.parseRecent("null", KEY, NOW).rejected, true)
  eq(M.parseRecent("x".repeat(5 * 1024 * 1024), KEY, NOW).rejected, true, "5 MB rejected before parse")
  const entry = (i, extra) => Object.assign({ uuid: "u" + i, status: "finished", finishedAt: new Date(NOW - i * 1000).toISOString() }, extra || {})
  const big = []; for (let i = 0; i < 10000; i++) big.push(entry(i))
  eq(M.parseRecent(JSON.stringify({ version: 1, instance: KEY, recent: big }), KEY, NOW).rejected, true, "10 000 entries exceed the size bound before the array cap")
  const two = []; for (let i = 0; i < 2000; i++) two.push(entry(i))
  const twoText = JSON.stringify({ version: 1, instance: KEY, recent: two }); assert(twoText.length < 262144, "under the bound")
  eq(M.parseRecent(twoText, KEY, NOW).recent.length, 20, "array capped at 20")
  eq(M.parseRecent(JSON.stringify({ version: 1, instance: KEY, recent: [entry(1, { uuid: "constructor" })] }), KEY, NOW).recent.length, 1, "a uuid that names a prototype member survives")
  const mixed = { version: 1, instance: KEY, recent: [entry(1, { finishedAt: null, updatedAt: null }), entry(2, { finishedAt: new Date(NOW - 8 * 24 * 3600 * 1000).toISOString() }), entry(3, { status: "in_progress" }), entry(4, { uuid: "../x" }), entry(5), entry(5)] }
  const m = M.parseRecent(JSON.stringify(mixed), KEY, NOW); eq(m.recent.length, 1); eq(m.recent[0].uuid, "u5")
  for (const u of ["https://evil/x", "//evil/x", "javascript:x", "-private", "project/x"]) {
    const r = M.parseRecent(JSON.stringify({ version: 1, instance: KEY, recent: [entry(9, { url: u })] }), KEY, NOW)
    eq(r.recent.length, 1); eq(M.openUrl("deployment", r.recent[0], KEY), "", u)
  }
  const tok = M.serialiseRecent([entry(7, { commitMessage: "oops 67|" + "b".repeat(30) })], KEY, NOW)
  assert(tok.text.indexOf("«token»") > 0 && !/67\|b{5}/.test(tok.text), "redacted on the way out")
  eq(M.serialiseRecent([entry(8, { status: "in_progress" })], KEY, NOW).key, JSON.stringify({ version: 1, instance: KEY, recent: [] }), "only terminal entries persist")
  const mem = [entry(1), entry(2)], loaded = [Object.assign(entry(2), { appName: "loaded" }), entry(3)]
  const mg = M.mergeRecent(mem, loaded); eq(mg.length, 3); eq(mg[0].uuid, "u1"); eq(mg[1].uuid, "u2"); eq(mg[1].appName, undefined, "memory wins"); eq(mg[2].uuid, "u3")
  const capped = []; for (let i = 0; i < 30; i++) capped.push(entry(i)); eq(M.mergeRecent(capped, []).length, 20)
})

test("Model.normaliseDeployment / terminalEvent on the recorded cancelled fixture", () => {
  const d = M.normaliseDeployment(fx("deployment-cancelled.json"))
  eq(d.status, "cancelled-by-user"); eq(M.terminalEvent(d).event, "cancelled"); eq(M.NOTIFY_ROWS.cancelled.toggle, "deploymentFinished")
  assert(d.finishedAt, "a cancelled queued deployment carries finished_at")
})

// ---- Model.js: bar, hero, callout --------------------------------------------------------------

test("Model.barState: all 15 rows (glyph, dimmed, active, tooltip)", () => {
  const G = M.G
  function st(o) { return M.barState(snap(o)) }
  let b = st({ error: M.makeError("noconfig") }); eq(b.glyph, G.cloudOutline); eq(b.dimmed, true); eq(b.active, false); assert(/no config at/.test(b.tooltip))
  b = st({ error: M.makeError("configerror", "bad\nmore") }); eq(b.glyph, G.cloudAlert); eq(b.tooltip, "Coolwatch — config error: bad more")
  b = st({ error: M.makeError("unsafe") }); eq(b.glyph, G.cloudAlert); assert(/writable/.test(b.tooltip))
  b = st({ error: M.makeError("tokencmd", "", { curlExit: 1 }) }); eq(b.glyph, G.cloudAlert); eq(b.tooltip, "Coolwatch — token command failed (exit 1)")
  b = st({ error: M.makeError("waitingtoken") }); eq(b.glyph, G.cloud); eq(b.dimmed, true); assert(/waiting/.test(b.tooltip))
  b = st({ error: M.makeError("auth") }); eq(b.glyph, G.cloudAlert); eq(b.tooltip, "Coolwatch — token rejected")
  b = st({ error: M.makeError("apidisabled") }); eq(b.glyph, G.cloudAlert); assert(/API disabled/.test(b.tooltip))
  b = st({ error: M.makeError("ipblocked") }); eq(b.glyph, G.cloudAlert); assert(/IP/.test(b.tooltip))
  b = st({ error: M.makeError("offline") }); eq(b.glyph, G.cloudOff); eq(b.dimmed, true); assert(/offline/.test(b.tooltip))
  b = st({ error: M.makeError("tls") }); eq(b.glyph, G.cloudAlert); eq(b.dimmed, true); assert(/certificate/.test(b.tooltip))   // SR36
  b = st({ error: M.makeError("ratelimited"), backoffSec: 30 }); eq(b.glyph, G.cloud); eq(b.tooltip, "Coolwatch — rate limited, backing off 30s")
  b = st({ baselineDone: false }); eq(b.glyph, G.cloud); eq(b.dimmed, true); eq(b.tooltip, "Coolwatch — starting")
  b = st({ failedUnacked: ["f1", "f2"], recent: [{ uuid: "f1", appName: "api", status: "failed" }] }); eq(b.glyph, G.failed); eq(b.active, true); eq(b.dimmed, false); eq(b.tooltip, "Deployment failed: api +1 more")
  b = st({ servers: [{ uuid: "s", name: "web-1", reachable: false, disabled: false }, { uuid: "t", name: "web-2", reachable: false, disabled: false }] }); eq(b.glyph, G.cloudOff); eq(b.active, true); eq(b.tooltip, "web-1 unreachable +1 more")
  b = st({ deployments: [{ uuid: "d", appName: "api", status: "in_progress" }] }); eq(b.glyph, G.progress); eq(b.active, true); eq(b.tooltip, "Deploying api")
  b = st({ deployments: [{ uuid: "d", appName: "api", status: "in_progress" }, { uuid: "e", appName: "w", status: "queued" }] }); eq(b.tooltip, "2 deployments running")
  b = st({ error: M.makeError("http", "x", { request: "servers" }), servers: [{ uuid: "s", name: "a", reachable: true }] }); eq(b.glyph, G.cloud); eq(b.active, false); eq(b.dimmed, false); assert(/\(servers unavailable\)/.test(b.tooltip))
  b = st({ servers: [{ uuid: "s", name: "a", reachable: true }, { uuid: "t", name: "b", reachable: true }], resources: [{}, {}, {}] }); eq(b.glyph, G.cloud); eq(b.dimmed, false); eq(b.active, false); eq(b.tooltip, "Coolify Cloud — 2 servers · 3 resources")
  b = st({}); eq(b.tooltip, "Coolify Cloud — no resources")
  b = st({ deployments: [{ uuid: "d", appName: "x".repeat(200), status: "in_progress" }] }); assert(b.tooltip.length < 60, "names in tooltips are bounded")
})

test("Model.barState: failed then acknowledged returns to idle; a failure with a panel open never arms (handled by the service)", () => {
  let b = M.barState(snap({ failedUnacked: ["f"], recent: [{ uuid: "f", appName: "api" }] }))
  eq(b.active, true)
  b = M.barState(snap({ failedUnacked: [], recent: [{ uuid: "f", appName: "api", status: "failed" }] }))
  eq(b.active, false); eq(b.glyph, M.G.cloud)
})

test("Model.heroMeta: every condition string; no 0 deploying; empty account; precedence", () => {
  eq(M.heroMeta(snap({ servers: [{}, {}, {}], resources: new Array(14).fill({}), deployments: [{ status: "in_progress" }] })), "3 servers · 14 resources · 1 deploying")
  eq(M.heroMeta(snap({ servers: [{}], resources: [{}] })), "1 server · 1 resource")
  eq(M.heroMeta(snap({})), "No resources on this team")
  eq(M.heroMeta(snap({ baselineDone: false })), "Loading")
  for (const [k, v] of Object.entries({ noconfig: "Not configured", configerror: "Config error", unsafe: "Config unsafe", tokencmd: "Token unavailable", waitingtoken: "Waiting for token", auth: "Token rejected", apidisabled: "API disabled", ipblocked: "IP not allowed", offline: "Offline · retrying", ratelimited: "Rate limited", toolarge: "Response too large", http: "Coolify error" }))
    eq(M.heroMeta(snap({ error: M.makeError(k) })), v, k)
  eq(M.heroMeta(snap({ error: M.makeError("http", "", { request: "servers" }), servers: [{}] })), "servers unavailable · showing last known")
  eq(M.heroMeta(snap({ error: M.makeError("ability", "Missing required permissions: deploy"), servers: [{}] })), "1 server", "ability does not take over meta")
  eq(M.heroMeta(snap({ error: M.makeError("offline"), baselineDone: false })), "Offline · retrying", "error beats loading")
  eq(M.heroTitle(snap({ instance: { url: "https://coolify.example.com" } })), "coolify.example.com")
  eq(M.heroDetail(snap({})), "v4.3.14"); eq(M.heroDetail(snap({ instance: {} })), "")
})

test("Model.callout: every error and warning kind has a body; healthy is null; staleness appended", () => {
  eq(M.callout(snap({})), null)
  const kinds = ["noconfig", "configerror", "unsafe", "tokencmd", "waitingtoken", "auth", "apidisabled", "ipblocked", "ability", "ratelimited", "offline", "tls", "toolarge", "http"]
  kinds.forEach(k => {
    const c = M.callout(snap({ error: M.makeError(k, "detail text", { curlExit: 3, httpCode: 500 }) }), NOW)
    assert(c && c.body.length > 0, k + " has a body"); assert(c.title.length > 0, k + " has a title")
  })
  assert(/read ability/.test(M.callout(snap({ error: M.makeError("auth") })).body))
  assert(/deploy ability/.test(M.callout(snap({ error: M.makeError("ability", "Missing required permissions: deploy") })).body))
  const st = M.callout(snap({ error: M.makeError("offline", "", { staleSince: NOW - 3 * 60000 }) }), NOW)
  assert(/Showing data from 3m ago\./.test(st.body), "staleness suffix")
  const w = M.callout(snap({ warning: { kind: "permissions" } }))
  assert(/chmod 600/.test(w.body)); assert(/readable/.test(w.title))
  // "Edit config" (Phase 5 prep): the file's own problems carry the button, nothing else does.
  ;["noconfig", "configerror", "unsafe", "tokencmd", "auth"].forEach(k => assert(M.callout(snap({ error: M.makeError(k, "d") })).edit === true, k + " editable"))
  ;["waitingtoken", "apidisabled", "ipblocked", "ability", "ratelimited", "offline", "tls", "toolarge", "http"].forEach(k => assert(M.callout(snap({ error: M.makeError(k, "d") })).edit === false, k + " not editable"))
  assert(w.edit === true, "permissions warning editable")
  assert(M.callout(snap({ warning: { kind: "plaintext" } })).edit === false, "plaintext not editable")
  assert(M.calloutEditable(null) === false && M.calloutEditable(snap({})) === false)
  const sample = JSON.parse(M.SAMPLE_CONFIG_FILE)
  assert(sample.instances[0].token === "paste-your-token-here", "the sample file parses")
  assert(/homelab/.test(sample._help) && /#configuration/.test(sample._help), "the help string shows a second instance and links the README")
  const ns = M.normaliseConfig(M.SAMPLE_CONFIG_FILE)
  assert(ns.ok && ns.instances.length === 1 && ns.instances[0].id === "cloud", "normaliseConfig accepts the sample and ignores _help")
  assert(/ · e config · /.test(M.footerHints("hero", null, {})), "hero hint names e at any time")
  assert(/^e edit config · /.test(M.footerHints("list", null, { editConfig: true })), "empty list hint under a config callout")
  assert(!/config/.test(M.footerHints("list", null, {})), "no list hint without the callout")
  const p = M.callout(snap({ warning: { kind: "plaintext" } }))
  assert(/http:\/\//.test(p.body))
  const both = M.callout(snap({ error: M.makeError("auth"), warning: { kind: "plaintext" } }))
  assert(/read ability/.test(both.body) && /http:\/\//.test(both.body), "error body then warning body")
  const partial = M.callout(snap({ error: M.makeError("http", "", { request: "servers" }), servers: [{}] }))
  eq(partial.title, "servers unavailable"); eq(partial.body, "servers is unavailable.")
  const topo = M.callout(snap({ error: M.makeError("http", "", { request: "serverResources" }), servers: [{}] }))
  eq(topo.title, "topology unavailable", "request ids map to display words")
  eq(M.heroMeta(snap({ error: M.makeError("http", "", { request: "project" }), servers: [{}] })), "topology unavailable · showing last known")
  const rl = M.callout(snap({ error: M.makeError("ratelimited"), backoffSec: 120 }))
  eq(rl.body, "Backing off 120s.", "callout and bar agree on the backoff")
})

// ---- Model.js: panel rows ---------------------------------------------------------------------

test("Model.panelRows: section order with separators, stable keys, notes for empty sections", () => {
  const rows = M.panelRows(snap({}), { groupBy: "project", folded: {} })
  eq(rows.map(r => r.type).join(","), "section,note,separator,section,note,separator,section,note")
  eq(rows[0].title, "DEPLOYMENTS"); eq(rows[1].text, "Nothing deploying."); eq(rows[4].text, "No servers on this team."); eq(rows[7].text, "No resources on this team.")
  const errRows = M.panelRows(snap({ error: M.makeError("offline"), baselineDone: false, lastPollAt: { deployments: 0, servers: 0, resources: 0 } }), {})
  eq(errRows[4].text, "Not loaded yet.", "no false empty-state copy while nothing has loaded")
  eq(rows[6].control, "groupBy"); eq(rows[0].control, null)
  assert(rows.every(r => typeof r.key === "string" && r.key.length > 0), "every row has a key")
})

test("Model.panelRows: deployments render active plus newest 5 recent only", () => {
  const recent = []
  for (let i = 0; i < 9; i++) recent.push({ uuid: "r" + i, appName: "app" + i, status: "finished", commit: "abcdef0", commitMessage: "m", createdAt: null, updatedAt: null, branch: "main" })
  const rows = M.panelRows(snap({ deployments: M.joinBranch(M.normaliseDeployments(fx("deployments-active.json")), []), recent }), {})
  const deps = rows.filter(r => r.type === "deployment")
  eq(deps.length, 7)
  eq(deps[0].key, "dep:activeinprogress0000001"); eq(deps[0].tone, "urgent", "in flight paints the bar's signal colour"); eq(deps[0].glyph, M.G.progress); eq(deps[0].terminal, false)
  eq(M.deploymentGlyph({ status: "failed" }).tone, "accent", "failed paints the theme accent")
  eq(deps[1].glyph, M.G.queued); eq(deps[2].uuid, "r0"); eq(deps[2].terminal, true); eq(deps[2].sub, "main · m")
  assert(deps[0].sub.indexOf("Merge pull request") > 0, "branch · commit message")
  assert(!rows.some(r => r.type === "note" && r.text === "Nothing deploying."))
  const old = recent.map(d => Object.assign({}, d, { updatedAt: new Date(NOW - 2 * 3600000).toISOString() }))
  const aged = M.panelRows(snap({ recent: old }), { nowMs: NOW })
  eq(aged.filter(r => r.type === "deployment").length, 1, "after an hour only the newest terminal deployment stays")
  eq(aged.filter(r => r.type === "deployment")[0].uuid, "r0")
  assert(!aged.some(r => r.type === "note" && r.text === "Nothing deploying."))
  const dismissedAll = M.panelRows(snap({ recent: old.map(d => Object.assign({}, d, { dismissed: true })) }), { nowMs: NOW })
  eq(dismissedAll.filter(r => r.type === "deployment").length, 0, "every terminal row dismissed: the section is empty")
  assert(dismissedAll.some(r => r.type === "note" && r.text === "Nothing deploying."))
  const firstGone = M.panelRows(snap({ recent: old.map((d, i) => Object.assign({}, d, { dismissed: i === 0 })) }), { nowMs: NOW })
  eq(firstGone.filter(r => r.type === "deployment")[0].uuid, "r1", "rendering rule: the newest undismissed entry stands in (the service flags older ones too, so this only happens for a flag set by hand)")
  const withActive = M.panelRows(snap({ deployments: M.joinBranch(M.normaliseDeployments(fx("deployments-active.json")), []), recent: old }), { nowMs: NOW })
  eq(withActive.filter(r => r.type === "deployment" && r.terminal).length, 0, "an active build needs no stand-in")
  const freshDismissed = M.panelRows(snap({ recent: recent.map((d, i) => Object.assign({}, d, { updatedAt: new Date(NOW - 10 * 60000).toISOString(), dismissed: i < 2 })) }), { nowMs: NOW })
  eq(freshDismissed.filter(r => r.type === "deployment").map(r => r.uuid).join(","), "r2,r3,r4,r5,r6", "dismissed rows under an hour old are hidden too")
  const fresh = M.panelRows(snap({ recent: recent.map(d => Object.assign({}, d, { updatedAt: new Date(NOW - 10 * 60000).toISOString() })) }), { nowMs: NOW })
  eq(fresh.filter(r => r.type === "deployment").length, 5)
})

test("Model.filterTerms / rowMatches / panelRows filter: empty filter is identical; terms AND; folds forced open or hidden; deployments narrowed; servers untouched; tags hidden; no-match notes (Phase 4b)", () => {
  eq(M.filterTerms("  Uma  Prod ").join("|"), "uma|prod"); eq(M.filterTerms("").length, 0); eq(M.filterTerms(null).length, 0)
  eq(M.filterTerms(new Array(20).fill("a").join(" ")).length, 8, "term cap"); eq(M.filterTerms("x".repeat(200))[0].length, 64, "term length cap")
  const row = { name: "umami-prod", statusWords: "running · healthy", kindHint: "service", status: "running:healthy" }
  assert(M.rowMatches(row, M.filterTerms("uma"))); assert(M.rowMatches(row, M.filterTerms("UMA healthy"))); assert(!M.rowMatches(row, M.filterTerms("uma exited")))
  assert(M.rowMatches(row, []), "no terms matches everything"); assert(M.rowMatches({ name: "" }, M.filterTerms("")))
  const recent = [{ uuid: "r0", appName: "umami-prod", status: "finished", commitMessage: "bump", branch: "main", updatedAt: new Date(NOW - 60000).toISOString() },
                  { uuid: "r1", appName: "landing", status: "failed", commitMessage: "fix login", branch: "main", updatedAt: new Date(NOW - 120000).toISOString() }]
  const base = loadedSnap({ recent, tags: ["blue"] })
  const plain = M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW })
  eq(JSON.stringify(M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW, filter: "" })), JSON.stringify(plain), "an empty filter changes nothing")
  eq(JSON.stringify(M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW, filter: "   " })), JSON.stringify(plain), "whitespace is an empty filter")
  assert(plain.some(r => r.key === "sec:tags"), "tags section present without a filter")
  const names = plain.filter(r => r.type === "resource").map(r => r.name)
  assert(names.length > 1, "fixture has several resources: " + names.join(","))
  const pick = names[0]
  const f = M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW, filter: pick.toUpperCase() })
  const fres = f.filter(r => r.type === "resource")
  assert(fres.length >= 1 && fres.every(r => r.name.toLowerCase().indexOf(pick.toLowerCase()) >= 0), "only matching resources: " + fres.map(r => r.name).join(","))
  assert(f.filter(r => r.type === "fold").every(r => r.open === true && r.count === f.filter(x => x.type === "resource").length), "folds with a match are open and count the matches")
  assert(!f.some(r => r.key === "sec:tags"), "tags hide while filtering")
  eq(f.filter(r => r.type === "server").length, plain.filter(r => r.type === "server").length, "servers untouched")
  const folded = {}; plain.filter(r => r.type === "fold").forEach(r => { folded[r.key] = true })   // every group closed
  const forced = M.panelRows(base, { groupBy: "project", folded, nowMs: NOW, filter: pick })
  assert(forced.filter(r => r.type === "fold").every(r => r.open === true), "a folded group with a match is forced open")
  assert(M.panelRows(base, { groupBy: "project", folded, nowMs: NOW }).filter(r => r.type === "fold" && r.key !== "fold:tags").every(r => r.open === false), "and the fold flag itself is untouched (the tags flag means opened)")
  const deps = M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW, filter: "login" }).filter(r => r.type === "deployment")
  eq(deps.map(r => r.uuid).join(","), "r1", "deployments match on the caption too")
  eq(M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW, filter: "failed" }).filter(r => r.type === "deployment").map(r => r.uuid).join(","), "r1", "and on the status word")
  const none = M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW, filter: "zzzz-nothing" })
  eq(none.filter(r => r.type === "resource").length, 0); eq(none.filter(r => r.type === "fold").length, 0); eq(none.filter(r => r.type === "deployment").length, 0)
  eq(none.filter(r => r.type === "note").map(r => r.text).join("|"), "No match.|No match.", "one note per narrowed section; servers keep their rows")
  const byServer = M.panelRows(base, { groupBy: "server", folded: {}, nowMs: NOW, filter: pick })
  assert(byServer.filter(r => r.type === "resource").length >= 1 && byServer.filter(r => r.type === "fold").every(r => r.open), "the same by server")
  assert(M.footerHints("list", null, { filterFocus: true }).indexOf("type to narrow") === 0)
  eq(f[M.firstMatchIndex(f)].type, "resource", "Enter from the field lands on the first match, past the servers")
  eq(M.firstMatchIndex(M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW, filter: "login" })), M.panelRows(base, { groupBy: "project", folded: {}, nowMs: NOW, filter: "login" }).findIndex(r => r.type === "deployment"))
  eq(M.firstMatchIndex(none), -1, "nothing matches: no landing row")
})

test("Model.panelRows: the leftover fold reads 'Ungrouped · loading' until the topology is complete; same key", () => {
  const base = loadedSnap({ topologyFetched: false })
  const rows0 = M.panelRows(base, {})
  const f0 = rows0.find(r => r.type === "fold" && /^Ungrouped/.test(r.title))
  assert(f0, "an Ungrouped fold exists in the fixture snapshot"); eq(f0.title, "Ungrouped · loading")
  const rows1 = M.panelRows(loadedSnap({ topologyFetched: true }), {})
  const f1 = rows1.find(r => r.type === "fold" && /^Ungrouped/.test(r.title))
  eq(f1.title, "Ungrouped"); eq(f1.key, f0.key, "the fold key survives the rename")
  assert(!M.sameRows(rows0, rows1), "rowRev notices the title")
  const named = rows1.filter(r => r.type === "fold" && !/^Ungrouped/.test(r.title))
  assert(named.length > 0 && rows1.indexOf(f1) > rows1.indexOf(named[named.length - 1]), "Ungrouped stays last")
  // The s.tree-empty fallback (the first seconds after a restart) takes the same title.
  const early = M.panelRows(snap({ resources: M.normaliseResources(fx("resources.json")), tree: [], topologyFetched: false }), {})
  eq(early.filter(r => r.type === "fold")[0].title, "Ungrouped · loading")
  const later = M.panelRows(snap({ resources: M.normaliseResources(fx("resources.json")), tree: [], topologyFetched: true }), {})
  eq(later.filter(r => r.type === "fold")[0].title, "Ungrouped")
})

test("Model.panelRows: group by project with folds, fold open/closed, Ungrouped last", () => {
  const s = loadedSnap({ topologyFetched: true })
  const open = M.panelRows(s, { groupBy: "project", folded: {} })
  const folds = open.filter(r => r.type === "fold")
  eq(folds[0].title, s.tree[0].projectName + " / production"); eq(folds[0].count, 2); eq(folds[0].open, true)
  eq(folds[folds.length - 1].title, "Ungrouped"); eq(folds[folds.length - 1].count, 5)
  eq(open.filter(r => r.type === "resource").length, 7)
  const closed = M.panelRows(s, { groupBy: "project", folded: { [folds[0].key]: true } })
  eq(closed.filter(r => r.type === "resource").length, 5)
  eq(closed.filter(r => r.type === "fold")[0].open, false)
  const res = open.find(r => r.type === "resource")
  eq(res.indent, 1); assert(res.statusWords === "healthy" || res.statusWords === "exited"); assert(M.GLYPHS.indexOf(res.dot) >= 0)
})

test("Model.panelRows: group by server uses byServer; leftovers go to Unassigned", () => {
  const s = loadedSnap()
  const rows = M.panelRows(s, { groupBy: "server", folded: {} })
  const folds = rows.filter(r => r.type === "fold")
  eq(folds[0].title, "hetzner-1"); eq(folds[0].key, "fold:s:" + s.servers[0].uuid)
  eq(folds[0].count, s.servers[0].resourceCount)
  const total = folds.reduce((n, f) => n + f.count, 0)
  eq(total, 7)
  const srv = rows.find(r => r.type === "server")
  eq(srv.name, "hetzner-1"); eq(srv.dot, M.G.dotOn); eq(srv.tone, "fg"); assert(/resources/.test(srv.sub)); eq(srv.dim, false)
})

test("Model.panelRows: server row words for unreachable, disabled, build server", () => {
  const rows = M.panelRows(snap({ servers: [
    { uuid: "a", name: "down", ip: "1.1.1.1", reachable: false, usable: false, disabled: false, buildServer: false, resourceCount: 2 },
    { uuid: "b", name: "off", ip: "2.2.2.2", reachable: true, usable: true, disabled: true, buildServer: true, resourceCount: 0 },
    { uuid: "c", name: "meh", ip: "3.3.3.3", reachable: true, usable: false, disabled: false, buildServer: false, resourceCount: 1 } ] }), {})
  const [a, b, c] = rows.filter(r => r.type === "server")
  eq(a.sub, "1.1.1.1 · 2 resources · unreachable"); eq(a.dot, M.G.dotOff); eq(a.tone, "urgent"); eq(a.dim, true)
  eq(b.sub, "2.2.2.2 · 0 resources · disabled · build server"); eq(b.dim, true); eq(b.tone, "dim")
  eq(c.sub, "3.3.3.3 · 1 resource"); eq(c.dot, M.G.half); eq(c.tone, "urgent")
})

test("Model.nextSelectable skips section/separator/note at both ends; indexOfKey; firstSelectableInSection", () => {
  const s = loadedSnap({ deployments: M.normaliseDeployments(fx("deployments-active.json")) })
  const rows = M.panelRows(s, {})
  const first = M.nextSelectable(rows, -1, 1)
  eq(rows[first].type, "deployment")
  eq(M.nextSelectable(rows, first, -1), -1, "nothing above the first deployment")
  const last = M.nextSelectable(rows, rows.length, -1)
  assert(M.nextSelectable(rows, last, 1) === -1, "nothing below the last")
  eq(M.indexOfKey(rows, "nope"), -1)
  eq(M.indexOfKey(rows, rows[first].key), first)
  const r = M.firstSelectableInSection(rows, "RESOURCES")
  eq(rows[r].type, "fold")
  eq(M.firstSelectableInSection(rows, "NOPE"), -1)
  const empty = M.panelRows(snap({}), {})
  eq(M.nextSelectable(empty, -1, 1), -1)
})

test("Model.sameRows: identical true; status change false; updatedAt-only change true; reorder false", () => {
  const s = loadedSnap({ deployments: M.normaliseDeployments(fx("deployments-active.json")) })
  const a = M.panelRows(s, {}), b = M.panelRows(s, {})
  eq(M.sameRows(a, b), true)
  const s2 = loadedSnap({ deployments: M.normaliseDeployments(fx("deployments-active.json")) })
  s2.deployments[0].updatedAt = "2026-09-06T21:31:00.000000Z"
  eq(M.sameRows(a, M.panelRows(s2, {})), true, "updatedAt is not a rev field")
  s2.deployments[0].status = "finished"
  eq(M.sameRows(a, M.panelRows(s2, {})), false, "status change")
  const c = a.slice(); const t = c[1]; c[1] = c[2]; c[2] = t
  eq(M.sameRows(a, c), false, "reorder")
  eq(M.sameRows(a, a.slice(0, -1)), false, "length")
})

test("Model.elapsed / age", () => {
  const t0 = NOW
  eq(M.elapsed(new Date(t0 - 45000).toISOString(), t0), "45s")
  eq(M.elapsed(new Date(t0 - 80000).toISOString(), t0), "1m 20s")
  eq(M.elapsed(new Date(t0 - (2 * 3600 + 3 * 60) * 1000).toISOString(), t0), "2h 03m")
  eq(M.elapsed("garbage", t0), "")
  eq(M.age(new Date(t0 - 10000).toISOString(), t0), "Just now")
  eq(M.age(new Date(t0 - 4 * 60000).toISOString(), t0), "4m ago")
  eq(M.age(new Date(t0 - 3 * 3600000).toISOString(), t0), "3h ago")
  eq(M.age(new Date(t0 - 2 * 86400000).toISOString(), t0), "2d ago")
  eq(M.age(t0 - 4 * 60000, t0), "4m ago", "numeric ms input")
})

test("Model.GLYPHS: every emitted glyph is in the allowlist and the list has no ◐", () => {
  const seen = new Set()
  const kinds = ["noconfig", "configerror", "unsafe", "tokencmd", "waitingtoken", "auth", "apidisabled", "ipblocked", "offline", "ratelimited"]
  kinds.forEach(k => seen.add(M.barState(snap({ error: M.makeError(k) })).glyph))
  seen.add(M.barState(snap({ baselineDone: false })).glyph)
  seen.add(M.barState(snap({ failedUnacked: ["f"] })).glyph)
  seen.add(M.barState(snap({ servers: [{ uuid: "s", name: "s", reachable: false }] })).glyph)
  seen.add(M.barState(snap({ deployments: [{ uuid: "d", appName: "a", status: "queued" }] })).glyph)
  seen.add(M.barState(snap({})).glyph)
  ;["in_progress", "queued", "finished", "failed", "cancelled-by-user", "wat"].forEach(st => seen.add(M.deploymentGlyph({ status: st }).glyph))
  ;["running", "starting", "restarting", "degraded", "exited", "paused", "unknown"].forEach(st => seen.add(M.statusDot({ state: st }).dot))
  seen.add(M.G.refresh); seen.add(M.G.foldOpen); seen.add(M.G.foldClosed)
  seen.forEach(g => assert(M.GLYPHS.indexOf(g) >= 0, "glyph " + JSON.stringify(g) + " not in allowlist"))
  assert(M.GLYPHS.indexOf("\u25d0") < 0, "no ◐")
  assert(seen.size >= 12, "exercised " + seen.size + " glyphs")
  eq(M.G.cloud, String.fromCodePoint(0xF015F)); eq(M.G.cloudOutline, String.fromCodePoint(0xF0163)); eq(M.G.half, String.fromCodePoint(0xF1396))
})

// ---- Model.js: Phase 2 actions ------------------------------------------------------

const ORIGIN = "https://app.coolify.io"
const APP = "h0wxyg40kc0lz727dom9l03i", SVC_EXITED = "ulg0n467viqx9g7nb25pwm6t", SVC_RUNNING = "iyoi5i0ot4nwvoz9zbkbnjsp", SRV = "qo4go8kswocog0gg0ckk8kk8"
function rec(code, body, exit) { return M.splitResponses((body || "") + trailer(exit || 0, code === 0 ? "000" : code, 0.2, (body || "").length, exit ? "curl failed" : "", "{}"))[0] }
function actSnap(extra) {
  const dep = M.normaliseDeployments(fx("deployments-active.json"))
  return loadedSnap(Object.assign({ deployments: dep }, extra || {}))
}
function rowOf(s, uuid) { return M.panelRows(s, {}).find(r => r.uuid === uuid) }

test("Model.environmentsOf keeps uuid; applyJoins carries environmentUuid", () => {
  const envs = M.environmentsOf(fx("project-detail.json"))
  eq(envs[0].uuid, "vokooc88s8cssgow0ww44ssw"); eq(envs[0].id, 15640)
  const s = loadedSnap()
  const app = s.resources.find(r => r.uuid === APP)
  eq(app.environmentUuid, "vokooc88s8cssgow0ww44ssw"); eq(app.projectUuid, "iwo4oo0cw0kc8s4g8s0og88c")
  const tree = M.buildTree([], {}, s.resources)
  eq(tree[0].environments[0].uuid, "", "Ungrouped env has an empty uuid")
})

test("Model.openUrl: deployment joins the relative deployment_url; hostile values yield empty (SR9)", () => {
  eq(M.openUrl("deployment", { url: "/project/p/environment/e/application/a/deployment/d" }, ORIGIN + "/"), ORIGIN + "/project/p/environment/e/application/a/deployment/d")
  for (const bad of ["javascript:alert(1)", "--app=https://evil", "file:///etc/passwd", "https://evil.example/x", "//evil.example/x", "project/x", "/javascript:alert(1)", "", null]) {
    eq(M.openUrl("deployment", { url: bad }, ORIGIN), "", "rejects " + bad)
  }
  eq(M.openUrl("deployment", { url: "/x" }, "ftp://x"), "", "origin must be http(s)")
  eq(M.openUrl("deployment", { url: "/x" }, "https://ops.example.com/coolify/"), "https://ops.example.com/coolify/x", "a path prefix is kept")
  eq(M.openUrl("deployment", { url: "/x" }, "https://app.coolify.io/?x=1"), "", "no query in the origin")
  eq(M.openUrl("deployment", { url: "/x" }, "https://app.coolify.io/#f"), "", "no fragment in the origin")
})

test("Model.openUrl: resource shape from topology, server shape, missing parts yield empty (SR9)", () => {
  const s = loadedSnap()
  const app = s.resources.find(r => r.uuid === APP)
  eq(M.openUrl("resource", app, ORIGIN), ORIGIN + "/project/iwo4oo0cw0kc8s4g8s0og88c/environment/vokooc88s8cssgow0ww44ssw/application/" + APP)
  eq(M.openUrl("resource", { uuid: "u", kind: "service", projectUuid: "p", environmentUuid: "e" }, ORIGIN), ORIGIN + "/project/p/environment/e/service/u")
  eq(M.openUrl("resource", { uuid: "u", kind: "database", projectUuid: "p", environmentUuid: "e" }, ORIGIN), ORIGIN + "/project/p/environment/e/database/u")
  eq(M.openUrl("resource", { uuid: "u", kind: "unknown", projectUuid: "p", environmentUuid: "e" }, ORIGIN), "")
  eq(M.openUrl("resource", { uuid: "u", kind: "application", projectUuid: "p", environmentUuid: null }, ORIGIN), "")
  eq(M.openUrl("resource", { uuid: "u/x", kind: "application", projectUuid: "p q", environmentUuid: "e" }, ORIGIN), ORIGIN + "/project/p%20q/environment/e/application/u%2Fx")
  eq(M.openUrl("server", { uuid: SRV }, ORIGIN + "///"), ORIGIN + "/server/" + SRV)
  eq(M.openUrl("server", { uuid: "" }, ORIGIN), "")
  eq(M.openUrl("resource", app, ""), "", "no origin, no url")
})

test("Model.actionsFor: the applicability table; Open only with a url", () => {
  const ids = r => M.actionsFor(r).map(a => a.id).join(",")
  eq(ids({ type: "resource", kind: "application", state: "running", url: "u" }), "redeploy,rebuild,restart,stop,logs,history,open")
  eq(ids({ type: "resource", kind: "application", state: "exited", url: "u" }), "deploy,start,history,open")
  const vis = M.actionsFor({ type: "resource", kind: "application", state: "running", url: "u" }).filter(a => a.button).map(a => a.id).join(",")
  eq(vis, "redeploy,restart,stop,logs,history,open", "rebuild is keyboard-only")
  assert(M.actionsFor({ type: "resource", kind: "application", state: "running" }).find(a => a.id === "rebuild").confirm === true)
  assert(M.actionsFor({ type: "resource", kind: "application", state: "running" }).find(a => a.id === "redeploy").confirm === false)
  eq(ids({ type: "resource", kind: "service", state: "restarting", url: "u" }), "restart,stop,logs,open")
  eq(ids({ type: "resource", kind: "database", state: "paused", url: "u" }), "start,open")
  eq(ids({ type: "resource", kind: "application", state: "unknown", url: "u" }), "history,open")
  eq(ids({ type: "resource", kind: "application", state: "unknown", url: "" }), "history")
  eq(ids({ type: "server", url: "u" }), "validate,open")
  eq(ids({ type: "deployment", status: "queued", url: "u" }), "logs,cancel,open")
  eq(ids({ type: "deployment", status: "in_progress", url: "" }), "logs,cancel")
  eq(ids({ type: "deployment", status: "finished", url: "u" }), "logs,dismiss,open")
  eq(ids({ type: "fold" }), ""); eq(ids(null), "")
  const stop = M.actionsFor({ type: "resource", kind: "application", state: "running" }).find(a => a.id === "stop")
  assert(stop.destructive && stop.confirm, "stop confirms")
  assert(M.actionsFor({ type: "resource", kind: "application", state: "exited" }).find(a => a.id === "deploy").confirm === false)
})

test("Model.actionFor: s resolves to stop or start; d/deploy to deploy or redeploy; D to rebuild; unknown verb null", () => {
  eq(M.actionFor({ type: "resource", kind: "application", state: "running" }, "d").id, "redeploy")
  eq(M.actionFor({ type: "resource", kind: "application", state: "running" }, "deploy").id, "redeploy")
  eq(M.actionFor({ type: "resource", kind: "application", state: "exited" }, "d").id, "deploy")
  eq(M.actionFor({ type: "resource", kind: "application", state: "exited" }, "deploy").id, "deploy")
  eq(M.actionFor({ type: "resource", kind: "application", state: "exited" }, "D"), null, "no rebuild on a stopped app")
  eq(M.actionFor({ type: "resource", kind: "application", state: "running" }, "s").id, "stop")
  eq(M.actionFor({ type: "resource", kind: "service", state: "exited" }, "s").id, "start")
  eq(M.actionFor({ type: "resource", kind: "application", state: "running" }, "D").id, "rebuild")
  eq(M.actionFor({ type: "resource", kind: "service", state: "running" }, "D"), null)
  eq(M.actionFor({ type: "resource", kind: "application", state: "running" }, "bogus"), null)
  eq(M.actionFor({ type: "server" }, "validate").id, "validate")
})

test("Model.actionRequest: the single gate — invalid, unknown, not applicable, and the ok shape (SR3)", () => {
  const s = actSnap()
  eq(M.actionRequest(s, "stop", "../x").why, "invalid")
  eq(M.actionRequest(s, "stop", "%2e%2e").why, "invalid")
  eq(M.actionRequest(s, "stop", "").why, "invalid")
  eq(M.actionRequest(s, "stop", "deadbeefdeadbeefdeadbeef").why, "unknown")
  eq(M.actionRequest(s, "deploy", SVC_RUNNING).why, "notapplicable", "deploy on a service")
  eq(M.actionRequest(s, "start", APP).why, "notapplicable", "start on a running app")
  eq(M.actionRequest(s, "stop", SVC_EXITED).why, "notapplicable", "stop on an exited service")
  eq(M.actionRequest(s, "open", APP).why, "nav", "open never reaches the service")
  eq(M.actionRequest(s, "cancel", APP).why, "notapplicable")
  const a = M.actionRequest(s, "stop", APP)
  assert(a.ok); eq(a.targetType, "resource"); eq(a.kind, "application"); eq(a.confirm, true); eq(a.verb, "stop"); eq(a.status, "running:healthy")
  assert(a.name.indexOf("storefront") === 0)
  const d = s.deployments[0]
  const c = M.actionRequest(s, "cancel", d.uuid)
  assert(c.ok); eq(c.targetType, "deployment"); eq(c.kind, null); eq(c.confirm, true)
  const fin = actSnap({ deployments: [Object.assign({}, d, { status: "finished" })] })
  eq(M.actionRequest(fin, "cancel", d.uuid).why, "notapplicable", "finished deployment cannot be cancelled")
  const v = M.actionRequest(s, "validate", SRV)
  assert(v.ok); eq(v.targetType, "server"); eq(v.confirm, false)
  eq(M.actionRequest(s, "s", APP).verb, "stop", "s resolves through actionFor")
  eq(M.actionRequest(s, "restart", SVC_RUNNING).kind, "service")
})

test("Model.canAct: pending and inflight dedupe by uuid; inflight or 1 s spacing is busy (SR6)", () => {
  const now = NOW
  eq(M.canAct({ u1: { verb: "stop" } }, null, "u1", now, 0), "already pending")
  eq(M.canAct({}, { uuid: "u1" }, "u1", now, now - 5000), "already pending")
  eq(M.canAct({}, { uuid: "u2" }, "u1", now, now - 5000), "busy")
  eq(M.canAct({}, null, "u1", now, now - 200), "busy")
  eq(M.canAct({}, null, "u1", now, now - 1500), "")
  eq(M.canAct({}, null, "u1", now, 0), "")
  eq(M.canAct({ constructor: 1 }, null, "toString", now, 0), "", "prototype keys are not pending")
})

test("Model.confirmCopy: three verbs; every label fits the cell (SR8)", () => {
  eq(M.confirmCopy("stop", "api").message, "Stop api?")
  eq(M.confirmCopy("rebuild", "api").message, "Rebuild api without cache?")
  const c = M.confirmCopy("cancel", "api")
  eq(c.message, "Cancel the deployment of api?"); eq(c.cancelText, "Keep it"); eq(c.confirmText, "Cancel it")
  for (const v of ["stop", "rebuild", "cancel"]) {
    const x = M.confirmCopy(v, "api")
    assert(x.cancelText.length <= 9 && x.confirmText.length <= 9, v + " labels fit")
  }
})

test("Model.pendingVerb / gerund: seven verbs with and without stale", () => {
  const want = { deploy: "deploying", redeploy: "redeploying", rebuild: "rebuilding", restart: "restarting", stop: "stopping", start: "starting", validate: "validating", cancel: "cancelling" }
  for (const v in want) {
    eq(M.gerund(v), want[v])
    eq(M.pendingVerb(v, false), want[v] + "…")
    eq(M.pendingVerb(v, true), want[v] + "… · still pending")
  }
})

test("Model.withPending: resource replaces statusWords; deployment and server append to sub; rowRev and sameRows notice (SR7)", () => {
  const s = actSnap()
  const app = rowOf(s, APP), srv = rowOf(s, SRV), dep = rowOf(s, s.deployments[0].uuid)
  const pa = M.withPending(app, { verb: "stop", stale: false })
  eq(pa.statusWords, "stopping…"); eq(pa.tone, "accent"); eq(pa.dot, M.G.half); eq(pa.pendingVerb, "stopping…")
  eq(app.statusWords, "healthy", "original row untouched")
  const ps = M.withPending(srv, { verb: "validate", stale: true })
  assert(ps.sub.indexOf(srv.sub) === 0 && ps.sub.endsWith(" · validating… · still pending"), ps.sub)
  const pd = M.withPending(dep, { verb: "cancel" })
  assert(pd.sub.indexOf(dep.sub) === 0 && pd.sub.endsWith(" · cancelling…"), pd.sub)
  assert(M.rowRev(pa) !== M.rowRev(app)); assert(!M.sameRows([app], [pa]))
  eq(M.withPending(app, null), app)
  const pending = {}; pending[APP] = { verb: "stop" }
  const rows = M.panelRows(s, { pending })
  eq(rows.find(r => r.uuid === APP).statusWords, "stopping…", "panelRows applies ui.pending")
  eq(rows.find(r => r.uuid === SRV).pendingVerb, "", "others untouched")
})

test("Model.actionOutcome: every fixture maps to its exact line and tone (SR4, SR10)", () => {
  const o = (verb, tt, code, name, exit) => M.actionOutcome(verb, tt, rec(code, name ? fixture(name) : "", exit))
  let r = o("deploy", "resource", 200, "action-deploy-ok.json")
  assert(r.ok); eq(r.text, "Deployment queued"); eq(r.tone, "dim"); eq(r.deploymentUuid, "n3wd3pl0ym3ntuu1dxk2q9pr"); eq(r.error, null)
  r = o("redeploy", "resource", 200, "action-deploy-ok.json"); eq(r.text, "Redeploy queued")
  r = o("rebuild", "resource", 200, "action-deploy-ok.json"); eq(r.text, "Rebuild queued")
  r = o("deploy", "resource", 200, "action-deploy-queue-full.json")
  assert(!r.ok); eq(r.text, "Coolify's build queue is full"); eq(r.tone, "urgent"); eq(r.deploymentUuid, null); assert(r.error && r.error.kind !== "ratelimited", "never pauses the instance")
  r = o("stop", "resource", 200, "action-stop-ok.json"); assert(r.ok); eq(r.text, "Stop requested"); eq(r.deploymentUuid, null)
  r = o("start", "resource", 200, "action-stop-ok.json"); eq(r.text, "Start requested")
  r = o("restart", "resource", 200, "action-restart-ok.json"); eq(r.text, "Restart queued"); eq(r.deploymentUuid, fx("action-restart-ok.json").deployment_uuid); assert(r.deploymentUuid, "recorded body carries a deployment uuid")
  r = o("restart", "resource", 200, "action-service-restart-ok.json"); eq(r.text, "Restart requested"); eq(r.deploymentUuid, null)
  r = o("cancel", "deployment", 200, "action-cancel-ok.json"); assert(r.ok); eq(r.text, "Deployment cancelled")
  r = o("cancel", "deployment", 400, "action-cancel-400.json"); assert(!r.ok); eq(r.text, "Coolify said: Deployment cannot be cancelled. Current status: finished"); eq(r.tone, "urgent")
  r = o("validate", "server", 201, "action-validate-201.json"); assert(r.ok); eq(r.text, "Validation started")
})

test("Model.actionOutcome: abilities, auth, rate limit, transport, 404, redaction (SR4, SR10)", () => {
  const o = (verb, tt, code, body, exit) => M.actionOutcome(verb, tt, rec(code, body, exit))
  let r = o("deploy", "resource", 403, fixture("error-403-ability.json"))
  eq(r.text, "Token lacks the deploy permission"); eq(r.error.kind, "ability"); eq(r.tone, "urgent")
  r = o("validate", "server", 403, '{"message":"Missing required permissions: write"}'); eq(r.text, "Token lacks the write permission")
  r = o("stop", "resource", 403, '{"message":"You do not have permission to do this."}'); eq(r.text, "Coolify said: You do not have permission to do this.")
  r = o("stop", "resource", 403, fixture("error-403-api-disabled.json")); eq(r.text, "Coolify's API is disabled on this instance")
  r = o("stop", "resource", 403, '{"message":"IP address not allowed."}'); eq(r.text, "This IP is not allowed by the token")
  r = o("stop", "resource", 401, fixture("error-401.json")); eq(r.text, "Token rejected"); eq(r.error.kind, "auth")
  r = o("stop", "resource", 429, fixture("error-429.json")); eq(r.error.kind, "ratelimited"); assert(/^Rate limited · try again in \d+s$/.test(r.text), r.text)
  r = o("stop", "resource", 0, "", 7); eq(r.text, "Coolify is unreachable"); eq(r.error.kind, "offline")
  r = o("stop", "resource", 0, "", 63); eq(r.text, "Coolify's response was too large")
  r = M.actionOutcome("stop", "resource", { exit: 1, code: 0, body: "", timeMs: 0, bytes: 0, errmsg: "", headers: { retryAfter: null, rateLimitRemaining: null, rateLimitLimit: null } })
  eq(r.text, "Coolify returned nothing (curl 1)"); assert(!r.ok)
  eq(o("stop", "resource", 404, '{"message":"Resource not found."}').text, "Coolify no longer has that resource")
  eq(o("cancel", "deployment", 404, '{"message":"Deployment not found."}').text, "Coolify no longer has that deployment")
  eq(o("validate", "server", 404, "").text, "Coolify no longer has that server")
  eq(o("stop", "resource", 500, "").text, "Coolify returned 500")
  const tok = "Bearer " + "x".repeat(43) + " 67|" + "a".repeat(30)
  r = o("stop", "resource", 500, JSON.stringify({ message: "boom " + tok + " " + "y".repeat(200) }))
  assert(r.text.indexOf("Coolify said: ") === 0); assert(r.text.indexOf("x".repeat(43)) < 0 && r.text.indexOf("a".repeat(30)) < 0, "redacted"); assert(r.text.length <= "Coolify said: ".length + 111, "elided")
  eq(M.actionOutcome("stop", "resource", null).ok, false)
})

test("Model.panelRows with expandedKey: the actions row follows its parent, is not selectable, vanishes with it, survives the empty-resources path", () => {
  const s = actSnap()
  const rows = M.panelRows(s, { expandedKey: "res:" + APP })
  const i = M.indexOfKey(rows, "res:" + APP)
  eq(rows[i + 1].type, "actions"); eq(rows[i + 1].key, "act:res:" + APP); eq(rows[i + 1].parentKey, "res:" + APP); eq(rows[i + 1].uuid, APP)
  eq(rows[i + 1].actions.map(a => a.id).join(","), "redeploy,restart,stop,more", "six buttons fold behind More")
  eq(rows[i + 1].primary.map(a => a.id).join(","), "redeploy,restart,stop,more"); eq(rows[i + 1].secondary.length, 0)
  const open = M.panelRows(s, { expandedKey: "res:" + APP, moreOpen: true })
  eq(open[i + 1].actions.map(a => a.id).join(","), "redeploy,restart,stop,more,logs,history,open", "More open: the secondaries follow in h/l order")
  eq(open[i + 1].primary.map(a => a.label).join(","), "Redeploy,Restart,Stop,Less"); eq(open[i + 1].secondary.map(a => a.id).join(","), "logs,history,open")
  assert(!M.sameRows(rows, open), "rowRev notices More opening")
  eq(rows[i + 1].targetType, "resource"); assert(rows[i + 1].name.length > 0)
  assert(M.nextSelectable(rows, i, 1) !== i + 1, "actions row is skipped by j")
  assert(M.nextSelectable(rows, i + 2, -1) !== i + 1, "and by k")
  eq(M.panelRows(s, { expandedKey: "res:nope" }).filter(r => r.type === "actions").length, 0)
  eq(M.panelRows(s, {}).filter(r => r.type === "actions").length, 0)
  const empty = actSnap({ resources: [], tree: [], byServer: {} })
  const er = M.panelRows(empty, { expandedKey: "srv:" + SRV })
  const j = M.indexOfKey(er, "srv:" + SRV)
  eq(er[j + 1].type, "actions", "early-return path splices too"); eq(er[j + 1].actions.map(a => a.id).join(","), "validate,open")
  const a1 = M.panelRows(s, { expandedKey: "res:" + APP }), a2 = M.panelRows(s, { expandedKey: "res:" + APP })
  assert(M.sameRows(a1, a2))
  const exited = actSnap({ resources: s.resources.map(r => r.uuid === APP ? Object.assign({}, r, { state: "exited", status: "exited", health: "unknown" }) : r) })
  const b = M.panelRows(exited, { expandedKey: "res:" + APP })
  assert(!M.sameRows(a1, b), "rowRev changes when the action id list changes")
  const noUrl = actSnap({ instance: Object.assign({}, s.instance, { url: "" }) })
  const c = M.panelRows(noUrl, { expandedKey: "res:" + APP })
  eq(c[M.indexOfKey(c, "res:" + APP) + 1].actions.map(a => a.id).join(","), "redeploy,restart,stop,more", "no Open without a url: still five, still folded")
  eq(M.panelRows(noUrl, { expandedKey: "res:" + APP, moreOpen: true })[M.indexOfKey(c, "res:" + APP) + 1].secondary.map(a => a.id).join(","), "logs,history")
  assert(!M.sameRows(a1, c), "url presence is in rowRev")
})

test("Model.stripFor: four or fewer buttons never fold; only a mix of primary and secondary folds; More/Less label; primary flags", () => {
  const ids = st => st.actions.map(a => a.id).join(",")
  const app = { type: "resource", kind: "application", state: "running", url: "u" }
  eq(ids(M.stripFor(app, false)), "redeploy,restart,stop,more"); eq(ids(M.stripFor(app, true)), "redeploy,restart,stop,more,logs,history,open")
  eq(M.stripFor(app, false).actions[3].label, "More"); eq(M.stripFor(app, true).actions[3].label, "Less")
  assert(!M.stripFor(app, false).actions[3].confirm && !M.stripFor(app, false).actions[3].destructive)
  const stopped = { type: "resource", kind: "application", state: "exited", url: "u" }
  eq(ids(M.stripFor(stopped, false)), "deploy,start,history,open", "four fit on one line: no More"); eq(M.stripFor(stopped, true).secondary.length, 0)
  eq(ids(M.stripFor({ type: "resource", kind: "service", state: "running", url: "u" }, false)), "restart,stop,logs,open")
  eq(ids(M.stripFor({ type: "deployment", status: "queued", url: "u" }, false)), "logs,cancel,open")
  eq(ids(M.stripFor({ type: "server", url: "u" }, false)), "validate,open")
  eq(ids(M.stripFor({ type: "fold" }, false)), "")
  const prim = M.actionsFor(app).filter(a => a.primary).map(a => a.id).join(",")
  eq(prim, "redeploy,restart,stop", "rebuild is keyboard-only and never primary; logs/history/open are secondary")
  eq(M.actionsFor(stopped).filter(a => a.primary).map(a => a.id).join(","), "deploy,start")
  eq(M.actionFor(app, "more"), null, "more is a panel toggle, never a verb")
  eq(M.actionFor(app, "logs").id, "logs", "text keys still reach a folded secondary")
})

test("Model.listPatch: keyed in-place edits reproduce next; set only on a rev change; reorder, duplicate and empty cases; coalesced ops", () => {
  const R = (k, v) => ({ type: "resource", key: k, name: v || k })
  function apply(prev, ops) {
    const cur = prev.slice()
    for (const o of ops) {
      if (o.op === "remove") cur.splice(o.i, o.n)
      else if (o.op === "insert") cur.splice(o.i, 0, ...o.rows)
      else if (o.op === "set") cur[o.i] = o.row
      else throw new Error("bad op " + o.op)
      assert(o.i >= 0 && o.i <= cur.length, "index in range at application time")
    }
    return cur
  }
  const same = (a, b) => a.length === b.length && a.every((r, i) => r.key === b[i].key && M.rowRev(r) === M.rowRev(b[i]))
  const a = [R("a"), R("b"), R("c"), R("d")]
  eq(M.listPatch(a, a).length, 0, "identical: no ops")
  eq(M.listPatch([], []).length, 0)
  let ops = M.listPatch(a, [R("a"), R("b"), R("act:b"), R("c"), R("d")])
  eq(JSON.stringify(ops.map(o => [o.op, o.i, o.n || o.rows.length])), '[["insert",2,1]]', "expand: one insert, nothing else touched")
  ops = M.listPatch([R("a"), R("b"), R("act:b"), R("c"), R("d")], a)
  eq(JSON.stringify(ops.map(o => [o.op, o.i, o.n])), '[["remove",2,1]]', "collapse: one remove")
  ops = M.listPatch(a, [R("a"), R("b", "B2"), R("c"), R("d")])
  eq(JSON.stringify(ops.map(o => [o.op, o.i])), '[["set",1]]', "a rev change is a set in place")
  ops = M.listPatch(a, [])
  eq(JSON.stringify(ops), '[{"op":"remove","i":0,"n":4}]', "consecutive removes coalesce")
  ops = M.listPatch([], a)
  eq(ops.length, 1); eq(ops[0].op, "insert"); eq(ops[0].rows.length, 4, "consecutive inserts coalesce")
  for (const [prev, next] of [
    [a, [R("d"), R("c"), R("b"), R("a")]],
    [a, [R("x"), R("b"), R("y"), R("d"), R("z")]],
    [[R("a"), R("a"), R("b")], [R("a"), R("b")]],
    [[R("a"), R("b")], [R("b"), R("a"), R("a")]],
    [a, [R("c")]], [[R("c")], a],
  ]) assert(same(apply(prev, M.listPatch(prev, next)), next), "reproduces " + next.map(r => r.key).join(","))
  // Random churn: every patch reproduces its target and never indexes out of range.
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
  const keys = ["a", "b", "c", "d", "e", "f", "g", "h"]
  for (let t = 0; t < 300; t++) {
    const gen = () => keys.filter(() => rnd(3) > 0).sort(() => rnd(3) - 1).map(k => R(k, rnd(2) ? k : k + "!"))
    const prev = gen(), next = gen()
    assert(same(apply(prev, M.listPatch(prev, next)), next), "random " + t)
  }
})

test("Model.deploymentRow / resourceRow: names pass appLabel (Phase 4b item 1)", () => {
  const o = "https://app.coolify.io"
  eq(M.deploymentRow({ uuid: "d1", status: "finished", appName: "storefront:main-h0wxyg40kc0lz727dom9l03i" }, o).name, "storefront")
  eq(M.deploymentRow({ uuid: "deadbeefdeadbeefdeadbeef", status: "finished", appName: "" }, o).name, "deadbeef", "no app name: uuid8")
  eq(M.resourceRow({ uuid: "xyhpwdxqu33omjgwuo6c7cjp", name: "xyhpwdxqu33omjgwuo6c7cjp-200537415987", kind: "application", state: "running", status: "running:healthy" }, 0, o).name, "xyhpwdxq")
  eq(M.resourceRow({ uuid: "u2", name: "Storefront Prod WP", kind: "service", state: "exited", status: "exited" }, 0, o).name, "Storefront Prod WP", "plain names untouched")
})

test("Model.dismissRecent: clears the row and everything older, keeps newer, same array back when nothing changes; survives the file round trip (Phase 4b)", () => {
  const rec = [{ uuid: "aaaa", status: "finished", finishedAt: new Date(NOW - 5000).toISOString() }, { uuid: "bbbb", status: "failed", finishedAt: new Date(NOW - 9000).toISOString() }]
  const out = M.dismissRecent(rec, "bbbb")
  assert(out !== rec); eq(out[1].dismissed, true); eq(out[0].dismissed, undefined, "newer entries untouched"); eq(rec[1].dismissed, undefined, "input untouched")
  assert(M.dismissRecent(rec, "zzzz") === rec, "unknown uuid: same array"); assert(M.dismissRecent(out, "bbbb") === out, "already dismissed: same array")
  const all = M.dismissRecent(rec, "aaaa")
  eq(all.map(d => !!d.dismissed).join(","), "true,true", "dismissing the newest clears everything older: an acknowledge, not a promotion")
  const three = [{ uuid: "n", status: "finished" }, { uuid: "m", status: "failed" }, { uuid: "o", status: "finished", dismissed: true }]
  eq(M.dismissRecent(three, "m").map(d => !!d.dismissed).join(","), "false,true,true")
  assert(M.dismissRecent(three, "o") === three, "the oldest already dismissed: nothing to do")
  assert(M.hasTerminal(out, "bbbb"), "dedupe still sees it")
  const KEY = "https://app.coolify.io"
  const text = M.serialiseRecent(out, KEY, NOW).text
  assert(JSON.parse(text).recent[1].dismissed === true && JSON.parse(text).recent[0].dismissed === false, "the flag is a whitelisted bool in the file")
  const back = M.parseRecent(text, KEY, NOW).recent
  eq(back[1].dismissed, true); eq(back[0].dismissed, false)
  assert(M.serialiseRecent(out, KEY, NOW).key !== M.serialiseRecent(rec, KEY, NOW).key, "the unchanged-write guard sees a dismiss")
  const week = M.parseRecent(JSON.stringify({ version: 1, instance: KEY, recent: [{ uuid: "cccc", status: "finished", finishedAt: new Date(NOW - 6 * 24 * 3600 * 1000).toISOString() }] }), KEY, NOW)
  eq(week.recent.length, 1, "six days old is kept (seven-day file window)")
  eq(M.actionRequest({ deployments: [], resources: [], servers: [] }, "dismiss", "aaaa").why, "nav", "dismiss never reaches act()")
  eq(M.actionFor({ type: "deployment", status: "in_progress" }, "dismiss"), null, "no Dismiss on an active build")
  eq(M.actionFor({ type: "deployment", status: "failed" }, "dismiss").id, "dismiss")
  eq(M.actionFor({ type: "deployment", status: "failed" }, "cancel"), null)
})

test("Model.parseUi / serialiseUi / uiSet / uiFor: round trip, defaults, rejection, prune, cap, tags fold, re-pointed origin, unchanged guard (Phase 4b)", () => {
  const O = "https://app.coolify.io"
  const ids = ["cloud", "home-lab_2"]
  let ui = M.uiSet({}, "cloud", O, { groupBy: "server" })
  ui = M.uiSet(ui, "cloud", O, { folded: { "fold:p:abc123/production": true, "fold:tags": true, "fold:s:unassigned": true, "fold:s:srv1": false, "nope": true, "fold:p:x/": true } })
  ui = M.uiSet(ui, "home-lab_2", "https://h.example", { folded: { "fold:s:srv9": true } })
  eq(M.uiFor(ui, "cloud", O).groupBy, "server")
  eq(Object.keys(M.uiFor(ui, "cloud", O).folded).sort().join(","), "fold:p:abc123/production,fold:p:x/,fold:s:unassigned,fold:tags", "false and malformed keys dropped; an empty environment name is a legal key")
  eq(M.uiFor(ui, "home-lab_2", "https://h.example").groupBy, "project", "grouping defaults per instance")
  eq(Object.keys(M.uiFor(ui, "cloud", "https://other").folded).length, 0, "a re-pointed id drops its folds")
  eq(M.uiFor(ui, "cloud", "https://other").groupBy, "server", "and keeps its grouping")
  eq(M.uiFor(ui, "ghost", O).groupBy, "project"); eq(Object.keys(M.uiFor(null, "cloud", O).folded).length, 0)
  assert(M.uiSet(ui, "cloud", O, { groupBy: "server" }) === ui, "no change: same map back")
  assert(M.uiSet(ui, "cloud", O, { groupBy: "bogus" }) === ui, "unknown grouping refused")
  assert(M.uiSet(ui, "bad id!", O, { groupBy: "server" }) === ui, "bad instance id refused")
  assert(M.uiSet(ui, "cloud", O, { folded: { "fold:tags": true } }) !== ui, "a changed fold set is a new map")
  eq(M.uiSet(ui, "cloud", "https://other", { groupBy: "project" }).cloud.origin, "https://other", "a set on a new origin re-homes the entry")
  const s = M.serialiseUi(ui, ids, NOW), file = JSON.parse(s.text)
  eq(file.version, 1); eq(file.savedAt, NOW); eq(Object.keys(file.instances).join(","), "cloud,home-lab_2")
  eq(file.instances.cloud.folded.join(","), "fold:p:abc123/production,fold:p:x/,fold:s:unassigned,fold:tags", "sorted, true keys only")
  eq(M.serialiseUi(ui, ids, NOW + 1).key, s.key, "the key ignores savedAt")
  eq(Object.keys(JSON.parse(M.serialiseUi(ui, ["cloud"], NOW).text).instances).join(","), "cloud", "unconfigured ids are pruned")
  assert(s.text.endsWith("\n"), "trailing newline")
  const back = M.parseUi(s.text, ids)
  eq(back.loaded, true); eq(back.rejected, false)
  eq(M.uiFor(back.ui, "cloud", O).groupBy, "server", "round trip"); eq(Object.keys(M.uiFor(back.ui, "cloud", O).folded).sort().join(","), Object.keys(M.uiFor(ui, "cloud", O).folded).sort().join(","), "round trip")
  eq(M.serialiseUi(back.ui, ids, NOW).key, s.key, "round trip is key-stable")
  eq(Object.keys(M.parseUi(s.text, ["cloud"]).ui).join(","), "cloud", "the parse keeps configured ids only")
  for (const t of [null, "", undefined]) { const r = M.parseUi(t, ids); eq(r.loaded, false); eq(r.rejected, false); eq(Object.keys(r.ui).length, 0) }
  for (const t of ["{", "[]", "null", "\"x\"", JSON.stringify({ version: 2, instances: {} }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, instances: [] }), "x".repeat(70000)]) {
    const r = M.parseUi(t, ids); eq(r.rejected, true, "rejects " + t.slice(0, 20)); eq(r.loaded, false)
  }
  const loose = M.parseUi(JSON.stringify({ version: 1, instances: { cloud: { origin: O, groupBy: "bogus", folded: ["fold:tags", "fold:tags", 7, "fold:p:../x", "fold:s:a b", "fold:p:abc/\u0007bell"] }, "bad id": { groupBy: "server" }, other: 3 } }), ids)
  eq(loose.rejected, false); eq(loose.ui.cloud.groupBy, "project", "an unknown grouping falls back, the file survives")
  eq(Object.keys(loose.ui.cloud.folded).join(","), "fold:tags", "duplicates, non-strings and malformed keys dropped; a control char in an env name is refused")
  eq(Object.keys(loose.ui).join(","), "cloud")
  const many = {}; for (let i = 0; i < 600; i++) many["fold:s:u" + i] = true
  eq(JSON.parse(M.serialiseUi(M.uiSet({}, "cloud", O, { folded: many }), ["cloud"], NOW).text).instances.cloud.folded.length, 500, "fold cap on write")
  const big = JSON.stringify({ version: 1, instances: { cloud: { origin: O, groupBy: "project", folded: Object.keys(many) } } })
  eq(Object.keys(M.parseUi(big, ids).ui.cloud.folded).length, 500, "fold cap on read")
  // The tags fold's flag means "opened" (panelRows); the file carries the flag, not the meaning.
  const rows = M.panelRows(snap({ tags: ["a"] }), { groupBy: "project", folded: M.uiFor(back.ui, "cloud", O).folded, nowMs: NOW })
  const tagRow = rows.filter(r => r.key === "fold:tags")[0]
  assert(tagRow && tagRow.open === true, "a persisted fold:tags flag reopens the tags fold")
})

test("Model.nextAction: clamps; h from the first returns to the row; a vanished id counts as the first", () => {
  const acts = [{ id: "deploy" }, { id: "start" }, { id: "open" }]
  eq(M.nextAction(acts, "deploy", 1), "start"); eq(M.nextAction(acts, "open", 1), "open")
  eq(M.nextAction(acts, "start", -1), "deploy"); eq(M.nextAction(acts, "deploy", -1), "")
  eq(M.nextAction(acts, "stop", 1), "start"); eq(M.nextAction(acts, "stop", -1), "")
  eq(M.nextAction([], "x", 1), "")
})

test("Model.GLYPHS: the pending dot and every glyph a pending row can emit are in the allowlist", () => {
  const s = actSnap()
  const pending = {}; pending[APP] = { verb: "stop" }; pending[SRV] = { verb: "validate", stale: true }
  for (const r of M.panelRows(s, { pending })) {
    for (const g of [r.dot, r.glyph]) if (g) assert(M.GLYPHS.indexOf(g) >= 0, "glyph " + g + " in allowlist")
  }
  assert(M.GLYPHS.indexOf(M.G.half) >= 0)
})

test("Model.footerHints: every cursor position; no o open without a url", () => {
  eq(M.footerHints("hero", null), "enter refresh · j down · r refresh · e config · esc close")
  eq(M.footerHints("hero", null, { instances: 1 }), "enter refresh · j down · r refresh · e config · esc close")
  eq(M.footerHints("hero", null, { instances: 2 }), "h/l instance · enter refresh · j down · r refresh · e config · esc close")   // Phase 4 chips
  eq(M.footerHints("list", { type: "fold" }), "j/k move · enter fold · g group · / filter · r refresh · esc close")
  eq(M.footerHints("list", { type: "resource", kind: "application", state: "running", url: "u" }), "enter actions · d redeploy · s stop · t restart · L logs · o open")
  eq(M.footerHints("list", { type: "resource", kind: "application", state: "exited", url: "u" }), "enter actions · d deploy · s start · o open")
  eq(M.footerHints("list", { type: "resource", kind: "service", state: "running", url: "u" }), "enter actions · s stop · t restart · L logs · o open")
  eq(M.footerHints("list", { type: "resource", kind: "database", state: "exited", url: "u" }), "enter actions · s start · o open")
  eq(M.footerHints("list", { type: "resource", kind: "application", state: "running", url: "" }), "enter actions · d redeploy · s stop · t restart · L logs")
  eq(M.footerHints("list", { type: "resource", kind: "application", state: "running", url: "u" }, { expanded: true, actionFocus: "stop" }), "h/l pick · enter run · esc collapse")
  eq(M.footerHints("list", { type: "resource", kind: "application", state: "running", url: "u" }, { expanded: true, actionFocus: "" }), "l pick · enter collapse · esc collapse")
  eq(M.footerHints("list", { type: "server", url: "u" }), "enter actions · v validate · o open")
  eq(M.footerHints("list", { type: "deployment", status: "in_progress", url: "u" }), "enter actions · x cancel · L logs · o open")
  eq(M.footerHints("list", { type: "deployment", status: "finished", url: "u" }), "enter actions · x dismiss · L logs · o open")
  eq(M.footerHints("list", { type: "deployment", status: "finished", url: "" }), "enter actions · x dismiss · L logs")
  eq(M.footerHints("list", { type: "resource" }, { confirmOpen: true }), "h/l pick · enter confirm · esc cancel")
})

// ---- Phase 4 depth: descriptors (SR28, SR36) ------------------------------------------------

test("Api.reqContainerLog: one path per group, constant lines, sub name through seg, hostile kinds refused (SR28)", () => {
  eq(A.CONTAINER_LINES, 200)
  eq(A.reqContainerLog("application", "u1").path, "/applications/u1/logs?lines=200&show_timestamps=false")
  eq(A.reqContainerLog("database", "u1").path, "/databases/u1/logs?lines=200&show_timestamps=false")
  eq(A.reqContainerLog("service", "u1", "wordpress").path, "/services/u1/logs?lines=200&show_timestamps=false&sub_service_name=wordpress")
  eq(A.reqContainerLog("service", "u1", "a b&c=d#e/../f\"\n,é").path,
     "/services/u1/logs?lines=200&show_timestamps=false&sub_service_name=a%20b%26c%3Dd%23e%2F..%2Ff%22%0A%2C%C3%A9")
  for (const k of ["server", "hasOwnProperty", "constructor", "", null]) eq(A.reqContainerLog(k, "u1"), null, "refused kind " + k)
  eq(A.reqContainerLog("application", "u1").kind, "containerlog")
})

test("Api.reqHistory: constant take, skip clamped to a non-negative integer (SR28)", () => {
  eq(A.HISTORY_TAKE, 10)
  eq(A.reqHistory("u1", 0).path, "/deployments/applications/u1?skip=0&take=10")
  eq(A.reqHistory("u1", 10).path, "/deployments/applications/u1?skip=10&take=10")
  eq(A.reqHistory("u1", -5).path, "/deployments/applications/u1?skip=0&take=10")
  eq(A.reqHistory("u1", NaN).path, "/deployments/applications/u1?skip=0&take=10")
  eq(A.reqHistory("u1", "7.9").path, "/deployments/applications/u1?skip=7&take=10")
  eq(A.reqHistory("u1", 0).maxBytes, A.MAX_FILESIZE_LOG, "history pages carry every row's log")
  eq(A.reqBuildLog("u1").maxBytes, A.MAX_FILESIZE_LOG)
  eq(A.reqBuildLog("u1").kind, "buildlog")
  eq(A.reqTags().path, "/tags")
  eq(A.reqService("u1").path, "/services/u1")
})

test("Api.reqDeployTag: one tag per request through seg, same block shape as reqDeploy, no body field (SR28, SR35)", () => {
  const t = A.reqDeployTag("a,b & c/../d\"\n")
  eq(t.path, "/deploy?tag=a%2Cb%20%26%20c%2F..%2Fd%22%0A")
  eq(t.kind, "action"); eq(t.verb, "deployTag"); eq(t.method, "POST")
  assert(!("body" in t), "no body field on a descriptor")
  const b = A.block(inst, TOK, t, 10), d = A.block(inst, TOK, A.reqDeploy("u1", false), 10)
  eq(b.replace(/url = "[^"]*"/, "URL"), d.replace(/url = "[^"]*"/, "URL"), "byte-identical apart from the url line")
  eq(count(b, 'data-raw = "{}"'), 1)
})

test("Api.block never emits insecure, -k or proto-default on any descriptor (SR36)", () => {
  const all = [A.reqVersion(), A.reqDeployments(), A.reqDeployment("u"), A.reqResources(), A.reqServers(), A.reqProjects(), A.reqProject("p"),
               A.reqServerResources("s"), A.reqBuildLog("u"), A.reqHistory("u", 0), A.reqContainerLog("application", "u"), A.reqService("u"), A.reqTags(),
               A.reqDeploy("u", true), A.reqLifecycle("application", "u", "stop"), A.reqCancel("u"), A.reqValidate("s"), A.reqDeployTag("t")]
  for (const r of all) {
    const b = A.block(inst, TOK, r, 10)
    assert(!/insecure|proto-default|\n-k\b/.test(b), "no verification bypass in " + r.kind)
    eq(count(b, 'proto = "=https,http"'), 1)
  }
})

// ---- Phase 4 depth: build log parsing (SR26, SR27) --------------------------------------------

const LOGF = fx("deployment-log-failed.json")
const LOGS = fx("deployment-log-finished.json")
// The fixture holds the parsed array under `entries`; Coolify's `logs` value is that array as JSON text.
const encode = entries => JSON.stringify(entries)

test("Model.parseBuildLog: entry 0 without order gets seq 1 and is kept; index is the identity (SR27)", () => {
  const r = M.parseBuildLog(encode(LOGF.entries))
  eq(r.entries.length, LOGF.entries.length); eq(r.dropped, 0); eq(r.truncated, false); eq(r.refused, false)
  eq(r.bytes, encode(LOGF.entries).length, "bytes is the raw string length")
  eq(r.entries[0].seq, 1); eq(r.entries[0].i, 0); eq(r.entries[1].seq, 2); eq(r.entries[1].i, 1)
  eq(r.entries[0].hidden, false); eq(r.entries[1].hidden, true); eq(r.entries[6].stream, "stderr"); eq(r.entries[0].command, null)
  assert(r.entries[6].command.startsWith("docker exec"), "command kept")
})

test("Model.parseBuildLog: double-encoded, malformed, non-array and non-object entries never throw (SR27)", () => {
  eq(M.parseBuildLog(JSON.stringify(encode(LOGF.entries))).entries.length, LOGF.entries.length, "a JSON string of the array parses twice")
  eq(M.parseBuildLog("[{\"command\":").entries.length, 0)
  eq(M.parseBuildLog("{\"a\":1}").entries.length, 0)
  eq(M.parseBuildLog("").entries.length, 0)
  eq(M.parseBuildLog(null).entries.length, 0)
  eq(M.parseBuildLog(42).entries.length, 0)
  const mixed = M.parseBuildLog(JSON.stringify([null, 1, "x", [1], { command: null, output: "ok", type: "stdout" }]))
  eq(mixed.entries.length, 1); eq(mixed.entries[0].i, 4); eq(mixed.entries[0].seq, 5)
})

test("Model.parseBuildLog: control characters stripped but newline and tab kept; caps on output and command (SR27)", () => {
  const r = M.parseBuildLog(JSON.stringify([{ command: "a bc", output: "xy\nz\tw", type: "stdout" }]))
  eq(r.entries[0].command, "abc"); eq(r.entries[0].output, "xy\nz\tw")
  const big = M.parseBuildLog(JSON.stringify([{ command: "c".repeat(5000), output: "o".repeat(9000), type: "stdout" }]))
  eq(big.entries[0].output.length, M.LOG_MAX_OUTPUT)
  eq(big.entries[0].command.length, M.LOG_MAX_COMMAND)
  assert(big.entries[0].command.indexOf("…") > 0, "middle-elided")
  eq(M.LOG_MAX_COMMAND, 320)
})

test("Model.parseBuildLog: 2001 entries keep the 2000 tail with dropped 1; a 3.5 MB string is refused, not parsed (SR27)", () => {
  const many = []; for (let i = 0; i < 2001; i++) many.push({ command: null, output: "line " + i, type: "stdout" })
  const r = M.parseBuildLog(JSON.stringify(many))
  eq(r.entries.length, 2000); eq(r.dropped, 1); eq(r.truncated, true); eq(r.refused, false)
  eq(r.entries[0].i, 1); eq(r.entries[0].output, "line 1"); eq(r.entries[1999].i, 2000)
  const huge = "x".repeat(3.5 * 1024 * 1024)
  const h = M.parseBuildLog(huge)
  eq(h.refused, true); eq(h.truncated, true); eq(h.entries.length, 0); eq(h.bytes, huge.length)
  eq(M.LOG_MAX_CHARS, 3145728)
})

test("Model.buildLogRev: digits and colons only, empty on no entries, changes on append/growth/drop, stable on re-parse (SR26)", () => {
  const r = M.parseBuildLog(encode(LOGF.entries))
  const rev = M.buildLogRev(r.entries, r.dropped)
  assert(/^[0-9:]+$/.test(rev), "rev is digits and colons: " + rev)
  eq(M.buildLogRev([], 0), "")
  eq(M.buildLogRev(M.parseBuildLog(encode(LOGF.entries)).entries, 0), rev, "same string, same rev")
  const more = LOGF.entries.concat([{ command: null, output: "one more", type: "stdout" }])
  assert(M.buildLogRev(M.parseBuildLog(encode(more)).entries, 0) !== rev, "append changes rev")
  const grown = LOGF.entries.map((e, i) => i === LOGF.entries.length - 1 ? Object.assign({}, e, { output: e.output + " and more" }) : e)
  assert(M.buildLogRev(M.parseBuildLog(encode(grown)).entries, 0) !== rev, "a longer last output changes rev")
  assert(M.buildLogRev(r.entries, 3) !== rev, "dropped changes rev")
})

test("Model.failingEntry: the hidden stderr command step on a failed build; null on a finished one (acceptance 1)", () => {
  const f = M.parseBuildLog(encode(LOGF.entries)).entries
  const e = M.failingEntry(f, "failed")
  assert(e, "found"); eq(e.i, 6); eq(e.hidden, true); eq(e.stream, "stderr")
  assert(e.command.endsWith("pull'"), "the un-elided tail names the failing verb: " + e.command.slice(-20))
  eq(M.failingEntry(M.parseBuildLog(encode(LOGS.entries)).entries, "finished"), null)
  eq(M.failingEntry(f, "finished"), null, "status gates it")
})

test("Model.buildLogLines: the failing command is rendered with showHidden false, one row per physical line, stderr alone never urgent (acceptance 1, SR27)", () => {
  const p = M.parseBuildLog(encode(LOGF.entries))
  const failing = M.failingEntry(p.entries, "failed")
  const lines = M.buildLogLines(p.entries, { showHidden: false, failing, uuid: "dep1" })
  const cmd = lines.filter(l => l.rowType === "line" && l.text.startsWith("$ "))
  eq(cmd.length, 1, "exactly the failing command is shown among hidden steps")
  assert(cmd[0].text.endsWith("pull'"), "tail kept: " + cmd[0].text.slice(-12)); eq(cmd[0].tone, "urgent")
  const mark = lines.findIndex(l => l.rowType === "note" && l.text === "── failure ──")
  assert(mark >= 0 && lines[mark + 1] === cmd[0], "marker precedes the failing command")
  const ref = lines.filter(l => /failed to resolve reference/.test(l.text))
  eq(ref.length, 1); eq(ref[0].tone, "urgent")
  eq(lines.filter(l => l.i === 6 && l.rowType === "line").length, 3, "command line + two output lines from the multi-line output")
  const summary = lines.filter(l => /^Deployment failed/.test(l.text))
  eq(summary.length, 2); eq(summary[0].tone, "urgent")
  assert(lines.every(l => l.hidden !== true || l.i === 6), "no other hidden entry rendered")
  assert(lines.every(l => !/^#[0-9] /.test(l.text)), "stack trace hidden by default")
  const all = M.buildLogLines(p.entries, { showHidden: true, failing, uuid: "dep1" })
  assert(all.length > lines.length && all.some(l => /^#0 /.test(l.text)), "H shows the hidden steps")
  eq(all.filter(l => l.hidden && l.i !== 6 && l.tone !== "dim").length, 0, "hidden steps are dim, never urgent")
  const fin = M.buildLogLines(M.parseBuildLog(encode(LOGS.entries)).entries, { showHidden: false, failing: null, uuid: "dep2" })
  eq(fin.filter(l => l.tone === "urgent").length, 0, "a successful build's stderr tail is not urgent")
  assert(fin.some(l => l.text.startsWith("$ docker compose")), "visible command steps render on a finished build")
  const keys = new Set(lines.map(l => l.key)); eq(keys.size, lines.length, "row keys unique")
})

test("Model.viewRow: every overlay row builder emits the same key set (ListModel roles)", () => {
  const want = M.VIEW_KEYS.slice().sort().join(",")
  const p = M.parseBuildLog(encode(LOGF.entries))
  const rows = M.buildLogLines(p.entries, { showHidden: true, failing: M.failingEntry(p.entries, "failed"), uuid: "d" })
  const hist = M.normaliseHistory(fx("history-page.json"))
  rows.push(M.historyRow(hist.rows[0], "app1", "https://app.coolify.io"))
  rows.push(M.moreRow({ appUuid: "app1", rows: hist.rows, count: hist.count, loading: false }, 10))
  rows.push(M.pickRow("svc1", "wordpress"))
  rows.push(M.noteRow("n", "Loading…"))
  for (const r of rows) eq(Object.keys(r).sort().join(","), want, "keys of a " + r.rowType + " row")
  for (const r of rows) eq(r.type, r.rowType, "type mirrors rowType so the cursor helpers see it")
  const list = [M.historyRow(hist.rows[0], "app1", ""), M.historyRow(hist.rows[1], "app1", ""), M.moreRow({ appUuid: "app1", rows: hist.rows, count: 39, loading: false }, 10)]
  eq(M.nextSelectable(list, 1, 1), 2, "j reaches the Show more row"); eq(list[2].type, "more")
  eq(M.nextSelectable([M.pickRow("s", "a"), M.pickRow("s", "b")], 0, 1), 1, "j reaches the second container")
  for (const r of rows) if (r.rowType === "line" || r.rowType === "note") assert(!M.SELECTABLE[r.type], "log lines and notes never take the cursor")
})

test("Model.parseContainerLog: split on newline, no trailing newline, empty and missing logs, cap and tail", () => {
  const text = fx("container-log.json").text
  const r = M.parseContainerLog({ logs: text })
  eq(r.lines.length, 3); eq(r.truncated, false); assert(r.lines[2].endsWith("4ms"))
  eq(M.parseContainerLog(JSON.stringify({ logs: text })).lines.length, 3, "a body string parses")
  eq(M.parseContainerLog({ logs: "" }).lines.length, 0)
  eq(M.parseContainerLog({}).lines.length, 0)
  eq(M.parseContainerLog(null).lines.length, 0)
  eq(M.parseContainerLog("not json").lines.length, 0)
  const big = M.parseContainerLog({ logs: "x\n".repeat(2100).slice(0, -1) })
  eq(big.lines.length, 2000); eq(big.truncated, true)
  eq(M.parseContainerLog({ logs: "a b[31mc" }).lines[0], "ab[31mc", "control bytes stripped")
})

test("Model.normaliseHistory: {count, rows} newest first, no logs key on any row; historyRow never renders HEAD (SR26)", () => {
  const h = M.normaliseHistory(fx("history-page.json"))
  eq(h.count, 39); eq(h.rows.length, 3)
  for (const r of h.rows) assert(!("logs" in r), "no logs on a normalised row")
  assert(Date.parse(h.rows[0].createdAt) >= Date.parse(h.rows[1].createdAt), "newest first")
  const row = M.historyRow(h.rows[0], "app1", "https://app.coolify.io")
  eq(row.type, "history"); eq(row.rowType, "history"); eq(row.key, "hist:" + h.rows[0].uuid); eq(row.appUuid, "app1")
  eq(row.sub, "deploy", "commit HEAD and no branch renders as deploy"); assert(!("age" in row) || row.age === null)
  eq(M.historyRow(Object.assign({}, h.rows[0], { restartOnly: true }), "app1", "").sub, "restart")
  eq(M.historyRow(Object.assign({}, h.rows[0], { branch: "main" }), "app1", "").sub, "main")
  eq(M.historyRow(Object.assign({}, h.rows[0], { branch: "HEAD" }), "app1", "").sub, "deploy")
  eq(M.normaliseHistory(fx("history-empty.json")).rows.length, 0); eq(M.normaliseHistory(fx("history-empty.json")).count, 39)
  eq(M.normaliseHistory(null).count, 0); eq(M.normaliseHistory({ count: -3, deployments: "x" }).count, 0)
  const more = M.moreRow({ appUuid: "app1", rows: h.rows, count: 39, loading: false }, 10)
  eq(more.text, "Show 10 more (3 of 39)"); eq(more.shown, 3); eq(more.total, 39)
  eq(M.moreRow({ appUuid: "app1", rows: h.rows, count: 3, loading: false }, 10), null, "nothing more at the end")
  eq(M.moreRow({ appUuid: "app1", rows: h.rows, count: 5, loading: false }, 10).text, "Show 2 more (3 of 5)")
  eq(M.moreRow({ appUuid: "app1", rows: h.rows, count: 39, loading: true }, 10).text, "Loading…")
})

test("Model.fetchOutcome: not-running, picker, history/buildlog 404, toolarge, 429, offline, ability; null on success (SR29)", () => {
  const rec = (code, body, exit) => ({ exit: exit || 0, code, body: body || "", errmsg: "", headers: null })
  eq(M.fetchOutcome("containerlog", rec(404, fixture("container-log-404.json")), "api").text, "api is not running.")
  eq(M.fetchOutcome("containerlog", rec(400, fixture("container-log-400.json")), "wp").text, "Pick a container.")
  eq(M.fetchOutcome("history", rec(404, fixture("history-404.json"))).text, "Coolify no longer has that application.")
  eq(M.fetchOutcome("buildlog", rec(404, "{\"message\":\"Deployment not found\"}")).text, "Coolify no longer has that deployment.")
  eq(M.fetchOutcome("buildlog", rec(0, "", 63)).text, "This build log is larger than 4 MB. Open it in Coolify.")
  eq(M.fetchOutcome("buildlog", rec(429, fixture("error-429.json"))).text, "Rate limited · backing off 30s.")
  eq(M.fetchOutcome("history", rec(0, "", 7)).text, "Offline · retrying.")
  eq(M.fetchOutcome("history", rec(403, fixture("error-403-ability.json"))).text, M.errorText(M.errorFor({ httpCode: 403, body: fixture("error-403-ability.json") }), null, "history"))
  eq(M.fetchOutcome("buildlog", rec(200, "{}")), null)
  eq(M.fetchOutcome("buildlog", undefined).text, "Coolify returned nothing (curl 1)")
  const o = M.fetchOutcome("history", rec(404, fixture("history-404.json")))
  eq(o.tone, "urgent"); eq(o.error.httpCode, 404)
})

test("Model.errorText is the single copy table: actionOutcome still says what it said (SR10)", () => {
  eq(M.actionOutcome("stop", "resource", { exit: 0, code: 404, body: "{}", errmsg: "", headers: null }).text, "Coolify no longer has that resource")
  eq(M.actionOutcome("deploy", "resource", { exit: 0, code: 403, body: fixture("error-403-ability.json"), errmsg: "", headers: null }).text, "Token lacks the deploy permission")
  eq(M.actionOutcome("deploy", "resource", { exit: 7, code: 0, body: "", errmsg: "", headers: null }).text, "Coolify is unreachable")
})

test("Model.sensitiveState: yes with a string, no only on a terminal row without logs, unknown otherwise (SR37)", () => {
  eq(M.sensitiveState({ status: "in_progress", logs: "[]" }), "yes")
  eq(M.sensitiveState({ status: "finished" }), "no")
  eq(M.sensitiveState({ status: "failed", logs: null }), "no")
  eq(M.sensitiveState({ status: "in_progress" }), "unknown")
  eq(M.sensitiveState({ status: "queued", logs: null }), "unknown")
  eq(M.sensitiveState(null), "unknown")
})

test("Model.deploymentsInterval: 2 s while deploying, stepping up at 256 KB, 1 MB, 4 MB; 8 s idle with the panel closed, the config value with one open (SR30)", () => {
  eq(M.deploymentsInterval(false, 4, 9999999), 8)
  eq(M.deploymentsInterval(false, 4, 9999999, false), 8)
  eq(M.deploymentsInterval(false, 4, 0, true), 4)
  eq(M.deploymentsInterval(false, 15, 0, false), 15)
  eq(M.deploymentsInterval(false, 15, 0, true), 15)
  eq(M.deploymentsInterval(false, 2, 0, true), 2)
  eq(M.deploymentsInterval(true, 4, 0, false), 2)
  eq(M.deploymentsInterval(true, 4, 0, true), 2)
  eq(M.deploymentsInterval(true, 4, 0), 2)
  eq(M.deploymentsInterval(true, 4, 262144), 2)
  eq(M.deploymentsInterval(true, 4, 262145), 4)
  eq(M.deploymentsInterval(true, 4, 1048577), 8)
  eq(M.deploymentsInterval(true, 4, 4194305), 15)
  eq(M.deploymentsInterval(true, 4, undefined), 2)
})

test("Model.normaliseTags: uuid and name validated, nothing else kept; tagRow shape", () => {
  const t = M.normaliseTags(fx("tags.json"))
  eq(t.length, 2); eq(t[1].name, "production-landing"); eq(Object.keys(t[0]).join(","), "uuid,name")
  eq(M.normaliseTags(fx("tags-empty.json")).length, 0)
  eq(M.normaliseTags(null).length, 0)
  eq(M.normaliseTags([{ uuid: "ok1", name: "a b" }, { uuid: "../x", name: "fine" }, { uuid: "ok2", name: "a,b" }, { uuid: "ok3", name: "good-tag" }, null, "x"]).map(x => x.name).join(","), "good-tag")
  const row = M.tagRow(t[1])
  eq(row.type, "tag"); eq(row.key, "tag:" + t[1].uuid); eq(row.uuid, t[1].uuid); eq(row.name, "production-landing"); eq(row.pendingVerb, "")
})

test("Model.logViewStatus: counts and a digits-only rev, never text (SR26)", () => {
  const p = M.parseBuildLog(encode(LOGF.entries))
  const rec = { entries: p.entries, dropped: p.dropped, rev: M.buildLogRev(p.entries, p.dropped), bytes: p.bytes, source: "list", terminal: false }
  const s = M.logViewStatus({ kind: "buildlog", uuid: "abcdefghijklmnop" }, rec)
  eq(s.kind, "buildlog"); eq(s.uuid8, "abcdefgh"); eq(s.entries, LOGF.entries.length); eq(s.bytes, p.bytes); eq(s.source, "list")
  assert(/^[0-9:]*$/.test(s.rev), "rev digits only")
  for (const k of Object.keys(s)) assert(!Array.isArray(s[k]) && !/text|lines|output|command/.test(k), "no text field: " + k)
  eq(M.logViewStatus({ kind: "containerlog", uuid: "u" }, { lines: ["a", "b"], bytes: 9 }).entries, 2)
  eq(M.logViewStatus(null, rec), null)
})

// ---- Phase 4 depth: rows, actions, hints, tables ---------------------------------------------

test("Model.actionsFor / actionFor: Logs first on deployments, Logs on running rows, History on applications, Deploy on tags; L resolves (SR3)", () => {
  const ids = r => M.actionsFor(r).map(a => a.id).join(",")
  eq(ids({ type: "deployment", status: "finished", url: "u" }), "logs,dismiss,open", "a terminal deployment has Logs, Dismiss, then Open")
  eq(ids({ type: "deployment", status: "in_progress", url: "u" }), "logs,cancel,open")
  eq(ids({ type: "resource", kind: "database", state: "running", url: "u" }), "restart,stop,logs,open")
  eq(ids({ type: "resource", kind: "database", state: "exited", url: "u" }), "start,open", "no Logs on a stopped container")
  eq(ids({ type: "resource", kind: "service", state: "exited", url: "u" }), "start,open", "no History off an application")
  eq(ids({ type: "tag", uuid: "t1", name: "production-landing" }), "deployTag")
  const tag = M.actionsFor({ type: "tag", uuid: "t1", name: "x" })[0]
  eq(tag.confirm, true); eq(tag.destructive, false); eq(tag.label, "Deploy")
  eq(M.actionFor({ type: "tag", uuid: "t1", name: "x" }, "d").id, "deployTag", "d on a tag row")
  eq(M.actionFor({ type: "deployment", status: "finished", url: "u" }, "L").id, "logs", "L resolves to logs")
  eq(M.actionFor({ type: "resource", kind: "application", state: "exited", url: "u" }, "L"), null, "no logs on a stopped app")
  eq(M.targetTypeOf({ type: "tag" }), "tag"); eq(M.targetTypeOf({ type: "actions" }), "")
})

test("Model.actionRequest: nav verbs never reach act(); the tag arm keys on the tag uuid and carries the name (SR28, SR35)", () => {
  const s = actSnap({ tags: M.normaliseTags(fx("tags.json")) })
  for (const v of ["logs", "history", "open"]) eq(M.actionRequest(s, v, APP).why, "nav", v + " is navigation")
  const t = s.tags[1]
  const a = M.actionRequest(s, "deployTag", t.uuid)
  assert(a.ok); eq(a.verb, "deployTag"); eq(a.uuid, t.uuid); eq(a.name, "production-landing"); eq(a.targetType, "tag"); eq(a.confirm, true); eq(a.kind, null)
  eq(M.actionRequest(s, "d", t.uuid).verb, "deployTag", "d resolves on a tag")
  eq(M.actionRequest(s, "stop", t.uuid).why, "notapplicable")
  eq(M.actionRequest(s, "deployTag", APP).why, "notapplicable", "deployTag on an application")
  eq(M.actionRequest(s, "deployTag", "production-landing").why, "invalid", "a tag name is not a key: the uuid gate refuses it")
  eq(M.actionRequest(s, "deployTag", "a b").why, "invalid")
  eq(M.actionRequest(actSnap(), "deployTag", t.uuid).why, "unknown", "no tags loaded")
  const c = M.confirmCopy("deployTag", "production-landing")
  eq(c.message, "Deploy everything tagged production-landing? Coolify decides what that is; the API cannot list it."); eq(c.confirmText, "Deploy")
})

test("Model.actionOutcome deployTag: per-item queued/refused counts and every deployment uuid; queue_full is a refusal (SR35)", () => {
  const rec = { exit: 0, code: 200, body: fixture("action-deploy-tag-ok.json"), errmsg: "", headers: null }
  const o = M.actionOutcome("deployTag", "tag", rec)
  assert(o.ok); eq(o.queued, 1); eq(o.refused, 1); eq(o.deploymentUuids.join(","), "c6vkvflj6qdkvw5k9sicwssh"); eq(o.deploymentUuid, "c6vkvflj6qdkvw5k9sicwssh")
  eq(o.text, "1 queued, 1 refused (queue full)"); eq(o.tone, "urgent"); eq(o.error, null)
  const all = M.actionOutcome("deployTag", "tag", { exit: 0, code: 200, body: JSON.stringify({ deployments: [{ message: "ok", resource_uuid: "r", deployment_uuid: "d1abc" }] }), errmsg: "", headers: null })
  eq(all.text, "1 queued", "the documented `deployments` key still reads"); eq(all.tone, "dim"); eq(all.refused, 0)
  const real = M.actionOutcome("deployTag", "tag", { exit: 0, code: 200, body: JSON.stringify({ details: [{ resource_uuid: "r", deployment_uuid: "d1abc" }], message: ["queued."] }), errmsg: "", headers: null })
  eq(real.text, "1 queued", "the live `details` shape"); eq(real.deploymentUuid, "d1abc")
  const none = M.actionOutcome("deployTag", "tag", { exit: 0, code: 200, body: JSON.stringify({ deployments: [] }), errmsg: "", headers: null })
  eq(none.text, "0 queued"); assert(none.ok)
  eq(M.actionOutcome("deployTag", "tag", { exit: 0, code: 403, body: fixture("error-403-ability.json"), errmsg: "", headers: null }).text, "Token lacks the deploy permission")
  const plain = M.actionOutcome("deploy", "resource", { exit: 0, code: 200, body: fixture("action-deploy-ok.json"), errmsg: "", headers: null })
  assert(Array.isArray(plain.deploymentUuids), "the field exists on every outcome"); eq(plain.queued, 0)
})

test("Model.panelRows: TAGS fold after RESOURCES only when tags exist, on both return paths; a tag row is selectable and renders pending through withPending", () => {
  const tags = M.normaliseTags(fx("tags.json"))
  const s = actSnap({ tags })
  const rows = M.panelRows(s, {})
  const sec = rows.map(r => r.key)
  assert(sec.indexOf("sec:tags") > sec.indexOf("sec:resources"), "TAGS after RESOURCES")
  const fold = rows[M.indexOfKey(rows, "fold:tags")]
  eq(fold.type, "fold"); eq(fold.open, false, "closed by default"); eq(fold.count, 2)
  eq(rows.filter(r => r.type === "tag").length, 0, "folded: no tag rows")
  const open = M.panelRows(s, { folded: { "fold:tags": true } })
  const tagRows = open.filter(r => r.type === "tag")
  eq(tagRows.length, 2); eq(tagRows[1].name, "production-landing"); eq(tagRows[1].key, "tag:" + tags[1].uuid)
  const fi = M.indexOfKey(open, "fold:tags")
  eq(open[M.nextSelectable(open, fi, 1)].type, "tag", "j from the fold lands on a tag row")
  eq(M.panelRows(actSnap(), {}).filter(r => r.key === "sec:tags").length, 0, "no section without tags")
  const empty = actSnap({ resources: [], tree: [], byServer: {}, tags })
  assert(M.indexOfKey(M.panelRows(empty, {}), "sec:tags") >= 0, "the empty-resources path carries it too")
  const pending = {}; pending[tags[1].uuid] = { verb: "deployTag", since: 0, stale: false }
  const pend = M.panelRows(s, { folded: { "fold:tags": true }, pending })
  const pr = pend[M.indexOfKey(pend, "tag:" + tags[1].uuid)]
  assert(pr.pendingVerb.length > 0, "pending decorates the tag row"); eq(pr.tone, "accent")
  assert(!M.sameRows(open, pend), "rowRev sees the pending flip")
  const withStrip = M.panelRows(s, { folded: { "fold:tags": true }, expandedKey: "tag:" + tags[1].uuid })
  const ti = M.indexOfKey(withStrip, "tag:" + tags[1].uuid)
  eq(withStrip[ti + 1].type, "actions"); eq(withStrip[ti + 1].actions.map(a => a.id).join(","), "deployTag"); eq(withStrip[ti + 1].targetType, "tag")
  for (const r of open) for (const g of [r.dot, r.glyph]) if (g) assert(M.GLYPHS.indexOf(g) >= 0, "glyph in allowlist")
})

test("Model.footerHints: view lines for following/held/paused/terminal logs, container logs, history and the picker; o open only with a page", () => {
  eq(M.footerHints("view", null, { view: { kind: "buildlog", following: true, terminal: false, hasUrl: true } }), "following · j/k scroll · b newest · H steps · o open · h back")
  eq(M.footerHints("view", null, { view: { kind: "buildlog", following: false, terminal: false, hasUrl: false } }), "held · j/k scroll · b newest · H steps · h back")
  eq(M.footerHints("view", null, { view: { kind: "buildlog", following: true, terminal: false, paused: true, hasUrl: true } }), "paused · j/k scroll · b newest · H steps · o open · h back")
  eq(M.footerHints("view", null, { view: { kind: "buildlog", following: true, terminal: true, hasUrl: true } }), "j/k scroll · b newest · H steps · o open · h back")
  eq(M.footerHints("view", null, { view: { kind: "containerlog", hasUrl: true } }), "j/k scroll · b newest · r refetch · o open · h back")
  eq(M.footerHints("view", null, { view: { kind: "history", hasUrl: true } }), "j/k move · enter log · o open · h back")
  eq(M.footerHints("view", null, { view: { kind: "servicepick" } }), "j/k move · enter logs · h back")
  eq(M.footerHints("list", { type: "tag", uuid: "t", name: "x" }), "enter actions · d deploy")
  eq(M.footerHints("view", null, { view: { kind: "history" }, confirmOpen: true }), "h/l pick · enter confirm · esc cancel", "the confirm wins")
})

// ---- Phase 4 depth: remaining plan cases --------------------------------------------------

test("Model.normaliseHistory rows take joinBranch like the drain arm: branch and appUuid from the joined resources", () => {
  const s = loadedSnap()
  const h = M.normaliseHistory(fx("history-page.json"))
  const joined = M.joinBranch(h.rows, s.resources)
  eq(joined.length, h.rows.length)
  for (const r of joined) assert(!("logs" in r), "still no logs after the join")
  const api = s.resources.filter(r => r.uuid === "xyhpwdxqu33omjgwuo6c7cjp")[0]
  if (api) { assert(joined.every(r => r.appUuid === "xyhpwdxqu33omjgwuo6c7cjp"), "appUuid joined"); eq(joined[0].branch, api.gitBranch || joined[0].branch) }
  const row = M.historyRow(joined[0], "xyhpwdxqu33omjgwuo6c7cjp", "https://app.coolify.io")
  assert(row.sub === "deploy" || row.sub === "restart" || (row.sub && row.sub !== "HEAD"), "sub never renders HEAD: " + row.sub)
  assert(row.url.indexOf("https://app.coolify.io/") === 0, "url from the instance origin")
})

test("Model.serialiseRecent never emits a logs key, even when a record carries one (SR26)", () => {
  const d = M.normaliseDeployment(fx("deployment-finished.json"))
  d.logs = "[{\"command\":null,\"output\":\"secret build output\"}]"
  d.entries = [{ output: "x" }]
  const at = Date.parse(d.finishedAt || d.updatedAt) + 1000       // the file's 24 h age-out is measured from this clock
  const text = M.serialiseRecent([d], "https://app.coolify.io", at).text
  assert(text.indexOf("logs") < 0, "no logs key or text"); assert(text.indexOf("secret build output") < 0); assert(text.indexOf("entries") < 0)
  const back = M.parseRecent(text, "https://app.coolify.io", at)
  eq(back.rejected, false); eq(back.recent.length, 1); assert(!("logs" in back.recent[0]))
})

// ---- Phase 4 depth: review-panel findings --------------------------------------------------

test("Model.viewRow coerces every field to its placeholder's type and drops unknown keys (review: security-analyst 3)", () => {
  const r = M.viewRow("line", { i: "7", hidden: "yes", shown: {}, text: 42, loading: 0, extra: { evil: 1 }, tone: null })
  eq(r.i, 7); eq(r.hidden, true); eq(r.shown, 0); eq(r.text, "42"); eq(r.loading, false); eq(r.tone, "")
  assert(!("extra" in r), "an unknown key never becomes a role")
  eq(Object.keys(r).sort().join(","), M.VIEW_KEYS.slice().sort().join(","))
})

test("Model.parseBuildLog bounds physical lines: 200 per entry, 5000 per log, dropping head entries with `dropped` (review: security-analyst 1)", () => {
  eq(M.LOG_MAX_OUTPUT_LINES, 200); eq(M.LOG_MAX_LINES, 5000)
  const one = M.parseBuildLog(JSON.stringify([{ command: null, output: "x\n".repeat(400).slice(0, -1), type: "stdout" }]))
  eq(one.entries[0].output.split("\n").length, 200, "per-entry tail")
  const many = []; for (let i = 0; i < 100; i++) many.push({ command: null, output: "l\n".repeat(100).slice(0, -1), type: "stdout" })
  const r = M.parseBuildLog(JSON.stringify(many))            // 100 entries x 100 lines = 10 000 physical lines
  const lines = r.entries.reduce((n, e) => n + e.output.split("\n").length, 0)
  assert(lines <= 5000, "line budget kept: " + lines); assert(r.truncated); assert(r.dropped >= 50, "head entries dropped: " + r.dropped)
  eq(r.entries[0].i, r.dropped, "dropped is the first kept index")
  const rows = M.buildLogLines(r.entries, { showHidden: true, failing: null, uuid: "u" })
  assert(rows.length <= 5000, "the ListModel never receives more rows than the budget")
})

test("Model.withPending on a tag row reads deploying…, and GERUND covers deployTag (review: ux-api-designer 2)", () => {
  eq(M.gerund("deployTag"), "deploying")
  const row = M.withPending(M.tagRow({ uuid: "t1", name: "production-landing" }), { verb: "deployTag", since: 0, stale: false })
  eq(row.pendingVerb, "deploying…"); eq(row.sub, "deploying…"); eq(row.tone, "accent")
  eq(M.tagRow({ uuid: "t1", name: "x" }).dot, M.G.tag, "a tag row has its own bullet")
  assert(M.GLYPHS.indexOf(M.G.tag) >= 0)
})

// review re-check (ux 4): the container breadcrumb passes fetchedAt as a number
test("elapsed and age accept a numeric timestamp as well as ISO", () => {
  const now = 1789205833000
  eq(M.elapsed(now - 12000, now), "12s")
  eq(M.elapsed(new Date(now - 12000).toISOString(), now), "12s")
  eq(M.elapsed(now - 90000, now), "1m 30s")
  eq(M.elapsed("not a date", now), "")
  eq(M.age(now - 12000, now), "Just now")
})

// ---- Phase 4 instances ---------------------------------------------------------------------

test("normaliseConfig: two instances from the fixture; a single-entry file is unchanged (SR32)", () => {
  const two = M.normaliseConfig(fixture("config-two-instances.json"))
  eq(two.ok, true); eq(two.instances.length, 2); eq(two.instances[0].id, "cloud"); eq(two.instances[1].id, "homelab")
  eq(two.instances[1].plaintext, true); eq(JSON.stringify(two.instances[1].tokenCommand), JSON.stringify(["op", "read", "op://Private/Coolify Homelab/credential"]))
  eq(two.instancesWarning, ""); eq(two.warning, "")
  const one = M.normaliseConfig({ version: 1, instances: [{ id: "cloud", name: "Coolify Cloud", url: "https://app.coolify.io", token: "67|x" }] })
  eq(one.ok, true); eq(one.instances.length, 1); eq(one.instances[0].id, "cloud"); eq(one.instancesWarning, "")
  const noId = M.normaliseConfig({ instances: [{ url: "https://x", token: "t" }, { url: "https://y", token: "t" }] })
  eq(noId.ok, true); eq(noId.instances[0].id, "instance0"); eq(noId.instances[1].id, "instance1")
})

test("normaliseConfig: duplicate id, a path-shaped id, a long id and a dotted id are config errors (SR32)", () => {
  const dup = M.normaliseConfig({ instances: [{ id: "a", url: "https://x", token: "t" }, { id: "a", url: "https://y", token: "t" }] })
  eq(dup.ok, false); assert(/instances\[1\]\.id "a" is already used by instances\[0\]/.test(dup.error), dup.error)
  for (const bad of ["../x", "a/b", "a.b", "a b", "x".repeat(33), "é", "a\n"]) {
    const c = M.normaliseConfig({ instances: [{ id: bad, url: "https://x", token: "t" }] })
    eq(c.ok, false, JSON.stringify(bad) + " must be rejected"); assert(/\.id must be/.test(c.error), c.error)
  }
  for (const good of ["a", "home-lab_2", "x".repeat(32), "0"]) eq(M.normaliseConfig({ instances: [{ id: good, url: "https://x", token: "t" }] }).ok, true, good)
})

test("normaliseConfig: the same origin twice is a warning, not an error; configSansNotify drops it", () => {
  const c = M.normaliseConfig({ instances: [{ id: "a", url: "https://app.coolify.io", token: "t" }, { id: "b", url: "https://app.coolify.io/", token: "u" }] })
  eq(c.ok, true); eq(c.instances.length, 2)
  assert(/^"b" and "a" are the same Coolify \(app\.coolify\.io\)/.test(c.instancesWarning), c.instancesWarning)   // ids, not positions (review: ux)
  assert(/twice/.test(c.instancesWarning))
  eq(c.warning, "", "the notify warning slot is untouched")
  const d = M.normaliseConfig({ instances: [{ id: "a", url: "https://app.coolify.io", token: "t" }, { id: "b", url: "https://other.example", token: "u" }] })
  eq(d.instancesWarning, "")
  const q = M.normaliseConfig({ instances: [{ id: "a", url: "https://one.example/?x=1", token: "t" }, { id: "b", url: "https://two.example/#y", token: "u" }] })
  eq(q.ok, true); eq(q.instancesWarning, "", "two hosts whose origin() is empty are never the same Coolify (review: data 4)")
  const sans = M.configSansNotify(c)
  assert(!("instancesWarning" in sans) && !("warning" in sans) && !("notify" in sans), "sans drops the live-applied parts")
  assert("instances" in sans && "poll" in sans)
})

test("errorFor: curl exit 60 is tls, named at every site; other transport exits stay offline (SR36)", () => {
  const e = M.errorFor({ curlExit: 60, errmsg: "SSL certificate problem: self-signed certificate", request: "servers" })
  eq(e.kind, "tls"); eq(e.title, "Certificate rejected"); assert(/self-signed/.test(e.detail)); eq(e.request, "servers")
  eq(M.errorFor({ curlExit: 60 }).detail, "certificate verification failed")
  for (const x of [6, 7, 28, 35]) eq(M.errorFor({ curlExit: x }).kind, "offline", "exit " + x)
  eq(M.OFFLINE_EXITS[60], undefined, "60 left the offline table")
  const b = M.barState(snap({ error: e })); eq(b.glyph, M.G.cloudAlert); eq(b.dimmed, true); assert(/certificate rejected/.test(b.tooltip))
  const c = M.callout(snap({ error: e }), NOW); eq(c.title, "Certificate rejected"); assert(/nothing was sent/.test(c.body)); assert(/Retrying/.test(c.body))
})

test("instanceKey / tokenFingerprint: the store key never holds the token, changes on any entry, poll or token change (SR34; review: security 3)", () => {
  const e = { id: "a", name: "A", url: "https://x", token: "67|secretsecretsecret", tokenCommand: null, plaintext: false }
  const k = M.instanceKey(e, { deploymentsSec: 4 })
  assert(k.indexOf("secret") < 0 && k.indexOf("67|") < 0, "no token in the key")
  eq(k, M.instanceKey(Object.assign({}, e), { deploymentsSec: 4 }), "stable")
  assert(k !== M.instanceKey(Object.assign({}, e, { token: "67|secretsecretsecreT" }), { deploymentsSec: 4 }), "a one-char token change resets")
  assert(k !== M.instanceKey(Object.assign({}, e, { name: "B" }), { deploymentsSec: 4 }), "a name change resets")
  assert(k !== M.instanceKey(e, { deploymentsSec: 2 }), "a poll change resets")
  eq(M.tokenFingerprint(""), "0:1505"); assert(/^21:[0-9a-f]+$/.test(M.tokenFingerprint(e.token)))
})

test("instanceChips: none for one instance; label, selected and trouble for two or more", () => {
  eq(M.instanceChips([{ id: "a", name: "A" }], "a").length, 0)
  eq(M.instanceChips([], "a").length, 0); eq(M.instanceChips(null, "a").length, 0)
  const chips = M.instanceChips([{ id: "cloud", name: "Coolify Cloud", error: "", failed: 0, down: 0 }, { id: "home", name: "Homelab", error: "auth", failed: 0, down: 0 }, { id: "x", name: "x".repeat(60), error: "", failed: 2, down: 0 }], "home")
  eq(chips.length, 3)
  eq(chips[0].id, "cloud"); eq(chips[0].label, "Coolify Cloud"); eq(chips[0].selected, false); eq(chips[0].trouble, false)
  eq(chips[1].id, "home"); eq(chips[1].selected, true); eq(chips[1].trouble, true)
  eq(chips[2].trouble, true); assert(chips[2].label.length <= 24, "chip labels are bounded")
  for (const c of chips) eq(JSON.stringify(Object.keys(c)), JSON.stringify(["id", "label", "selected", "trouble"]))
})

test("instanceTrouble: names the first non-active instance in trouble, never the active one; empty when healthy", () => {
  const list = [{ id: "cloud", name: "Coolify Cloud", error: "auth", failed: 0, down: 0 }, { id: "home", name: "Homelab", error: "", failed: 1, down: 0 }, { id: "lab2", name: "Lab 2", error: "", failed: 0, down: 2 }]
  eq(M.instanceTrouble(list, "cloud"), "Homelab: 1 failed build")
  eq(M.instanceTrouble(list, "home"), "Coolify Cloud: token rejected")
  eq(M.instanceTrouble(list, "lab2"), "Coolify Cloud: token rejected")
  eq(M.instanceTrouble([list[0]], "cloud"), "", "the active instance's own trouble is the bar icon's job")
  eq(M.instanceTrouble([{ id: "a", name: "A" }, { id: "b", name: "B", error: "", failed: 0, down: 0 }], "a"), "")
  eq(M.instanceTrouble([{ id: "a" }, { id: "b", name: "B", error: "offline" }], "a"), "B: offline")
  eq(M.instanceTrouble([{ id: "a" }, { id: "b", name: "B", error: "tls" }], "a"), "B: certificate rejected")
  eq(M.instanceTrouble([{ id: "a" }, { id: "b", name: "B", error: "ability" }], "a"), "B: token lacks an ability")   // review: ux 3
  eq(M.instanceTrouble([{ id: "a" }, { id: "b", name: "B", down: 1 }], "a"), "B: 1 server unreachable")
  eq(M.instanceTrouble([{ id: "a" }, { id: "b", name: "x".repeat(80), error: "http" }], "a").length < 50, true)
})

test("parseRecent / serialiseRecent with an instance id: a v1 file without id is accepted, an id mismatch is rejected, the id is emitted, no logs key (SR26)", () => {
  const KEY = "https://app.coolify.io"
  const v1 = M.parseRecent(fixture("state-recent.json"), KEY, NOW, "cloud", true)
  eq(v1.loaded, true); eq(v1.rejected, false); eq(v1.recent.length, 2, "a Phase 3 file (no id) loads for the first instance")
  eq(M.parseRecent(fixture("state-recent.json"), KEY, NOW, "homelab", false).rejected, true, "and for no other instance (review: data 2)")
  eq(M.parseRecent(fixture("state-recent.json"), KEY, NOW).rejected, false, "the Phase 3 call shape (no id) still loads it")
  const rt = M.serialiseRecent(v1.recent, KEY, NOW, "cloud")
  const parsed = JSON.parse(rt.text); eq(parsed.id, "cloud"); eq(parsed.instance, KEY); eq(parsed.version, 1)
  eq(JSON.stringify(Object.keys(parsed)), JSON.stringify(["version", "instance", "id", "savedAt", "recent"]))
  assert(rt.text.indexOf('"logs"') < 0 && rt.key.indexOf('"logs"') < 0)
  eq(M.parseRecent(rt.text, KEY, NOW, "cloud").rejected, false); eq(M.parseRecent(rt.text, KEY, NOW, "cloud", true).rejected, false)
  eq(M.parseRecent(rt.text, KEY, NOW, "homelab").rejected, true, "another instance's file")
  eq(M.parseRecent(rt.text, KEY, NOW).rejected, true, "a file with an id needs a caller id")
  eq(M.parseRecent(rt.text, KEY, NOW, "").rejected, true)
  const noId = M.serialiseRecent(v1.recent, KEY, NOW)
  assert(JSON.parse(noId.text).id === undefined, "no id → no id key (Phase 3 shape)")
  assert(noId.key !== rt.key, "the key carries the id")
  eq(M.serialiseRecent(v1.recent, KEY, NOW + 5000, "cloud").key, rt.key, "key ignores savedAt")
})

test("notifyCopy: the body names the instance when ctx.instanceLabel is set, escaped, bounded; headline untouched", () => {
  const s = snap({ recent: [{ uuid: "d1", appUuid: "a1", appName: "api", status: "failed", createdAt: "2026-09-06T21:00:00Z", finishedAt: "2026-09-06T21:00:30Z", branch: "main", url: "/x" }] })
  const ev = [{ kind: "deployment", event: "failed", uuid: "d1" }]
  const base = M.notifyPlan(ev, s, { notify: M.notifyDefaults(), origin: "https://app.coolify.io", now: NOW, pluginId: "p" })
  const named = M.notifyPlan(ev, s, { notify: M.notifyDefaults(), origin: "https://app.coolify.io", now: NOW, pluginId: "p", instanceLabel: "Homelab <1> & co" })
  eq(base.argvs.length, 1); eq(named.argvs.length, 1)
  eq(named.argvs[0][7], base.argvs[0][7], "headline unchanged")
  assert(named.argvs[0][8].endsWith(" · Homelab &lt;1> &amp; co"), named.argvs[0][8])   // notifyBody escapes & and < (the shell's StyledText); > is left alone
  assert(base.argvs[0][8].indexOf("Homelab") < 0)
  const c = M.notifyPlan([{ kind: "deployment", event: "cancelled", uuid: "d1" }], snap({ recent: [{ uuid: "d1", appName: "api", status: "cancelled-by-user" }] }), { notify: M.notifyDefaults(), origin: "", now: NOW, pluginId: "p", instanceLabel: "Homelab" })
  eq(c.argvs[0][8], "Homelab", "an otherwise empty body is just the instance")
})

test("statusWords / countsLine / heroMeta / barState: the dot carries the state, the counts carry the trouble (Phase 4b)", () => {
  const sw = (status) => M.statusWords(Object.assign({ status }, M.parseStatus(status)))
  eq(sw("running:healthy"), "healthy")
  eq(sw("running:unhealthy"), "unhealthy")
  eq(sw("running"), "running", "no health word: the state stays so the caption is never empty")
  eq(sw("exited"), "exited"); eq(sw("exited:unhealthy"), "exited")
  eq(sw("restarting:unhealthy"), "restarting"); eq(sw("paused"), "paused"); eq(sw("degraded"), "degraded")
  eq(sw("weird"), "weird", "unknown state shows the raw status")
  const s = loadedSnap()
  const nx = s.resources.filter(r => r.state === "exited").length
  assert(nx >= 1, "the resources fixture holds a stopped app")
  const line = M.heroMeta(s)
  assert(line.endsWith(" · " + nx + " stopped"), line)
  assert(line.indexOf("unhealthy") < 0, "no unhealthy clause when none")
  eq(M.barState(s).tooltip, "Coolify Cloud — " + M.countsLine(s), "the bar tooltip carries the same counts")
  const r = s.resources.map(x => Object.assign({}, x))
  r.find(x => x.state === "running").health = "unhealthy"
  r.find(x => x.state === "running" && x.health !== "unhealthy").state = "degraded"
  r.find(x => x.state === "exited").state = "paused"
  const s2 = snap({ servers: s.servers, resources: r })
  const l2 = M.countsLine(s2)
  assert(l2.endsWith(" · " + nx + " stopped · 2 unhealthy"), l2)
  const clean = snap({ servers: s.servers, resources: s.resources.filter(x => x.state === "running") })
  assert(M.countsLine(clean).indexOf("stopped") < 0 && M.countsLine(clean).indexOf("unhealthy") < 0, "zero clauses drop")
  eq(M.countsLine(snap({ deployments: [{ status: "in_progress" }], resources: [{ state: "exited" }] })), "1 resource · 1 deploying · 1 stopped", "order: totals, deploying, stopped, unhealthy")
})

console.log(passed + " passed, " + failed + " failed")
process.exit(failed ? 1 : 0)
