// Runs team configurations through the Rust engine with common random numbers and turns the
// results into metrics.
import { compilePayload } from "./engine-core.mjs"
import { buildPayload } from "./model.mjs"
import { teamMetrics } from "./metrics.mjs"

/** Seeds shared by every candidate of a comparison (common random numbers). */
export function seedList(base, n) {
  return Array.from({ length: n }, (_, i) => (base + Math.imul(i + 1, 2654435769)) >>> 0)
}

const METRIC_KEYS = ["xpPerHour", "profitPerHour", "profitMidpointPerHour", "deathsPerHour", "encountersPerHour", "outOfManaTimeRatio"]

function average(list) {
  const out = {}
  for (const k of METRIC_KEYS) out[k] = list.reduce((a, x) => a + x[k], 0) / list.length
  const n = list[0].players.length
  out.players = Array.from({ length: n }, (_, i) => {
    const o = {}
    for (const k of Object.keys(list[0].players[i])) o[k] = list.reduce((a, x) => a + x.players[i][k], 0) / list.length
    return o
  })
  return out
}

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

  /** One run; returns { metrics, result } (result only when `detail`). */
  async runOnce(members, target, { hours, seed, extra, detail = false }) {
    const { m, rust, book } = this.ctx
    const payload = buildPayload(m, members, target, { hours, seed, extra })
    const out = await rust.run(compilePayload(m, payload), { attacks: detail })
    this.sims++
    this.simHours += hours
    const result = out.result
    return { metrics: teamMetrics(book, result, members.length), result: detail ? result : undefined }
  }

  /** Mean metrics over `seeds`; also returns the per-seed objective values. */
  async evaluate(members, target, { hours, seeds, extra, objective = "profit", signal }) {
    if (signal?.aborted) throw new Error("cancelled")
    const runs = await Promise.all(seeds.map(seed => this.runOnce(members, target, { hours, seed, extra })))
    const per = runs.map(r => r.metrics)
    const mean = average(per)
    return { mean, perSeed: per.map(p => objectiveValue(p, objective)), value: objectiveValue(mean, objective) }
  }
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
