// Node runner for Model.js and Api.js. Each file is `.pragma library` QML JS;
// the pragma is stripped and the file is evaluated in its own vm context, so a
// cross-dependency between the two would fail here as it would in QML.
//
// Each test names the plan item it covers: SR<n> = Security requirement n in
// docs/plans (the Phase 1 plan), otherwise the Model/Api function under test.
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

// A trailer exactly as curl emits it for Api.TRAILER.
function trailer(exit, code, time, bytes, errmsg, headersJson) {
  return "\n" + RS + exit + " " + code + " " + time + " " + bytes + " " + errmsg + "\n" + headersJson + "\n" + US
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

test("Model.splitResponses: three-block batch in order with a failed middle block", () => {
  const s = '{"a":1}' + trailer(0, 200, "0.07", 7, "", "{}") +
    trailer(7, "000", "0.001", 0, "Failed to connect", "{}") +
    '{"bb":2}' + trailer(0, 200, "0.04", 8, "", '{"date":["x"]}')
  const r = M.splitResponses(s)
  eq(r.length, 3)
  eq(r[0].body, '{"a":1}'); eq(r[1].exit, 7); eq(r[1].body, ""); eq(r[2].body, '{"bb":2}'); eq(r[2].code, 200)
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

console.log(passed + " passed, " + failed + " failed")
process.exit(failed ? 1 : 0)
