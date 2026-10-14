// Team skill + trigger optimization. Candidates follow the combat-sim site's skill optimizer:
// class pool (learned abilities plus any the user added with a level), finisher locked last, cast order by class, trigger
// presets per ability; thresholds of "search" presets tuned afterwards (coarse, then fine).
// Coordinate descent over members; successive halving per member.
import { halving, DEFAULT_STAGES } from "./search.mjs"
import { OBJECTIVE_FORMATS, paired, seedList } from "./evaluator.mjs"
import { zh } from "./i18n.mjs"
import { groups, memberPool, presetVariants, triggerKey } from "./skill-pools.mjs"

const clone = v => JSON.parse(JSON.stringify(v))
const strip = c => ({ dependencyHrid: c.dependencyHrid, conditionHrid: c.conditionHrid, comparatorHrid: c.comparatorHrid, value: Number(c.value || 0) })

const GRID = {
  enemyHp: [500, 1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000],
  missingHp: [200, 500, 1000, 1500, 2500, 4000, 6000],
  percentage: [30, 40, 50, 60, 70, 80, 90],
}

/** Member config with `group` in slots 1..4 (special slot untouched) and the chosen presets. With the game data
 *  (`m`), an ability whose current trigger is equivalent to the preset keeps the current one (no cosmetic change). */
export function applyGroup(members, idx, group, variant, levels, m = null) {
  const prev = members[idx].triggerMap || {}
  const next = clone(members)
  const c = next[idx]
  c.abilities = [c.abilities?.[0] || { abilityHrid: "", level: 1 }]
  for (let i = 0; i < 4; i++) c.abilities.push(group[i] ? { abilityHrid: group[i], level: levels[group[i]] || 1 } : { abilityHrid: "", level: 1 })
  c.abilityLevelMap = { ...(c.abilityLevelMap || {}), ...Object.fromEntries(group.map(h => [h, levels[h] || 1])) }
  c.triggerMap = { ...(c.triggerMap || {}) }
  const search = []
  for (const h of group) {
    const p = variant[h]
    const cur = Object.prototype.hasOwnProperty.call(prev, h) ? prev[h] : m ? (m.$e.abilityDetailMap[h]?.defaultCombatTriggers || []) : null
    if (cur && triggerKey(cur) === triggerKey(p.conditions)) continue // keep the current wording (and its search: none)
    c.triggerMap[h] = p.conditions.map(strip)
    p.conditions.forEach((cd, i) => {
      if (cd.valueMode === "search") search.push({ hrid: h, index: i, kind: cd.searchKind, cond: cd.conditionHrid })
    })
  }
  return { members: next, search, presets: Object.fromEntries(group.map(h => [h, variant[h].label])) }
}

/** Comparable form of a member's abilities (slots 1-4, in order, with levels) and their triggers. */
function configKey(m, cfg) {
  return JSON.stringify((cfg.abilities || []).slice(1).map(a => {
    const h = a?.abilityHrid
    if (!h) return null
    const t = Object.prototype.hasOwnProperty.call(cfg.triggerMap || {}, h) ? cfg.triggerMap[h] : m.$e.abilityDetailMap[h]?.defaultCombatTriggers || []
    return [h, a.level, triggerKey(t)]
  }))
}

function gridFor(s) {
  if (s.kind === "percentage") return GRID.percentage
  return s.cond.endsWith("missing_hp") ? GRID.missingHp : GRID.enemyHp
}

const names = (m, cfg) => (cfg.abilities || []).map(a => (a?.abilityHrid ? zh(m.$e, a.abilityHrid) : "—"))

