// Team upgrade planner. Every reachable state of every slot (enhancement levels of the current
// item and its refined version, the class's upper replacement, ability levels) is simulated
// against the current team with paired seeds. Then a purchase plan is searched for each horizon:
// starting cash, income = team profit (+ other income), purchases happen as soon as the cash is
// there, and the objective is the wealth at the horizon (cash + resale value of held gear). So a
// temporary +12 that is later sold for a +14 pays its spread and sales tax twice, and the plan
// only does that when the earlier profit is worth it.
import { pool } from "./search.mjs"
import { paired, seedList } from "./evaluator.mjs"
import { zh } from "./i18n.mjs"

const clone = v => JSON.parse(JSON.stringify(v))
const ARTISAN = 0.89
const MIRROR = "/items/philosophers_mirror"
const INF = Number.POSITIVE_INFINITY
const SKILL_KEYS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]
export const SLOT_ZH = { weapon: "武器", off_hand: "副手", head: "头部", body: "身体", legs: "腿部", hands: "手部", feet: "脚部", back: "背部", neck: "项链", earrings: "耳环", ring: "戒指", pouch: "袋子" }

// the site's per-class "upper replacement" targets (simulationStatistics `re`)
const ACC = { neck: "/items/philosophers_necklace", earrings: "/items/philosophers_earrings", ring: "/items/philosophers_ring", pouch: "/items/guzzling_pouch" }
const MAGE = { head: "/items/magicians_hat", hands: "/items/chrono_gloves", feet: "/items/pathseeker_boots", back: "/items/enchanted_cloak" }
const MELEE = { head: "/items/corsair_helmet", body: "/items/maelstrom_plate_body", legs: "/items/maelstrom_plate_legs", hands: "/items/dodocamel_gauntlets", feet: "/items/pathbreaker_boots", back: "/items/sinister_cape" }
const RANGED = { head: "/items/acrobatic_hood", body: "/items/kraken_tunic", legs: "/items/kraken_chaps", hands: "/items/marksman_bracers", feet: "/items/pathfinder_boots", back: "/items/chimerical_quiver" }
const UPPER = {
  water: { weapon: "/items/rippling_trident", off_hand: "/items/bishops_codex", ...MAGE, body: "/items/royal_water_robe_top", legs: "/items/royal_water_robe_bottoms", ...ACC },
  fire: { weapon: "/items/blazing_trident", off_hand: "/items/bishops_codex", ...MAGE, body: "/items/royal_fire_robe_top", legs: "/items/royal_fire_robe_bottoms", ...ACC },
  nature: { weapon: "/items/blooming_trident", off_hand: "/items/bishops_codex", ...MAGE, body: "/items/royal_nature_robe_top", legs: "/items/royal_nature_robe_bottoms", ...ACC },
  sword: { weapon: "/items/regal_sword", off_hand: "/items/knights_aegis", ...MELEE, ...ACC },
  mace: { weapon: "/items/chaotic_flail", off_hand: "/items/knights_aegis", ...MELEE, ...ACC },
  spear: { weapon: "/items/furious_spear", off_hand: "/items/knights_aegis", ...MELEE, ...ACC },
  bow: { weapon: "/items/cursed_bow", ...RANGED, ...ACC },
  crossbow: { weapon: "/items/sundering_crossbow", off_hand: "/items/manticore_shield", ...RANGED, ...ACC },
  shield: { weapon: "/items/griffin_bulwark", head: "/items/corsair_helmet", body: "/items/anchorbound_plate_body", legs: "/items/anchorbound_plate_legs", hands: "/items/dodocamel_gauntlets", feet: "/items/pathbreaker_boots", back: "/items/sinister_cape", ...ACC },
}

function refinements(maps) {
  const out = new Map()
  for (const a of Object.values(maps.actionDetailMap)) {
    const up = a?.upgradeItemHrid
    const o = (a?.outputItems || []).find(x => maps.itemDetailMap[x?.itemHrid]?.categoryHrid === "/item_categories/equipment")
    if (!up || !o || a.retainAllEnhancement !== true) continue
    out.set(up, { after: o.itemHrid, inputs: (a.inputItems || []).filter(i => i.itemHrid !== up), outputCount: Math.max(1, Number(o.count || 1)) })
  }
  return out
}

function classOf(maps, weapon) {
  const h = String(weapon || "")
  for (const [k, list] of Object.entries(UPPER)) if (list.weapon === h || h.startsWith(list.weapon)) return k
  const dt = maps.itemDetailMap[h]?.equipmentDetail?.combatStats?.damageType || ""
  if (dt.endsWith("water")) return "water"
  if (dt.endsWith("fire")) return "fire"
  if (dt.endsWith("nature")) return "nature"
  return null
}

