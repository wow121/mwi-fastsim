// Ironcow (铁牛) evaluation: no market. Drops are worth the shop's sell price, consumables and
// dungeon keys cost the hours to make them by hand (craft.mjs), and the chosen target items
// (1–5, weighted) count by expected amount, chests opened into their contents.
// A character cannot fight and craft at once, so everything is per "cycle hour": the combat hours
// plus the hand-work hours the team needs to replace what it used (the slowest member's, since the
// party fights together).
import { compilePayload } from "../engine-core.mjs"
import { buildPayload } from "../model.mjs"
import { activePlayer, dungeonInfo, effectiveTime, outOfManaRatio, playerDrops, runs } from "../metrics.mjs"
import { OBJECTIVE_FORMATS } from "../evaluator.mjs"
import { CraftTimes } from "./craft.mjs"

const HOUR = 3600e9
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

export const IRONCOW_OBJECTIVES = { items: "目标物品", coins: "商店卖价金币", xp: "经验" }

// optimizer logs (opt-skills / opt-consumables) format objective values through this registry
OBJECTIVE_FORMATS["ironcow-items"] = v => `${(v * 24).toFixed(2)} 个目标物品/天（含手搓时间）`
OBJECTIVE_FORMATS["ironcow-coins"] = v => `${(v * 24 / 1e6).toFixed(2)}M 商店金币/天（含手搓时间）`
OBJECTIVE_FORMATS["ironcow-xp"] = v => `${Math.round(v).toLocaleString()} 经验/小时（含手搓时间）`

/** cfg: { targets: [{ hrid, weight }], objective: "items" | "coins" | "xp", craft: craft.mjs cfg } */
export function normalizeIronCfg(cfg = {}) {
  const targets = (Array.isArray(cfg.targets) ? cfg.targets : [])
    .filter(t => t?.hrid)
    .slice(0, 5)
    .map(t => ({ hrid: String(t.hrid), weight: Math.max(0, num(t.weight, 1)) }))
  const objective = IRONCOW_OBJECTIVES[cfg.objective] ? cfg.objective : targets.length ? "items" : "coins"
  return { targets, objective: objective === "items" && !targets.length ? "coins" : objective, craft: cfg.craft || {} }
}

function add(map, k, v) {
  if (!k || !(v > 0)) return
  map.set(k, (map.get(k) || 0) + v)
}

export class IronMetrics {
  constructor(maps, book, cfg) {
    this.maps = maps
    this.book = book
    this.cfg = normalizeIronCfg(cfg)
    this.craft = new CraftTimes(maps, this.cfg.craft)
    this.weights = new Map(this.cfg.targets.map(t => [t.hrid, t.weight]))
    this.openMemo = new Map()
  }

  /** Expected target items (Map hrid -> amount) from one unit of `hrid`, opening openables. */
  targetsIn(hrid, seen = new Set()) {
    if (this.openMemo.has(hrid)) return this.openMemo.get(hrid)
    const out = new Map()
    if (this.weights.has(hrid)) out.set(hrid, 1)
    const drops = this.maps.openableLootDropMap?.[hrid]
    if (Array.isArray(drops) && !seen.has(hrid)) {
      const s2 = new Set(seen).add(hrid)
      for (const d of drops) {
        const n = Math.max(0, num(d.dropRate)) * (num(d.minCount) + num(d.maxCount)) / 2
        if (n > 0) for (const [h, a] of this.targetsIn(d.itemHrid, s2)) add(out, h, a * n)
      }
    }
    this.openMemo.set(hrid, out)
    return out
  }

  /** Keys the run used (dungeon entry keys and chest keys), as dungeonKeyCosts counts them. */
  keys(r, rewards) {
    const out = new Map()
    const entry = String(dungeonInfo(this.maps, r)?.keyItemHrid || "")
    for (const u of rewards) {
      const s = Math.max(0, num(u?.amount))
      if (s <= 0) continue
      if (!String(u.itemHrid || "").endsWith("_refinement_chest")) add(out, entry, s)
      add(out, String(this.maps.itemDetailMap[u.itemHrid]?.openKeyItemHrid || ""), s)
    }
    return out
  }

  /** One player over the whole run (totals, not per hour). */
  player(r, playerId) {
    const pid = activePlayer(r, playerId)
    const { drops, rewards } = playerDrops(this.maps, r, pid)
    let coins = 0
    const targets = new Map()
    for (const [h, a] of drops) {
      coins += a * this.book.price(h, "vendor")
      for (const [t, n] of this.targetsIn(h)) add(targets, t, a * n)
    }
    const used = new Map()
    for (const [h, n] of Object.entries(r.consumablesUsed?.[pid] ?? {})) add(used, h, num(n))
    for (const [h, n] of this.keys(r, rewards)) add(used, h, n)
    let craftSec = 0
    const missing = new Set()
    const locked = new Set()
    for (const [h, n] of used) {
      const c = this.craft.of(h)
      craftSec += c.seconds * n
      for (const x of c.missing) missing.add(x)
      for (const x of c.locked) locked.add(x)
    }
    let score = 0
    for (const [h, n] of targets) score += n * (this.weights.get(h) || 0)
    const xp = Object.values(r?.experienceGained?.[pid] || {}).reduce((a, b) => a + num(b), 0)
    return { coins, targets, score, used, craftHours: craftSec / 3600, missing, locked, xp, deaths: num(r?.deaths?.[pid]) }
  }