/**
 * params: { members, target, extra, objective, optimize: [idx], exclude: {idx: [hrid]},
 *           add: {idx: {hrid: level}} (abilities not read from the game, e.g. a teammate's unequipped ones),
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
  const options = {} // member index -> its best configurations of the latest round, for the team cross check
  const common = { target, extra, objective, signal: api.signal }
  // 24 h x 32 runs, paired: with 8 runs the noise (deaths come in chains) often hid real gains
  const finalSeeds = seedList(99173, 32)
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
      const added = Object.fromEntries(Object.entries(params.add?.[idx] || {}).filter(([h, l]) => mp.pool.some(p => p.hrid === h) && Number(l) > 0).map(([h, l]) => [h, Math.floor(Number(l))]))
      const pool = mp.pool.filter(p => (p.learned || added[p.hrid]) && !excluded.has(p.hrid)).map(p => p.hrid)
      const levels = { ...Object.fromEntries(mp.pool.map(p => [p.hrid, p.level])), ...added }
      const gs = groups(pool, mp.slots, mp.cls)
      const cands = [{ key: "当前", members: clone(members), incumbent: true, search: [] }]
      const seen = new Set([configKey(m, members[idx])])
      for (const g of gs)
        for (const v of presetVariants(m, g, !params.allPresets)) {
          const a = applyGroup(members, idx, g, v, levels, m)
          // skip variants that are the current configuration (or another candidate) in other words
          const k = configKey(m, a.members[idx])
          if (seen.has(k)) continue
          seen.add(k)
          cands.push({ key: `${g.join("|")}#${JSON.stringify(a.presets)}`, members: a.members, search: a.search, presets: a.presets })
        }
      api.log(`第 ${round} 轮 · ${who}（${mp.className}，${mp.slots} 个技能格，池 ${pool.length} 个）：${cands.length - 1} 个方案`)
      let ranked = await halving(ev, cands, {
        ...common,
        stages,
        seedBase: 1000 * round + idx,
        onStage: (s, d, t) => api.progress(d, t, `第 ${round} 轮 · ${who} · 阶段 ${s + 1}/${stages.length}`),
      })
      // challenger = the candidate most likely better than the current one (highest lower bound of the paired
      // difference), not just the highest mean: with deaths in the mix the top mean is often the noisiest one
      const cur = ranked.find(r => r.incumbent)
      const pick = ranked.filter(r => !r.incumbent).sort((a, b) => b.vsIncumbent.low - a.vsIncumbent.low)[0]
      const tuneCtx = { ev, common, stages, idx, who, api, m }
      const challengers = []
      // 1) the best preset group, with its "search" thresholds tuned
      if (pick) {
        const items = (pick.search || []).map(x => ({ hrid: x.hrid, index: x.index, coarse: gridFor(x), percentage: x.kind === "percentage", fine: v => (x.kind === "percentage" ? [v - 5, v + 5] : [v * 0.75, v * 0.9, v * 1.1, v * 1.25]) }))
        challengers.push({ ...(await tune(tuneCtx, { ...pick }, items)).best, key: "best", incumbent: false })
      }
      // 2) the current abilities and trigger conditions, improved step by step: add / remove one condition at a
      //    time, then tune every numeric threshold
      {
        const t = await improveCurrent(tuneCtx, cur, round)
        if (t.changes.length) challengers.push({ ...t.best, key: "tuned", incumbent: false, tuned: t.changes, presets: groupLabels(t.changes) })
      }
      // confirm against the current configuration on fresh seeds (2x hours, 4x runs of the last stage):
      // the challengers were picked as the best of many on the search seeds, so those numbers flatter them
      let best = cur
      if (challengers.length) {
        const last = stages.at(-1)
        const confirm = { hours: last.hours * 2, seeds: last.seeds * 4 }
        api.progress(0, challengers.length + 1, `${who} · 复核（${confirm.hours} 小时 × ${confirm.seeds} 次）`)
        const check = await halving(ev, [{ ...cur, key: "cur", incumbent: true }, ...challengers], { ...common, stages: [confirm], seedBase: 8000 + 100 * round + idx })
        const confirmed = check.filter(r => !r.incumbent).map(r => ({ ...r, confirmed: confirm })).sort((a, b) => b.vsIncumbent.low - a.vsIncumbent.low)
        best = confirmed[0]
        ranked = [...confirmed, ...ranked.filter(r => r.key !== pick?.key)]
      }
      options[idx] = ranked.slice(0, 6).map(r => ({ cfg: r.members[idx], label: r.tuned ? `当前技能，触发改为 ${r.tuned.map(c => c.label).join("，")}` : names(m, r.members[idx]).join(" / ") }))
      history.push({ round, member: idx, top: ranked.slice(0, 5).map(r => ({ abilities: names(m, r.members[idx]), presets: r.presets, value: r.value, deaths: r.mean.deathsPerHour, vs: r.vsIncumbent, confirmed: r.confirmed, tuned: r.tuned?.map(c => c.label) })) })
      if (best.confirmed && best.vsIncumbent?.clearlyBetter) {
        members = best.members
        chosen[idx] = best.presets
        changed = true
        api.log(`  → 采用 ${best.tuned ? `当前技能，触发改为 ${best.tuned.map(c => c.label).join("，")}` : names(m, members[idx]).join(" / ")}（+${fmt(best.vsIncumbent.mean, objective)}）`)
      } else api.log(best.confirmed ? `  → 当前配置已是最好（最有希望的 ${best.tuned ? `当前触发改进 ${best.tuned.map(c => c.label).join("，")}` : names(m, best.members[idx]).join(" / ")} 复核 ${best.vsIncumbent.mean >= 0 ? "+" : ""}${fmt(best.vsIncumbent.mean, objective)} ± ${fmt(1.96 * best.vsIncumbent.se, objective)}，不显著）` : "  → 当前配置已是最好")
      api.partial({ members, history, baseline: baseline.mean, objective })
    }
    if (!changed) break
  }

  // team cross check: each member's top configurations (the current one plus up to 2 others) combined across the
  // team and simulated together, for changes that only pay off together (e.g. who casts the shared debuff)
  if (optimize.length >= 2) {
    const key = c => configKey(m, c)
    const lists = optimize.map(idx => {
      const seen = new Set()
      return [{ cfg: members[idx], label: "当前" }, ...(options[idx] || [])].filter(o => !seen.has(key(o.cfg)) && seen.add(key(o.cfg))).slice(0, 3)
    })
    if (lists.some(l => l.length > 1)) {
      const product = lists.reduce((acc, l) => acc.flatMap(a => l.map(o => [...a, o])), [[]])
      const cands = product.map((combo, k) => {
        const mem = clone(members)
        combo.forEach((o, j) => (mem[optimize[j]] = clone(o.cfg)))
        return { key: `x${k}`, members: mem, combo, incumbent: k === 0 }
      })
      api.log(`全队交叉组合：每人前 ${Math.max(...lists.map(l => l.length))} 名方案互相组合，共 ${cands.length} 种`)
      let ranked = await halving(ev, cands, { ...common, stages, seedBase: 6000, onStage: (s, d, t) => api.progress(d, t, `全队交叉组合 · 阶段 ${s + 1}/${stages.length}`) })
      const cur = ranked.find(r => r.incumbent)
      const pick = ranked.filter(r => !r.incumbent).sort((a, b) => b.vsIncumbent.low - a.vsIncumbent.low)[0]
      const comboText = r => r.combo.map((o, j) => `${members[optimize[j]].name || `队员${optimize[j] + 1}`}：${o.label}`)
      if (pick) {
        const last = stages.at(-1)
        const confirm = { hours: last.hours * 2, seeds: last.seeds * 4 }
        api.progress(0, 2, `全队交叉组合 · 复核（${confirm.hours} 小时 × ${confirm.seeds} 次）`)
        const check = await halving(ev, [{ ...cur, key: "cur" }, { ...pick, key: "best", incumbent: false }], { ...common, stages: [confirm], seedBase: 6500 })
        const best = { ...check.find(r => r.key === "best"), confirmed: confirm }
        ranked = [best, ...ranked.filter(r => r.key !== pick.key)]
        history.push({ title: "全队交叉组合", team: true, top: ranked.slice(0, 5).map(r => ({ abilities: comboText(r), value: r.value, deaths: r.mean.deathsPerHour, vs: r.vsIncumbent, confirmed: r.confirmed })) })
        const changedNames = best.combo.map((o, j) => (o.label === "当前" ? null : optimize[j])).filter(x => x != null)
        if (best.vsIncumbent.clearlyBetter) {
          members = best.members
          for (const idx of changedNames) chosen[idx] ||= {}
          api.log(`  → 采用 ${comboText(best).filter((_, j) => best.combo[j].label !== "当前").join("；")}（+${fmt(best.vsIncumbent.mean, objective)}）`)
        } else api.log(`  → 不换（最有希望的 ${comboText(best).join("；")} 复核 ${best.vsIncumbent.mean >= 0 ? "+" : ""}${fmt(best.vsIncumbent.mean, objective)} ± ${fmt(1.96 * best.vsIncumbent.se, objective)}，不显著）`)
        api.partial({ members, history, baseline: baseline.mean, objective })
      }
    }
  }

  const final = await ev.evaluate(members, target, { hours: 24, seeds: finalSeeds, extra, objective, signal: api.signal })
  const cmp = paired(final.perSeed, baseline.perSeed)
  // every change was confirmed on its own; the team check is reported, not used to throw them away
  if (!Object.keys(chosen).length) {
    api.log("当前技能配置已是最好")
    return { members: clone(params.members), history, chosen: {}, baseline: baseline.mean, final: baseline.mean, improvement: { mean: 0, se: 0, low: 0, high: 0 }, objective, unchanged: true }
  }
  restoreDefaults(m, members, params.members)
  api.log(`完成：${fmt(final.value, objective)}（基准 ${fmt(baseline.value, objective)}，提升 ${fmt(cmp.mean, objective)} ± ${fmt(1.96 * cmp.se, objective)}）`)
  return { members, history, chosen, baseline: baseline.mean, final: final.mean, improvement: cmp, objective }
}

/** Numeric thresholds of a member's current ability triggers (slots 1-4) as tuning items. A value of 1 or less
 *  on a HP / MP condition means "always" and is left alone. */
