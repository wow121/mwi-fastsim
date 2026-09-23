// Team skill + trigger optimization. Candidates follow the combat-sim site's skill optimizer:
// class pool (learned abilities only), finisher locked last, cast order by class, trigger
// presets per ability; thresholds of "search" presets tuned afterwards (coarse, then fine).
// Coordinate descent over members; successive halving per member.
import { halving, DEFAULT_STAGES } from "./search.mjs"
import { paired, seedList } from "./evaluator.mjs"
import { zh } from "./i18n.mjs"
import { groups, memberPool, presetVariants } from "./skill-pools.mjs"

const clone = v => JSON.parse(JSON.stringify(v))
const strip = c => ({ dependencyHrid: c.dependencyHrid, conditionHrid: c.conditionHrid, comparatorHrid: c.comparatorHrid, value: Number(c.value || 0) })

const GRID = {
  enemyHp: [500, 1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000],
  missingHp: [200, 500, 1000, 1500, 2500, 4000, 6000],
  percentage: [30, 40, 50, 60, 70, 80, 90],
}

/** Member config with `group` in slots 1..4 (special slot untouched) and the chosen presets. */
function applyGroup(members, idx, group, variant, levels) {
  const next = clone(members)
  const c = next[idx]
  c.abilities = [c.abilities?.[0] || { abilityHrid: "", level: 1 }]
  for (let i = 0; i < 4; i++) c.abilities.push(group[i] ? { abilityHrid: group[i], level: levels[group[i]] || 1 } : { abilityHrid: "", level: 1 })
  c.triggerMap = { ...(c.triggerMap || {}) }
  const search = []
  for (const h of group) {
    const p = variant[h]
    c.triggerMap[h] = p.conditions.map(strip)
    p.conditions.forEach((cd, i) => {
      if (cd.valueMode === "search") search.push({ hrid: h, index: i, kind: cd.searchKind, cond: cd.conditionHrid })
    })
  }
  return { members: next, search, presets: Object.fromEntries(group.map(h => [h, variant[h].label])) }
}

function gridFor(s) {
  if (s.kind === "percentage") return GRID.percentage
  return s.cond.endsWith("missing_hp") ? GRID.missingHp : GRID.enemyHp
}

const names = (m, cfg) => (cfg.abilities || []).map(a => (a?.abilityHrid ? zh(m.$e, a.abilityHrid) : "—"))

/**
 * params: { members, target, extra, objective, optimize: [idx], exclude: {idx: [hrid]},
 *           allPresets, rounds, stages }
 */
