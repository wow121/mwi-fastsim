// Gear cost: the cheapest way to get an item at an enhancement level — buy it on the market,
// Philosopher's Mirror synthesis (+N main + a +(N-1) pad + a mirror = +(N+1); the pad of a refined
// item may be the normal version), buy the normal version and refine it, or buy the refined version
// and un-refine it (half of the refining materials come back) — optionally starting from a piece
// the player already has (sell it, mirror it up as the main item, use it as a pad, un-refine it).
import { GearPrices } from "./opt-upgrades.mjs"
import { zh } from "./i18n.mjs"

const INF = Number.POSITIVE_INFINITY
const ARTISAN = 0.89
const fin = v => (Number.isFinite(v) ? v : null)

/** Steps -> readable lines + shopping list (items by level, mirrors, refining materials). */
function describe(game, gp, steps) {
  const nm = h => zh(game.$e, h)
  const buy = new Map()
  let mirrors = 0
  let refines = 0
  const lines = steps.map((s) => {
    if (s.op === "buy") {
      const k = `${s.h}|${s.n}`
      buy.set(k, { h: s.h, name: nm(s.h), n: s.n, count: (buy.get(k)?.count || 0) + 1, price: s.cost })
      return { text: `买 ${nm(s.h)} +${s.n}`, cost: s.cost }
    }
    if (s.op === "refine") {
      refines++
      return { text: `精炼 ${nm(s.h)} +${s.n} → ${nm(s.to)} +${s.n}`, cost: s.cost }
    }
    if (s.op === "unrefine") return { text: `解精炼 ${nm(s.h)} +${s.n} → ${nm(s.to)} +${s.n}（拿回一半精炼材料）`, cost: s.cost }
    if (s.op === "keep") return { text: `手上的 ${nm(s.h)} +${s.n}`, cost: 0 }
    mirrors++
    return { text: `镜子：${nm(s.h)} +${s.from}（主件）+ ${nm(s.pad)} +${s.padLevel}（垫子）→ +${s.from + 1}`, cost: s.cost }
  })
  const shopping = [...buy.values()].sort((a, b) => a.n - b.n)
  if (mirrors) shopping.push({ h: "/items/philosophers_mirror", name: nm("/items/philosophers_mirror"), n: 0, count: mirrors, price: gp.mirror })
  return { lines, shopping, mirrors, refines, total: lines.reduce((a, l) => a + l.cost, 0) }
}

/** Mirror the main piece (h, from) up to `to`, pads bought the cheapest way. */
function mirrorUp(gp, h, from, to) {
  const steps = []
  for (let j = from + 1; j <= to; j++) {
    if (j < 2) return null
    const p = gp.padSource(h, j - 2)
    const r = gp.recipe(p.h, j - 2)
    if (!r) return null
    steps.push(...r, { op: "mirror", h, from: j - 1, pad: p.h, padLevel: j - 2, cost: gp.mirror })
  }
  return steps
}

/**
 * params: { hrid, level, tax, held: { hrid, level } | null }
 * -> { target, mirrorPrice, refine, market, options: [{ key, label, cost, lines, shopping }], best, table }
 */
