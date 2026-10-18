// Team upgrade planner. Every reachable state of every slot (enhancement levels of the current
// item and its refined version, the class's upper replacement, ability levels) is simulated
// against the current team (run over 4× the seeds, so its luck does not shift every comparison).
// Then a purchase plan is searched for each horizon: starting cash, income = team profit (+ other
// income), purchases happen as soon as the cash is there, and the objective is the wealth at the
// horizon (cash + resale value of held gear). So a temporary +12 that is later sold for a +14 pays
// its spread and sales tax twice, and the plan only does that when the earlier profit is worth it.
import { pool } from "./search.mjs"
import { seedList, unpaired } from "./evaluator.mjs"
import { zh } from "./i18n.mjs"

const clone = v => JSON.parse(JSON.stringify(v))
const ARTISAN = 0.89
const MIRROR = "/items/philosophers_mirror"
const INF = Number.POSITIVE_INFINITY
const SKILL_KEYS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]
export const SKILL_ZH = { stamina: "耐力", intelligence: "智力", attack: "攻击", melee: "近战", defense: "防御", ranged: "远程", magic: "魔法" }
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
 * The planners' prices: buying at the lowest ask (default) or at the highest bid (a buy order
 * that waits), selling at the highest bid (default) or at the lowest ask (a sell order). Wraps the
 * price book so gear quotes, mirrors, refining materials, books and house materials all follow.
 *
 * Only prices inside the game's tradable band count: trades happen within ±10% of an item's
 * market value (`p`), orders outside it just wait. A sell order above the band or a buy order below
 * it is ignored; one below / above the band trades at its edge. Enhanced gear has no market value
 * in the data: there both sides can only be in the band when the bid is at least 0.9 / 1.1 of the
 * ask, so a lower bid (a +9 ring bid of 12.3M against a 2.9B ask) is treated as a waiting lowball.
 * A buy order at the bid needs an ask, or a known market value. Combat profit is not affected.
 */
const BAND = 0.1
const num = v => (Number.isFinite(Number(v)) ? Number(v) : -1)
function inBand(ask, bid, p) {
  if (p > 0) {
    const lo = p * (1 - BAND)
    const hi = p * (1 + BAND)
    if (ask > hi) ask = -1
    else if (ask > 0 && ask < lo) ask = lo
    if (bid > 0 && bid < lo) bid = -1
    else if (bid > hi) bid = hi
  } else if (ask > 0 && bid > 0 && bid < (ask * (1 - BAND)) / (1 + BAND)) bid = -1
  return { ask, bid, p }
}
export function pricedBook(book, opts = {}) {
  const buyAtBid = opts.buyPrice === "bid"
  const sellAtAsk = opts.sellPrice === "ask"
  const buy = q => (buyAtBid && q.bid > 0 && (q.ask > 0 || q.p > 0) ? q.bid : q.ask)
  const sell = q => (sellAtAsk && q.ask > 0 ? q.ask : q.bid)
  const price = (h, mode = "bid") => {
    const r = book.market?.[h]?.["0"]
    if ((mode !== "ask" && mode !== "bid") || !r) return book.price(h, mode)
    const q = inBand(num(r.a), num(r.b), num(r.p))
    const [first, other] = mode === "ask" ? [buy(q), q.bid] : [sell(q), q.ask]
    return first > 0 ? first : other > 0 ? other : book.price(h, "vendor")
  }
  return new Proxy(book, {
    get(t, k) {
      if (k === "price") return price
      if (k === "priceOrShop") return (h, mode) => {
        const v = price(h, mode)
        return v > 0 ? v : t.priceOrShop(h, mode)
      }
      if (k === "enhancedQuote") return (h, n) => {
        const q = t.enhancedQuote(h, n)
        if (!q) return q
        const b = inBand(q.ask, q.bid, num(t.market?.[h]?.[String(n)]?.p))
        return { ask: buy(b), bid: sell(b) }
      }
      const v = t[k]
      return typeof v === "function" ? v.bind(t) : v
    },
  })
}

/**
 * Gear prices: acquisition cost of (item, level) — market ask, mirror synthesis (+N and a +(N-1)
 * pad and a Philosopher's Mirror give +(N+1); the pad of a refined item may be the normal
 * version) or buying the normal version and refining it — and the resale value after tax.
 */
export class GearPrices {
  /** opts.refinedResale: "market" (default: sold at the bid) or "unrefine" (valued as un-refined, conservative) */
  constructor(maps, book, tax, opts = {}) {
    this.maps = maps
    this.book = book
    this.tax = tax
    this.refinedResale = opts.refinedResale || "market"
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
    // optional, conservative: count a refined piece as un-refined (normal version's value + half of
    // the materials back) instead of selling it at its bid
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
  const { m } = ctx
  const book = gp.book // the planner's buy / sell prices
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
      // too low a level now: with level growth, wearable from the day the requirements are met
      let unlock = 0
      if (req.some(q => Number(cfg.levels?.[String(q.skillHrid).split("/").pop()] || 1) < Number(q.level || 0))) {
        unlock = opts.unlockDay ? opts.unlockDay(idx, req) : INF
        if (!(unlock <= (opts.unlockBy ?? 0))) return
      }
      states.push({ label: `${nm(h)} +${n}`, h, n, fam, ref: h === gp.family(h).refined ? 1 : 0, unlock })
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
      score: s => (s.h && opts.fair ? opts.fair(s.h, s.n) : 0),
    })
  }
  // Ability and house levels are part of the wealth, like gear: valued at what their books /
  // materials would sell for (bid after tax, else 90% of the ask; coins at face value), so a book
  // costs its spread and tax, not its whole price.
  const resale = h => {
    if (h === "/items/coin") return 1
    const bid = book.price(h, "bid")
    const ask = book.priceOrShop(h, "ask")
    // never above the buying price (selling at the ask, buying at the bid is trading, not an upgrade)
    const sell = bid > 0 ? bid : ask > 0 ? ask * 0.9 : 0
    return (ask > 0 ? Math.min(sell, ask) : sell) * (1 - gp.tax)
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
      value: st => count(from, st.level) * resale(b.item),
      // combat score: the books from level 0 (MWITools: experience / book experience + 1 books)
      score: st => (opts.fair ? (Number(xpTable[st.level] || 0) / b.xp + 1) * opts.fair(b.item, 0) : 0),
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
      const levelValue = L => (costs[L] || []).reduce((sum, i) => sum + resale(i.itemHrid) * Number(i.count || 0), 0)
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
        value: st => {
          let v = 0
          for (let L = from + 1; L <= st.level; L++) v += levelValue(L)
          return v
        },
        // combat score: all materials from level 1 at their fair value
        score: st => {
          if (!opts.fair) return 0
          let v = 0
          for (let L = 1; L <= st.level; L++) for (const i of costs[L] || []) v += opts.fair(i.itemHrid, 0) * Number(i.count || 0)
          return v
        },
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
 * Guild buffs: one slot for the whole team (each member's buff is raised to the slot's level).
 * A member's level can't go above their guild's shrine level (`guildBuffCaps`, read from the
 * game); a member without it (teammates' profiles don't show it) is assumed to be in the same
 * guild as the known ones, and stays where it is when nobody's is known. The personal upgrade is
 * paid with guild tokens and credits, not coins, so it's listed apart from the coin plans.
 */