function bookInfo(maps) {
  const byAbility = {}
  for (const it of Object.values(maps.itemDetailMap)) {
    const a = it?.abilityBookDetail?.abilityHrid
    const xp = Number(it?.abilityBookDetail?.experienceGain || 0)
    if (a && xp > (byAbility[a]?.xp || 0)) byAbility[a] = { item: it.hrid, xp }
  }
  return byAbility
}

/**
 * Gear prices: acquisition cost of (item, level) — market ask, mirror synthesis (+N and a +(N-1)
 * pad and a Philosopher's Mirror give +(N+1); the pad of a refined item may be the normal
 * version) or buying the normal version and refining it — and the resale value after tax.
 */
export class GearPrices {
  /** opts.refinedResale: "unrefine" (default) values a refined piece as un-refined, "market" at its bid */
  constructor(maps, book, tax, opts = {}) {
    this.maps = maps
    this.book = book
    this.tax = tax
    this.refinedResale = opts.refinedResale || "unrefine"
    this.refs = refinements(maps)
    this.cap = (maps.enhancementLevelSuccessRateTable || []).length || 20
    this.mirror = book.price(MIRROR, "ask") || INF
    this.tables = new Map()
  }

  family(h) {
    let base = h
    for (const [b, r] of this.refs) if (r.after === h) base = b
    const r = this.refs.get(base)
    const refineCost = r ? r.inputs.reduce((s, i) => s + this.book.price(i.itemHrid, "ask") * (Number(i.count || 0) / r.outputCount) * ARTISAN, 0) : INF
    // un-refining gives back half of the refining materials (valued at the bid, after tax)
    const unrefineValue = r ? r.inputs.reduce((s, i) => s + this.book.price(i.itemHrid, "bid") * (Number(i.count || 0) / r.outputCount) * 0.5, 0) * (1 - this.tax) : 0
    return { base, refined: r?.after || null, refineCost, unrefineValue }
  }

  quote(h, n) {
    const q = this.book.enhancedQuote(h, n)
    return { ask: q?.ask > 0 ? q.ask : INF, bid: q?.bid > 0 ? q.bid : 0 }
  }

  /**
   * acq(h)[n] = { cost, how, kind: "market" | "refine" | "unrefine" | "mirror", pad? }: the cheapest
   * way to get it. The normal and refined versions of an item are computed together, level by
   * level (refine and un-refine link them at the same level; mirrors use lower levels).
   */
  acq(h) {
    if (this.tables.has(h)) return this.tables.get(h)
    const f = this.family(h)
    const tb = []
    const tr = f.refined ? [] : null
    this.tables.set(f.base, tb)
    if (tr) this.tables.set(f.refined, tr)
    const mirror = (x, t, n) => {
      if (n < 2) return null
      const p = this.padSource(x, n - 2, t)
      return { cost: t[n - 1].cost + p.cost + this.mirror, how: `+${n - 1} 加垫子 +${n - 2} 加镜子`, kind: "mirror", pad: p.h }
    }
    const better = (a, b) => (b && b.cost < a.cost ? b : a)
    for (let n = 0; n <= this.cap; n++) {
      let b = better({ cost: this.quote(f.base, n).ask, how: "市场买", kind: "market" }, mirror(f.base, tb, n))
      tb.push(b)
      if (!tr) continue
      let r = better({ cost: this.quote(f.refined, n).ask, how: "市场买", kind: "market" }, mirror(f.refined, tr, n))
      r = better(r, { cost: b.cost + f.refineCost, how: `买普通 +${n} 自己精炼`, kind: "refine" })
      tr.push(r)
      if (r.kind !== "refine") {
        b = better(b, { cost: r.cost - f.unrefineValue, how: `买精炼 +${n} 解精炼（拿回一半材料）`, kind: "unrefine" })
        tb[n] = b
      }
    }
    return this.tables.get(h)
  }

  /** Cheapest pad of level k for upgrading h (normal version allowed for a refined item). */
  pad(h, k, own) {
    return this.padSource(h, k, own).cost
  }

  /** { cost, h }: the pad item (h itself or its normal version) of level k. */
  padSource(h, k, own) {
    const f = this.family(h)
    const a = (own || this.acq(h))[k].cost
    if (h === f.refined) {
      const b = this.acq(f.base)[k].cost
      if (b <= a) return { cost: b, h: f.base }
    }
    return { cost: a, h }
  }

