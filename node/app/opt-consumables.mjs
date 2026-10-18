// Food / drink optimization for the whole team: per slot, first which item (any combat food /
// drink, unlocked empty slots included; one item per food family — yogurt / gummy / donut / cake —
// and per drink buff),
// then its trigger (templates with coarse-then-fine thresholds). Coordinate descent over all
// members and slots; only changes that are clearly better than noise again on fresh seeds (the
// winner's own seeds flatter it) are adopted, and the result is kept only if the final review
// (24 h × 32 runs) confirms it.
// A new item is tried with its game default trigger and, when it restores the same thing (HP / MP)
// as the item it replaces, also with that item's trigger: a default that fires too early can make
// a better item lose before its trigger is ever tuned. Each round starts with team-wide swaps (an
// item held by several members replaced for all of them at once), whose gain is large enough to
// show above the noise where a single member's share would not.
import { confirmAdaptive, halving } from "./search.mjs"
import { defaultTriggers, teamDTO, triggersFor } from "./model.mjs"
import { OBJECTIVE_FORMATS, paired, seedList } from "./evaluator.mjs"
import { zh } from "./i18n.mjs"
import { playerStats } from "./game.mjs"

const clone = v => JSON.parse(JSON.stringify(v))
const D = "/combat_trigger_dependencies/"
const C = "/combat_trigger_conditions/"
const K = "/combat_trigger_comparators/"
const cond = (dep, c, cmp, value = 0) => ({ dependencyHrid: D + dep, conditionHrid: C + c, comparatorHrid: K + cmp, value })
const KINDS = [["food", "/item_categories/food", "食物"], ["drinks", "/item_categories/drink", "饮料"]]

/** Max HP / MP and unlocked food/drink slots of a member. */
function memberInfo(m, dto) {
  const s = playerStats(m, { ...dto, food: [], drinks: [], abilities: [] })
  return { hp: s.maxHitpoints, mp: s.maxManapoints, slots: { food: s.foodSlots, drinks: s.drinkSlots } }
}

const grid = (max, fr) => [...new Set(fr.map(f => Math.max(1, Math.round((max * f) / 10) * 10)))]

/** Trigger templates for a consumable (threshold grids scaled to the member's max HP/MP). */
function templates(m, hrid, info) {
  const d = m.$e.itemDetailMap[hrid]?.consumableDetail || {}
  const out = []
  const coarse = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
  if (d.hitpointRestore > 0) {
    for (const v of grid(info.hp, coarse)) out.push({ family: "missing_hp", label: `缺失HP ≥ ${v}`, triggers: [cond("self", "missing_hp", "greater_than_equal", v)], value: v })
    for (const v of grid(info.hp, coarse)) out.push({ family: "current_hp", label: `当前HP ≤ ${v}`, triggers: [cond("self", "current_hp", "less_than_equal", v)], value: v })
  }
  if (d.manapointRestore > 0)
    for (const v of grid(info.mp, coarse)) out.push({ family: "missing_mp", label: `缺失MP ≥ ${v}`, triggers: [cond("self", "missing_mp", "greater_than_equal", v)], value: v })
  if (!(d.hitpointRestore > 0) && !(d.manapointRestore > 0)) {
    out.push({ family: "in_combat", label: "有目标时（战斗中）", triggers: [cond("targeted_enemy", "current_hp", "greater_than_equal", 1)] })
    for (const n of [2, 3, 4]) out.push({ family: "enemies", label: `所有敌人的存活数 ≥ ${n}`, triggers: [cond("all_enemies", "number_of_active_units", "greater_than_equal", n)], value: n })
    for (const v of [5000, 10000, 20000, 40000]) out.push({ family: "target_hp", label: `目标敌人的当前HP ≥ ${v}`, triggers: [cond("targeted_enemy", "current_hp", "greater_than_equal", v)], value: v })
  }
  return out
}

function refineAround(best, info) {
  if (!best?.family || best.value == null) return []
  const step = best.family.endsWith("hp") ? info.hp * 0.05 : best.family.endsWith("mp") ? info.mp * 0.05 : 0
  if (!step) return []
  return [-1, 1].map(f => {
    const v = Math.max(1, Math.round((best.value + f * step) / 10) * 10)
    const t = clone(best.triggers)
    t[0].value = v
    return { ...best, label: best.label.replace(/\d+$/, String(v)), triggers: t, value: v }
  })
}

