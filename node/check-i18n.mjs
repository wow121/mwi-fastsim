// Checks the UI translation (see app/lang.mjs):
//   1. t("…") keys with no English entry,
//   2. Chinese text in the code that is not a t() key (comments ignored; end a line with `// i18n-ok`
//      to allow it, e.g. a regex that matches Chinese input),
//   3. English entries whose {placeholders} differ from the key's, or that still contain Chinese.
// Usage: node node/check-i18n.mjs [file or dir …]   (default: web/src, node/app, userscript)
// Exit code 1 when anything is found.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { enDict } from "./app/lang.mjs"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKIP = /[\\/](locales|node_modules|dist)[\\/]|[\\/](zh-game|zh-names|i18n|lang)\.mjs$|check-i18n\.mjs$/
const CJK = /[　-〿一-鿿＀-￯]/

function files(p) {
  const st = fs.statSync(p)
  if (st.isFile()) return [p]
  return fs.readdirSync(p).flatMap(f => files(path.join(p, f)))
}
const args = process.argv.slice(2)
const targets = (args.length ? args : ["web/src", "node/app", "userscript"]).map(a => path.resolve(root, a))
const list = targets.flatMap(files).filter(f => /\.(vue|js|mjs)$/.test(f) && !SKIP.test(f))

// string literal right after `t(` / `tk(` (", ', or a backtick without ${})
const CALL = /\b(?:t|tk)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.)*)`)/g
const unesc = s => s.replace(/\\(.)/g, "$1")
const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",")

let bad = 0
const missing = new Map()
const loose = []
for (const f of list) {
  const rel = path.relative(root, f)
  const src = fs.readFileSync(f, "utf8")
  for (const m of src.matchAll(CALL)) {
    const key = unesc(m[1] ?? m[2] ?? m[3])
    if (CJK.test(key) && !(key in enDict)) {
      const line = src.slice(0, m.index).split("\n").length
      if (!missing.has(key)) missing.set(key, `${rel}:${line}`)
    }
  }
  let inBlock = false
  src.split("\n").forEach((line, i) => {
    if (/i18n-ok/.test(line)) return
    let s = line
    if (inBlock) {
      const e = s.search(/\*\/|-->/)
      if (e < 0) return
      s = s.slice(e + 3)
      inBlock = false
    }
    s = s.replace(/\/\*.*?\*\/|<!--.*?-->/g, "")
    const open = s.search(/\/\*|<!--/)
    if (open >= 0) {
      s = s.slice(0, open)
      inBlock = true
    }
    s = s.replace(CALL, "t()")
    s = s.replace(/(^|[^:"'`\\])\/\/.*$/, "$1") // line comment (not inside a URL)
    if (/^\s*\*/.test(s)) return // JSDoc continuation
    if (CJK.test(s)) loose.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`)
  })
}
if (missing.size) {
  bad = 1
  console.log(`== ${missing.size} t() keys without English`)
  for (const [k, at] of missing) console.log(`${at}\t${JSON.stringify(k)}`)
}
if (loose.length) {
  bad = 1
  console.log(`== ${loose.length} lines with Chinese outside t()`)
  for (const l of loose) console.log(l)
}
const wrong = Object.entries(enDict).filter(([k, v]) => typeof v !== "string" || ph(k) !== ph(v) || CJK.test(v.replace(/[“”‘’…—–·]/g, "")))
if (wrong.length) {
  bad = 1
  console.log(`== ${wrong.length} English entries with wrong placeholders or Chinese left`)
  for (const [k, v] of wrong) console.log(`${JSON.stringify(k)} -> ${JSON.stringify(v)}`)
}
if (!bad) console.log(`i18n ok: ${list.length} files, ${Object.keys(enDict).length} English entries`)
process.exit(bad)
