// mwi-fastsim local server.
//   node server.mjs [--port 8765] [--threads N] [--bin path/to/mwi-fastsim(.exe)]
//
// - /simulate, /status: accelerator for the site (used by the userscript)
// - /api/*: the local web app (team sync, simulation, optimizers)
// - /: the web app (web/dist)
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import crypto from "node:crypto"
import { compilePayload, exportGameData } from "./app/engine-core.mjs"
import { ENGINE_VERSION, Game, normalizeEnvelope } from "./app/game.mjs"
import { RustEngine } from "./rust-client.mjs"
import { PriceBook } from "./app/metrics.mjs"
import { Evaluator } from "./app/evaluator.mjs"
import { Jobs } from "./app/jobs.mjs"
import { teamDTO } from "./app/model.mjs"
import { options } from "./app/options.mjs"
import { decodeGameData } from "./app/gamedata.mjs"
import { gearCost, jobRoutes, selectedMembers, simulate, skillPools, teamFromGame, teamFromSite } from "./app/routes-core.mjs"

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const PORT = Number(args.port || 8765)
const THREADS = Number(args.threads || os.cpus().length)
const here = path.dirname(fileURLToPath(import.meta.url))
const exe = process.platform === "win32" ? "mwi-fastsim.exe" : "mwi-fastsim"
const BIN = args.bin || path.join(here, "..", "engine", "target", "release", exe)
const CACHE = path.join(here, "cache")
const DATA = path.join(here, "data")
const WEB = path.join(here, "..", "web", "dist")
const MARKET_URL = "https://www.milkywayidle.com/game_data/marketplace.json"
for (const d of [CACHE, DATA]) fs.mkdirSync(d, { recursive: true })

console.log = ((orig) => (...a) => {
  if (typeof a[0] === "string" && a[0].startsWith("[fastsim]")) orig(...a)
})(console.log)
const log = (...a) => console.log("[fastsim]", ...a)
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {
    return d
  }
}
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v))

// ------------------------------------------------------------------ engine context

let ctx = null // { m: Game, rust, gdHash, book, ev }
let loading = null
let market = readJson(path.join(DATA, "market.json"), null)

const NO_DATA = "还没有游戏数据：装好油猴脚本后打开一次游戏页面（会自动读取），或在模拟网站上点“网站队伍同步到本地”"

function writeGameData(game) {
  const gd = exportGameData(game)
  const hash = crypto.createHash("sha1").update(JSON.stringify(gd)).digest("hex").slice(0, 16)
  const file = path.join(CACHE, `gamedata-${hash}.json`)
  if (!fs.existsSync(file)) writeJson(file, gd)
  return { hash, file }
}

/** Starts the engine on a game data envelope, or switches the running one to it. */
async function useGameData(envelope) {
  const game = new Game(envelope)
  const gd = writeGameData(game)
  if (ctx) {
    if (gd.hash !== ctx.gdHash) {
      await ctx.rust.reloadGameData(gd.file)
      ctx.gdHash = gd.hash
      log(`game data updated: ${game.version} (${gd.hash})`)
    }
    ctx.m = game
    ctx.book = new PriceBook(game.$e, market?.marketData)
    return ctx
  }
  const st = { m: game, rust: new RustEngine(BIN, gd.file, THREADS), gdHash: gd.hash, mode: "rust" }
  st.book = new PriceBook(game.$e, market?.marketData)
  st.ev = new Evaluator(st)
  ctx = st
  log(`engine ready: game data ${game.version} (${gd.hash})`)
  return st
}

async function ensureEngine() {
  if (ctx) return ctx
  if (!loading) {
    const env = readJson(path.join(DATA, "envelope.json"), null)
    if (!env) throw new Error(NO_DATA)
    loading = useGameData(env).finally(() => { loading = null })
  }
  return loading
}

/** New game data from the game page / the sim site: keep it and use it. */
let lastEnvelopeKey = ""
async function applyEnvelope(envelope) {
  if (!envelope) return ensureEngine()
  // the sim site sends its game data with every simulation: only switch when it is a new capture
  const key = `${envelope.gameVersion}|${envelope.versionTimestamp}|${envelope.capturedAt}`
  if (ctx && key === lastEnvelopeKey) return ctx
  const st = await useGameData(envelope)
  writeJson(path.join(DATA, "envelope.json"), envelope)
  lastEnvelopeKey = key
  return st
}