function currentItems(m, cfg) {
  const maps = m.$e
  const out = []
  for (const a of (cfg.abilities || []).slice(1)) {
    const h = a?.abilityHrid
    if (!h) continue
    ;(cfg.triggerMap?.[h] || []).forEach((c, index) => {
      if (!maps.combatTriggerComparatorDetailMap?.[c.comparatorHrid]?.allowValue) return
      const v = Number(c.value || 0)
      const cond = String(c.conditionHrid || "")
      if (cond.endsWith("number_of_active_units")) out.push({ hrid: h, index, coarse: [1, 2, 3, 4], fine: () => [] })
      else if (cond.endsWith("percentage")) out.push({ hrid: h, index, coarse: [v - 20, v - 10, v + 10, v + 20], fine: x => [x - 5, x + 5], percentage: true })
      else if (v > 1) out.push({ hrid: h, index, coarse: [v * 0.25, v * 0.5, v * 0.75, v * 1.5, v * 2, v * 3], fine: x => [x * 0.85, x * 1.15] })
    })
  }
  return out
}

/** Tunes thresholds one at a time (coarse values, then fine values around the best); a new value is kept when it
 *  beats the running best on the search seeds. Returns { best, changes: [{ hrid, index, from, to, label }] }. */
async function tune({ ev, common, stages, idx, who, api, m }, start, items) {
  let best = start
  const at = (c, it) => c.members[idx].triggerMap[it.hrid][it.index]
  const clean = (it, v) => (it.percentage ? Math.min(100, Math.max(1, Math.round(v))) : Math.max(1, Math.round(v)))
  const tryValues = async (it, vals, label) => {
    const cs = [{ ...best, key: "best", incumbent: true }]
    for (const v of new Set(vals.map(x => clean(it, x)))) {
      if (at(best, it).value === v) continue
      const mem = clone(best.members)
      mem[idx].triggerMap[it.hrid][it.index].value = v
      cs.push({ ...best, key: `${v}`, members: mem, incumbent: false })
    }
    if (cs.length === 1) return
    api.progress(0, cs.length, `${who} · ${zh(m.$e, it.hrid)} 阈值${label}`)
    const r = await halving(ev, cs, { ...common, stages: stages.length > 1 ? stages.slice(1) : stages, seedBase: 7000 + idx })
    if (!r[0].incumbent && r[0].vsIncumbent.mean > 0) best = { ...r[0], incumbent: false }
  }
  for (const it of items) {
    await tryValues(it, it.coarse, "粗搜")
    await tryValues(it, it.fine(at(best, it).value), "细搜")
  }
  const changes = items.map(it => ({ hrid: it.hrid, index: it.index, from: at(start, it).value, to: at(best, it).value }))
    .filter(c => c.from !== c.to)
    .map(c => ({ ...c, label: `${zh(m.$e, c.hrid)} ${c.from}→${c.to}` }))
  return { best, changes }
}