export function guildSlots(maps, members, opts = {}) {
  const up = Math.max(0, Math.floor(Number(opts.maxGuildUp ?? 3)))
  const out = []
  for (const g of Object.values(maps.guildBuffDetailMap || {})) {
    if (g.isCombat !== true) continue
    const cur = c => Math.floor(Number(c.guildBuffs?.[g.hrid] || 0))
    const known = members.map(c => c.guildBuffCaps?.[g.hrid]).filter(v => Number.isFinite(Number(v))).map(Number)
    const teamCap = known.length ? Math.min(...known) : null
    const cap = c => {
      const own = Number(c.guildBuffCaps?.[g.hrid])
      return Math.max(cur(c), Number.isFinite(own) ? own : teamCap ?? cur(c))
    }
    const from = Math.max(0, ...members.map(cur))
    const levels = []
    for (let l = from; l <= Math.min(Math.max(...members.map(cap)), from + up); l++) levels.push(l)
    if (levels.length < 2) continue
    const target = (c, l) => Math.max(cur(c), Math.min(l, cap(c)))
    // guild tokens and credits all raised members pay together
    const cost = l => {
      let tokens = 0
      const credits = {}
      for (const c of members)
        for (let L = cur(c) + 1; L <= target(c, l); L++) {
          const lc = g.levelCosts?.[L] || {}
          tokens += Number(lc.guildTokenCost || 0)
          for (const x of lc.creditCosts || []) credits[x.itemHrid] = (credits[x.itemHrid] || 0) + Number(x.count || 0)
        }
      return { tokens, credits }
    }
    const name = GUILD_ZH[g.hrid] || (zh(maps, g.hrid) !== g.hrid ? zh(maps, g.hrid) : g.name || g.hrid)
    out.push({
      key: `guild:${g.hrid}`, hrid: g.hrid, name,
      states: levels.map(l => ({
        label: `${name} ${l} 级`, level: l,
        apply: team => team.forEach(c => { c.guildBuffs = { ...(c.guildBuffs || {}), [g.hrid]: target(c, l) } }),
      })),
      cost,
      costText: l => {
        const { tokens, credits } = cost(l)
        const cr = Object.entries(credits).map(([h, n]) => `${zh(maps, h)} ${n.toLocaleString()}`).join("、")
        return `${tokens.toLocaleString()} 公会代币${cr ? ` + ${cr}` : ""}`
      },
    })
  }
  return out
}

/**
 * Wealth at the horizon for an ordered purchase list. Cash is per character: each character buys
 * its own purchases in plan order, each as soon as its own cash is there; incomes change for
 * everyone after each purchase (a stronger teammate changes everyone's drops).
 */
/**
 * Value of a plan's outcome for the chosen objective:
 * "wealth" (default): cash + what the held gear / levels would sell for at the horizon;
 * "income": that wealth + the daily profit at the horizon over `paybackDays` more days (the money
 *   spent may take that long to come back: a 3B buy for +1M/day on the last day is not worth it);
 * "score": the rise of the combat score (fair value of the build), ties broken by wealth.
 */
function objective(r, P) {
  if (P.mode === "income") return r.wealth + r.income * P.payback
  if (P.mode === "score") return r.score + r.wealth * 1e-6
  return r.wealth
}

/**
 * Level growth: a member's extra profit per day from the levels farmed by day t, as points
 * [{ t, g }] from { t: 0, g: 0 }, linear in between and flat after the last one.
 */
function gainAt(pts, t) {
  if (!pts) return 0
  for (let x = 1; x < pts.length; x++) {
    const a = pts[x - 1]
    const b = pts[x]
    if (t <= b.t) return a.g + ((b.g - a.g) * (t - a.t)) / (b.t - a.t)
  }
  return pts.at(-1).g
}

/** Coins earned from time a for dt days at rate `inc` + the level gain. */
function earned(pts, inc, a, dt) {
  if (!(dt > 0)) return 0
  let v = inc * dt
  if (!pts) return v
  const b = a + dt
  let x = a
  for (let q = 1; q < pts.length && x < b; q++) {
    const end = Math.min(b, pts[q].t)
    if (end > x) v += ((gainAt(pts, x) + gainAt(pts, end)) / 2) * (end - x)
    x = Math.max(x, end)
  }
  if (b > x) v += pts.at(-1).g * (b - x)
  return v
}

/** Days from time a until `need` more coins are earned (INF if never). */
function waitFor(pts, inc, a, need) {
  if (need <= 0) return 0
  let x = a
  if (pts) {
    for (let q = 1; q < pts.length; q++) {
      if (pts[q].t <= x) continue
      const len = pts[q].t - x
      const got = earned(pts, inc, x, len)
      if (got < need) {
        need -= got
        x = pts[q].t
        continue
      }
      // rate is linear in the segment: inc + r0 + sl·τ, so the amount is r·τ + sl·τ²/2
      const r = inc + gainAt(pts, x)
      const sl = (pts[q].g - pts[q - 1].g) / (pts[q].t - pts[q - 1].t)
      if (Math.abs(sl) < 1e-9) return x - a + need / r
      const d = Math.sqrt(Math.max(0, r * r + 2 * sl * need))
      const roots = [(-r + d) / sl, (-r - d) / sl].filter(v => v > 0 && v <= len + 1e-9)
      return x - a + (roots.length ? Math.min(...roots) : len)
    }
  }
  const r = inc + (pts ? pts.at(-1).g : 0)
  return r > 0 ? x - a + need / r : INF
}

