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
  constructor(maps, book, tax) {
    this.maps = maps
    this.book = book
    this.tax = tax
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
    return { base, refined: r?.after || null, refineCost }
  }

  quote(h, n) {
    const q = this.book.enhancedQuote(h, n)
    return { ask: q?.ask > 0 ? q.ask : INF, bid: q?.bid > 0 ? q.bid : 0 }
  }

  /** acq(h)[n] = { cost, how, kind: "market" | "refine" | "mirror", pad? } (cheapest way to get it) */
  acq(h) {
    if (this.tables.has(h)) return this.tables.get(h)
    const f = this.family(h)
    const isRef = h === f.refined
    const base = isRef ? this.acq(f.base) : null
    const t = []
    for (let n = 0; n <= this.cap; n++) {
      let best = { cost: this.quote(h, n).ask, how: "市场买", kind: "market" }
      if (isRef && base[n].cost + f.refineCost < best.cost) best = { cost: base[n].cost + f.refineCost, how: `买普通 +${n} 自己精炼`, kind: "refine" }
      if (n >= 2) {
        const p = this.padSource(h, n - 2, t)
        const c = t[n - 1].cost + p.cost + this.mirror
        if (c < best.cost) best = { cost: c, how: `+${n - 1} 加垫子 +${n - 2} 加镜子`, kind: "mirror", pad: p.h }
      }
      t.push(best)
    }
    this.tables.set(h, t)
    return t
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
    return [...this.recipe(h, n - 1), ...this.recipe(a.pad, n - 2), { op: "mirror", h, from: n - 1, pad: a.pad, padLevel: n - 2, cost: this.mirror }]
  }

  /** Resale value after tax (estimated from the ask / cost when nobody bids). */
  value(h, n) {
    if (!h) return 0
    const q = this.quote(h, n)
    const cost = this.acq(h)[n].cost
    const raw = q.bid > 0 ? q.bid : q.ask < INF ? q.ask * 0.9 : cost < INF ? cost * 0.8 : 0
    // never above what it costs to get: a bid over the refining / mirror cost is a trade, not an upgrade
    return Math.min(raw, cost) * (1 - this.tax)
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
  const gp = new GearPrices(maps, ev.ctx.book, tax)

  const baseline = await ev.evaluate(members, target, { hours, seeds, extra, objective: "profit", signal: api.signal })
  const P0 = baseline.mean.profitPerHour * 24
  const own = baseline.mean.players.map(p => p.profitPerHour * 24)
  const income = members.map((_, k) => own[k] + otherIncome[k])
  const name = k => members[k].name || `队员${k + 1}`
  api.log(`当前全队利润 ${fmtM(P0)}/天，卖出税 ${(tax * 100).toFixed(1)}%，镜子 ${fmtM(gp.mirror)}`)
  members.forEach((_, k) => api.log(`  ${name(k)}：现金 ${fmtM(budget[k])}，战斗利润 ${fmtM(own[k])}/天，其他收入 ${fmtM(otherIncome[k])}/天`))
  const slots = optimize.flatMap(idx => memberSlots(ev.ctx, gp, members, idx, { maxSpend: budget[idx] + Math.max(0, income[idx]) * horizons.at(-1), maxLevelUp: params.maxLevelUp || 6, replacements: params.replacements !== false }))
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
