// Per-player metrics from a simResult, ported from the site's CombatHeader (`o0`, `s0`, `a0`,
// `u0`) and simulationStatistics (`Ie`). Prices: { [itemHrid]: { ask, bid, vendor } }.

const HOUR = 3600e9
const PLAYERS = new Set(["player1", "player2", "player3", "player4", "player5"])
const KEY_ARTISAN = 0.897
const CHESTS = ["/items/small_treasure_chest", "/items/medium_treasure_chest", "/items/large_treasure_chest"]

const SKILL_KEYS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

export class PriceBook {
  /** maps: the engine's game data maps ($e); market: marketplace.json `marketData` */
  constructor(maps, market) {
    this.maps = maps
    const vendor = h => Math.max(0, num(maps.itemDetailMap[h]?.sellPrice, 0))
    this.vendor = vendor
    const t = {}
    for (const it of Object.values(maps.itemDetailMap)) t[it.hrid] = { ask: -1, bid: -1, vendor: vendor(it.hrid) }
    for (const [h, lv] of Object.entries(market || {})) {
      const a = lv?.["0"]
      if (!a || typeof a !== "object") continue
      const u = t[h] || { ask: -1, bid: -1, vendor: vendor(h) }
      t[h] = { ask: num(a.a, u.ask), bid: num(a.b, u.bid), vendor: u.vendor }
    }
    this.table = t
    this.market = market || {}
    this.addChests()
  }

  /** `Um` + `Ki` */
  price(hrid, mode = "bid") {
    const e = this.table[hrid]
    if (!e) return this.vendor(hrid)
    const n = num(e.ask, -1)
    const i = num(e.bid, -1)
    const o = Math.max(0, num(e.vendor, 0))
    const v = mode === "vendor" ? o : mode === "bid" ? (i >= 0 ? i : n >= 0 ? n : o) : n >= 0 ? n : i >= 0 ? i : o
    return Math.max(0, num(v, 0))
  }

  /** `qm`: price, or value via single-cost shop conversions. */
  priceOrShop(hrid, mode) {
    const p = this.price(hrid, mode)
    if (p > 0) return p
    let best = 0
    for (const s of Object.values(this.maps.shopItemDetailMap || {})) {
      const costs = Array.isArray(s?.costs) ? s.costs : []
      if (costs.length !== 1 || costs[0]?.itemHrid !== hrid) continue
      const count = Math.max(0, num(costs[0]?.count, 0))
      if (count <= 0 || !s.itemHrid || s.itemHrid === hrid) continue
      best = Math.max(best, this.price(s.itemHrid, mode) / count)
    }
    return Math.max(0, best)
  }

  /** `ki`: expected value of an openable. */
  openValue(hrid, mode, seen = new Set()) {
    const drops = this.maps.openableLootDropMap?.[hrid]
    if (!Array.isArray(drops) || seen.has(hrid)) return 0
    const s2 = new Set(seen).add(hrid)
    let v = 0
    for (const d of drops) {
      const rate = Math.max(0, num(d?.dropRate, 0))
      const avg = (Math.max(0, num(d?.minCount, 0)) + Math.max(0, num(d?.maxCount, 0))) / 2
      const p = Array.isArray(this.maps.openableLootDropMap[d.itemHrid]) ? this.openValue(d.itemHrid, mode, s2) : this.priceOrShop(d.itemHrid, mode)
      v += p * rate * avg
    }
    return Math.max(0, v)
  }

  /** `bl`: coin = 1, chests valued by contents. */
  addChests() {
    this.table["/items/coin"] = { ask: 1, bid: 1, vendor: 1 }
    const dungeonChests = Object.values(this.maps.actionDetailMap).flatMap(a =>
      a?.combatZoneInfo?.isDungeon !== true ? [] : (a.combatZoneInfo.dungeonInfo?.rewardDropTable || []).map(d => d.itemHrid).filter(h => Array.isArray(this.maps.openableLootDropMap?.[h])))
    for (const h of new Set([...CHESTS, ...dungeonChests]))
      this.table[h] = { ask: this.openValue(h, "ask"), bid: this.openValue(h, "bid"), vendor: this.openValue(h, "vendor") }
  }

  /** Market quote of an enhanced item: { ask, bid } or null. */
  enhancedQuote(hrid, level) {
    const q = this.market[hrid]?.[String(level)]
    if (!q) return null
    const ask = num(q.a, -1)
    const bid = num(q.b, -1)
    return ask < 0 && bid < 0 ? null : { ask, bid }
  }
}

function add(map, k, v) {
  const n = Math.max(0, num(v, 0))
  if (!k || n <= 0) return
  map.set(k, num(map.get(k), 0) + n)
}