function runPlan(plan, P) {
  const n = P.budget.length
  const held = P.slots.map(() => 0)
  const cash = [...P.budget]
  const inc = [...P.income]
  const curve = k => P.curve?.[k] || null
  // charms bought for farming levels: paid on their day (day 0: from the starting cash)
  const charges = k => P.charges?.[k] || []
  const owed = (k, a, b) => charges(k).reduce((v, x) => v + (x.day > a && x.day <= b ? x.cost : 0), 0)
  for (let k = 0; k < n; k++) cash[k] -= charges(k).reduce((v, x) => v + (x.day <= 0 ? x.cost : 0), 0)
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
        // only steps that earn more (score: that raise the combat score) and are reachable
        const better = P.mode === "score" ? P.S[s][j] > P.S[s][i] : P.dp[s][j] > P.dp[s][i]
        if (i !== j && better && P.pay[s][i][j].cost < INF) break
      }
      if (ptr[k] >= queues[k].length) continue
      const [s, j] = queues[k][ptr[k]]
      const c = P.pay[s][held[s]][j].cost
      // gear that needs higher levels: not before the day they are reached
      const u = Math.max(0, (P.slots[s].states[j].unlock || 0) - t)
      const need = c - cash[k] - earned(curve(k), inc[k], t, u)
      let wait = u + waitFor(curve(k), inc[k], t + u, need)
      for (let it = 0; it < 6 && wait < INF; it++) {
        const w = u + waitFor(curve(k), inc[k], t + u, need + owed(k, t, t + wait))
        if (Math.abs(w - wait) < 1e-9) break
        wait = w
      }
      if (t + wait <= P.days && (!best || wait < best.wait)) best = { k, s, j, c, wait }
    }
    if (!best) break
    const { k, s, j, c, wait } = best
    for (let q = 0; q < n; q++) cash[q] += earned(curve(q), inc[q], t, wait) - owed(q, t, t + wait)
    t += wait
    const i = held[s]
    const cashBefore = cash[k]
    cash[k] = Math.max(0, cash[k] - c)
    held[s] = j
    for (let q = 0; q < n; q++) inc[q] += P.dpv[s][j][q] - P.dpv[s][i][q]
    ptr[k]++
    steps.push({ s, from: i, to: j, day: t, cost: c, how: P.pay[s][i][j].how, cashBefore, cashAfter: cash[k], incomeAfter: inc[k] + gainAt(curve(k), t) })
  }
  const endCash = cash.map((c, q) => c + earned(curve(q), inc[q], t, P.days - t) - owed(q, t, P.days))
  const charmsBack = Array.from({ length: n }, (_, q) => charges(q).reduce((v, x) => v + (x.day <= P.days ? x.resale : 0), 0))
  const wealth = endCash.reduce((a, v) => a + v, 0) + charmsBack.reduce((a, v) => a + v, 0) + held.reduce((a, j, s) => a + P.Lend[s][j], 0)
  const score = held.reduce((a, j, s) => a + P.S[s][j] - P.S[s][0], 0)
  const incomes = inc.map((v, q) => v + gainAt(curve(q), P.days))
  return { wealth, steps, held, score, income: incomes.reduce((a, v) => a + v, 0), incomes, cash: endCash }
}