  /** Team metrics of one run, per cycle hour (combat + hand work) unless noted. */
  team(r, n) {
    const combat = effectiveTime(r) / HOUR
    const per = Array.from({ length: n }, (_, i) => this.player(r, `player${i + 1}`))
    const craft = Math.max(0, ...per.map(p => p.craftHours))
    const cycle = combat > 0 ? combat + craft : Infinity
    const sum = k => per.reduce((a, p) => a + p[k], 0)
    const targetsPerHour = {}
    for (const p of per) for (const [h, a] of p.targets) targetsPerHour[h] = (targetsPerHour[h] || 0) + a / cycle
    return {
      itemsPerHour: sum("score") / cycle,
      coinsPerHour: sum("coins") / cycle,
      xpPerHour: sum("xp") / cycle,
      targetsPerHour,
      craftRatio: combat > 0 ? craft / combat : 0, // hand-work hours per combat hour (slowest member)
      combatShare: cycle > 0 && Number.isFinite(cycle) ? combat / cycle : 0,
      deathsPerHour: combat > 0 ? sum("deaths") / combat : 0, // per combat hour, like the other pages
      encountersPerHour: combat > 0 ? runs(r) / combat : 0,
      outOfManaTimeRatio: Math.max(0, ...per.map((_, i) => outOfManaRatio(r, `player${i + 1}`))),
      players: per.map((p, i) => ({
        coinsPerHour: p.coins / cycle,
        itemsPerHour: p.score / cycle,
        xpPerHour: p.xp / cycle,
        craftPerCombatHour: combat > 0 ? p.craftHours / combat : 0,
        deathsPerHour: combat > 0 ? p.deaths / combat : 0,
        usedPerCombatHour: Object.fromEntries([...p.used].map(([h, a]) => [h, combat > 0 ? a / combat : 0])),
        craftSecondsPerUnit: Object.fromEntries([...p.used.keys()].map(h => [h, this.craft.seconds(h)])),
        missing: [...p.missing],
        locked: [...p.locked],
        outOfManaTimeRatio: outOfManaRatio(r, `player${i + 1}`),
      })),
    }
  }

  value(t) {
    return this.cfg.objective === "items" ? t.itemsPerHour : this.cfg.objective === "xp" ? t.xpPerHour : t.coinsPerHour
  }
}

const NUMERIC = ["itemsPerHour", "coinsPerHour", "xpPerHour", "craftRatio", "combatShare", "deathsPerHour", "encountersPerHour", "outOfManaTimeRatio"]

function average(list) {
  const avg = get => list.reduce((a, x) => a + get(x), 0) / list.length
  const out = Object.fromEntries(NUMERIC.map(k => [k, avg(x => x[k])]))
  const keys = new Set(list.flatMap(x => Object.keys(x.targetsPerHour)))
  out.targetsPerHour = Object.fromEntries([...keys].map(h => [h, avg(x => x.targetsPerHour[h] || 0)]))
  out.players = list[0].players.map((_, i) => {
    const ps = list.map(x => x.players[i])
    const o = {}
    for (const k of Object.keys(ps[0])) {
      if (typeof ps[0][k] === "number") o[k] = ps.reduce((a, p) => a + p[k], 0) / ps.length
    }
    const used = new Set(ps.flatMap(p => Object.keys(p.usedPerCombatHour)))
    o.usedPerCombatHour = Object.fromEntries([...used].map(h => [h, ps.reduce((a, p) => a + (p.usedPerCombatHour[h] || 0), 0) / ps.length]))
    o.craftSecondsPerUnit = Object.assign({}, ...ps.map(p => p.craftSecondsPerUnit))
    o.missing = [...new Set(ps.flatMap(p => p.missing))]
    o.locked = [...new Set(ps.flatMap(p => p.locked))]
    return o
  })
  return out
}

/** Same interface as Evaluator (evaluate → { mean, perSeed, value }), so the shared searches run on it. */
export class IronEvaluator {
  constructor(ctx, cfg) {
    this.ctx = ctx // { m, rust, book }
    this.metrics = new IronMetrics(ctx.m.$e, ctx.book, cfg)
    this.objective = `ironcow-${this.metrics.cfg.objective}`
  }

  async runOnce(members, target, { hours, seed, extra }) {
    const { m, rust } = this.ctx
    const out = await rust.run(compilePayload(m, buildPayload(m, members, target, { hours, seed, extra })), { attacks: false })
    return this.metrics.team(out.result, members.length)
  }

  async evaluate(members, target, { hours, seeds, extra, signal }) {
    if (signal?.aborted) throw new Error("cancelled")
    const per = await Promise.all(seeds.map(seed => this.runOnce(members, target, { hours, seed, extra })))
    const mean = average(per)
    return { mean, perSeed: per.map(p => this.metrics.value(p)), value: this.metrics.value(mean) }
  }
}