  /** Steps of the cheapest way to get (h, n): [{ op: "buy" | "refine" | "mirror", ... }]. */
  recipe(h, n) {
    const a = this.acq(h)[n]
    if (!(a.cost < INF)) return null
    if (a.kind === "market") return [{ op: "buy", h, n, cost: a.cost }]
    if (a.kind === "refine") {
      const f = this.family(h)
      return [...this.recipe(f.base, n), { op: "refine", h: f.base, to: h, n, cost: f.refineCost }]
    }
    if (a.kind === "unrefine") {
      const f = this.family(h)
      return [...this.recipe(f.refined, n), { op: "unrefine", h: f.refined, to: h, n, cost: -f.unrefineValue }]
    }
    return [...this.recipe(h, n - 1), ...this.recipe(a.pad, n - 2), { op: "mirror", h, from: n - 1, pad: a.pad, padLevel: n - 2, cost: this.mirror }]
  }

  /** Resale value after tax (estimated from the ask / cost when nobody bids). */
  value(h, n) {
    if (!h) return 0
    const q = this.quote(h, n)
    const cost = this.acq(h)[n].cost
    const raw = q.bid > 0 ? q.bid : q.ask < INF ? q.ask * 0.9 : cost < INF ? cost * 0.8 : 0
    // never above what it costs to get: a bid over the refining / mirror cost is a trade, not an upgrade
    const market = Math.min(raw, cost) * (1 - this.tax)
    // refined pieces rarely sell for their bid, and the cheap way up later is "buy normal + refine":
    // count a refined piece as un-refined (normal version's value + half of the materials back)
    const f = this.family(h)
    if (this.refinedResale === "unrefine" && h === f.refined) return Math.min(market, this.value(f.base, n) + f.unrefineValue)
    return market
  }

  /** Cheapest way from holding (h0, n0) to holding (h, n): { cost, how } (cost = cash out). */
  transition(h0, n0, h, n) {
    const sell = this.value(h0, n0)
    const buy = this.acq(h)[n]
    let best = { cost: buy.cost - sell, how: `${h0 ? "卖旧，" : ""}${buy.how}` }
    if (!h0) return best
    const f = this.family(h)
    if (this.family(h0).base !== f.base) return best
    const up = (from, to) => {
      let c = 0
      for (let j = from + 1; j <= to; j++) c += j >= 2 ? this.mirror + this.pad(h, j - 2) : INF
      return c
    }
    // keep the held piece as the main item: mirror it up, refine if needed
    if ((h0 === h || (h0 === f.base && h === f.refined)) && n >= n0) {
      const c = up(n0, n) + (h0 === h ? 0 : f.refineCost)
      const how = [n > n0 ? `镜子把手上的 +${n0} 升到 +${n}` : "", h0 === h ? "" : "自己精炼"].filter(Boolean).join("，")
      if (c < best.cost) best = { cost: c, how }
    }
    // un-refine the held refined piece, then use it as the normal main item
    if (h0 === f.refined && h === f.base && n >= n0) {
      const c = -f.unrefineValue + up(n0, n)
      if (c < best.cost) best = { cost: c, how: `解精炼手上的 +${n0}（拿回一半材料）${n > n0 ? `，镜子升到 +${n}` : ""}` }
    }
    if (h0 === f.refined && h === f.base && n >= n0 + 2) {
      const c = -f.unrefineValue + this.acq(h)[n0 + 1].cost + this.mirror + up(n0 + 2, n)
      if (c < best.cost) best = { cost: c, how: `解精炼手上的 +${n0} 当垫子，买 +${n0 + 1} 加镜子${n > n0 + 2 ? `，再升到 +${n}` : ""}` }
    }
    // use the held piece as the pad: buy +(n0+1), then mirror up
    if ((h0 === h || h0 === f.base) && n >= n0 + 2) {
      const c = this.acq(h)[n0 + 1].cost + this.mirror + up(n0 + 2, n)
      if (c < best.cost) best = { cost: c, how: `买 +${n0 + 1}，手上的 +${n0} 当垫子加镜子${n > n0 + 2 ? `，再升到 +${n}` : ""}` }
    }
    return best
  }
}