async function refreshMarket() {
  try {
    const r = await fetch(MARKET_URL)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    market = await r.json()
    writeJson(path.join(DATA, "market.json"), market)
    if (ctx) ctx.book = new PriceBook(ctx.m.$e, market.marketData)
    log(`market prices updated (${new Date(market.timestamp * 1000).toLocaleString()})`)
  } catch (e) {
    log(`market refresh failed: ${e.message}`)
  }
}

// ------------------------------------------------------------------ site accelerator

let stats = { jobs: 0, simHours: 0, engineMs: 0, since: Date.now() }

async function accelerate(body) {
  const { payload, lite } = body
  if (!payload || payload.type !== "start_simulation") throw new Error("not a start_simulation payload")
  const st = payload.gameDataEnvelope ? await applyEnvelope(normalizeEnvelope(payload.gameDataEnvelope)) : await ensureEngine()
  const p = { ...payload }
  delete p.gameDataEnvelope
  writeJson(path.join(DATA, "last-site-payload.json"), p)
  const out = await st.rust.run(compilePayload(st.m, p), { attacks: !lite })
  stats.engineMs += out.ms
  const mode = p.combatMode || (p.labyrinth ? "labyrinth" : "normal")
  const tail = JSON.stringify({ engineVersion: ENGINE_VERSION, combatMode: mode, seed: p.seed }).slice(1)
  stats.jobs++
  stats.simHours += (p.simulationTimeLimit || 0) / 3600e9
  return `{"simResult":${out.raw.slice(0, -1)},${tail}}`
}

// ------------------------------------------------------------------ app API

const jobs = new Jobs(path.join(DATA, "jobs"))

function loadTeam() {
  return readJson(path.join(DATA, "team.json"), { members: [], selected: [], settings: {}, syncedAt: 0 })
}

/**
 * Compares our config -> worker DTO conversion with the players the site itself last sent to its
 * worker (captured by the accelerator), for members present in both.
 */
