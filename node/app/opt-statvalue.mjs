// Marginal value of combat stats (属性价值): for one member at a time, add a step of one stat (or
// a few skill levels) and simulate against the unchanged team (run over 4× the seeds, see vsBase);
// the difference, scaled to one display unit, is what one point of that stat is worth per day.
// The step is larger than one unit so the difference stands out from the noise; the value per
// unit is the average over the step.
import { pool } from "./search.mjs"
import { seedList, vsBase } from "./evaluator.mjs"
import { zh } from "./i18n.mjs"
import { statGroups, styleOf } from "./stat-groups.mjs"

const clone = v => JSON.parse(JSON.stringify(v))

// healer: healing amplify is in the default selection
const healer = (maps, cfg) => (cfg.abilities || []).some(a => maps.abilityDetailMap[a?.abilityHrid]?.abilityEffects?.some(e => e.effectType === "/ability_effect_types/heal"))

// Teammates with the same timings act at exactly the same moments, and the engine handles those
// in member order. Any timing stat moves the member ahead of the others, which alone can change
// the team's profit by ~0.5% (seen with 3 identical mages). So the comparison is against the
// team with this member a hair faster (EPS): both sides then have the same order.
// (event times are rounded to 1 µs: the hair must move casts / attacks by more than that)
const EPS = { castSpeed: 1e-5, attackSpeed: 1e-5, abilityHaste: 1e-3 }

function withBonus(cfg, bonus) {
  const c = clone(cfg)
  c.statBonus = { ...c.statBonus }
  for (const [k, v] of Object.entries(bonus)) c.statBonus[k] = (c.statBonus[k] || 0) + v
  return c
}

/** Member config with one group raised by `step`. */
function raised(cfg, grp) {
  const c = clone(cfg)
  if (grp.levels) {
    c.levels = { ...c.levels }
    for (const s of grp.levels) c.levels[s] = Number(c.levels[s] ?? 1) + grp.step
  } else {
    c.statBonus = { ...c.statBonus }
    for (const k of grp.keys) c.statBonus[k] = (c.statBonus[k] || 0) + grp.step
  }
  return c
}

/** Stat changes of each equipped item's next enhancement level (+1). */
function enhancementSteps(maps, cfg) {
  const table = maps.enhancementLevelTotalBonusMultiplierTable || []
  const cap = table.length - 1
  const out = []
  for (const [slot, e] of Object.entries(cfg.equipment || {})) {
    const it = maps.itemDetailMap[e?.itemHrid]
    const ed = it?.equipmentDetail
    if (!ed?.combatStats) continue
    const lvl = Math.max(0, Math.floor(Number(e.enhancementLevel) || 0))
    if (lvl >= cap) continue
    const d = (table[lvl + 1] ?? 0) - (table[lvl] ?? 0)
    const delta = {}
    for (const [k, b] of Object.entries(ed.combatEnhancementBonuses || {}))
      if (typeof b === "number" && b && ed.combatStats[k]) delta[k] = b * d
    if (Object.keys(delta).length) out.push({ slot, itemHrid: it.hrid, name: zh(maps, it.hrid), from: lvl, to: lvl + 1, delta })
  }
  return out
}

const STYLES = ["stab", "slash", "smash", "ranged", "magic"]
const DTYPES = ["physical", "water", "nature", "fire"]

/** Stats that do nothing for this member: other weapon styles' accuracy / damage, other damage
 *  types' amplify / penetration. */
function unused(maps, cfg) {
  const { style, dtype } = styleOf(maps, cfg)
  const out = new Set()
  for (const s of STYLES) if (s !== style) out.add(`${s}Accuracy`).add(`${s}Damage`)
  for (const d of DTYPES) if (d !== dtype) out.add(`${d}Amplify`).add(d === "physical" ? "armorPenetration" : `${d}Penetration`)
  return out
}

