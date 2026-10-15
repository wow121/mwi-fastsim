// Value of the labyrinth scrolls (卷轴价值) at one target: each combat scroll that is not already on
// is opened by the whole team, and (optionally) by one member at a time, and simulated against the
// unchanged team on the same seeds. A scroll lasts 30 minutes, so each member who opens it uses 2 an
// hour: the paired difference per scroll used is what one scroll is worth there. Scrolls come from the
// labyrinth and are not on the market; a market price is only used if one shows up.
import { pool } from "./search.mjs"
import { paired, seedList } from "./evaluator.mjs"
import { COMBAT_SEALS } from "./game.mjs"

const PER_HOUR = 2 // one scroll = 30 minutes of buff

/**
 * params: { members, target, hours, seeds, seedBase, extra, single (also one member at a time) }
 * Values are team totals per hour.
 */
export async function scrollValue(ev, params, api) {
  const { members, target, extra = {} } = params
  if (target?.kind === "labyrinth") throw new Error("卷轴在迷宫里不生效，请选择区域或地下城")
  const { book } = ev.ctx
  const hours = params.hours || 24
  const seeds = seedList(Number(params.seedBase || 616161), params.seeds || 16)
  const on = Array.isArray(extra.seals) ? extra.seals : []
  const seals = COMBAT_SEALS.filter(s => !on.includes(s.key))
  const who = [null, ...(params.single && members.length > 1 ? members.map((_, i) => i) : [])]
  const jobs = seals.flatMap(s => who.map(i => ({ s, i })))

  const total = jobs.length + 1
  let done = 0
  const run = async (team, ex) => {
    const r = await ev.evaluate(team, target, { hours, seeds, extra: ex, signal: api.signal })
    api.progress(++done, total, "模拟")
    return r
  }
  const base = await run(members, extra)
  const series = (r, k) => r.per.map(p => p[k])
  // no quote: PriceBook falls back to the shop price (0 for scrolls)
  const priceOf = h => ({ ask: book.price(h, "ask"), bid: book.price(h, "bid") })
  const rows = await pool(jobs, 16, async ({ s, i }) => {
    const r = i == null
      ? await run(members, { ...extra, seals: [...on, s.key] })
      : await run(members.map((c, j) => (j === i ? { ...c, seals: [s.key] } : c)), extra)
    const users = i == null ? members.length : 1
    const itemHrid = `/items/seal_of_${s.key}`
    const price = priceOf(itemHrid)
    const profit = paired(series(r, "profitPerHour"), series(base, "profitPerHour"))
    const xp = paired(series(r, "xpPerHour"), series(base, "xpPerHour"))
    const used = PER_HOUR * users
    const costPerHour = price.ask > 0 ? price.ask * used : null
    return {
      key: s.key, itemHrid, member: i, users, price,
      profit, xp, costPerHour,
      perScroll: { profit: profit.mean / used, profitHalf: (profit.high - profit.mean) / used, xp: xp.mean / used },
      netPerHour: costPerHour == null ? null : profit.mean - costPerHour,
      deathsPerHour: r.mean.deathsPerHour,
    }
  })
  return {
    names: members.map(c => c.name),
    target, hours, seeds: seeds.length, seedBase: params.seedBase || null,
    on, perHour: PER_HOUR,
    base: base.mean,
    rows,
  }
}
