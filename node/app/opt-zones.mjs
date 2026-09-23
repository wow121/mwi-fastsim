// Zone recommendation (刷图推荐) and batch queue.
import { pool } from "./search.mjs"
import { seedList } from "./evaluator.mjs"
import { zh } from "./i18n.mjs"

/** params: { members, targets: [{kind:"zone", zoneHrid, difficultyTier}], hours, seeds, extra, objective } */
export async function recommendZones(ev, params, api) {
  const { members, extra, objective = "profit" } = params
  const hours = params.hours || 24
  const seeds = seedList(424242, params.seeds || 2)
  const { m } = ev.ctx
  let done = 0
  const rows = await pool(params.targets, 16, async (t) => {
    let r
    try {
      r = await ev.evaluate(members, t, { hours, seeds, extra, objective, signal: api.signal })
    } catch (e) {
      if (api.signal.aborted) throw e
      return { target: t, error: String(e.message || e) }
    }
    done++
    api.progress(done, params.targets.length, "模拟各区域")
    const z = m.$e.actionDetailMap[t.zoneHrid]
    return { target: t, name: zh(m.$e, t.zoneHrid), isDungeon: !!z?.combatZoneInfo?.isDungeon, metrics: r.mean }
  })
  const key = objective === "xp" ? "xpPerHour" : "profitPerHour"
  rows.sort((a, b) => (b.metrics?.[key] ?? -Infinity) - (a.metrics?.[key] ?? -Infinity))
  return { rows, hours, seeds: seeds.length, objective }
}

/** params: { items: [{ label, members, target, hours, seeds, extra }] } */
export async function runQueue(ev, params, api) {
  let done = 0
  const rows = await pool(params.items, 8, async (it) => {
    const seeds = seedList(31337, it.seeds || 1)
    const r = await ev.evaluate(it.members, it.target, { hours: it.hours || 24, seeds, extra: it.extra, objective: "profit", signal: api.signal })
    done++
    api.progress(done, params.items.length, "队列")
    return { label: it.label, target: it.target, metrics: r.mean }
  })
  return { rows }
}
