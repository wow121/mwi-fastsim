// End-to-end test of the browser build (static hosting, wasm engine) against the local server:
// serves web/dist statically, drives headless Edge/Chrome over CDP, imports the team, runs the
// same simulation in both modes and compares, then runs a small job in the browser.
//   node browser-test.mjs [browserExe]
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, "..", "web", "dist")
const exe = process.argv[2] || ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(f => fs.existsSync(f))
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2" }
const stat = http.createServer((req, res) => {
  let f = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname))
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, "index.html")
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" })
  fs.createReadStream(f).pipe(res)
})
await new Promise(r => stat.listen(8791, "127.0.0.1", r))
const srv = spawn(process.execPath, ["server.mjs", "--port", "8799"], { cwd: here, stdio: ["ignore", "ignore", "inherit"] })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fastsim-browser-"))
const br = spawn(exe, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--no-first-run", "http://127.0.0.1:8791/"], { stdio: "ignore" })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = (...a) => process.stdout.write(a.join(" ") + "\n")
try {
  let target
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(300)
    try { target = (await (await fetch("http://127.0.0.1:9333/json")).json()).find(t => t.type === "page") } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => (ws.onopen = r))
  let n = 0
  const waiting = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) out("  [console]", m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 300))
    if (m.method === "Runtime.exceptionThrown") out("  [exception]", JSON.stringify(m.params.exceptionDetails).slice(0, 400))
    if (m.id && waiting.has(m.id)) waiting.get(m.id)(m)
  }
  const send = (method, params = {}) => new Promise(r => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  await send("Runtime.enable")
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails))
    return r.result.result.value
  }
  for (let i = 0; i < 50; i++) {
    if (await ev("return !!globalThis.__fastsim").catch(() => false)) break
    await sleep(200)
  }
  out("mode:", await ev("return await __fastsim.detectMode()"))
  const team = JSON.parse(fs.readFileSync(path.join(here, "data", "team.json"), "utf8"))
  let t0 = Date.now()
  // the browser build has no game data yet: hand it over like the userscript's site sync does
  const envelope = fs.readFileSync(path.join(here, "data", "envelope.json"), "utf8")
  const players = team.members.map(p => ({ ...p, selected: team.selected.map(String).includes(String(p.id)) }))
  await ev(`await __fastsim.call("POST", "/api/sync", { store: ${JSON.stringify({ players, simulationSettings: team.settings })}, gameDataRaw: ${JSON.stringify(envelope)} }); return await __fastsim.call("GET", "/api/options").then(o => o.zones.length)`)
  const st = await ev(`return await __fastsim.call("GET", "/api/state")`)
  out(`browser engine up in ${Date.now() - t0} ms:`, JSON.stringify(st.engine), "market", st.market?.timestamp)
  const members = team.selected.map(id => team.members.find(p => String(p.id) === String(id)))
  const o = await (await fetch("http://127.0.0.1:8799/api/options")).json().catch(() => null)
  const zone = o?.zones?.[0]?.hrid || "/actions/combat/golem_cave"
  const body = { members, target: { kind: "zone", zoneHrid: zone, difficultyTier: 1 }, hours: 24, seeds: 16, extra: { mooPass: true, comExp: 20, comDrop: 20 } }
  t0 = Date.now()
  const b = await ev(`const r = await __fastsim.call("POST", "/api/simulate", ${JSON.stringify(body)}); return r.mean`)
  const tb = Date.now() - t0
  // the server loads its engine lazily: wait for it
  let s
  for (let i = 0; i < 120; i++) {
    try {
      const st2 = await (await fetch("http://127.0.0.1:8799/api/state")).json()
      if (st2.engine) break
    } catch {}
    await sleep(500)
  }
  t0 = Date.now()
  s = await (await fetch("http://127.0.0.1:8799/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()
  const ts = Date.now() - t0
  out(`simulate 16 x 24h: browser ${tb} ms, server ${ts} ms; profit/day browser ${(b.profitPerHour * 24 / 1e6).toFixed(3)}M server ${(s.mean.profitPerHour * 24 / 1e6).toFixed(3)}M; xp/deaths/encounters identical: ${["xpPerHour", "deathsPerHour", "encountersPerHour"].every(k => b[k] === s.mean[k])}, all identical: ${JSON.stringify(b) === JSON.stringify(s.mean)}`)
  const st3 = await (await fetch("http://127.0.0.1:8799/api/state")).json()
  out(`market: browser ${st.market?.timestamp} server ${st3.market?.timestamp} (profit only matches with the same prices)`)
  // a small job
  t0 = Date.now()
  const { id } = await ev(`return await __fastsim.call("POST", "/api/jobs", ${JSON.stringify({ type: "consumables", params: { ...body, rounds: 1, swapItems: false } })})`)
  let j
  do {
    await sleep(1000)
    j = await ev(`return await __fastsim.call("GET", "/api/jobs/${id}")`)
  } while (j.status === "running")
  out(`browser job consumables: ${j.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s ${j.error ? j.error.split("\n")[0] : ""}; ${j.log.at(-1)?.msg || ""}`)
  // every job type that runs in the browser, with tiny settings
  for (const [type, extra] of [["upgrades", { hours: 2, seeds: 2, budgets: [5e8, 5e8, 5e8], horizons: [30] }], ["skills", { rounds: 1, stages: [{ hours: 1, seeds: 2, keep: 3 }] }]]) {
    t0 = Date.now()
    const { id: jid } = await ev(`return await __fastsim.call("POST", "/api/jobs", ${JSON.stringify({ type, params: { ...body, ...extra } })})`)
    let jj
    do {
      await sleep(1000)
      jj = await ev(`return await __fastsim.call("GET", "/api/jobs/${jid}")`)
    } while (jj.status === "running")
    out(`browser job ${type}: ${jj.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s ${jj.error ? jj.error.split("\n")[0] : ""}; ${jj.log.at(-1)?.msg || ""}`)
  }
  const text = async () => (await ev(`return document.body.innerText`)).replace(/\s+/g, " ").slice(0, 1400)
  await ev(`location.hash = "#/team"`)
  await sleep(1500)
  out("browser-mode page:", await text())
  await send("Page.navigate", { url: "http://127.0.0.1:8799/#/team" })
  await sleep(4000)
  out("server-mode page:", await text())
  // gear cost page: preset the form, click 计算
  await ev(`localStorage.setItem("fastsim-gear-cost", JSON.stringify({ hrid: "/items/blooming_trident_refined", level: 14, tax: 5, hasHeld: true, heldHrid: "/items/blooming_trident", heldLevel: 12 }))`)
  await send("Page.navigate", { url: "http://127.0.0.1:8799/#/gear-cost" })
  await sleep(3000)
  await ev(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("计算")).click()`)
  await sleep(1500)
  out("gear-cost page:", (await text()).replace(/^.*?装备获取成本 选一件/, "…").slice(0, 900))
} catch (e) {
  out("ERROR", e.stack)
} finally {
  br.kill()
  srv.kill()
  stat.close()
  process.exit(0)
}
