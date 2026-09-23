// Class-based ability pools, orders, finishers and trigger presets — ported from the combat-sim
// site's skill optimizer (index bundle: AI, MI, ng, FI, ZI, NI, k5, D5, x5).
const A = e => `/abilities/${e}`
const D = e => `/combat_trigger_dependencies/${e}`
const C = e => `/combat_trigger_conditions/${e}`
const K = e => `/combat_trigger_comparators/${e}`

export const CLASS_NAMES = { water: "水法", fire: "火法", nature: "自然法", sword: "剑", mace: "锤", spear: "枪", bow: "弓", crossbow: "弩", shield: "盾" }

export const POOLS = {
  water: ["elemental_affinity", "frost_surge", "mana_spring", "water_strike", "precision", "ice_spear"],
  fire: ["elemental_affinity", "smoke_burst", "firestorm", "flame_blast", "fireball", "precision"],
  nature: ["elemental_affinity", "toxic_pollen", "natures_veil", "life_drain", "entangle", "quick_aid", "rejuvenate", "precision"],
  sword: ["frenzy", "berserk", "precision", "maim", "crippling_slash", "cleave", "vampirism"],
  mace: ["frenzy", "berserk", "precision", "fracturing_impact", "stunning_blow", "sweep", "vampirism"],
  spear: ["frenzy", "berserk", "precision", "puncture", "penetrating_strike", "vampirism"],
  bow: ["frenzy", "berserk", "precision", "rain_of_arrows", "steady_shot", "pestilent_shot", "penetrating_shot", "vampirism"],
  crossbow: ["frenzy", "berserk", "precision", "rain_of_arrows", "steady_shot", "pestilent_shot", "penetrating_shot", "vampirism"],
  shield: ["provoke", "elusiveness", "toughness", "spike_shell", "retribution", "fracturing_impact", "shield_bash"],
}
const FINISHER = { water: A("water_strike"), fire: A("fireball"), nature: A("entangle") }
const ORDER = {
  water: ["elemental_affinity", "precision", "frost_surge", "mana_spring", "ice_spear", "water_strike"],
  fire: ["elemental_affinity", "precision", "smoke_burst", "firestorm", "flame_blast", "fireball"],
  nature: ["rejuvenate", "quick_aid", "elemental_affinity", "precision", "toxic_pollen", "natures_veil", "life_drain", "entangle"],
  sword: ["frenzy", "berserk", "precision", "vampirism", "maim", "crippling_slash", "cleave"],
  mace: ["frenzy", "berserk", "precision", "vampirism", "fracturing_impact", "stunning_blow", "sweep"],
  spear: ["frenzy", "berserk", "precision", "vampirism", "puncture", "penetrating_strike"],
  bow: ["frenzy", "berserk", "precision", "vampirism", "penetrating_shot", "rain_of_arrows", "pestilent_shot", "steady_shot"],
  crossbow: ["frenzy", "berserk", "precision", "vampirism", "penetrating_shot", "rain_of_arrows", "pestilent_shot", "steady_shot"],
  shield: ["provoke", "elusiveness", "toughness", "spike_shell", "retribution", "fracturing_impact", "shield_bash"],
}
const AFFINITY = A("elemental_affinity")
const HEALS = new Set([A("minor_heal"), A("heal"), A("quick_aid"), A("rejuvenate")])

// condition builders (`ka`); valueMode "search" marks thresholds the optimizer tunes
const cond = (dep, c, cmp, value = 0, mode = "fixed", kind) => ({ dependencyHrid: D(dep), conditionHrid: C(c), comparatorHrid: K(cmp), value, valueMode: mode, searchKind: kind })
const enemyHp = (v, mode = "fixed") => cond("all_enemies", "current_hp", "greater_than_equal", v, mode, "absolute")
const targetHp = (v = 2000) => cond("targeted_enemy", "current_hp", "greater_than_equal", v, "search", "absolute")
const multi = () => cond("all_enemies", "number_of_active_units", "greater_than_equal", 2)
const lowestHp = () => cond("all_allies", "lowest_hp_percentage", "less_than_equal", 75, "search", "percentage")
const missingHp = () => cond("all_allies", "missing_hp", "greater_than_equal", 1000, "search", "absolute")
const inactive = e => cond("self", e, "is_inactive")
const mpSafe = () => cond("self", "current_mp", "greater_than_equal", 200)
const preset = (id, label, checked, conditions) => ({ id, label, checked, conditions })

