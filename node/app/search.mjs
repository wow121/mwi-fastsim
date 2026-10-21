// Successive halving over candidate team configurations.
import { paired, seedList } from "./evaluator.mjs"

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const k = i++
      out[k] = await fn(items[k], k)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export const DEFAULT_STAGES = [
  { hours: 2, seeds: 2, keep: 0.1, min: 12 },
  { hours: 6, seeds: 4, keep: 6 },
  { hours: 12, seeds: 8, keep: 3 },
]

/** Planned sim-hours of `halving` over n candidates (incumbent included), for progress estimates. */
export function halvingWork(n, stages = DEFAULT_STAGES) {
  let alive = n, work = 0
  for (let s = 0; s < stages.length && alive > 0; s++) {
    const st = stages[s]
    work += alive * st.hours * st.seeds
    const keep = typeof st.keep === "number" && st.keep < 1 ? Math.ceil(alive * st.keep) : st.keep
    alive = Math.min(alive, Math.max(st.min || 1, keep) + 1)
  }
  return work
}

/** Expected sim-hours of `confirmAdaptive` with k challengers (usually one doubling past the first 4x). */
export function confirmWork(stages, k) {
  const last = stages.at(-1)
  return (k + 1) * last.hours * 2 * last.seeds * 4 * 1.5
}

/** The api for an optimizer run inside another: its remaining work plus `after` (sim-hours the caller still
 *  has to run once it returns). */
export function nestedApi(api, after, extra = {}) {
  return { ...api, ...extra, remaining: api.remaining ? (r, o) => api.remaining(r + after, o) : undefined }
}

/**
 * candidates: [{ key, label, members, incumbent? }]; the incumbent always survives. `onScored(stage, sorted)` sees
 * every stage's scores (e.g. the first stage's ranking of all candidates).
 * Returns candidates of the last stage sorted by objective, each with { value, mean, perSeed,
 * vsIncumbent }.
 */
export async function halving(ev, candidates, opt) {
  const { target, extra, objective, seedBase = 20260923, signal, stages = DEFAULT_STAGES, onStage, onScored, concurrency = 48 } = opt
  let alive = candidates
  let scored = []
  for (let s = 0; s < stages.length; s++) {
    const st = stages[s]
    const seeds = seedList(seedBase + s * 7919, st.seeds)
    let done = 0
    scored = await pool(alive, concurrency, async (c) => {
      if (signal?.aborted) throw new Error("cancelled")
      const r = await ev.evaluate(c.members, target, { hours: st.hours, seeds, extra, objective, signal })
      done++
      onStage?.(s, done, alive.length)
      return { ...c, value: r.value, mean: r.mean, perSeed: r.perSeed }
    })
    scored.sort((a, b) => b.value - a.value || a.mean.deathsPerHour - b.mean.deathsPerHour)
    onScored?.(s, scored)
    if (s === stages.length - 1) break
    const n = typeof st.keep === "number" && st.keep < 1 ? Math.ceil(scored.length * st.keep) : st.keep
    const k = Math.max(st.min || 1, n)
    const next = scored.slice(0, k)
    const inc = scored.find(c => c.incumbent)
    if (inc && !next.includes(inc)) next.push(inc)
    alive = next
  }
  const inc = scored.find(c => c.incumbent)
  if (inc) for (const c of scored) c.vsIncumbent = paired(c.perSeed, inc.perSeed)
  return scored
}

/** Confirmation on fresh seeds at 2x the hours of the last stage, starting with 4x its runs: challengers still
 *  undecided (the 95% range spans 0 and is wider than 0.5% of the current value) get more runs, doubling up to
 *  16x. Every challenger is paired with the current configuration on the same seeds.
 *  Returns the challengers with value, mean (deaths), vsIncumbent and confirmed: { hours, seeds }. */
export async function confirmAdaptive(ev, common, stages, cur, challengers, { seedBase, label, api }) {
  const last = stages.at(-1)
  const hours = last.hours * 2
  const maxSeeds = last.seeds * 16
  const all = [cur, ...challengers]
  const vals = all.map(() => [])
  const deaths = all.map(() => [])
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length
  const vs = i => paired(vals[i], vals[0].slice(0, vals[i].length))
  let open = new Set(challengers.map((_, k) => k + 1))
  for (let n = 0, want = last.seeds * 4; ; want = Math.min(maxSeeds, want * 2)) {
    const seeds = seedList(seedBase, want).slice(n)
    api.progress(0, 1, `${label}（${hours} 小时 × ${want} 次）`)
    const rs = await Promise.all(all.map((c, i) => (i === 0 || open.has(i) ? ev.evaluate(c.members, common.target, { hours, seeds, extra: common.extra, objective: common.objective, signal: common.signal }) : null)))
    rs.forEach((r, i) => {
      if (!r) return
      vals[i].push(...r.perSeed)
      deaths[i].push(...r.per.map(p => p.deathsPerHour))
    })
    n = want
    const small = 0.005 * Math.abs(avg(vals[0]))
    open = new Set([...open].filter(i => { const v = vs(i); return v.low <= 0 && v.high >= 0 && 1.96 * v.se > small }))
    if (!open.size || want >= maxSeeds) break
  }
  return challengers.map((c, k) => ({ ...c, incumbent: false, value: avg(vals[k + 1]), mean: { ...c.mean, deathsPerHour: avg(deaths[k + 1]) }, vsIncumbent: vs(k + 1), confirmed: { hours, seeds: vals[k + 1].length } }))
}
