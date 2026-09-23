// The app's /api/* routes, served inside the browser (static deployment): the game data (captured
// from the game by the userscript) and the app logic run on the main thread, the Rust engine runs
// as wasm in a pool of Web Workers, and state lives in IndexedDB. Mirrors node/server.mjs.
import { exportGameData } from "@app/engine-core.mjs"
import { Game } from "@app/game.mjs"
import { PriceBook } from "@app/metrics.mjs"
import { Evaluator } from "@app/evaluator.mjs"
import { teamDTO } from "@app/model.mjs"
import { options } from "@app/options.mjs"
import { decodeGameData } from "@app/gamedata.mjs"
import { hash53 } from "@app/hash.mjs"
import { gearCost, jobRoutes, simulate, skillPools, teamFromGame, teamFromSite } from "@app/routes-core.mjs"
import { kvGet, kvSet } from "./kv.js"
import { Jobs } from "./jobs.js"
import { WasmPool } from "./pool.js"

const BASE = import.meta.env.BASE_URL
const MARKET_URL = "https://www.milkywayidle.com/game_data/marketplace.json"
const EMPTY_TEAM = { members: [], selected: [], settings: {}, syncedAt: 0 }

let ctx = null
let loading = null
let market = null
const jobs = new Jobs()

const NO_DATA = "还没有游戏数据：装好油猴脚本后打开一次游戏页面（会自动读取），再刷新本页"

async function refreshMarket() {
  try {
    const r = await fetch(MARKET_URL, { cache: "no-cache" })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    market = await r.json()
    await kvSet("market", market)
    if (ctx) ctx.book = new PriceBook(ctx.m.$e, market.marketData)
  } catch (e) {
    console.warn("[fastsim] market refresh failed", e)
  }
}

/** Starts the engine on a game data envelope, or switches the running one to it. */
async function useGameData(envelope) {
  const game = new Game(envelope)
  const gd = JSON.stringify(exportGameData(game))
  const h = hash53(gd)
  if (ctx) {
    if (h !== ctx.gdHash) {
      await ctx.rust.reloadGameData(gd)
      ctx.gdHash = h
    }
    ctx.m = game
    ctx.book = new PriceBook(game.$e, market?.marketData)
    return ctx
  }
  const rust = await WasmPool.create(`${BASE}engine/mwi_engine.wasm`, gd)
  const st = { m: game, rust, gdHash: h, mode: "wasm" }
  st.book = new PriceBook(game.$e, market?.marketData)
  st.ev = new Evaluator(st)
  ctx = st
  setInterval(refreshMarket, 30 * 60 * 1000)
  return st
}

function ensureEngine() {
  if (ctx) return Promise.resolve(ctx)
  loading ||= (async () => {
    market = await kvGet("market")
    if (!market || Date.now() / 1000 - market.timestamp > 1800) await refreshMarket()
    const env = await kvGet("envelope")
    if (!env) throw new Error(NO_DATA)
    return useGameData(env)
  })()
  loading.catch(() => {}).finally(() => { loading = null })
  return loading
}

async function applyEnvelope(env) {
  if (!env) return ensureEngine()
  if (!ctx && !market) market = await kvGet("market")
  if (!market) await refreshMarket()
  const st = await useGameData(env)
  await kvSet("envelope", env)
  return st
}

export async function localApi(method, p, body = {}) {
  if (p === "/api/state" && method === "GET") {
    return {
      team: await kvGet("team", EMPTY_TEAM),
      engine: ctx ? { mode: "wasm", gameVersion: ctx.m.version, gameData: ctx.gdHash, threads: ctx.rust.threads } : null,
      market: market ? { timestamp: market.timestamp } : null,
    }
  }
  if (p === "/api/team" && method === "PUT") {
    await kvSet("team", { ...(await kvGet("team", EMPTY_TEAM)), ...body })
    return { ok: true }
  }
  if (p === "/api/loadouts" && method === "GET") return kvGet("loadouts", [])
  if (p === "/api/loadouts" && method === "PUT") {
    await kvSet("loadouts", body)
    return { ok: true }
  }
  if (p === "/api/sync" && method === "POST") {
    const env = body.gameDataRaw ? decodeGameData(body.gameDataRaw) : null
    await applyEnvelope(env)
    const team = teamFromSite(body)
    team.dtoCheck = { summary: "浏览器版不核对", ok: null }
    await kvSet("team", team)
    return { ok: true, members: team.members.length, gameData: !!env, dtoCheck: team.dtoCheck }
  }
  if (p === "/api/game" && method === "POST") {
    const env = body.initClientData ? decodeGameData({ compressedInitClientData: body.initClientData, capturedAt: Date.now() }) : null
    const st = await applyEnvelope(env)
    const { team, reply } = teamFromGame(st.m, body.envelope, await kvGet("team", EMPTY_TEAM))
    await kvSet("team", team)
    return reply
  }
  const st = await ensureEngine()
  if (p === "/api/options" && method === "GET") return options(st.m, st.book)
  if (p === "/api/market/refresh" && method === "POST") {
    await refreshMarket()
    return { timestamp: market?.timestamp }
  }
  if (p === "/api/dto" && method === "POST") return teamDTO(st.m, body.members)
  if (p === "/api/skill-pools" && method === "POST") return skillPools(st.m, body)
  if (p === "/api/simulate" && method === "POST") return simulate(st, body)
  if (p === "/api/gear-cost" && method === "POST") return gearCost(st.m, st.book, body)
  await jobs.ready
  const jr = jobRoutes(jobs, st, method, p, body)
  if (jr !== undefined) return jr
  throw new Error(`not found: ${method} ${p}`)
}