// ------------------------------------------------------------------------- trigger condition search

const DEP = e => `/combat_trigger_dependencies/${e}`
const CND = e => `/combat_trigger_conditions/${e}`
const CMP = e => `/combat_trigger_comparators/${e}`
const cnd = (dep, c, cmp, value = 0) => ({ dependencyHrid: DEP(dep), conditionHrid: CND(c), comparatorHrid: CMP(cmp), value })
const CMP_TEXT = { greater_than_equal: "≥", less_than_equal: "≤", is_active: "生效", is_inactive: "未生效" }

/** Conditions tried as additions to an ability's trigger (coarse values; the thresholds are tuned afterwards). */
function conditionLibrary(m, hrid, selfBuff) {
  const own = hrid.split("/").at(-1)
  const out = []
  for (const v of [300, 600, 1000]) out.push(cnd("self", "current_mp", "greater_than_equal", v))
  // the ability's own debuff still missing on the target (self buffs already have "self ... inactive")
  if (m.$e.combatTriggerConditionDetailMap?.[CND(own)] && !selfBuff) out.push(cnd("targeted_enemy", own, "is_inactive"))
  out.push(cnd("targeted_enemy", "blind_status", "is_inactive"), cnd("targeted_enemy", "stun_status", "is_inactive"))
  out.push(cnd("targeted_enemy", "boss_status", "is_active"), cnd("targeted_enemy", "boss_status", "is_inactive"))
  for (const v of [2, 3]) out.push(cnd("all_enemies", "number_of_active_units", "greater_than_equal", v))
  out.push(cnd("all_enemies", "number_of_active_units", "less_than_equal", 1))
  for (const v of [1000, 3000, 8000]) out.push(cnd("all_enemies", "current_hp", "greater_than_equal", v), cnd("targeted_enemy", "current_hp", "greater_than_equal", v))
  for (const v of [20, 50]) out.push(cnd("all_enemies", "lowest_hp_percentage", "greater_than_equal", v))
  return out
}