const buffUniques = (m, h) => new Set((m.$e.itemDetailMap[h]?.consumableDetail?.buffs || []).map(b => b.uniqueHrid))

/** Food family (only one of each can be equipped): yogurt, gummy, donut, cake. */
function foodFamily(h) {
  const n = String(h || "").replace("/items/", "")
  for (const f of ["yogurt", "gummy", "donut"]) if (n === f || n.endsWith(`_${f}`)) return f
  if (n === "cupcake" || n.endsWith("_cake")) return "cake"
  return ""
}

/** Items that cannot sit next to each other: same food family, or same drink buff. */
function conflicts(m, a, b) {
  const fa = foodFamily(a)
  if (fa && fa === foodFamily(b)) return true
  const ua = buffUniques(m, a)
  return [...buffUniques(m, b)].some(u => ua.has(u))
}

/** "hp" / "mp" for a restoring food, "" otherwise. */
function restores(m, h) {
  const d = m.$e.itemDetailMap[h]?.consumableDetail || {}
  return d.hitpointRestore > 0 ? "hp" : d.manapointRestore > 0 ? "mp" : ""
}

/**
 * Trigger variants for `to` replacing `from` in a member: the game default and, for the same kind of
 * restore, `from`'s current trigger. Each variant: { carried, apply(member) } (sets the triggerMap entry).
 */
function swapTriggers(m, member, from, to) {
  const out = [{ carried: false, apply: x => { if (x.triggerMap) delete x.triggerMap[to] } }]
  if (from && restores(m, from) && restores(m, from) === restores(m, to)) {
    const carried = triggersFor(m, member.triggerMap || {}, from)
    if (JSON.stringify(carried) !== JSON.stringify(defaultTriggers(m, to)))
      out.push({ carried: true, apply: x => { x.triggerMap = { ...(x.triggerMap || {}), [to]: clone(carried) } } })
  }
  return out
}

const CARRIED = "（沿用原触发）"