/** Slots of a member with their candidate states. state: { label, apply(cfg), h, n } / { level }. */
export function memberSlots(ctx, gp, members, idx, opts) {
  const { m, book } = ctx
  const maps = m.$e
  const cfg = members[idx]
  const nm = h => zh(maps, h)
  const who = cfg.name || `队员${idx + 1}`
  const out = []
  const cls = classOf(maps, cfg.equipment?.weapon?.itemHrid)
  const upper = cls ? UPPER[cls] : {}
  const weaponType = maps.itemDetailMap[cfg.equipment?.weapon?.itemHrid]?.equipmentDetail?.type
  const slotNames = new Set([...Object.keys(cfg.equipment || {}), ...Object.keys(upper)])
  for (const slot of slotNames) {
    if (!SLOT_ZH[slot]) continue
    if (slot === "off_hand" && weaponType === "/equipment_types/two_hand") continue
    const e = cfg.equipment?.[slot] || {}
    const h0 = e.itemHrid || ""
    const n0 = Math.max(0, Math.floor(Number(e.enhancementLevel || 0)))
    const states = [{ label: h0 ? `${nm(h0)} +${n0}` : "空", h: h0, n: n0, fam: 0, ref: h0 && h0 === gp.family(h0).refined ? 1 : 0 }]
    const add = (h, n, fam) => {
      if (states.some(s => s.h === h && s.n === n)) return
      const t = gp.transition(h0, n0, h, n)
      if (!(t.cost < INF) || t.cost > opts.maxSpend) return
      const req = maps.itemDetailMap[h]?.equipmentDetail?.levelRequirements || []
      if (req.some(q => Number(cfg.levels?.[String(q.skillHrid).split("/").pop()] || 1) < Number(q.level || 0))) return
      states.push({ label: `${nm(h)} +${n}`, h, n, fam, ref: h === gp.family(h).refined ? 1 : 0 })
    }
    const fams = []
    if (h0) fams.push({ f: gp.family(h0), from: n0, own: true, fam: 0 })
    if (opts.replacements && upper[slot] && (!h0 || gp.family(h0).base !== gp.family(upper[slot]).base)) {
      if (!(slot === "off_hand" && maps.itemDetailMap[upper.weapon]?.equipmentDetail?.type === "/equipment_types/two_hand"))
        fams.push({ f: gp.family(upper[slot]), from: 0, own: false, fam: 1 })
    }
    for (const { f, from, own, fam } of fams) {
      for (const h of [f.base, f.refined].filter(Boolean)) {
        const lo = own ? from : 0
        const hi = Math.min(gp.cap, own ? from + opts.maxLevelUp : gp.cap)
        for (let n = lo; n <= hi; n++) add(h, n, fam)
      }
    }
    if (states.length < 2) continue
    for (const s of states) s.apply = c => { c.equipment[slot] = s.h ? { itemHrid: s.h, enhancementLevel: s.n } : { itemHrid: "", enhancementLevel: 0 } }
    out.push({
      key: `${idx}:${slot}`, member: idx, memberName: who, slot, slotName: SLOT_ZH[slot], states,
      // only forward: higher level / refined within a family, current family -> upper replacement
      trans: (a, b) => {
        const ok = a.fam === b.fam ? b.n >= a.n && b.ref >= a.ref : a.fam < b.fam
        return ok ? gp.transition(a.h, a.n, b.h, b.n) : { cost: INF, how: "" }
      },
      value: s => gp.value(s.h, s.n),
    })
  }
  // abilities: +5 / +10 levels with books
  const xpTable = maps.levelExperienceTable || []
  const books = bookInfo(maps)
  ;(cfg.abilities || []).forEach((a, i) => {
    if (!a?.abilityHrid || !books[a.abilityHrid]) return
    const b = books[a.abilityHrid]
    const price = book.priceOrShop(b.item, "ask")
    if (!(price > 0)) return
    const from = Math.max(1, Math.floor(Number(a.level || 1)))
    const levels = [from, from + 5, from + 10].filter(l => l < xpTable.length)
    if (levels.length < 2) return
    const count = (x, y) => Math.ceil(Math.max(0, Number(xpTable[y]) - Number(xpTable[x])) / b.xp)
    const states = levels.map(l => ({
      label: `${zh(maps, a.abilityHrid)} Lv.${l}`, level: l,
      apply: c => {
        c.abilities[i].level = l
        c.abilityLevelMap = { ...(c.abilityLevelMap || {}), [a.abilityHrid]: l }
      },
    }))
    out.push({
      key: `${idx}:ability${i}`, member: idx, memberName: who, slot: `ability${i}`, slotName: `技能 ${i + 1}`, states,
      trans: (x, y) => (y.level > x.level ? { cost: count(x.level, y.level) * price, how: `${count(x.level, y.level)} 本书` } : { cost: INF, how: "" }),
      value: () => 0,
    })
  })
  // house rooms: +1..+maxHouseUp levels; cost = upgrade materials at the market ask + coins
  if (opts.houses !== false) {
    const up = Math.max(0, Math.floor(Number(opts.maxHouseUp ?? 3)))
    // the combat skills of the member's style (magic: stamina / intelligence / attack / defense / magic)
    const weapon = maps.itemDetailMap[cfg.equipment?.weapon?.itemHrid]?.equipmentDetail?.combatStats
    const style = weapon?.combatStyleHrids?.[0] || "/combat_styles/smash"
    const useful = new Set(Object.keys(maps.combatStyleDetailMap?.[style]?.skillExpMap || {}).map(h => h.split("/").pop()))
    for (const room of Object.values(maps.houseRoomDetailMap || {})) {
      const types = [...(room.actionBuffs || []), ...(room.globalBuffs || [])].map(b => String(b.typeHrid))
      // a room that raises a combat level the member does not use (a mage's archery range / gym)
      const raises = types.map(t => /\/buff_types\/(\w+)_level$/.exec(t)?.[1]).filter(x => x && SKILL_KEYS.includes(x))
      if (raises.length && !raises.some(x => useful.has(x))) continue
      // "combat": only rooms with combat stats (levels / speeds / regen), not just rare find + wisdom
      if (opts.houses === "combat" && !types.some(t => /_level$|attack_speed|cast_speed|hp_regen|mp_regen/.test(t))) continue
      const costs = room.upgradeCostsMap || {}
      const max = Math.max(0, ...Object.keys(costs).map(Number))
      const from = Math.max(0, Math.floor(Number(cfg.houseRooms?.[room.hrid] || 0)))
      const levelCost = L => (costs[L] || []).reduce((sum, i) => {
        const p = i.itemHrid === "/items/coin" ? 1 : book.priceOrShop(i.itemHrid, "ask")
        return sum + (p > 0 ? p * Number(i.count || 0) : INF)
      }, 0)
      const stepCost = (a, b) => {
        let c = 0
        for (let L = a + 1; L <= b; L++) c += levelCost(L)
        return c
      }
      const levels = []
      for (let l = from; l <= Math.min(max, from + up); l++) if (l === from || stepCost(from, l) <= opts.maxSpend) levels.push(l)
      if (levels.length < 2) continue
      const name = zh(maps, room.hrid)
      const states = levels.map(l => ({
        label: `${name} ${l} 级`, level: l,
        apply: c => { c.houseRooms = { ...(c.houseRooms || {}), [room.hrid]: l } },
      }))
      out.push({
        key: `${idx}:house:${room.hrid}`, member: idx, memberName: who, slot: `house:${room.hrid}`, slotName: `房子·${name}`, states, house: true,
        trans: (x, y) => (y.level > x.level ? { cost: stepCost(x.level, y.level), how: `升级房子（${x.level} → ${y.level} 级）` } : { cost: INF, how: "" }),
        value: () => 0,
      })
    }
  }
  return out
}