export function gearCost(game, book, params) {
  const maps = game.$e
  const tax = Number.isFinite(Number(params.tax)) ? Number(params.tax) : 0.05
  const gp = new GearPrices(maps, book, tax, { refinedResale: params.refinedResale || "market" })
  const h = String(params.hrid || "")
  const n = Math.max(0, Math.floor(Number(params.level || 0)))
  if (!maps.itemDetailMap[h]?.equipmentDetail) throw new Error("请选择一件装备")
  if (n > gp.cap) throw new Error(`强化等级最高 +${gp.cap}`)
  const f = gp.family(h)
  const nm = x => zh(maps, x)
  const q = gp.quote(h, n)

  const options = []
  const add = (key, label, steps, note) => {
    if (!steps) return options.push({ key, label, cost: null, note: note || "买不到" })
    const d = describe(game, gp, steps)
    options.push({ key, label, cost: d.total, lines: d.lines, shopping: d.shopping, mirrors: d.mirrors, refines: d.refines, note })
  }

  // 1) straight from the market
  add("market", "直接买", q.ask < INF ? [{ op: "buy", h, n, cost: q.ask }] : null, q.ask < INF ? "" : "市场上没人卖这个等级")
  // 2) the cheapest route from scratch (market / mirror / refine, recursively)
  const best = gp.recipe(h, n)
  add("cheapest", "最便宜的路线（从零开始）", best)
  // 3) mirror all the way from a bought low level (shows the mirror chain even when not cheapest)
  for (const from of [n - 1, n - 2, n - 3]) {
    if (from < 1 || from >= n) continue
    const start = gp.recipe(h, from)
    const up = mirrorUp(gp, h, from, n)
    if (start && up) add(`mirror-${from}`, `买 +${from} 再用镜子升到 +${n}`, [...start, ...up])
  }
  // 4) refined target: buy the normal version at this level and refine
  if (h === f.refined) {
    const r = gp.recipe(f.base, n)
    add("refine", `买普通 +${n} 自己精炼`, r ? [...r, { op: "refine", h: f.base, to: h, n, cost: f.refineCost }] : null)
  }
  // 5) starting from a held piece of the same family
  const held = params.held?.hrid ? { h: String(params.held.hrid), n: Math.max(0, Math.floor(Number(params.held.level || 0))) } : null
  if (held && maps.itemDetailMap[held.h]) {
    const same = gp.family(held.h).base === f.base
    if (same && (held.h === h || (held.h === f.base && h === f.refined)) && n >= held.n) {
      const up = mirrorUp(gp, held.h === h ? h : f.base, held.n, n)
      if (up) add("main", `手上的 +${held.n} 当主件${n > held.n ? "用镜子升级" : ""}${held.h === h ? "" : "，再精炼"}`, [{ op: "keep", h: held.h, n: held.n }, ...up, ...(held.h === h ? [] : [{ op: "refine", h: f.base, to: h, n, cost: f.refineCost }])])
    }
    // held refined piece, normal target: un-refine it, then main item or pad
    if (same && held.h === f.refined && h === f.base) {
      const unref = { op: "unrefine", h: f.refined, to: f.base, n: held.n, cost: -f.unrefineValue }
      if (n >= held.n) {
        const up = mirrorUp(gp, h, held.n, n)
        if (up) add("unrefine-main", `解精炼手上的 +${held.n}${n > held.n ? "，再用镜子升级" : ""}`, [{ op: "keep", h: held.h, n: held.n }, unref, ...up])
      }
      if (n >= held.n + 2) {
        const main = gp.recipe(h, held.n + 1)
        const up = mirrorUp(gp, h, held.n + 2, n)
        if (main && up) add("unrefine-pad", `解精炼手上的 +${held.n} 当垫子（买 +${held.n + 1} 当主件）`, [{ op: "keep", h: held.h, n: held.n }, unref, ...main, { op: "mirror", h, from: held.n + 1, pad: f.base, padLevel: held.n, cost: gp.mirror }, ...up])
      }
    }
    if (same && (held.h === h || held.h === f.base) && n >= held.n + 2) {
      const main = gp.recipe(h, held.n + 1)
      const up = mirrorUp(gp, h, held.n + 2, n)
      if (main && up) add("pad", `手上的 +${held.n} 当垫子（买 +${held.n + 1} 当主件）`, [{ op: "keep", h: held.h, n: held.n }, ...main, { op: "mirror", h, from: held.n + 1, pad: held.h, padLevel: held.n, cost: gp.mirror }, ...up])
    }
  }
  // net cost: routes that do not use the held piece leave it to be sold
  const heldValue = held && maps.itemDetailMap[held.h] ? gp.value(held.h, held.n) : 0
  for (const o of options) {
    o.usesHeld = ["main", "pad", "unrefine-main", "unrefine-pad"].includes(o.key)
    o.net = o.cost == null ? null : o.usesHeld ? o.cost : o.cost - heldValue
  }
  const ok = options.filter(o => o.net != null)
  const cheapest = ok.length ? ok.reduce((a, b) => (b.net < a.net ? b : a)) : null

  // per level: market vs cheapest, for the item and its refined / normal version
  const table = []
  for (let k = 0; k <= gp.cap; k++) {
    const row = { n: k }
    for (const [key, x] of [["base", f.base], ["refined", f.refined]]) {
      if (!x) continue
      const qq = gp.quote(x, k)
      const a = gp.acq(x)[k]
      row[key] = { ask: fin(qq.ask), bid: fin(qq.bid) || null, cost: fin(a.cost), kind: a.kind, how: a.how }
    }
    table.push(row)
  }

  const r = gp.refs.get(f.base)
  return {
    target: { hrid: h, name: nm(h), level: n, base: f.base, baseName: nm(f.base), refined: f.refined, refinedName: f.refined ? nm(f.refined) : null },
    market: { ask: fin(q.ask), bid: q.bid || null },
    mirrorPrice: fin(gp.mirror),
    refine: r ? {
      cost: fin(f.refineCost),
      unrefineValue: fin(f.unrefineValue),
      inputs: r.inputs.map(i => ({ hrid: i.itemHrid, name: nm(i.itemHrid), count: (Number(i.count || 0) / r.outputCount) * ARTISAN, price: book.price(i.itemHrid, "ask") })),
    } : null,
    held: held ? { ...held, name: nm(held.h), value: heldValue } : null,
    options,
    best: cheapest?.key || null,
    table,
    tax,
  }
}