/** `FI`: trigger presets of an ability (checked = used by default). */
export function presets(m, hrid) {
  const t = hrid.split("/").at(-1) || ""
  if (["elemental_affinity", "frenzy", "vampirism"].includes(t))
    return [preset("default-inactive", "效果未生效", true, [inactive(t)]), preset("mp-safe", "效果未生效 且 MP≥200", false, [inactive(t), mpSafe()])]
  if (["precision", "berserk"].includes(t)) return [preset("default-inactive", "效果未生效", true, [inactive(t)])]
  if (["frost_surge", "smoke_burst"].includes(t))
    return [preset("always", "敌方总 HP≥1", true, [enemyHp(1)]), preset("hp-search", "敌方总 HP≥阈值", false, [enemyHp(2000, "search")])]
  if (["mana_spring", "ice_spear", "life_drain", "entangle", "fireball"].includes(t)) return [preset("always", "敌方总 HP≥1", true, [enemyHp(1)])]
  if (t === "water_strike") return [preset("empty", "无条件", true, [])]
  if (["firestorm", "flame_blast"].includes(t))
    return [preset("always", "敌方总 HP≥1", true, [enemyHp(1)]), preset("hp-search", "敌方总 HP≥阈值", false, [enemyHp(2000, "search")]), preset("multi-hp-search", "存活数≥2 且 敌方总 HP≥阈值", false, [multi(), enemyHp(2000, "search")])]
  if (["toxic_pollen", "natures_veil"].includes(t))
    return [preset("hp-search", "敌方总 HP≥阈值", true, [enemyHp(2000, "search")]), preset("multi", "敌方存活数≥2", true, [multi()])]
  if (t === "quick_aid") return [preset("lowest-hp", "队伍最低 HP≤阈值", true, [lowestHp()]), preset("missing-hp", "队友已损失总 HP≥阈值", false, [missingHp()])]
  if (t === "rejuvenate") return [preset("missing-hp", "队友已损失总 HP≥阈值", true, [missingHp()]), preset("lowest-hp", "队伍最低 HP≤阈值", true, [lowestHp()])]
  if (["maim", "fracturing_impact", "puncture", "pestilent_shot", "steady_shot"].includes(t)) return [preset("target-hp", "目标敌人当前 HP≥阈值", true, [targetHp()])]
  if (["crippling_slash", "cleave", "stunning_blow", "sweep", "penetrating_strike", "penetrating_shot", "rain_of_arrows", "shield_bash"].includes(t))
    return [preset("hp-search", "敌方总 HP≥阈值", true, [enemyHp(2000, "search")])]
  if (["provoke", "spike_shell", "retribution"].includes(t)) return [preset("empty", "无条件", true, [])]
  if (t === "elusiveness") return [preset("empty", "无条件", true, []), preset("other-inactive", "坚韧未生效", false, [inactive("toughness")])]
  if (t === "toughness") return [preset("empty", "无条件", true, []), preset("other-inactive", "闪避未生效", false, [inactive("elusiveness")])]
  return [preset("game-default", "游戏默认", true, (m.$e.abilityDetailMap[hrid]?.defaultCombatTriggers || []).slice(0, 4).map(c => ({ ...c })))]
}