// what each combat guild buff does (the site's name table has no entries for them)
const GUILD_ZH = {
  "/guild_buffs/force_combat": "伤害（公会）",
  "/guild_buffs/rarity_combat": "稀有发现（公会）",
  "/guild_buffs/scholar_combat": "经验（公会）",
  "/guild_buffs/spirit_combat": "生命与法力上限（公会）",
  "/guild_buffs/tempo_combat": "攻击与施法速度（公会）",
}

/**
 * Guild buffs are shared by the guild and paid with guild points, not personal coins: one slot for
 * the whole team (the level is raised for every member). cost = guild points.
 */
export function guildSlots(maps, members, opts = {}) {
  const up = Math.max(0, Math.floor(Number(opts.maxGuildUp ?? 3)))
  const out = []
  for (const g of Object.values(maps.guildBuffDetailMap || {})) {
    if (g.isCombat !== true) continue
    const shrine = maps.guildShrineDetailMap?.[g.shrineHrid] || {}
    const max = Math.max(0, Number(shrine.maxLevel || 0) || Math.max(0, ...Object.keys(g.levelCosts || {}).map(Number)))
    const from = Math.max(0, ...members.map(c => Math.floor(Number(c.guildBuffs?.[g.hrid] || 0))))
    const levels = []
    for (let l = from; l <= Math.min(max, from + up); l++) levels.push(l)
    if (levels.length < 2) continue
    const points = (a, b) => {
      let p = 0
      for (let L = a + 1; L <= b; L++) p += Number(shrine.guildPointCosts?.[L] || 0)
      return p
    }
    const name = GUILD_ZH[g.hrid] || (zh(maps, g.hrid) !== g.hrid ? zh(maps, g.hrid) : g.name || g.hrid)
    out.push({
      key: `guild:${g.hrid}`, hrid: g.hrid, name,
      states: levels.map(l => ({
        label: `${name} ${l} 级`, level: l,
        apply: team => team.forEach(c => { c.guildBuffs = { ...(c.guildBuffs || {}), [g.hrid]: Math.max(l, Number(c.guildBuffs?.[g.hrid] || 0)) } }),
      })),
      points,
    })
  }
  return out
}