function condText(m, c) {
  const n = h => { const t = zh(m.$e, h); return t === h ? h.split("/").at(-1) : t }
  const cmp = c.comparatorHrid.split("/").at(-1)
  return `${n(c.dependencyHrid)}${n(c.conditionHrid)}${CMP_TEXT[cmp] || n(c.comparatorHrid)}${["is_active", "is_inactive"].includes(cmp) ? "" : Number(c.value || 0)}`
}
const sameKind = (a, b) => a.dependencyHrid === b.dependencyHrid && a.conditionHrid === b.conditionHrid && a.comparatorHrid === b.comparatorHrid

/** Members with the trigger of every ability in slots 1-4 written out (game default when not set). */
function materialize(m, members, idx) {
  const next = clone(members)
  const c = next[idx]
  c.triggerMap = { ...(c.triggerMap || {}) }
  for (const a of (c.abilities || []).slice(1)) {
    const h = a?.abilityHrid
    if (h && !c.triggerMap[h]) c.triggerMap[h] = (m.$e.abilityDetailMap[h]?.defaultCombatTriggers || []).map(strip)
  }
  return next
}

/** Configurations one change away: one condition added to or removed from one ability's trigger (at most 4). */
function neighbors(m, members, idx) {
  const cfg = members[idx]
  const out = []
  for (const a of (cfg.abilities || []).slice(1)) {
    const h = a?.abilityHrid
    if (!h) continue
    const conds = cfg.triggerMap[h] || []
    const name = zh(m.$e, h)
    conds.forEach((c, i) => {
      const mem = clone(members)
      mem[idx].triggerMap[h].splice(i, 1)
      out.push({ members: mem, hrid: h, label: `${name} 去掉「${condText(m, c)}」` })
    })
    if (conds.length >= 4) continue
    const selfBuff = conds.some(c => c.dependencyHrid === DEP("self") && c.conditionHrid === CND(h.split("/").at(-1)))
    for (const c of conditionLibrary(m, h, selfBuff)) {
      if (conds.some(x => sameKind(x, c))) continue
      const mem = clone(members)
      mem[idx].triggerMap[h] = [...conds.map(strip), strip(c)]
      out.push({ members: mem, hrid: h, label: `${name} 加上「${condText(m, c)}」` })
    }
  }
  return out
}

