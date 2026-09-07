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
    eq(count(b, "request = "), 0, "no method line on a GET")
    eq(count(b, "data-raw"), 0)
    eq(count(b, "Content-Type"), 0)
    eq(b.split("\n").filter(l => l.length).length, 9, "nine lines per GET block")
  }
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
  eq(d.verb, "redeploy"); eq(d.kind, "action"); eq(d.method, "POST")
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

// ---- Model.js: bar, hero, callout --------------------------------------------------------------

test("Model.barState: all 14 rows (glyph, dimmed, active, tooltip)", () => {
  const G = M.G
  function st(o) { return M.barState(snap(o)) }
  let b = st({ error: M.makeError("noconfig") }); eq(b.glyph, G.cloudOutline); eq(b.dimmed, true); eq(b.active, false); assert(/no config at/.test(b.tooltip))
  b = st({ error: M.makeError("configerror", "bad\nmore") }); eq(b.glyph, G.cloudAlert); eq(b.tooltip, "Omarify — config error: bad more")
  b = st({ error: M.makeError("unsafe") }); eq(b.glyph, G.cloudAlert); assert(/writable/.test(b.tooltip))
  b = st({ error: M.makeError("tokencmd", "", { curlExit: 1 }) }); eq(b.glyph, G.cloudAlert); eq(b.tooltip, "Omarify — token command failed (exit 1)")
  b = st({ error: M.makeError("waitingtoken") }); eq(b.glyph, G.cloud); eq(b.dimmed, true); assert(/waiting/.test(b.tooltip))
  b = st({ error: M.makeError("auth") }); eq(b.glyph, G.cloudAlert); eq(b.tooltip, "Omarify — token rejected")
  b = st({ error: M.makeError("apidisabled") }); eq(b.glyph, G.cloudAlert); assert(/API disabled/.test(b.tooltip))
  b = st({ error: M.makeError("ipblocked") }); eq(b.glyph, G.cloudAlert); assert(/IP/.test(b.tooltip))
  b = st({ error: M.makeError("offline") }); eq(b.glyph, G.cloudOff); eq(b.dimmed, true); assert(/offline/.test(b.tooltip))
  b = st({ error: M.makeError("ratelimited"), backoffSec: 30 }); eq(b.glyph, G.cloud); eq(b.tooltip, "Omarify — rate limited, backing off 30s")
  b = st({ baselineDone: false }); eq(b.glyph, G.cloud); eq(b.dimmed, true); eq(b.tooltip, "Omarify — starting")
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
  const kinds = ["noconfig", "configerror", "unsafe", "tokencmd", "waitingtoken", "auth", "apidisabled", "ipblocked", "ability", "ratelimited", "offline", "toolarge", "http"]
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
  eq(aged.filter(r => r.type === "deployment").length, 0, "finished deployments leave after an hour")
  assert(aged.some(r => r.type === "note" && r.text === "Nothing deploying."))
  const fresh = M.panelRows(snap({ recent: recent.map(d => Object.assign({}, d, { updatedAt: new Date(NOW - 10 * 60000).toISOString() })) }), { nowMs: NOW })
  eq(fresh.filter(r => r.type === "deployment").length, 5)
})

test("Model.panelRows: group by project with folds, fold open/closed, Ungrouped last", () => {
  const s = loadedSnap()
  const open = M.panelRows(s, { groupBy: "project", folded: {} })
  const folds = open.filter(r => r.type === "fold")
  eq(folds[0].title, s.tree[0].projectName + " / production"); eq(folds[0].count, 2); eq(folds[0].open, true)
  eq(folds[folds.length - 1].title, "Ungrouped"); eq(folds[folds.length - 1].count, 5)
  eq(open.filter(r => r.type === "resource").length, 7)
  const closed = M.panelRows(s, { groupBy: "project", folded: { [folds[0].key]: true } })
  eq(closed.filter(r => r.type === "resource").length, 5)
  eq(closed.filter(r => r.type === "fold")[0].open, false)
  const res = open.find(r => r.type === "resource")
  eq(res.indent, 1); assert(res.statusWords === "running · healthy" || res.statusWords === "exited"); assert(M.GLYPHS.indexOf(res.dot) >= 0)
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

test("Model.footerHints: hero, fold, leaf", () => {
  eq(M.footerHints("hero", null), "enter refresh · j down · r refresh · esc close")
  eq(M.footerHints("list", { type: "fold" }), "j/k move · enter fold · g group · r refresh · esc close")
  eq(M.footerHints("list", { type: "resource" }), "j/k move · g group · r refresh · esc close")
})

console.log(passed + " passed, " + failed + " failed")
process.exit(failed ? 1 : 0)