/** params: { members, target, extra, objective, optimize, rounds, swapItems, allowItems? (candidate items; default all) } */
export async function optimizeConsumables(ev, params, api) {
  const { m } = ev.ctx
  const { target, extra, objective = "profit", rounds = 2, swapItems = true } = params
  let members = clone(params.members)
  const optimize = params.optimize?.length ? params.optimize : members.map((_, i) => i)
  const itemStages = [{ hours: 4, seeds: 2, keep: 6 }, { hours: 12, seeds: 6, keep: 2 }]
  const trigStages = [{ hours: 6, seeds: 4, keep: 4 }, { hours: 12, seeds: 8, keep: 2 }]
  // team swaps: few of them, and their gains (a few %) need more seeds to survive the first cut
  const teamStages = [{ hours: 6, seeds: 6, keep: 8 }, { hours: 12, seeds: 12, keep: 3 }, { hours: 24, seeds: 24, keep: 2 }]
  const common = { target, extra, objective, signal: api.signal }
  const infos = teamDTO(m, members).map(d => memberInfo(m, d))
  const pool = Object.fromEntries(KINDS.map(([k, cat]) => [k, Object.values(m.$e.itemDetailMap)
    .filter(i => i.categoryHrid === cat && i.consumableDetail?.cooldownDuration > 0 && i.consumableDetail?.usableInActionTypeMap?.["/action_types/combat"])
    .map(i => i.hrid)
    .filter(h => !params.allowItems || params.allowItems.includes(h))]))
  // 24 h × 32 runs: with 8 the end check was about a coin flip for small gains
  const finalSeeds = seedList(55511, 32)
  const baseline = await ev.evaluate(members, target, { hours: 24, seeds: finalSeeds, extra, objective, signal: api.signal })
  api.log(`基准：${fmt(baseline.value, objective)}`)
  const changes = []
  // the last halving stage picks the best on its own seeds, so its number flatters it (the best of
  // dozens): a winner is taken only once it is confirmed against the current setting on fresh seeds
  let confirms = 0
  const confirmed = async (ranked, stages, label) => {
    const best = ranked[0]
    if (best.incumbent || !best.vsIncumbent?.clearlyBetter) return null
    const cur = ranked.find(r => r.incumbent)
    if (!cur) return best
    const [c] = await confirmAdaptive(ev, common, stages, cur, [best], { seedBase: 70000 + 97 * confirms++, label: `${label} · 复核`, api })
    if (c.vsIncumbent.clearlyBetter) return { ...best, vsIncumbent: c.vsIncumbent }
    api.log(`${label}：最好的候选初看 +${fmt(best.vsIncumbent.mean, objective)}，换一组随机种子复核 ${c.vsIncumbent.mean >= 0 ? "+" : ""}${fmt(c.vsIncumbent.mean, objective)} ± ${fmt(1.96 * c.vsIncumbent.se, objective)}，不显著，不换`)
    return null
  }

  for (let round = 1; round <= rounds; round++) {
    let changed = false

    // 0) team-wide swaps: an item held by two or more members, replaced for all of them
    if (swapItems && optimize.length > 1) {
      for (const [kind, , kindName] of KINDS) {
        const held = [...new Set(optimize.flatMap(i => (members[i][kind] || []).filter(Boolean)))]
          .map(from => ({ from, who: optimize.filter(i => (members[i][kind] || []).includes(from)) }))
          .filter(x => x.who.length > 1)
        for (const { from, who } of held) {
          if (api.signal.aborted) throw new Error("cancelled")
          const cands = [{ key: from, members: clone(members), incumbent: true }]
          for (const to of pool[kind]) {
            if (to === from) continue
            const fits = who.every(i => (members[i][kind] || []).filter(h => h && h !== from).every(o => o !== to && !conflicts(m, to, o)))
            if (!fits) continue
            // default triggers for all, or each member's own trigger of the replaced item (default where it has none to carry)
            const variants = who.map(i => swapTriggers(m, members[i], from, to))
            for (const carried of variants.some(v => v.length > 1) ? [false, true] : [false]) {
              const mem = clone(members)
              who.forEach((i, k) => {
                mem[i][kind] = mem[i][kind].map(h => (h === from ? to : h))
                ;(carried ? variants[k].at(-1) : variants[k][0]).apply(mem[i])
              })
              cands.push({ key: carried ? to + CARRIED : to, hrid: to, carried, members: mem })
            }
          }
          const where = `全队 · ${kindName} · ${zh(m.$e, from)}`
          const ranked = await halving(ev, cands, {
            ...common,
            stages: teamStages,
            seedBase: 500 * round + (kind === "food" ? 0 : 11) + pool[kind].indexOf(from),
            onStage: (s, d, t) => api.progress(d, t, `第 ${round} 轮 · ${where} · 全队换药`),
          })
          const best = await confirmed(ranked, teamStages, `${where} · 全队换药`)
          if (best) {
            members = best.members
            changed = true
            const to = zh(m.$e, best.hrid) + (best.carried ? CARRIED : "")
            changes.push({ round, member: who[0], members: who, team: true, kind, what: "物品", from: zh(m.$e, from), to, gain: best.vsIncumbent })
            api.log(`${where} → ${to}（${who.length} 人，+${fmt(best.vsIncumbent.mean, objective)}）`)
            api.partial({ members, changes, baseline: baseline.mean, objective })
          }
        }
      }
    }

    for (const idx of optimize) {
      const who = members[idx].name || `队员${idx + 1}`
      for (const [kind, , kindName] of KINDS) {
        const slotCount = Math.min(3, infos[idx].slots[kind] || 1)
        for (let slot = 0; slot < slotCount; slot++) {
          if (api.signal.aborted) throw new Error("cancelled")
          const cur = members[idx][kind]?.[slot] || ""
          const where = `${who} · ${kindName} ${slot + 1}`

          // 1) which item
          if (swapItems) {
            const others = (members[idx][kind] || []).filter((h, i) => h && i !== slot)
            const cands = [{ key: cur || "空", members: clone(members), incumbent: true }]
            for (const h of pool[kind]) {
              if (h === cur || others.includes(h)) continue
              if (others.some(o => conflicts(m, h, o))) continue
              for (const v of swapTriggers(m, members[idx], cur, h)) {
                const mem = clone(members)
                mem[idx][kind] = [...(mem[idx][kind] || ["", "", ""])]
                mem[idx][kind][slot] = h
                v.apply(mem[idx])
                cands.push({ key: v.carried ? h + CARRIED : h, hrid: h, carried: v.carried, members: mem })
              }
            }
            const ranked = await halving(ev, cands, {
              ...common,
              stages: itemStages,
              seedBase: 400 * round + idx * 31 + slot + (kind === "food" ? 0 : 7),
              onStage: (s, d, t) => api.progress(d, t, `第 ${round} 轮 · ${where} · 选药`),
            })
            const best = await confirmed(ranked, itemStages, `${where} · 选药`)
            if (best) {
              members = best.members
              changed = true
              const to = zh(m.$e, best.hrid) + (best.carried ? CARRIED : "")
              changes.push({ round, member: idx, kind, slot, what: "物品", from: cur ? zh(m.$e, cur) : "空", to, gain: best.vsIncumbent })
              api.log(`${where}：${cur ? zh(m.$e, cur) : "空"} → ${to}（+${fmt(best.vsIncumbent.mean, objective)}）`)
            }
          }

          // 2) its trigger
          const hrid = members[idx][kind]?.[slot]
          if (!hrid) continue
          const name = zh(m.$e, hrid)
          const curTrig = triggersFor(m, members[idx].triggerMap || {}, hrid)
          const base = [
            { label: "当前", triggers: curTrig },
            { label: "游戏默认", triggers: defaultTriggers(m, hrid) },
            { label: "无条件（冷却好就用）", triggers: [] },
            ...templates(m, hrid, infos[idx]),
          ]
          const mk = list => {
            const seen = new Set()
            return list.filter(v => {
              const k = JSON.stringify(v.triggers)
              if (seen.has(k)) return false
              seen.add(k)
              return true
            }).map((v, i) => {
              const mem = clone(members)
              mem[idx].triggerMap = { ...(mem[idx].triggerMap || {}), [hrid]: v.triggers }
              return { key: v.label, label: v.label, variant: v, members: mem, incumbent: i === 0 }
            })
          }
          let ranked = await halving(ev, mk(base), {
            ...common,
            stages: trigStages,
            seedBase: 300 * round + idx * 17 + slot + (kind === "food" ? 0 : 5),
            onStage: (s, d, t) => api.progress(d, t, `第 ${round} 轮 · ${where} · ${name} 触发`),
          })
          const fine = refineAround(ranked[0].variant, infos[idx])
          if (fine.length) ranked = await halving(ev, mk([base[0], ranked[0].variant, ...fine]), { ...common, stages: [trigStages[1]], seedBase: 900 + idx })
          const best = await confirmed(ranked, trigStages, `${where} · ${name} 触发`)
          if (best) {
            members = best.members
            changed = true
            changes.push({ round, member: idx, kind, slot, what: "触发", from: "", to: `${name}：${best.label}`, gain: best.vsIncumbent })
            api.log(`${where} · ${name} 触发 → ${best.label}`)
          }
          api.partial({ members, changes, baseline: baseline.mean, objective })
        }
      }
    }
    if (!changed) break
  }

  const final = await ev.evaluate(members, target, { hours: 24, seeds: finalSeeds, extra, objective, signal: api.signal })
  const improvement = paired(final.perSeed, baseline.perSeed)
  if (!changes.length || improvement.mean <= 0) {
    api.log(changes.length ? "复核没有提升，保留原来的设置" : "当前药水配置已是最好")
    return { members: clone(params.members), changes: [], rejected: changes, baseline: baseline.mean, final: baseline.mean, improvement: { mean: 0, se: 0, low: 0, high: 0 }, objective, unchanged: true }
  }
  api.log(`完成：${fmt(final.value, objective)}（基准 ${fmt(baseline.value, objective)}，提升 ${fmt(improvement.mean, objective)}）`)
  return { members, changes, baseline: baseline.mean, final: final.mean, improvement, objective }
}

function fmt(v, objective) {
  if (OBJECTIVE_FORMATS[objective]) return OBJECTIVE_FORMATS[objective](v)
  if (objective === "xp") return `${Math.round(v).toLocaleString()} 经验/小时`
  return `${(v * 24 / 1e6).toFixed(2)}M/天`
}
