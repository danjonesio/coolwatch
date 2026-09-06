// Node runner for Model.js and Api.js. Each file is `.pragma library` QML JS;
// the pragma is stripped and the file is evaluated in its own vm context, so a
// cross-dependency between the two would fail here as it would in QML.
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

if (M) test("Model.js loads", () => assert(typeof M.version === "function", "Model.version missing"))
if (A) test("Api.js loads", () => assert(typeof A.version === "function", "Api.version missing"))

console.log(passed + " passed, " + failed + " failed")
process.exit(failed ? 1 : 0)