/** Linear estimate of a stat change from the measured groups (mean change over a group's keys). */
function estimate(rows, delta, skip) {
  let profit = 0
  let xp = 0
  const used = new Set()
  for (const r of rows) {
    if (!r.keys) continue
    const keys = r.keys.filter(k => delta[k])
    if (!keys.length) continue
    keys.forEach(k => used.add(k))
    const mean = r.keys.reduce((a, k) => a + (delta[k] || 0), 0) / r.keys.length
    profit += (mean / r.step) * r.profit.mean
    xp += (mean / r.step) * r.xp.mean
  }
  return { profitPerHour: profit, xpPerHour: xp, missing: Object.keys(delta).filter(k => !used.has(k) && !skip.has(k)) }
}

/**
 * params: { members, target, hours, seeds, seedBase, extra, objective,
 *   analyze: [member index], groups: [group id] (default: each group's `on`) }
 * Values are team totals per hour (profit, xp), and the change per stat unit.
 */
export async function statValue(ev, params, api) {
  const { members, target, extra, objective = "profit" } = params
  const { m } = ev.ctx
  const maps = m.$e
  const hours = params.hours || 24
  const seedBase = Number(params.seedBase || 515151)
  const seeds = seedList(seedBase, params.seeds || 16)
  // the bases over 4× the seeds (the first ones shared): every stat of a member is compared with the
  // same base, and a change that alters the fights barely pairs with it, so its luck would shift them all
  const baseSeeds = seedList(seedBase, seeds.length * 4)
  const analyze = (params.analyze?.length ? params.analyze : members.map((_, i) => i)).filter(i => members[i])
  const want = params.groups?.length ? new Set(params.groups) : null

  const jobs = []
  for (const i of analyze)
    for (const grp of statGroups(maps, members[i]))
      if (want ? want.has(grp.id) : grp.on || (grp.id === "healingAmplify" && healer(maps, members[i]))) jobs.push({ i, grp })
  const total = jobs.length + analyze.length + 1
  let done = 0
  const run = async (team, s = seeds) => {
    const r = await ev.evaluate(team, target, { hours, seeds: s, extra, objective, signal: api.signal })
    api.progress(++done, total, "模拟")
    return r
  }
  const teamWith = (i, cfg) => members.map((c, j) => (j === i ? cfg : c))
  const [base, ...bases] = await Promise.all([members, ...analyze.map(i => teamWith(i, withBonus(members[i], EPS)))].map(t => run(t, baseSeeds)))
  const baseOf = Object.fromEntries(analyze.map((i, k) => [i, bases[k]]))
  const series = (r, k) => r.per.map(p => p[k])
  const rows = await pool(jobs, 16, async ({ i, grp }) => {
    const r = await run(teamWith(i, raised(withBonus(members[i], EPS), grp)))
    const base = baseOf[i]
    const profit = vsBase(series(r, "profitPerHour"), series(base, "profitPerHour"))
    const xp = vsBase(series(r, "xpPerHour"), series(base, "xpPerHour"))
    const scale = grp.unit / grp.step
    return {
      member: i, id: grp.id, label: grp.label, kind: grp.kind, keys: grp.keys, levels: grp.levels, step: grp.step, unit: grp.unit, pct: grp.pct,
      profit, xp,
      perUnit: { profitPerHour: profit.mean * scale, profitHalf: (profit.high - profit.mean) * scale, xpPerHour: xp.mean * scale, xpHalf: (xp.high - xp.mean) * scale },
      deathsPerHour: r.mean.deathsPerHour,
    }
  })

  const enhancements = analyze.map(i => ({
    member: i,
    items: enhancementSteps(maps, members[i]).map(s => ({ ...s, ...estimate(rows.filter(r => r.member === i), s.delta, unused(maps, members[i])) })),
  }))
  return {
    names: members.map(c => c.name),
    target, analyze, hours, seeds: seeds.length, seedBase: params.seedBase || null, objective,
    base: base.mean,
    rows,
    enhancements,
  }
}