export async function optimizeSkills(ev, params, api) {
  const { m } = ev.ctx
  const { target, extra, objective = "profit", rounds = 2 } = params
  const stages = params.stages || DEFAULT_STAGES
  let members = clone(params.members)
  const optimize = params.optimize?.length ? params.optimize : members.map((_, i) => i)
  const history = []
  const chosen = {}
  const common = { target, extra, objective, signal: api.signal }
  const finalSeeds = seedList(99173, 8)
  const baseline = await ev.evaluate(members, target, { hours: 24, seeds: finalSeeds, extra, objective, signal: api.signal })
  api.log(`基准：${fmt(baseline.value, objective)}`)

  for (let round = 1; round <= rounds; round++) {
    let changed = false
    for (const idx of optimize) {
      const cfg = members[idx]
      const who = cfg.name || `队员${idx + 1}`
      const mp = memberPool(m, cfg)
      if (!mp.cls) {
        api.log(`${who}：没识别出职业（武器 ${zh(m.$e, cfg.equipment?.weapon?.itemHrid) || "空"}），跳过`)
        continue
      }
      const excluded = new Set(params.exclude?.[idx] || [])
      const pool = mp.pool.filter(p => p.learned && !excluded.has(p.hrid)).map(p => p.hrid)
      const levels = Object.fromEntries(mp.pool.map(p => [p.hrid, p.level]))
      const gs = groups(pool, mp.slots, mp.cls)
      const cands = [{ key: "当前", members: clone(members), incumbent: true, search: [] }]
      for (const g of gs)
        for (const v of presetVariants(m, g, !params.allPresets)) {
          const a = applyGroup(members, idx, g, v, levels)
          cands.push({ key: `${g.join("|")}#${JSON.stringify(a.presets)}`, members: a.members, search: a.search, presets: a.presets })
        }
      api.log(`第 ${round} 轮 · ${who}（${mp.className}，${mp.slots} 个技能格，池 ${pool.length} 个）：${cands.length - 1} 个方案`)
      let ranked = await halving(ev, cands, {
        ...common,
        stages,
        seedBase: 1000 * round + idx,
        onStage: (s, d, t) => api.progress(d, t, `第 ${round} 轮 · ${who} · 阶段 ${s + 1}/${stages.length}`),
      })
      let best = ranked[0]
      // tune the thresholds of the best candidate: coarse grid, then around the best value
      if (!best.incumbent && best.search?.length) {
        for (const s of best.search) {
          const name = zh(m.$e, s.hrid)
          const tryValues = async (vals, label) => {
            const cs = [{ ...best, key: "best", incumbent: true }]
            for (const v of vals) {
              const mem = clone(best.members)
              if (mem[idx].triggerMap[s.hrid][s.index].value === v) continue
              mem[idx].triggerMap[s.hrid][s.index].value = v
              cs.push({ ...best, key: `${v}`, members: mem, incumbent: false })
            }
            if (cs.length === 1) return
            api.progress(0, cs.length, `${who} · ${name} 阈值${label}`)
            const r = await halving(ev, cs, { ...common, stages: stages.slice(1), seedBase: 7000 + idx })
            if (!r[0].incumbent && r[0].vsIncumbent.mean > 0) best = { ...r[0], incumbent: false }
          }
          await tryValues(gridFor(s), "粗搜")
          const v = best.members[idx].triggerMap[s.hrid][s.index].value
          const fine = s.kind === "percentage" ? [v - 5, v + 5] : [Math.round(v * 0.75), Math.round(v * 0.9), Math.round(v * 1.1), Math.round(v * 1.25)]
          await tryValues(fine.filter(x => x > 0), "细搜")
        }
        const check = await halving(ev, [{ ...ranked.find(r => r.incumbent), key: "cur", incumbent: true }, { ...best, key: "best", incumbent: false }], { ...common, stages: [stages.at(-1)], seedBase: 8000 + idx })
        best = check.find(r => r.key === "best")
        ranked = [best, ...ranked.filter(r => r !== ranked[0])]
      }
      history.push({ round, member: idx, top: ranked.slice(0, 5).map(r => ({ abilities: names(m, r.members[idx]), presets: r.presets, value: r.value, deaths: r.mean.deathsPerHour, vs: r.vsIncumbent })) })
      if (!best.incumbent && best.vsIncumbent?.clearlyBetter) {
        members = best.members
        chosen[idx] = best.presets
        changed = true
        api.log(`  → 采用 ${names(m, members[idx]).join(" / ")}（+${fmt(best.vsIncumbent.mean, objective)}）`)
      } else api.log("  → 当前配置已是最好")
      api.partial({ members, history, baseline: baseline.mean, objective })
    }
    if (!changed) break
  }

  const final = await ev.evaluate(members, target, { hours: 24, seeds: finalSeeds, extra, objective, signal: api.signal })
  const cmp = paired(final.perSeed, baseline.perSeed)
  if (cmp.mean <= 0) {
    api.log("当前技能配置已是最好")
    return { members: clone(params.members), history, chosen: {}, baseline: baseline.mean, final: baseline.mean, improvement: { mean: 0, se: 0, low: 0, high: 0 }, objective, unchanged: true }
  }
  api.log(`完成：${fmt(final.value, objective)}（基准 ${fmt(baseline.value, objective)}，提升 ${fmt(cmp.mean, objective)} ± ${fmt(1.96 * cmp.se, objective)}）`)
  return { members, history, chosen, baseline: baseline.mean, final: final.mean, improvement: cmp, objective }
}

function fmt(v, objective) {
  if (objective === "xp") return `${Math.round(v).toLocaleString()} 经验/小时`
  return `${(v * 24 / 1e6).toFixed(2)}M/天`
}