/** `ZI`: class of a weapon. */
export function classOf(m, weaponHrid) {
  const d = m.$e.itemDetailMap[weaponHrid]?.equipmentDetail
  const type = String(d?.type || "")
  if (!["/equipment_types/main_hand", "/equipment_types/two_hand"].includes(type)) return null
  const s = d.combatStats || {}
  const style = String(s.combatStyleHrids?.[0] || "")
  if (style === "/combat_styles/magic") {
    if (s.damageType === "/damage_types/water") return "water"
    if (s.damageType === "/damage_types/fire") return "fire"
    if (s.damageType === "/damage_types/nature") return "nature"
  }
  if (style === "/combat_styles/slash") return "sword"
  if (style === "/combat_styles/stab") return "spear"
  if (style === "/combat_styles/ranged") return type === "/equipment_types/two_hand" ? "bow" : "crossbow"
  if (style === "/combat_styles/smash") return s.primaryTraining === "/skills/defense" ? "shield" : "mace"
  return null
}

/** `x5`: unlocked normal ability slots. */
export function normalSlots(m, intelligence) {
  const req = m.$e.abilitySlotsLevelRequirementList || []
  const t = Math.max(1, Math.floor(Number(intelligence || 1)))
  return [1, 2, 3, 4].filter(i => t >= Number(req[i + 1] ?? Infinity)).length
}

/** `NI`: cast order of a group. */
export function orderGroup(group, cls, lockFinisher = true) {
  const set = new Set(group)
  const rank = new Map()
  ;[...ORDER[cls].map(A), ...group].forEach((h, i) => rank.has(h) || rank.set(h, i))
  let o = [...group].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b))
  if (set.has(AFFINITY)) {
    const rest = o.filter(h => h !== AFFINITY)
    o = [...rest.filter(h => HEALS.has(h)), AFFINITY, ...rest.filter(h => !HEALS.has(h))]
  }
  const fin = FINISHER[cls]
  return lockFinisher && fin && set.has(fin) ? [...o.filter(h => h !== fin), fin] : o
}

function combos(arr, k) {
  if (k === 0) return [[]]
  if (k < 0 || arr.length < k) return []
  const out = []
  for (let i = 0; i <= arr.length - k; i++) for (const rest of combos(arr.slice(i + 1), k - 1)) out.push([arr[i], ...rest])
  return out
}

/** `k5`: ability groups for a pool (finisher locked into every group when available). */
export function groups(pool, slots, cls, lockFinisher = true) {
  const k = Math.max(0, Math.min(4, Math.floor(slots)))
  const fin = FINISHER[cls]
  const raw = lockFinisher && fin && pool.includes(fin) && k > 0
    ? combos(pool.filter(h => h !== fin), k - 1).map(g => [...g, fin])
    : combos(pool, k)
  return raw.map(g => orderGroup(g, cls, lockFinisher))
}

/** `D5`: one variant per combination of the abilities' checked presets. */
export function presetVariants(m, group, checkedOnly = true) {
  let out = [{}]
  for (const h of group) {
    const ps = presets(m, h).filter(p => !checkedOnly || p.checked)
    const list = ps.length ? ps : [preset("empty", "无条件", true, [])]
    out = out.flatMap(v => list.map(p => ({ ...v, [h]: p })))
  }
  return out
}

/** Pool of a member: class, pool abilities with learned levels, unlocked slots. */
export function memberPool(m, cfg) {
  const cls = classOf(m, cfg.equipment?.weapon?.itemHrid)
  const levels = { ...(cfg.abilityLevelMap || {}) }
  for (const a of cfg.abilities || []) if (a?.abilityHrid) levels[a.abilityHrid] = Math.max(Number(levels[a.abilityHrid] || 0), Number(a.level || 1))
  const pool = cls ? POOLS[cls].map(A).map(h => ({ hrid: h, level: Number(levels[h] || 0), learned: Number(levels[h] || 0) > 0 })) : []
  return { cls, className: cls ? CLASS_NAMES[cls] : "未识别", pool, slots: normalSlots(m, cfg.levels?.intelligence) }
}