/** Greedy insertion, then best-improvement local search (remove / change target / swap). */
async function searchPlan(P, signal) {
  const moves = []
  P.slots.forEach((sl, s) => sl.states.forEach((_, j) => j > 0 && moves.push([s, j])))
  let plan = []
  let best = objective(runPlan(plan, P), P)
  const tryPlans = (cands) => {
    let improved = false
    for (const c of cands) {
      const w = objective(runPlan(c, P), P)
      if (w > best + (P.mode === "score" ? 1e-3 : 1)) {
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

const unlockText = st => (st?.unlock > 0.05 ? `（第 ${st.unlock.toFixed(1)} 天够等级）` : "")

/**
 * Combat levels farmed over the plan: from the synced experience and the experience per day at the
 * target now, the levels of every member on a few days (the horizons and quarters of the longest);
 * the team with those levels (gear unchanged) is simulated on the baseline's seeds, which gives
 * each member's extra profit per day from levels alone (`curve`, linear in between), at the re-check
 * precision (few runs, and level gains are small next to the team's profit). Gear whose
 * level requirements are not met yet becomes wearable on the day they are (`unlockDay`).
 * The experience rate is kept as it is now (levels and upgrades also raise it a little).
 *
 * Charms (o.charms): a charm only moves experience (its focus skill gets a share of all of it, plus
 * its bonus), and what a level is worth differs per member and map. The days up to the longest
 * horizon are cut into stages at the same days; at the start of each stage, with the levels farmed
 * so far, every skill of every member is raised a few levels on its own (against the team at
 * those levels), which gives the value of one level per day. Each member then wears the charm whose
 * levels over the stage are worth the most until the horizon, less the loss on buying and reselling
 * a charm not owned yet (`charges`: bought at the stage start, resold after tax at the horizon);
 * it switches only when that is clearly more than the noise of those values.
 */
async function levelGrowth(ev, members, baseline, o, api) {
  const xpTable = o.maps.levelExperienceTable || []
  const H = o.horizons.at(-1)
  const times = [...new Set([...o.horizons, ...[0.25, 0.5, 0.75].map(f => Math.round(H * f))])].filter(t => t > 0).sort((a, b) => a - b)
  const baseRates = k => Object.fromEntries(SKILL_KEYS.map(s => [s, Math.max(0, Number(baseline.mean.players[k]?.[`xp_${s}`] || 0) * 24)]))
  const lv0 = (k, s) => Math.max(1, Math.floor(Number(members[k].levels?.[s] || 1)))
  const exp0 = (k, s) => {
    const L = lv0(k, s)
    const e = Number(members[k].experience?.[s])
    return Number.isFinite(e) && e >= Number(xpTable[L] || 0) && e < Number(xpTable[L + 1] ?? INF) ? e : Number(xpTable[L] || 0)
  }
  // experience per day of each member by stage: [{ a, b, rates }], the last one continues after b
  const plan = members.map((_, k) => [{ a: 0, b: INF, rates: baseRates(k) }])
  const expAt = (k, s, T) => plan[k].reduce((e, g) => e + g.rates[s] * Math.max(0, Math.min(T, g.b) - g.a), exp0(k, s))
  const levelOf = e => {
    let L = 1
    while (L + 1 < xpTable.length && Number(xpTable[L + 1]) <= e) L++
    return L
  }
  // fractional level (for the value of part of a level)
  const fracOf = e => {
    const L = levelOf(e)
    const lo = Number(xpTable[L] || 0)
    const hi = Number(xpTable[L + 1] ?? INF)
    return hi < INF ? L + (e - lo) / (hi - lo) : L
  }
  const levelAt = (k, s, T) => Math.max(lv0(k, s), levelOf(expAt(k, s, T)))
  const levelsAt = (k, T) => Object.fromEntries(SKILL_KEYS.map(s => [s, levelAt(k, s, T)]))
  const daysTo = (k, s, L) => {
    let need = Number(xpTable[L] ?? INF) - exp0(k, s)
    if (need <= 0) return 0
    for (const g of plan[k]) {
      const got = g.rates[s] * (g.b - g.a)
      if (got >= need) return g.a + need / g.rates[s]
      need -= got
    }
    return INF
  }
  const unlockDay = (k, req) => Math.max(0, ...req.map(q => daysTo(k, String(q.skillHrid).split("/").pop(), Number(q.level || 0))))
  const cfg = { hours: Math.min(48, o.hours * 2), seeds: seedList(33333, Math.min(64, o.seeds.length * 4)), extra: o.extra, objective: "profit", signal: api.signal }
  // the base of each comparison over 4× the seeds (see `unpaired`)
  const baseCfg = { ...cfg, seeds: seedList(33333, cfg.seeds.length * 4) }
  const withLevels = lv => {
    const mem = clone(members)
    mem.forEach((c, k) => { c.levels = { ...c.levels, ...lv[k] } })
    return mem
  }

  const charges = members.map(() => [])
  const stages = []
  if (o.charms) {
    // options per member: the charm worn now (free) and every charm on the market, with the
    // experience per day each gives (relative to the current one, on the same short runs)
    const TIERS = ["trainee", "basic", "advanced", "expert", "master", "grandmaster"]
    const quick = { hours: Math.min(12, o.hours), seeds: seedList(4343, 4), extra: o.extra, objective: "profit", signal: api.signal }
    const opts = members.map(() => null)
    const jobs = []
    for (const k of o.optimize) {
      const cur = members[k].equipment?.charm
      const h0 = cur?.itemHrid || ""
      opts[k] = [{ hrid: h0, label: h0 ? `${zh(o.maps, h0)}${cur.enhancementLevel ? ` +${cur.enhancementLevel}` : ""}（现在戴的）` : "不戴护符（现在）", cost: 0, resale: 0, req: [], current: true, rates: null }]
      jobs.push({ k, x: opts[k][0] })
      for (const sk of SKILL_KEYS) for (const t of TIERS) {
        const h = `/items/${t}_${sk}_charm`
        const it = o.maps.itemDetailMap[h]
        if (!it || h === h0) continue
        const cost = o.gp.quote(h, 0).ask
        if (!(cost < INF)) continue
        const x = { hrid: h, label: zh(o.maps, h), cost, resale: o.gp.value(h, 0), req: it.equipmentDetail?.levelRequirements || [], focus: sk, rates: null }
        opts[k].push(x)
        jobs.push({ k, x })
      }
    }
    let done = 0
    await pool(jobs, 32, async ({ k, x }) => {
      const mem = clone(members)
      if (!x.current) mem[k].equipment = { ...mem[k].equipment, charm: { itemHrid: x.hrid, enhancementLevel: 0 } }
      const r = await ev.evaluate(mem, o.target, quick)
      x.raw = Object.fromEntries(SKILL_KEYS.map(s => [s, Math.max(0, Number(r.mean.players[k]?.[`xp_${s}`] || 0) * 24)]))
      api.progress(++done, jobs.length, "护符经验")
    })
    for (const k of o.optimize) {
      const now = baseRates(k)
      const cur = opts[k][0].raw
      for (const x of opts[k]) x.rates = Object.fromEntries(SKILL_KEYS.map(s => [s, cur[s] > 0 ? (now[s] * x.raw[s]) / cur[s] : x.raw[s]]))
      plan[k] = []
    }
    api.log(`护符：每人 ${opts.find(Boolean)?.length - 1 || 0} 种可买，按 ${times.length} 个阶段规划刷经验时戴哪个`)
    const owned = members.map(() => new Set())
    const worn = members.map(c => c.equipment?.charm?.itemHrid || "")
    const bounds = [0, ...times]
    for (let x = 0; x + 1 < bounds.length; x++) {
      const a = bounds[x]
      const b = bounds[x + 1]
      const lv = members.map((_, k) => levelsAt(k, a))
      const st = { from: a, to: b, members: [] }
      const base = await ev.evaluate(withLevels(lv), o.target, baseCfg)
      const P = r => r.mean.profitPerHour * 24
      // what one more level of each skill is worth now (whole team, per day)
      const tasks = []
      for (const k of o.optimize) {
        const exp = Object.fromEntries(SKILL_KEYS.map(s => [s, expAt(k, s, a)]))
        const ok = opts[k].filter(c => c.req.every(q => Number(lv[k][String(q.skillHrid).split("/").pop()] || 1) >= Number(q.level || 0)))
        const gain = c => Object.fromEntries(SKILL_KEYS.map(s => [s, fracOf(exp[s] + c.rates[s] * (b - a)) - fracOf(exp[s])]))
        ok.forEach(c => { c.gain = gain(c) })
        const per = { k, ok, value: {}, se: {} }
        st.members[k] = per
        for (const s of SKILL_KEYS) {
          const most = Math.max(0, ...ok.map(c => c.gain[s]))
          if (!(most > 0.05) || lv[k][s] + 1 >= xpTable.length) continue
          tasks.push({ per, s, step: Math.max(5, Math.ceil(most)) })
        }
      }
      await pool(tasks, 8, async ({ per, s, step }) => {
        const l2 = clone(lv)
        l2[per.k][s] = Math.min(xpTable.length - 1, l2[per.k][s] + step)
        const r = await ev.evaluate(withLevels(l2), o.target, cfg)
        const n = l2[per.k][s] - lv[per.k][s]
        per.value[s] = (P(r) - P(base)) / n
        per.se[s] = (unpaired(r.perSeed, base.perSeed).se * 24) / n
      })
      const keep = (H - b) + (b - a) / 2 // days a level farmed in this stage pays, on average
      for (const k of o.optimize) {
        const per = st.members[k]
        const net = c => SKILL_KEYS.reduce((v, s) => v + Math.max(0, per.value[s] || 0) * c.gain[s], 0) * keep - (owned[k].has(c.hrid) || c.current ? 0 : c.cost - c.resale)
        // switch from the charm worn in the last stage only when the other one is clearly better:
        // the values of a level are small (~1M/day) and about as uncertain, so a switch on a
        // smaller margin would mostly follow the noise
        const prev = per.ok.find(c => c.hrid === worn[k]) || per.ok.find(c => c.current) || per.ok[0]
        const noise = c => keep * Math.sqrt(SKILL_KEYS.reduce((v, s) => v + ((c.gain[s] - prev.gain[s]) * (per.se[s] || 0)) ** 2, 0))
        const best = per.ok.reduce((p, c) => (net(c) > net(p) ? c : p), prev)
        const pick = net(best) - net(prev) > 2 * noise(best) + 1 ? best : prev
        worn[k] = pick.hrid
        if (!pick.current && !owned[k].has(pick.hrid)) {
          owned[k].add(pick.hrid)
          charges[k].push({ day: a, cost: pick.cost, resale: pick.resale, label: pick.label })
        }
        plan[k].push({ a, b: x + 2 === bounds.length ? INF : b, rates: pick.rates })
        Object.assign(per, { charm: pick.label, focus: pick.focus || null, bought: charges[k].at(-1)?.day === a && charges[k].at(-1)?.label === pick.label ? pick.cost : 0 })
      }
      stages.push({
        from: a, to: b,
        members: o.optimize.map(k => {
          const per = st.members[k]
          return { member: k, name: o.name(k), charm: per.charm, focus: per.focus, cost: per.bought, values: SKILL_KEYS.filter(s => per.value[s] !== undefined).map(s => ({ skill: s, name: SKILL_ZH[s], perLevel: per.value[s] })) }
        }),
      })
      api.log(`  第 ${a}–${b} 天：${stages.at(-1).members.map(m => `${m.name} 戴${m.charm}（每级：${m.values.map(v => `${v.name} ${fmtM(v.perLevel)}`).join("，") || "—"}）`).join("；")}`)
      api.progress(x + 1, bounds.length - 1, "护符阶段")
    }
  }

  const start = JSON.stringify(members.map((_, k) => levelsAt(k, 0)))
  const configs = times.map(T => members.map((_, k) => levelsAt(k, T)))
  const keys = [...new Set(configs.map(c => JSON.stringify(c)).filter(c => c !== start))]
  const noXp = members.map((c, k) => (c.experience ? null : o.name(k))).filter(Boolean)
  api.log(`考虑战斗等级增长：按${noXp.length ? "" : "同步时的经验和"}现在在这里每天的经验推算${noXp.length ? `（${noXp.join("、")} 没有当前经验数据，按整级算）` : ""}，模拟 ${keys.length} 个时间点的等级`)
  let done = 0
  const total = keys.length ? keys.length + 1 : 0
  const base = keys.length ? await ev.evaluate(members, o.target, baseCfg) : null
  if (base) api.progress(++done, total, "等级增长")
  const evals = await pool(keys, 8, async key => {
    const r = await ev.evaluate(withLevels(JSON.parse(key)), o.target, cfg)
    api.progress(++done, total, "等级增长")
    return [key, r.mean.players.map((p, k) => (p.profitPerHour - base.mean.players[k].profitPerHour) * 24)]
  })
  const gainOf = new Map(evals)
  const gains = configs.map(c => gainOf.get(JSON.stringify(c)) || members.map(() => 0))
  const curve = members.map((_, k) => [{ t: 0, g: 0 }, ...times.map((t, x) => ({ t, g: gains[x][k] }))])
  const changed = (k, T) => SKILL_KEYS.filter(s => levelAt(k, s, T) > lv0(k, s))
  members.forEach((_, k) => {
    const c = changed(k, H)
    api.log(`  ${o.name(k)}：${c.length ? c.map(s => `${SKILL_ZH[s]} ${lv0(k, s)} → ${levelAt(k, s, H)}`).join("，") : "没有能升的等级"}（${H} 天）`)
  })
  times.forEach((t, x) => api.log(`  第 ${t} 天：只靠等级全队 ${gains[x].reduce((a, v) => a + v, 0) >= 0 ? "+" : ""}${fmtM(gains[x].reduce((a, v) => a + v, 0))}/天`))
  const report = {
    times,
    members: members.map((_, k) => ({
      name: o.name(k),
      skills: SKILL_KEYS.filter(s => expAt(k, s, H) > exp0(k, s) || changed(k, H).includes(s)).map(s => ({
        skill: s, name: SKILL_ZH[s], from: lv0(k, s), xpPerDay: (expAt(k, s, H) - exp0(k, s)) / H, at: times.map(T => levelAt(k, s, T)),
      })),
    })),
    gains: times.map((t, x) => ({ day: t, team: gains[x].reduce((a, v) => a + v, 0), perMember: gains[x] })),
    stages,
    charmCost: charges.map(c => c.reduce((a, x) => a + x.cost, 0)),
    noExperience: noXp,
  }
  return { curve, unlockDay, charges, report }
}

/**
 * params: { members, target, extra, optimize, hours, seeds, replacements, budgets: [per member],
 *           otherIncomes: [per member],
 *           horizons: [days], tax, maxLevelUp, keepEnd, levels (false: combat levels stay as they are),
 *           charms (false: keep the charm worn now while farming levels) }
 */
export async function adviseUpgrades(ev, params, api) {
  const { target, extra } = params
  const members = clone(params.members)
  const optimize = params.optimize?.length ? params.optimize : members.map((_, i) => i)
  const hours = params.hours || 24
  const seeds = seedList(77777, params.seeds || 16)
  const budget = members.map((_, k) => Math.max(0, Number(params.budgets?.[k] || 0)))
  const otherIncome = members.map((_, k) => Number(params.otherIncomes?.[k] || 0))
  const horizons = (params.horizons?.length ? params.horizons : [30, 60]).map(Number).filter(d => d > 0).sort((a, b) => a - b)
  const tax = Number.isFinite(Number(params.tax)) ? Number(params.tax) : 0.04
  const maps = ev.ctx.m.$e
  const gp = new GearPrices(maps, pricedBook(ev.ctx.book, params), tax, { refinedResale: params.refinedResale })
  const mode = ["income", "score"].includes(params.objective) ? params.objective : "wealth"
  const payback = Math.max(0, Number(params.paybackDays ?? 180))
  const fair = fairValue(maps, ev.ctx.book, gp)

  // every comparison is against this base, so over 4× the seeds (its luck would shift them all)
  const baseline = await ev.evaluate(members, target, { hours, seeds: seedList(77777, seeds.length * 4), extra, objective: "profit", signal: api.signal })
  const P0 = baseline.mean.profitPerHour * 24
  const own = baseline.mean.players.map(p => p.profitPerHour * 24)
  const income = members.map((_, k) => own[k] + otherIncome[k])
  const name = k => members[k].name || `队员${k + 1}`
  api.log(`当前全队利润 ${fmtM(P0)}/天，卖出税 ${(tax * 100).toFixed(1)}%，镜子 ${fmtM(gp.mirror)}`)
  members.forEach((_, k) => api.log(`  ${name(k)}：现金 ${fmtM(budget[k])}，战斗利润 ${fmtM(own[k])}/天，其他收入 ${fmtM(otherIncome[k])}/天`))
  const growth = params.levels === false ? null : await levelGrowth(ev, members, baseline, { maps, horizons, target, hours, seeds, extra, name, gp, optimize, charms: params.charms !== false }, api)
  const curve = growth?.curve || null
  const maxGain = k => Math.max(0, ...(curve?.[k] || [{ g: 0 }]).map(p => p.g))
  const slots = optimize.flatMap(idx => memberSlots(ev.ctx, gp, members, idx, {
    maxSpend: budget[idx] + Math.max(0, income[idx] + maxGain(idx)) * horizons.at(-1), maxLevelUp: params.maxLevelUp || 6, replacements: params.replacements !== false, houses: params.houses !== false, maxHouseUp: params.maxHouseUp ?? 3, fair,
    unlockDay: growth?.unlockDay, unlockBy: growth ? horizons.at(-1) : 0,
  }))
  const scores = members.map(c => combatScore(maps, c, fair))
  api.log(`战斗评分（装备 + 战斗房子 + 已装备技能，不含公会）：${members.map((_, k) => `${name(k)} ${fmtScore(scores[k])}`).join("，")}`)
  const jobs = slots.flatMap((sl, s) => sl.states.slice(1).map((st, k) => ({ s, j: k + 1, st })))
  api.log(`${slots.length} 个位置，共 ${jobs.length} 个可达状态需要模拟`)
  let done = 0
  const evals = await pool(jobs, 32, async ({ s, j, st }) => {
    const mem = clone(members)
    st.apply(mem[slots[s].member])
    const r = await ev.evaluate(mem, target, { hours, seeds, extra, objective: "profit", signal: api.signal })
    api.progress(++done, jobs.length, "逐项模拟")
    const dpv = r.mean.players.map((p, k) => (p.profitPerHour - baseline.mean.players[k].profitPerHour) * 24)
    return { s, j, dpv, dp: (r.mean.profitPerHour - baseline.mean.profitPerHour) * 24, dXp: r.mean.xpPerHour - baseline.mean.xpPerHour, sig: unpaired(r.perSeed, baseline.perSeed) }
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
  const S = slots.map(sl => sl.states.map(st => (sl.score ? sl.score(st) : 0)))
  // gear still held at the horizon: taxed resale value, or untaxed when it is kept
  const Lend = params.keepEnd && tax < 1 ? L.map(r => r.map(v => v / (1 - tax))) : L
  const pay = slots.map(sl => sl.states.map(a => sl.states.map(b => (a === b ? { cost: 0, how: "" } : sl.trans(a, b)))))

  // Second pass. For a strong team one upgrade is often ~1% of its profit, about the size of the
  // screening's error, and picking the best of hundreds of noisy estimates favours the lucky ones:
  // the plan then swings with any small change of the team. Re-simulate the states that could pay
  // off within the longest horizon (optimistic screening estimate) with more, fresh seeds, and plan
  // with those numbers only; the rest stay in the table as screening results.
  // how long an upgrade has to pay off: the longest horizon (+ the payback days when aiming at income)
  const H = horizons.at(-1) + (mode === "income" ? payback : 0)
  const refineHours = Math.min(48, hours * 2)
  const refineSeeds = seedList(55555, Math.min(64, seeds.length * 4))
  const refineTop = Math.max(0, Math.floor(Number(params.refineTop ?? 60)))
  const optimistic = (s, j) => (dp[s][j] + 3 * (info[s][j]?.sig?.se ?? 0) * 24) * H - (pay[s][0][j].cost - L[s][j] + L[s][0])
  const screenNet = (s, j) => dp[s][j] * H - (pay[s][0][j].cost - L[s][j] + L[s][0])
  const hopeful = jobs.filter(({ s, j }) => pay[s][0][j].cost < INF && optimistic(s, j) > 0)
    .sort((a, b) => screenNet(b.s, b.j) - screenNet(a.s, a.j))
  // the best state of every slot first, then the other states, in order of the screening estimate
  const firsts = hopeful.filter((x, k) => hopeful.findIndex(y => y.s === x.s) === k)
  const top = [...firsts, ...hopeful.filter(x => !firsts.includes(x))].slice(0, refineTop)
  // the steps below a slot's best state (+11..+13 under a +14, house 4-5 under 6): a plan that can't
  // afford the best yet may take one of them first, and left at the screening number (not planned)
  // it would never be taken. Same item and family, the few levels just below, outside the cap.
  const lvl = st => st.n ?? st.level
  const below = firsts.filter(x => top.includes(x)).flatMap(({ s, j }) => {
    const sl = slots[s]
    const b = sl.states[j]
    const from = sl.states[0].fam === b.fam ? lvl(sl.states[0]) : -1
    return jobs.filter(y => y.s === s && y.j !== j && !top.includes(y) && y.st.h === b.h && y.st.fam === b.fam &&
      lvl(y.st) > from && lvl(y.st) < lvl(b) && pay[s][0][y.j].cost < INF)
      .sort((p, q) => lvl(q.st) - lvl(p.st)).slice(0, 4)
  })
  const picks = [...top, ...below]
  const refined = slots.map(sl => sl.states.map(() => false))
  const planDp = slots.map(sl => sl.states.map(() => 0))
  const planDpv = slots.map(sl => sl.states.map(() => members.map(() => 0)))
  let refBase = baseline
  if (picks.length) {
    api.log(`初筛有 ${hopeful.length} 个可能划算的提升，复核${hopeful.length > top.length ? `最有希望的 ${top.length} 个` : "全部"}${below.length ? `，另加它们下面的 ${below.length} 个中间级` : ""}（每项 ${refineHours} 小时 × ${refineSeeds.length} 次，换一组随机种子）`)
    refBase = await ev.evaluate(members, target, { hours: refineHours, seeds: seedList(55555, refineSeeds.length * 4), extra, objective: "profit", signal: api.signal })
    done = 0
    const again = await pool(picks, 32, async ({ s, j, st }) => {
      const mem = clone(members)
      st.apply(mem[slots[s].member])
      const r = await ev.evaluate(mem, target, { hours: refineHours, seeds: refineSeeds, extra, objective: "profit", signal: api.signal })
      api.progress(++done, picks.length, "复核")
      const dpv = r.mean.players.map((p, k) => (p.profitPerHour - refBase.mean.players[k].profitPerHour) * 24)
      return { s, j, dpv, dp: (r.mean.profitPerHour - refBase.mean.profitPerHour) * 24, dXp: r.mean.xpPerHour - refBase.mean.xpPerHour, sig: unpaired(r.perSeed, refBase.perSeed) }
    })
    for (const e of again) {
      dp[e.s][e.j] = planDp[e.s][e.j] = e.dp
      dpv[e.s][e.j] = planDpv[e.s][e.j] = e.dpv
      info[e.s][e.j] = e
      refined[e.s][e.j] = true
    }
  } else if (refineTop) api.log("初筛没有找到可能在规划期内回本的提升")
  // re-check turned off, or aiming at the combat score (there the profit only sets how fast the
  // money comes in, the choice is made by the score): the other states use the screening numbers
  if (!refineTop || mode === "score")
    slots.forEach((sl, s) => sl.states.forEach((_, j) => {
      if (refined[s][j]) return
      planDp[s][j] = dp[s][j]
      planDpv[s][j] = dpv[s][j]
    }))

  // per-state table (from the current state)
  const rows = []
  slots.forEach((sl, s) => sl.states.forEach((st, j) => {
    if (!j) return
    const t = pay[s][0][j]
    const loss = t.cost - L[s][j] + L[s][0]
    rows.push({
      id: `${sl.key}#${j}`, member: sl.member, memberName: sl.memberName, slotName: sl.slotName, from: sl.states[0].label, label: st.label,
      cost: t.cost, how: t.how + unlockText(st), loss, dProfitPerDay: dp[s][j], unlock: st.unlock || 0, dOwnPerDay: dpv[s][j][sl.member], dXpPerHour: info[s][j].dXp, significance: info[s][j].sig, refined: refined[s][j], dScore: S[s][j] - S[s][0],
      net: Object.fromEntries(horizons.map(d => [d, dp[s][j] * d - loss])),
      paybackDays: dp[s][j] > 0 ? loss / dp[s][j] : null,
    })
  }))
  // guild buffs: guild tokens and credits, not coins -> listed for reference, not in the coin plans
  if (params.guild !== false) {
    const gs = guildSlots(maps, members, { maxGuildUp: params.maxGuildUp ?? 3 })
    const gjobs = gs.flatMap(g => g.states.slice(1).map((st, k) => ({ g, j: k + 1, st })))
    done = 0
    const gevals = await pool(gjobs, 32, async ({ g, j, st }) => {
      const mem = clone(members)
      st.apply(mem)
      const r = await ev.evaluate(mem, target, { hours, seeds, extra, objective: "profit", signal: api.signal })
      api.progress(++done, gjobs.length, "公会加成")
      return { g, j, st, dp: (r.mean.profitPerHour - baseline.mean.profitPerHour) * 24, dXp: r.mean.xpPerHour - baseline.mean.xpPerHour, sig: unpaired(r.perSeed, baseline.perSeed) }
    })
    for (const e of gevals) {
      rows.push({
        id: `${e.g.key}#${e.j}`, member: -1, memberName: "全队（公会）", slotName: "公会", from: e.g.states[0].label, label: e.st.label, guild: true,
        cost: null, guildTokens: e.g.cost(e.st.level).tokens, how: `个人公会加成升级（${e.g.costText(e.st.level)}，不花金币）`,
        loss: 0, dProfitPerDay: e.dp, dOwnPerDay: null, dXpPerHour: e.dXp, significance: e.sig,
        net: Object.fromEntries(horizons.map(d => [d, e.dp * d])), paybackDays: null,
      })
    }
  }
  rows.sort((a, b) => b.net[horizons.at(-1)] - a.net[horizons.at(-1)])

  // plans
  // Winner's curse: the plan takes the states with the highest re-checked numbers, and with effects
  // about the size of the noise those are mostly the lucky ones (seen: 22 steps planned at +38M/day,
  // +16M/day when each was measured again on other seeds). So the states a plan takes are measured
  // once more on fresh seeds, the plan is searched again with those numbers, until it takes no
  // unverified state. Then the end state is measured as a whole: upgrades overlap (the same 22
  // steps: +11M/day together), so when it is clearly below the sum of the steps every gain of this
  // horizon is scaled down by that ratio and the plan is searched once more.
  const plans = []
  const valCfg = { hours: refineHours, seeds: seedList(13579, refineSeeds.length), extra, objective: "profit" }
  const checkCfg = { hours: refineHours, seeds: seedList(91919, refineSeeds.length), extra, objective: "profit" }
  let valBase = null
  let checkBase = null
  const validated = slots.map(sl => sl.states.map(() => false))
  const validate = async list => {
    valBase ??= await ev.evaluate(members, target, { ...valCfg, seeds: seedList(13579, valCfg.seeds.length * 4), signal: api.signal })
    let n = 0
    await pool(list, 32, async ({ s, j }) => {
      const mem = clone(members)
      slots[s].states[j].apply(mem[slots[s].member])
      const r = await ev.evaluate(mem, target, { ...valCfg, signal: api.signal })
      api.progress(++n, list.length, "验证选中的提升")
      const e = {
        s, j, dpv: r.mean.players.map((p, k) => (p.profitPerHour - valBase.mean.players[k].profitPerHour) * 24),
        dp: (r.mean.profitPerHour - valBase.mean.profitPerHour) * 24, dXp: r.mean.xpPerHour - valBase.mean.xpPerHour, sig: unpaired(r.perSeed, valBase.perSeed),
      }
      dp[s][j] = planDp[s][j] = e.dp
      dpv[s][j] = planDpv[s][j] = e.dpv
      info[s][j] = e
      validated[s][j] = true
    })
  }
  // the end state of a plan measured as a whole, on seeds no choice has seen
  const measure = async (held, estimated) => {
    checkBase ??= await ev.evaluate(members, target, { ...checkCfg, seeds: seedList(91919, checkCfg.seeds.length * 4), signal: api.signal })
    const mem = clone(members)
    held.forEach((j, s) => j && slots[s].states[j].apply(mem[slots[s].member]))
    const f = await ev.evaluate(mem, target, { ...checkCfg, signal: api.signal })
    return { estimated, actual: (f.mean.profitPerHour - checkBase.mean.profitPerHour) * 24, sig: unpaired(f.perSeed, checkBase.perSeed) }
  }
  for (const days of horizons) {
    if (api.signal.aborted) throw new Error("cancelled")
    api.progress(0, 1, `规划 ${days} 天`)
    let P = { slots, dp: planDp, dpv: planDpv, L, Lend, S, pay, budget, income, days, mode, payback, curve, charges: growth?.charges }
    const levelGain = members.reduce((a, _, k) => a + gainAt(curve?.[k], days), 0)
    const gainOf = r => r.income - levelGain - income.reduce((a, v) => a + v, 0)
    const ts = Date.now()
    let r = await searchPlan(P, api.signal)
    for (let round = 0; round < 4; round++) {
      const todo = [...new Map(r.steps.filter(x => !validated[x.s][x.to]).map(x => [`${x.s}:${x.to}`, { s: x.s, j: x.to }])).values()]
      if (!todo.length) break
      api.log(`${days} 天：计划里 ${todo.length} 项提升换一组随机种子再测一遍，用新数字重新规划`)
      await validate(todo)
      r = await searchPlan(P, api.signal)
    }
    let check = r.steps.length ? await measure(r.held, gainOf(r)) : null
    let scale = 1
    if (check && check.estimated > 0 && check.actual < check.estimated - 2 * check.sig.se * 24) {
      scale = Math.max(0.2, Math.min(1, check.actual / check.estimated))
      const sum = check.estimated
      P = { ...P, dp: planDp.map(row => row.map(v => v * scale)), dpv: planDpv.map(row => row.map(a => a.map(v => v * scale))) }
      r = await searchPlan(P, api.signal)
      check = r.steps.length ? { ...(await measure(r.held, gainOf(r))), sum, scale } : null
      api.log(`${days} 天：一起买实测只有逐项相加的 ${(scale * 100).toFixed(0)}%（提升之间有重叠），收益按这个比例打折后重新规划`)
    }
    api.log(`规划 ${days} 天用时 ${Date.now() - ts} ms`)
    const idleRun = runPlan([], P)
    const idle = idleRun.wealth
    const mem = clone(members)
    r.held.forEach((j, s) => j && slots[s].states[j].apply(mem[slots[s].member]))
    const steps = r.steps.map(x => {
      const sl = slots[x.s]
      return {
        day: x.day, memberName: sl.memberName, slotName: sl.slotName, from: sl.states[x.from].label, to: sl.states[x.to].label,
        cost: x.cost, how: x.how + unlockText(sl.states[x.to]), cashBefore: x.cashBefore, cashAfter: x.cashAfter, incomeAfter: x.incomeAfter, dProfitPerDay: P.dp[x.s][x.to] - P.dp[x.s][x.from],
        loss: x.cost - L[x.s][x.to] + L[x.s][x.from], dScore: S[x.s][x.to] - S[x.s][x.from],
      }
    })
    const final = r.held.map((j, s) => ({ j, s })).filter(x => x.j).map(({ j, s }) => ({ memberName: slots[s].memberName, slotName: slots[s].slotName, from: slots[s].states[0].label, to: slots[s].states[j].label }))
    const scoreAfter = members.map((_, k) => scores[k] + r.held.reduce((a, j, s) => a + (slots[s].member === k ? S[s][j] - S[s][0] : 0), 0))
    const perMember = members.map((_, k) => ({ name: name(k), cash: r.cash[k], income: r.incomes[k], startIncome: income[k], score: scores[k], scoreAfter: scoreAfter[k] }))
    plans.push({ days, levelGain, wealth: r.wealth, idle, gain: r.wealth - idle, incomeGain: r.income - idleRun.income, scoreGain: r.score, steps, final, check, finalIncome: r.income, perMember, members: mem })
    api.log(`${days} 天：${steps.length} 步，期末比不动多 ${fmtM(r.wealth - idle)}，日利润 +${fmtM(r.income - idleRun.income)}/天${curve ? `（另有等级提升 +${fmtM(levelGain)}/天）` : ""}，战斗评分 +${fmtScore(r.score)}${check ? `（终态实测 +${fmtM(check.actual)}/天，逐项相加估 +${fmtM(check.estimated)}/天）` : ""}`)
  }
  // the table with the numbers measured again for the plans
  for (const row of rows) {
    if (row.guild) continue
    const [key, jj] = row.id.split("#")
    const s = slots.findIndex(sl => sl.key === key)
    const j = Number(jj)
    if (s < 0 || !validated[s][j]) continue
    Object.assign(row, { dProfitPerDay: dp[s][j], dOwnPerDay: dpv[s][j][slots[s].member], dXpPerHour: info[s][j].dXp, significance: info[s][j].sig, validated: true, net: Object.fromEntries(horizons.map(d => [d, dp[s][j] * d - row.loss])), paybackDays: dp[s][j] > 0 ? row.loss / dp[s][j] : null })
  }
  rows.sort((a, b) => b.net[horizons.at(-1)] - a.net[horizons.at(-1)])
  return { levels: growth?.report || null, keepEnd: !!params.keepEnd, baseline: baseline.mean, profitPerDay: P0, income: income.reduce((a, v) => a + v, 0), incomes: income, budget: budget.reduce((a, v) => a + v, 0), budgets: budget, names: members.map((_, k) => name(k)), tax, mirror: gp.mirror, horizons, rows, plans, hours, seeds: seeds.length, refineHours, refineSeeds: refineSeeds.length, refinedCount: picks.length, refineTop, objective: mode, paybackDays: payback, scores }
}

function fmtM(v) {
  return Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(1)}M`
}

/** Combat score as a plain number (fair value in millions, like MWITools' build score). */
function fmtScore(v) {
  return (v / 1e6).toFixed(1)
}

/**
 * Fair value of an item at a level, for the combat score (after MWITools' build score): the
 * market value, else the middle of the ask and the bid (inside the tradable band); enhanced gear
 * at what it costs to get (market, mirrors, refining), like MWITools' acquisition value.
 */
function fairValue(maps, rawBook, gp) {
  const book = pricedBook(rawBook, {}) // band only: the fair value doesn't depend on buying / selling at the ask or bid
  const cache = new Map()
  return (h, n = 0) => {
    if (!h) return 0
    if (h === "/items/coin") return 1
    const key = `${h}#${n}`
    if (cache.has(key)) return cache.get(key)
    const q = book.enhancedQuote(h, n) || { ask: -1, bid: -1 }
    const p = Number(rawBook.market?.[h]?.[String(n)]?.p) || 0
    const market = p > 0 ? p : q.ask > 0 && q.bid > 0 ? (q.ask + q.bid) / 2 : q.ask > 0 ? q.ask : q.bid > 0 ? q.bid : 0
    let v = market
    if (maps.itemDetailMap[h]?.equipmentDetail) {
      const acq = gp.acq(h)?.[n]?.cost
      if (acq > 0 && acq < INF && (n > 0 || !(v > 0))) v = acq
    }
    if (!(v > 0)) v = rawBook.priceOrShop(h, "ask") || 0
    cache.set(key, v)
    return v
  }
}

/** Combat score of a member (MWITools' build score without the guild shrines): combat gear + combat house rooms + equipped abilities, at fair value. */
export function combatScore(maps, cfg, fair) {
  let v = 0
  for (const e of Object.values(cfg.equipment || {})) {
    const d = maps.itemDetailMap[e?.itemHrid]?.equipmentDetail
    if (!d || !(Object.keys(d.combatStats || {}).length || Object.keys(d.combatEnhancementBonuses || {}).length)) continue
    v += fair(e.itemHrid, Math.max(0, Math.floor(Number(e.enhancementLevel || 0))))
  }
  for (const [room, lv] of Object.entries(cfg.houseRooms || {})) {
    const r = maps.houseRoomDetailMap?.[room]
    if (!r?.usableInActionTypeMap?.["/action_types/combat"]) continue
    for (let L = 1; L <= Number(lv || 0); L++) for (const i of r.upgradeCostsMap?.[L] || []) v += fair(i.itemHrid, 0) * Number(i.count || 0)
  }
  const books = bookInfo(maps)
  const xpTable = maps.levelExperienceTable || []
  for (const a of cfg.abilities || []) {
    const b = books[a?.abilityHrid]
    if (b) v += (Number(xpTable[a.level] || 0) / b.xp + 1) * fair(b.item, 0)
  }
  return v
}
