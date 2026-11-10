// English UI check: starts the local server on web/dist, switches the page to English, opens every page
// and runs small jobs, and reports any Chinese left in the visible text / job results (character names
// from the team excluded). Needs a build (web/dist) and node/data like browser-test.mjs.
//   node lang-test.mjs [browserExe]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const exe = process.argv[2] || ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium"].find(f => fs.existsSync(f))
const PORT = 8797
const BASE = `http://127.0.0.1:${PORT}`
const srv = spawn(process.execPath, ["server.mjs", "--port", String(PORT)], { cwd: here, stdio: ["ignore", "ignore", "inherit"] })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fastsim-lang-"))
const br = spawn(exe, ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = (...a) => process.stdout.write(a.join(" ") + "\n")
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g
const team = JSON.parse(fs.readFileSync(path.join(here, "data", "team.json"), "utf8"))
const names = team.members.map(m => m.name).filter(Boolean).sort((a, b) => b.length - a.length)
/** Chinese runs in `s`, with context, minus character names. */
function leftovers(s) {
  for (const n of names) s = s.split(n).join("<name>")
  s = s.split("中文\nEN").join("").split("中文 EN").join("") // the language switch
  const hits = new Map()
  for (const m of s.matchAll(CJK)) {
    const ctx = s.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " ")
    if (!hits.has(m[0])) hits.set(m[0], ctx)
  }
  return [...hits.values()]
}
let bad = 0
try {
  let target
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(300)
    try { target = (await (await fetch("http://127.0.0.1:9334/json")).json()).find(t => t.type === "page") } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => (ws.onopen = r))
  let n = 0
  const waiting = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") out("  [console]", m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 300))
    if (m.method === "Runtime.exceptionThrown") out("  [exception]", JSON.stringify(m.params.exceptionDetails).slice(0, 400))
    if (m.id && waiting.has(m.id)) waiting.get(m.id)(m)
  }
  const send = (method, params = {}) => new Promise(r => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  await send("Runtime.enable")
  const ev = async expr => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails))
    return r.result.result.value
  }
  for (let i = 0; i < 120; i++) {
    try {
      if ((await (await fetch(`${BASE}/api/state`)).json()).team) break
    } catch {}
    await sleep(500)
  }
  await send("Page.navigate", { url: `${BASE}/` })
  await sleep(1500)
  await ev(`localStorage.setItem("fastsim-lang", "en"); localStorage.setItem("fastsim-seen-version", "x")`)
  await send("Page.reload")
  await sleep(5000)
  const pages = ["team", "simulate", "zones", "skills", "consumables", "upgrades", "goal", "stat-value", "scrolls", "gear-cost", "labyrinth", "queue", "jobs", "ironcow"]
  for (const p of pages) {
    await ev(`location.hash = "#/${p}"`)
    await sleep(2500)
    if (p === "team") {
      // every tab of the member editor
      const tabs = await ev(`return [...document.querySelectorAll(".el-tabs__item")].length`)
      let all = ""
      for (let i = 0; i < tabs; i++) {
        all += await ev(`document.querySelectorAll(".el-tabs__item")[${i}].click(); await new Promise(r => setTimeout(r, 400)); return document.body.innerText`)
      }
      const l = leftovers(all)
      out(`== ${p}: ${l.length ? l.length + " Chinese" : "ok"}`)
      for (const x of l) out("   ", x)
      bad += l.length
      continue
    }
    // the job list also shows older jobs, whose progress text keeps the language they ran in
    const l = p === "jobs" ? [] : leftovers(await ev(`return document.body.innerText`))
    out(`== ${p}: ${l.length ? l.length + " Chinese" : "ok"}`)
    for (const x of l) out("   ", x)
    bad += l.length
  }
  // the changelog dialog is Chinese on purpose; the language switch itself shows "中文"
  // jobs in English, through the page's API so the language is the page's
  const members = team.selected.map(id => team.members.find(p => String(p.id) === String(id)))
  const o = await (await fetch(`${BASE}/api/options`)).json()
  const zone = o.zones?.[0]?.hrid
  const body = { members, target: { kind: "zone", zoneHrid: zone, difficultyTier: 1 }, hours: 2, seeds: 2, extra: { mooPass: true } }
  const sim = await ev(`return await __fastsim.call("POST", "/api/simulate", ${JSON.stringify(body)})`)
  const ls = leftovers(JSON.stringify(sim))
  out(`== simulate result: ${ls.length ? ls.length + " Chinese" : "ok"}`)
  for (const x of ls) out("   ", x)
  bad += ls.length
  const jobsToRun = [
    ["consumables", { rounds: 1, swapItems: false }],
    ["upgrades", { budgets: [5e8, 5e8, 5e8], horizons: [30] }],
    ["skills", { rounds: 1, stages: [{ hours: 1, seeds: 2, keep: 3 }] }],
    ["zones", { targets: o.zones.slice(0, 2).map(z => ({ kind: "zone", zoneHrid: z.hrid, difficultyTier: 0 })) }],
    ["statvalue", {}],
  ]
  const PAGE = { consumables: "consumables", upgrades: "upgrades", skills: "skills", zones: "zones", statvalue: "stat-value" }
  for (const [type, extra] of jobsToRun) {
    const t0 = Date.now()
    let id
    try {
      ;({ id } = await ev(`return await __fastsim.call("POST", "/api/jobs", ${JSON.stringify({ type, params: { ...body, ...extra } })})`))
    } catch (e) {
      out(`== job ${type}: could not start: ${e.message.split("\n")[0]}`)
      bad++
      continue
    }
    let j
    do {
      await sleep(1000)
      j = await ev(`return await __fastsim.call("GET", "/api/jobs/${id}")`)
    } while (j.status === "running" && Date.now() - t0 < 240000)
    if (j.status === "running") await ev(`return await __fastsim.call("POST", "/api/jobs/${id}/cancel").catch(() => null)`)
    // the title is a t() key, translated by the page
    const l = leftovers(JSON.stringify({ log: j.log, result: j.result, error: j.error }))
    out(`== job ${type}: ${j.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${l.length ? l.length + " Chinese" : "ok"} ${j.error ? j.error.split("\n")[0] : ""}`)
    for (const x of l.slice(0, 30)) out("   ", x)
    bad += l.length
    // and the page that shows it (JobRunner picks the job up from localStorage)
    await ev(`localStorage.setItem("fastsim-job-${type}", "${id}"); location.hash = "#/${PAGE[type]}"`)
    await send("Page.reload")
    await sleep(4000)
    const lp = leftovers(await ev(`return document.body.innerText`))
    if (lp.length) out(`   job page ${type}:`, lp.length, "Chinese")
    for (const x of lp.slice(0, 30)) out("   ", x)
    bad += lp.length
  }
} catch (e) {
  out("ERROR", e.stack)
  bad++
} finally {
  // back to Chinese for the next run of the other tests
  await fetch(`${BASE}/api/lang`, { method: "PUT", headers: { "content-type": "application/json" }, body: '{"lang":"zh"}' }).catch(() => {})
  br.kill()
  srv.kill()
  out(bad ? `${bad} Chinese leftovers` : "English UI: no Chinese left")
  process.exit(bad ? 1 : 0)
}