/** From the current configuration: up to 3 steps of the best single condition change (all neighbours through the
 *  staged search, coarse to fine; a step is taken when it is clearly better on the search seeds), then the
 *  numeric thresholds tuned. Returns { best, changes: [{ hrid, label }] }. */
async function improveCurrent(ctx, cur, round) {
  const { ev, common, stages, idx, who, api, m } = ctx
  let state = { ...cur, members: materialize(m, cur.members, idx), incumbent: false, presets: {} }
  const changes = []
  for (let step = 1; step <= 3; step++) {
    const nb = neighbors(m, state.members, idx)
    if (!nb.length) break
    const cands = [{ ...state, key: "state", incumbent: true }, ...nb.map((n, k) => ({ ...state, key: `n${k}`, members: n.members, change: n, incumbent: false }))]
    const r = await halving(ev, cands, {
      ...common, stages, seedBase: 9000 + 100 * round + 10 * idx + step,
      onStage: (s, d, t) => api.progress(d, t, `${who} · 触发条件搜索第 ${step} 步（${nb.length} 个改法）· 阶段 ${s + 1}/${stages.length}`),
    })
    const top = r.filter(x => !x.incumbent).sort((a, b) => b.vsIncumbent.low - a.vsIncumbent.low)[0]
    if (!top || !(top.vsIncumbent.low > 0)) break
    api.log(`  ${who} 触发条件第 ${step} 步：${top.change.label}（搜索时 +${fmt(top.vsIncumbent.mean, common.objective)}）`)
    changes.push({ hrid: top.change.hrid, label: top.change.label })
    state = { ...top, incumbent: false }
  }
  const t = await tune(ctx, state, currentItems(m, state.members[idx]))
  return { best: t.best, changes: [...changes, ...t.changes] }
}

/** { abilityHrid: "change; change" } for the history table. */
function groupLabels(changes) {
  const out = {}
  for (const c of changes) out[c.hrid] = out[c.hrid] ? `${out[c.hrid]}；${c.label}` : c.label
  return out
}

/** Trigger entries the search only wrote out (materialize) and left at the game default go back to "not set". */
function restoreDefaults(m, members, original) {
  members.forEach((c, i) => {
    for (const [h, conds] of Object.entries(c.triggerMap || {})) {
      if (Object.prototype.hasOwnProperty.call(original[i]?.triggerMap || {}, h)) continue
      const def = (m.$e.abilityDetailMap[h]?.defaultCombatTriggers || []).map(strip)
      if (JSON.stringify(conds.map(strip)) === JSON.stringify(def)) delete c.triggerMap[h]
    }
  })
}

function fmt(v, objective) {
  if (OBJECTIVE_FORMATS[objective]) return OBJECTIVE_FORMATS[objective](v)
  if (objective === "xp") return `${Math.round(v).toLocaleString()} 经验/小时`
  return `${(v * 24 / 1e6).toFixed(2)}M/天`
}