/**
 * Wealth at the horizon for an ordered purchase list. Cash is per character: each character buys
 * its own purchases in plan order, each as soon as its own cash is there; incomes change for
 * everyone after each purchase (a stronger teammate changes everyone's drops).
 */
function runPlan(plan, P) {
  const n = P.budget.length
  const held = P.slots.map(() => 0)
  const cash = [...P.budget]
  const inc = [...P.income]
  const queues = Array.from({ length: n }, () => [])
  for (const [s, j] of plan) queues[P.slots[s].member].push([s, j])
  const ptr = new Array(n).fill(0)
  let t = 0
  const steps = []
  for (;;) {
    let best = null
    for (let k = 0; k < n; k++) {
      for (; ptr[k] < queues[k].length; ptr[k]++) {
        const [s, j] = queues[k][ptr[k]]
        const i = held[s]
        // only steps that earn more and are reachable
        if (i !== j && P.dp[s][j] > P.dp[s][i] && P.pay[s][i][j].cost < INF) break
      }
      if (ptr[k] >= queues[k].length) continue
      const [s, j] = queues[k][ptr[k]]
      const c = P.pay[s][held[s]][j].cost
      const wait = c <= cash[k] ? 0 : inc[k] > 0 ? (c - cash[k]) / inc[k] : INF
      if (t + wait <= P.days && (!best || wait < best.wait)) best = { k, s, j, c, wait }
    }
    if (!best) break
    const { k, s, j, c, wait } = best
    t += wait
    for (let q = 0; q < n; q++) cash[q] += inc[q] * wait
    const i = held[s]
    cash[k] = Math.max(0, cash[k] - c)
    held[s] = j
    for (let q = 0; q < n; q++) inc[q] += P.dpv[s][j][q] - P.dpv[s][i][q]
    ptr[k]++
    steps.push({ s, from: i, to: j, day: t, cost: c, how: P.pay[s][i][j].how, cashAfter: cash[k], incomeAfter: inc[k] })
  }
  const endCash = cash.map((c, q) => c + inc[q] * (P.days - t))
  const wealth = endCash.reduce((a, v) => a + v, 0) + held.reduce((a, j, s) => a + P.Lend[s][j], 0)
  return { wealth, steps, held, income: inc.reduce((a, v) => a + v, 0), incomes: inc, cash: endCash }
}

/** Greedy insertion, then best-improvement local search (remove / change target / swap). */
async function searchPlan(P, signal) {
  const moves = []
  P.slots.forEach((sl, s) => sl.states.forEach((_, j) => j > 0 && moves.push([s, j])))
  let plan = []
  let best = runPlan(plan, P).wealth
  const tryPlans = (cands) => {
    let improved = false
    for (const c of cands) {
      const w = runPlan(c, P).wealth
      if (w > best + 1) {
        best = w
        plan = c
        improved = true
      }
    }
    return improved
  }
  for (let guard = 0; guard < 200; guard++) {
    await new Promise(r => setTimeout(r, 0)) // keep the page / server responsive
    if (signal?.aborted) throw new Error("cancelled")
    const cands = []
    for (const mv of moves) for (let pos = 0; pos <= plan.length; pos++) cands.push([...plan.slice(0, pos), mv, ...plan.slice(pos)])
    for (let k = 0; k < plan.length; k++) {
      cands.push(plan.filter((_, x) => x !== k))
      for (const mv of moves) if (mv[0] === plan[k][0] && mv[1] !== plan[k][1]) cands.push(plan.map((p, x) => (x === k ? mv : p)))
      if (k + 1 < plan.length) cands.push(plan.map((p, x) => (x === k ? plan[k + 1] : x === k + 1 ? plan[k] : p)))
    }
    if (!tryPlans(cands)) break
  }
  const r = runPlan(plan, P)
  return { plan, ...r }
}

/**
 * params: { members, target, extra, optimize, hours, seeds, replacements, budgets: [per member],
 *           otherIncomes: [per member],
 *           horizons: [days], tax, maxLevelUp, keepEnd }
 */