function dungeonInfo(maps, r) {
  const z = maps.actionDetailMap[String(r?.zoneName || "")]
  return z?.combatZoneInfo?.isDungeon === true ? z.combatZoneInfo.dungeonInfo : null
}

function chestRate(d, tier) {
  if (String(d?.itemHrid || "").endsWith("_refinement_chest")) return tier >= 2 ? 1 : tier === 1 ? 1 / 3 : 0
  return Math.max(0, Math.min(1, num(d?.dropRate, 0) + num(d?.dropRatePerDifficultyTier, 0) * tier))
}

function keyInputs(maps, hrid) {
  if (!hrid) return []
  const aid = hrid.startsWith("/items/") ? hrid.replace("/items/", "/actions/crafting/") : ""
  const act = (aid ? maps.actionDetailMap[aid] : null)
    || Object.values(maps.actionDetailMap).find(a => (a?.outputItems || []).some(o => o?.itemHrid === hrid))
  if (!act || String(act.category || act.categoryHrid || "") !== "/action_categories/crafting/dungeon_keys") return []
  const out = (act.outputItems || []).find(o => o?.itemHrid === hrid)
  const cnt = Math.max(0, num(out?.count, 0))
  if (cnt <= 0) return []
  return (act.inputItems || []).map(i => ({ itemHrid: i.itemHrid, count: Math.max(0, num(i.count, 0)) / cnt })).filter(i => i.itemHrid && i.count > 0)
}

function addKeyCost(maps, costs, hrid, amount) {
  const n = Math.max(0, num(amount, 0))
  if (!hrid || n <= 0) return
  const ins = keyInputs(maps, hrid)
  if (!ins.length) return add(costs, hrid, n)
  for (const i of ins) add(costs, i.itemHrid, i.count * n * KEY_ARTISAN)
}

function dungeonRewards(maps, r, pid, drops) {
  const info = dungeonInfo(maps, r)
  const done = Math.max(0, Math.floor(num(r?.dungeonsCompleted, 0)))
  if (!info || done <= 0) return []
  const tier = Math.max(0, Math.floor(num(r?.difficultyTier, 0)))
  const np = Math.max(1, Math.floor(num(r?.numberOfPlayers, 1)))
  const qty = 1 + Math.max(0, num(r?.combatDropQuantity?.[pid], 0))
  const out = []
  for (const d of info.rewardDropTable || []) {
    const amount = (done * chestRate(d, tier) * ((num(d?.minCount, 0) + num(d?.maxCount, 0)) / 2) * qty) / np
    add(drops, d?.itemHrid, amount)
    if (amount > 0) out.push({ itemHrid: d.itemHrid, amount })
  }
  return out
}

function dungeonKeyCosts(maps, r, rewards, costs) {
  const key = String(dungeonInfo(maps, r)?.keyItemHrid || "")
  for (const u of rewards) {
    const s = Math.max(0, num(u?.amount, 0))
    if (s <= 0) continue
    if (!String(u.itemHrid || "").endsWith("_refinement_chest")) addKeyCost(maps, costs, key, s)
    addKeyCost(maps, costs, String(maps.itemDetailMap[u.itemHrid]?.openKeyItemHrid || ""), s)
  }
}

function monsterDrops(maps, monster, deaths, r, pid, out) {
  const mon = maps.combatMonsterDetailMap[monster]
  if (!mon || deaths <= 0) return
  const o = {
    deaths: Math.floor(num(deaths, 0)),
    tier: Math.max(0, Math.floor(num(r.difficultyTier, 0))),
    dropRate: num(r.dropRateMultiplier?.[pid], 1),
    rareFind: num(r.rareFindMultiplier?.[pid], 1),
    qty: num(r.combatDropQuantity?.[pid], 0),
    gap: num(r.debuffOnLevelGap?.[pid], 0),
    np: Math.max(1, Math.floor(num(r.numberOfPlayers, 1))),
  }
  if (o.deaths <= 0) return
  const table = (list, rare) => {
    for (const i of list || []) {
      if (num(i.minDifficultyTier, 0) > o.tier) continue
      let p
      if (rare) p = num(i.dropRate, 0) * o.rareFind
      else {
        const c = num(i.dropRate, 0) + num(i.dropRatePerDifficultyTier, 0) * o.tier
        p = Math.min(1, Math.min(1, c * (1 + 0.1 * o.tier)) * o.dropRate)
      }
      if (p <= 0) continue
      const s = ((num(i.minCount, 0) + num(i.maxCount, 0)) / 2) * (1 + o.gap) * (1 + o.qty)
      add(out, i.itemHrid, (o.deaths * p * s) / o.np)
    }
  }
  table(mon.dropTable, false)
  table(mon.rareDropTable, true)
}