function checkDTO(st, team) {
  const site = readJson(path.join(DATA, "last-site-payload.json"), null)
  if (!site?.players?.length) return { summary: "尚无网站模拟记录（在网站上跑一次模拟后再同步即可核对）", ok: null }
  const members = selectedMembers(team)
  if (members.length !== site.players.length) return { summary: `网站最近一次模拟是 ${site.players.length} 人，当前选择 ${members.length} 人，未核对`, ok: null }
  const ours = teamDTO(st.m, members)
  const sort = v => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v)
  const diffs = []
  const walk = (a, b, p) => {
    if (JSON.stringify(sort(a)) === JSON.stringify(sort(b))) return
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${p}.${k}`)
    } else diffs.push(`${p}: 本地=${JSON.stringify(a)} 网站=${JSON.stringify(b)}`)
  }
  ours.forEach((o, i) => walk(o, site.players[i], `队员${i + 1}`))
  return { ok: diffs.length === 0, summary: diffs.length ? `${diffs.length} 处不一致` : "与网站生成的数据完全一致", diffs: diffs.slice(0, 50) }
}

async function api(req, url, body) {
  const p = url.pathname
  if (p === "/api/state" && req.method === "GET") {
    return {
      team: loadTeam(),
      engine: ctx ? { mode: ctx.mode, gameVersion: ctx.m.version, gameData: ctx.gdHash, threads: THREADS } : null,
      market: market ? { timestamp: market.timestamp } : null,
    }
  }
  if (p === "/api/sync" && req.method === "POST") {
    // from the userscript on the site: the "simulator" store + plugin game data
    const env = body.gameDataRaw ? decodeGameData(body.gameDataRaw) : null
    const st = await applyEnvelope(env)
    const team = teamFromSite(body)
    const players = team.members
    team.dtoCheck = checkDTO(st, team)
    writeJson(path.join(DATA, "team.json"), team)
    log(`team synced: ${players.map(pl => pl.name).join(", ")}; DTO check: ${team.dtoCheck?.summary}`)
    return { ok: true, members: players.length, gameData: !!env, dtoCheck: team.dtoCheck }
  }
  if (p === "/api/game" && req.method === "POST") {
    // from the userscript on the game page: team envelope (current character + teammates'
    // shared profiles) and the game's initClientData
    const env = body.initClientData ? decodeGameData({ compressedInitClientData: body.initClientData, capturedAt: Date.now() }) : null
    const st = await applyEnvelope(env)
    writeJson(path.join(DATA, "game-envelope.json"), body.envelope)
    const { team, reply } = teamFromGame(st.m, body.envelope, loadTeam())
    writeJson(path.join(DATA, "team.json"), team)
    log(`team from game: ${team.members.map(pl => `${pl.name}(${pl.source})`).join(", ")}${team.missing.length ? `; missing ${team.missing.join(", ")}` : ""}`)
    return reply
  }
  if (p === "/api/team" && req.method === "PUT") {
    writeJson(path.join(DATA, "team.json"), { ...loadTeam(), ...body })
    return { ok: true }
  }
  if (p === "/api/loadouts" && req.method === "GET") return readJson(path.join(DATA, "loadouts.json"), [])
  if (p === "/api/loadouts" && req.method === "PUT") {
    writeJson(path.join(DATA, "loadouts.json"), body)
    return { ok: true }
  }
  const st = await ensureEngine()
  if (p === "/api/options" && req.method === "GET") return options(st.m, st.book)
  if (p === "/api/market/refresh" && req.method === "POST") {
    await refreshMarket()
    return { timestamp: market?.timestamp }
  }
  if (p === "/api/dto" && req.method === "POST") return teamDTO(st.m, body.members)
  if (p === "/api/skill-pools" && req.method === "POST") return skillPools(st.m, body)
  if (p === "/api/simulate" && req.method === "POST") return simulate(st, body)
  if (p === "/api/gear-cost" && req.method === "POST") return gearCost(st.m, st.book, body)
  const jr = jobRoutes(jobs, st, req.method, p, body)
  if (jr !== undefined) return jr
  throw Object.assign(new Error("not found"), { status: 404 })
}

// ------------------------------------------------------------------ http

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" }

function serveStatic(url, res) {
  let f = path.normalize(path.join(WEB, decodeURIComponent(url.pathname)))
  if (!f.startsWith(WEB)) f = WEB
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(WEB, "index.html")
  if (!fs.existsSync(f)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    return res.end("web/dist 不存在：请先在 web 目录执行 npm run build")
  }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" })
  fs.createReadStream(f).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": req.headers.origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
  }
  const url = new URL(req.url, "http://localhost")
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors)
    return res.end()
  }
  const readBody = async () => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const s = Buffer.concat(chunks).toString("utf8")
    return s ? JSON.parse(s) : {}
  }
  try {
    if (url.pathname === "/status" && req.method === "GET") {
      res.writeHead(200, { ...cors, "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true, mode: ctx?.mode ?? "idle", gameData: ctx?.gdHash ?? null, threads: THREADS, ...stats }))
    }
    if (url.pathname === "/simulate" && req.method === "POST") {
      const text = await accelerate(await readBody())
      res.writeHead(200, { ...cors, "content-type": "application/json" })
      return res.end(text)
    }
    if (url.pathname.startsWith("/api/")) {
      const out = await api(req, url, req.method === "GET" ? {} : await readBody())
      res.writeHead(200, { ...cors, "content-type": "application/json" })
      return res.end(JSON.stringify(out))
    }
    serveStatic(url, res)
  } catch (e) {
    res.writeHead(e.status || 500, { ...cors, "content-type": "application/json" })
    res.end(JSON.stringify({ error: String(e?.message || e) }))
  }
})

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT} (${THREADS} threads, engine ${BIN})`)
  ensureEngine().catch(e => log(`engine not started: ${e.message}`))
})
if (!market || Date.now() / 1000 - market.timestamp > 1800) refreshMarket()
setInterval(refreshMarket, 30 * 60 * 1000).unref()
setInterval(() => {
  if (!stats.jobs) return
  log(`${stats.jobs} site sims, ${stats.simHours.toFixed(1)} sim-hours in ${((Date.now() - stats.since) / 1000).toFixed(0)}s`)
  stats = { jobs: 0, simHours: 0, engineMs: 0, since: Date.now() }
}, 30000).unref()