export async function adviseUpgrades(ev, params, api) {
  const { target, extra } = params
  const members = clone(params.members)
  const optimize = params.optimize?.length ? params.optimize : members.map((_, i) => i)
  const hours = params.hours || 12
  const seeds = seedList(77777, params.seeds || 8)
  const budget = members.map((_, k) => Math.max(0, Number(params.budgets?.[k] || 0)))
  const otherIncome = members.map((_, k) => Number(params.otherIncomes?.[k] || 0))
  const horizons = (params.horizons?.length ? params.horizons : [30, 60]).map(Number).filter(d => d > 0).sort((a, b) => a - b)
  const tax = Number.isFinite(Number(params.tax)) ? Number(params.tax) : 0.05
  const maps = ev.ctx.m.$e
  const gp = new GearPrices(maps, ev.ctx.book, tax, { refinedResale: params.refinedResale })

  const baseline = await ev.evaluate(members, target, { hours, seeds, extra, objective: "profit", signal: api.signal })
  const P0 = baseline.mean.profitPerHour * 24
  const own = baseline.mean.players.map(p => p.profitPerHour * 24)
  const income = members.map((_, k) => own[k] + otherIncome[k])
  const name = k => members[k].name || `队员${k + 1}`
  api.log(`当前全队利润 ${fmtM(P0)}/天，卖出税 ${(tax * 100).toFixed(1)}%，镜子 ${fmtM(gp.mirror)}`)
  members.forEach((_, k) => api.log(`  ${name(k)}：现金 ${fmtM(budget[k])}，战斗利润 ${fmtM(own[k])}/天，其他收入 ${fmtM(otherIncome[k])}/天`))
  const slots = optimize.flatMap(idx => memberSlots(ev.ctx, gp, members, idx, { maxSpend: budget[idx] + Math.max(0, income[idx]) * horizons.at(-1), maxLevelUp: params.maxLevelUp || 6, replacements: params.replacements !== false, houses: params.houses !== false, maxHouseUp: params.maxHouseUp ?? 3 }))
  const jobs = slots.flatMap((sl, s) => sl.states.slice(1).map((st, k) => ({ s, j: k + 1, st })))
  api.log(`${slots.length} 个位置，共 ${jobs.length} 个可达状态需要模拟`)
  let done = 0
  const evals = await pool(jobs, 32, async ({ s, j, st }) => {
    const mem = clone(members)
    st.apply(mem[slots[s].member])
    const r = await ev.evaluate(mem, target, { hours, seeds, extra, objective: "profit", signal: api.signal })
    api.progress(++done, jobs.length, "逐项模拟")
    const dpv = r.mean.players.map((p, k) => (p.profitPerHour - baseline.mean.players[k].profitPerHour) * 24)
    return { s, j, dpv, dp: (r.mean.profitPerHour - baseline.mean.profitPerHour) * 24, dXp: r.mean.xpPerHour - baseline.mean.xpPerHour, sig: paired(r.perSeed, baseline.perSeed) }
  })
  const dp = slots.map(sl => sl.states.map(() => 0))
  const dpv = slots.map(sl => sl.states.map(() => members.map(() => 0)))
  const info = slots.map(sl => sl.states.map(() => null))
  for (const e of evals) {
    dp[e.s][e.j] = e.dp
    dpv[e.s][e.j] = e.dpv
    info[e.s][e.j] = e
  }
  const L = slots.map(sl => sl.states.map(st => sl.value(st)))
  // gear still held at the horizon: taxed resale value, or untaxed when it is kept
  const Lend = params.keepEnd && tax < 1 ? L.map(r => r.map(v => v / (1 - tax))) : L
  const pay = slots.map(sl => sl.states.map(a => sl.states.map(b => (a === b ? { cost: 0, how: "" } : sl.trans(a, b)))))

  // per-state table (from the current state)
  const rows = []
  slots.forEach((sl, s) => sl.states.forEach((st, j) => {
    if (!j) return
    const t = pay[s][0][j]
    const loss = t.cost - L[s][j] + L[s][0]
    rows.push({
      id: `${sl.key}#${j}`, member: sl.member, memberName: sl.memberName, slotName: sl.slotName, from: sl.states[0].label, label: st.label,
      cost: t.cost, how: t.how, loss, dProfitPerDay: dp[s][j], dOwnPerDay: dpv[s][j][sl.member], dXpPerHour: info[s][j].dXp, significance: info[s][j].sig,
      net: Object.fromEntries(horizons.map(d => [d, dp[s][j] * d - loss])),
      paybackDays: dp[s][j] > 0 ? loss / dp[s][j] : null,
    })
  }))
  // guild buffs: guild points, shared by the guild -> listed for reference, not in the coin plans
  if (params.guild !== false) {
    const gs = guildSlots(maps, members, { maxGuildUp: params.maxGuildUp ?? 3 })
    const gjobs = gs.flatMap(g => g.states.slice(1).map((st, k) => ({ g, j: k + 1, st })))
    done = 0
    const gevals = await pool(gjobs, 32, async ({ g, j, st }) => {
      const mem = clone(members)
      st.apply(mem)
      const r = await ev.evaluate(mem, target, { hours, seeds, extra, objective: "profit", signal: api.signal })
      api.progress(++done, gjobs.length, "公会加成")
      return { g, j, st, dp: (r.mean.profitPerHour - baseline.mean.profitPerHour) * 24, dXp: r.mean.xpPerHour - baseline.mean.xpPerHour, sig: paired(r.perSeed, baseline.perSeed) }
    })
    for (const e of gevals) {
      rows.push({
        id: `${e.g.key}#${e.j}`, member: -1, memberName: "全队（公会）", slotName: "公会", from: e.g.states[0].label, label: e.st.label, guild: true,
        cost: null, guildPoints: e.g.points(e.g.states[0].level, e.st.level), how: `公会升级（${e.g.points(e.g.states[0].level, e.st.level).toLocaleString()} 公会点数，不花个人金币）`,
        loss: 0, dProfitPerDay: e.dp, dOwnPerDay: null, dXpPerHour: e.dXp, significance: e.sig,
        net: Object.fromEntries(horizons.map(d => [d, e.dp * d])), paybackDays: null,
      })
    }
  }
  rows.sort((a, b) => b.net[horizons.at(-1)] - a.net[horizons.at(-1)])

  // plans
  const plans = []
  for (const days of horizons) {
    if (api.signal.aborted) throw new Error("cancelled")
    api.progress(0, 1, `规划 ${days} 天`)
    const P = { slots, dp, dpv, L, Lend, pay, budget, income, days }
    const ts = Date.now()
    const r = await searchPlan(P, api.signal)
    api.log(`规划 ${days} 天用时 ${Date.now() - ts} ms`)
    const idle = runPlan([], P).wealth
    const mem = clone(members)
    r.held.forEach((j, s) => j && slots[s].states[j].apply(mem[slots[s].member]))
    let check = null
    if (r.steps.length) {
      const f = await ev.evaluate(mem, target, { hours, seeds, extra, objective: "profit", signal: api.signal })
      check = { estimated: r.income - income.reduce((a, v) => a + v, 0), actual: (f.mean.profitPerHour - baseline.mean.profitPerHour) * 24, sig: paired(f.perSeed, baseline.perSeed) }
    }
    const steps = r.steps.map(x => {
      const sl = slots[x.s]
      return {
        day: x.day, memberName: sl.memberName, slotName: sl.slotName, from: sl.states[x.from].label, to: sl.states[x.to].label,
        cost: x.cost, how: x.how, cashAfter: x.cashAfter, incomeAfter: x.incomeAfter, dProfitPerDay: dp[x.s][x.to] - dp[x.s][x.from],
        loss: x.cost - L[x.s][x.to] + L[x.s][x.from],
      }
    })
    const final = r.held.map((j, s) => ({ j, s })).filter(x => x.j).map(({ j, s }) => ({ memberName: slots[s].memberName, slotName: slots[s].slotName, from: slots[s].states[0].label, to: slots[s].states[j].label }))
    const perMember = members.map((_, k) => ({ name: name(k), cash: r.cash[k], income: r.incomes[k], startIncome: income[k] }))
    plans.push({ days, wealth: r.wealth, idle, gain: r.wealth - idle, steps, final, check, finalIncome: r.income, perMember, members: mem })
    api.log(`${days} 天：${steps.length} 步，期末比不动多 ${fmtM(r.wealth - idle)}${check ? `（终态实测 +${fmtM(check.actual)}/天，逐项相加估 +${fmtM(check.estimated)}/天）` : ""}`)
  }
  return { keepEnd: !!params.keepEnd, baseline: baseline.mean, profitPerDay: P0, income: income.reduce((a, v) => a + v, 0), incomes: income, budget: budget.reduce((a, v) => a + v, 0), budgets: budget, names: members.map((_, k) => name(k)), tax, mirror: gp.mirror, horizons, rows, plans, hours, seeds: seeds.length }
}

function fmtM(v) {
  return Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(1)}M`
}