function activePlayer(r, id) {
  const want = `player${String(id || "1").replace(/^player/, "")}`
  return PLAYERS.has(want) ? want : "player1"
}

/** `o0`: revenue / expenses / profit over the whole run for one player. */
export function profit(book, r, playerId, { dropMode = "bid", consumableMode = "ask" } = {}) {
  const maps = book.maps
  const pid = activePlayer(r, playerId)
  const drops = new Map()
  let rewards = []
  if (r.isDungeon) rewards = dungeonRewards(maps, r, pid, drops)
  else for (const [h, n] of Object.entries(r.deaths ?? {})) if (!PLAYERS.has(h)) monsterDrops(maps, h, n, r, pid, drops)
  const costs = new Map()
  for (const [h, n] of Object.entries(r.consumablesUsed?.[pid] ?? {})) add(costs, h, n)
  if (r.isDungeon) dungeonKeyCosts(maps, r, rewards, costs)
  const total = (m, mode) => {
    let t = 0
    const rows = []
    for (const [h, a] of m) {
      const p = book.price(h, mode)
      t += a * p
      rows.push({ itemHrid: h, amount: a, unitPrice: p, total: a * p })
    }
    rows.sort((x, y) => y.total - x.total)
    return { t, rows }
  }
  const rev = total(drops, dropMode)
  const exp = total(costs, consumableMode)
  return { revenue: rev.t, expenses: exp.t, profit: rev.t - exp.t, revenueItems: rev.rows, expenseItems: exp.rows }
}

/** `s0` */
export function effectiveTime(r) {
  const t = Math.max(0, num(r?.simulatedTime, 0))
  if (!r?.isDungeon || num(r?.dungeonTerminalTrackingVersion, 0) < 1) return t
  return Math.min(t, Math.max(0, num(r?.lastDungeonFinishTime, 0)))
}

/** `a0` */
export function runs(r) {
  return r?.isDungeon ? Math.max(0, num(r.dungeonsCompleted, 0)) + Math.max(0, num(r.dungeonsFailed, 0)) : Math.max(0, num(r?.encounters, 0))
}

/** `u0` */
export function outOfManaRatio(r, pid) {
  const t = Math.max(0, num(r?.simulatedTime, 0))
  if (t <= 0) return 0
  const n = r?.playerRanOutOfManaTime?.[pid]
  if (!n) return 0
  let i = Math.max(0, num(n.totalTimeForOutOfMana, 0))
  if (n.isOutOfMana) i += Math.max(0, t - Math.max(0, num(n.startTimeForOutOfMana, 0)))
  return Math.max(0, Math.min(1, i / t))
}

/** `Ie`: per-hour metrics of one player. */
export function playerMetrics(book, r, playerId) {
  const pid = activePlayer(r, playerId)
  const t = effectiveTime(r)
  const hours = t > 0 ? t / HOUR : Infinity
  const xp = Object.values(r?.experienceGained?.[pid] || {}).reduce((a, b) => a + num(b, 0), 0)
  const lo = profit(book, r, pid, { dropMode: "bid", consumableMode: "ask" })
  const hi = profit(book, r, pid, { dropMode: "ask", consumableMode: "bid" })
  const bySkill = Object.fromEntries(SKILL_KEYS.map(k => [`xp_${k}`, num(r?.experienceGained?.[pid]?.[k], 0) / hours]))
  return {
    ...bySkill,
    xpPerHour: xp / hours,
    encountersPerHour: runs(r) / hours,
    deathsPerHour: num(r?.deaths?.[pid], 0) / hours,
    revenuePerHour: lo.revenue / hours,
    expensesPerHour: lo.expenses / hours,
    profitPerHour: lo.profit / hours,
    profitUpperPerHour: hi.profit / hours,
    profitMidpointPerHour: (lo.profit + hi.profit) / 2 / hours,
    outOfManaTimeRatio: outOfManaRatio(r, pid),
  }
}

/** Team totals (sum over members; per-hour). */
export function teamMetrics(book, r, n) {
  const per = Array.from({ length: n }, (_, i) => playerMetrics(book, r, `player${i + 1}`))
  const sum = k => per.reduce((a, p) => a + p[k], 0)
  return {
    players: per,
    xpPerHour: sum("xpPerHour"),
    profitPerHour: sum("profitPerHour"),
    profitMidpointPerHour: sum("profitMidpointPerHour"),
    deathsPerHour: sum("deathsPerHour"),
    encountersPerHour: per[0]?.encountersPerHour ?? 0,
    outOfManaTimeRatio: Math.max(0, ...per.map(p => p.outOfManaTimeRatio)),
  }
}
