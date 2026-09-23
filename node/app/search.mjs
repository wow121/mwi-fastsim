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

/**
 * candidates: [{ key, label, members, incumbent? }]; the incumbent always survives.
 * Returns candidates of the last stage sorted by objective, each with { value, mean, perSeed,
 * vsIncumbent }.
 */
export async function halving(ev, candidates, opt) {
  const { target, extra, objective, seedBase = 20260923, signal, stages = DEFAULT_STAGES, onStage, concurrency = 48 } = opt
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
