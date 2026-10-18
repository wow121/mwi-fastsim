// Runs team configurations through the Rust engine with common random numbers and turns the
// results into metrics.
import { compilePayload } from "./engine-core.mjs"
import { buildPayload } from "./model.mjs"
import { HOUR, effectiveTime, profit, teamMetrics } from "./metrics.mjs"

/** Seeds shared by every candidate of a comparison (common random numbers). */
export function seedList(base, n) {
  return Array.from({ length: n }, (_, i) => (base + Math.imul(i + 1, 2654435769)) >>> 0)
}

const METRIC_KEYS = ["xpPerHour", "profitPerHour", "profitMidpointPerHour", "deathsPerHour", "encountersPerHour", "outOfManaTimeRatio"]

/** Half width of the 95% interval of the mean over seeds, per key ({} with fewer than 2 seeds).
 *  Deaths in particular vary a lot between runs (they come in chains). */
export function spread(list, keys) {
  const n = list.length
  if (n < 2) return {}
  return Object.fromEntries(keys.map(k => {
    const m = list.reduce((a, x) => a + x[k], 0) / n
    const sd = Math.sqrt(list.reduce((a, x) => a + (x[k] - m) ** 2, 0) / (n - 1))
    return [k, (1.96 * sd) / Math.sqrt(n)]
  }))
}
export const SPREAD_KEYS = ["xpPerHour", "profitPerHour", "profitMidpointPerHour", "deathsPerHour"]

function average(list) {
  const out = {}
  for (const k of METRIC_KEYS) out[k] = list.reduce((a, x) => a + x[k], 0) / list.length
  out.ci = spread(list, SPREAD_KEYS)
  const n = list[0].players.length
  out.players = Array.from({ length: n }, (_, i) => {
    const o = {}
    for (const k of Object.keys(list[0].players[i])) o[k] = list.reduce((a, x) => a + x.players[i][k], 0) / list.length
    return o
  })
  return out
}

/** Log formatting of objective values that are not profit / xp (filled in by other modes, e.g. ironcow). */
export const OBJECTIVE_FORMATS = {}

export function objectiveValue(metrics, objective) {
  switch (objective) {
    case "xp": return metrics.xpPerHour
    case "profitMid": return metrics.profitMidpointPerHour
    default: return metrics.profitPerHour
  }
}

export class Evaluator {
  constructor(ctx) {
    this.ctx = ctx // { m, rust, book }
    this.sims = 0
    this.simHours = 0
  }

  /** One run; returns { metrics, result } (result only when `detail` or `keep`). */
  async runOnce(members, target, { hours, seed, extra, detail = false, keep = false }) {
    const { m, rust, book } = this.ctx
    const payload = buildPayload(m, members, target, { hours, seed, extra })
    const out = await rust.run(compilePayload(m, payload), { attacks: detail })
    this.sims++
    this.simHours += hours
    const result = out.result
    return { metrics: teamMetrics(book, result, members.length), result: detail || keep ? result : undefined }
  }

  /** Mean metrics over `seeds`; also returns the per-seed objective values. With `items`, the
   *  mean also has the team's revenue / expense items per hour (`mean.items`). */
  async evaluate(members, target, { hours, seeds, extra, objective = "profit", signal, items = false }) {
    if (signal?.aborted) throw new Error("cancelled")
    const runs = await Promise.all(seeds.map(seed => this.runOnce(members, target, { hours, seed, extra, keep: items })))
    const per = runs.map(r => r.metrics)
    const mean = average(per)
    if (items) mean.items = teamItems(this.ctx.book, runs.map(r => r.result), members.length)
    return { mean, per, perSeed: per.map(p => objectiveValue(p, objective)), value: objectiveValue(mean, objective) }
  }
}

/** Team revenue / expense items per hour, averaged over runs (bid for drops, ask for consumables). */
function teamItems(book, results, n) {
  const acc = { revenue: new Map(), expenses: new Map() }
  for (const r of results) {
    const h = effectiveTime(r) / HOUR
    if (!(h > 0)) continue
    for (let i = 0; i < n; i++) {
      const p = profit(book, r, `player${i + 1}`, { dropMode: "bid", consumableMode: "ask" })
      for (const [list, m] of [[p.revenueItems, acc.revenue], [p.expenseItems, acc.expenses]])
        for (const it of list) {
          const e = m.get(it.itemHrid) || { itemHrid: it.itemHrid, amountPerHour: 0, valuePerHour: 0 }
          e.amountPerHour += it.amount / h / results.length
          e.valuePerHour += it.total / h / results.length
          m.set(it.itemHrid, e)
        }
    }
  }
  const out = m => [...m.values()].sort((a, b) => b.valuePerHour - a.valuePerHour)
  return { revenue: out(acc.revenue), expenses: out(acc.expenses) }
}

/** Comparison of two independent per-seed series (any seeds): mean difference and its standard
 *  error from both spreads. For team changes the per-seed results barely correlate with the base
 *  (any change sends the fights down another path), so pairing does not cancel the noise and the
 *  base's own luck shifts every difference against it the same way; compare with a base over more
 *  seeds instead. Same shape as `paired`. */
export function unpaired(a, b) {
  const st = x => {
    const n = x.length
    const m = x.reduce((s, v) => s + v, 0) / n
    return { n, m, v: n > 1 ? x.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1) : Infinity }
  }
  const A = st(a)
  const B = st(b)
  const mean = A.m - B.m
  const se = Math.sqrt(A.v / A.n + B.v / B.n)
  return { mean, se, low: mean - 1.96 * se, high: mean + 1.96 * se, clearlyBetter: mean - 1.96 * se > 0 }
}

/** A series against a base run over more seeds whose first ones are the series' own (seedList(b, n)
 *  is a prefix of seedList(b, 4n)): paired on the shared seeds or unpaired against the whole base,
 *  whichever has the smaller error. Pairing wins when the change leaves the fights as they were
 *  (only loot rolls differ); otherwise the whole base keeps its luck from shifting every comparison. */
export function vsBase(a, base) {
  const p = paired(a, base.slice(0, a.length))
  const u = unpaired(a, base)
  return p.se <= u.se ? p : u
}

/** Paired comparison of two per-seed series (same seeds). */
export function paired(a, b) {
  const d = a.map((x, i) => x - b[i])
  const n = d.length
  const mean = d.reduce((s, x) => s + x, 0) / n
  const sd = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0
  const se = n > 1 ? sd / Math.sqrt(n) : Infinity
  return { mean, se, low: mean - 1.96 * se, high: mean + 1.96 * se, clearlyBetter: mean - 1.96 * se > 0 }
}
