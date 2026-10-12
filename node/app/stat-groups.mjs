// Stat groups of the stat value analysis (属性价值, opt-statvalue.mjs). Kept free of the name
// tables so the web page can list the groups too.

const STYLE_ZH = { stab: "刺击", slash: "斩击", smash: "钝击", ranged: "远程", magic: "魔法" }
const DTYPE_ZH = { physical: "物理", water: "水系", nature: "自然系", fire: "火系" }
const SKILL_ZH = { stamina: "耐力", intelligence: "智力", attack: "攻击", defense: "防御", melee: "近战", ranged: "远程", magic: "魔法" }
const EVASIONS = ["stabEvasion", "slashEvasion", "smashEvasion", "rangedEvasion", "magicEvasion"]
const RESISTANCES = ["waterResistance", "natureResistance", "fireResistance"]

/**
 * id, label (generic; style-specific ones are filled in per member), kind, default selection,
 * step and display unit (pct: the unit is 1% / 0.1%). `keys(style, dtype)`: equipStats keys
 * raised together; level groups raise skill levels instead.
 */
export const STAT_GROUPS = [
  { id: "accuracy", label: "精准（武器类型）", kind: "attack", on: true, step: 0.1, unit: 0.01, keys: s => [`${s}Accuracy`], name: s => `${STYLE_ZH[s]}精准` },
  { id: "damage", label: "伤害（武器类型）", kind: "attack", on: true, step: 0.1, unit: 0.01, keys: s => [`${s}Damage`], name: s => `${STYLE_ZH[s]}伤害` },
  { id: "amplify", label: "增幅（伤害类型）", kind: "attack", on: true, step: 0.05, unit: 0.01, keys: (s, d) => [`${d}Amplify`], name: (s, d) => `${DTYPE_ZH[d]}增幅` },
  { id: "penetration", label: "穿透（伤害类型）", kind: "attack", on: true, step: 0.1, unit: 0.01, keys: (s, d) => [d === "physical" ? "armorPenetration" : `${d}Penetration`], name: (s, d) => `${DTYPE_ZH[d]}穿透` },
  { id: "criticalRate", label: "暴击率", kind: "attack", on: true, step: 0.03, unit: 0.01, keys: () => ["criticalRate"] },
  { id: "criticalDamage", label: "暴击伤害", kind: "attack", on: true, step: 0.1, unit: 0.01, keys: () => ["criticalDamage"] },
  { id: "attackSpeed", label: "攻击速度", kind: "attack", on: true, step: 0.05, unit: 0.01, keys: () => ["attackSpeed"] },
  { id: "castSpeed", label: "施法速度", kind: "attack", on: true, step: 0.05, unit: 0.01, keys: () => ["castSpeed"] },
  { id: "abilityHaste", label: "技能急速", kind: "attack", on: true, step: 10, unit: 1, keys: () => ["abilityHaste"] },
  { id: "abilityDamage", label: "技能伤害", kind: "attack", on: true, step: 0.05, unit: 0.01, keys: () => ["abilityDamage"] },
  { id: "autoAttackDamage", label: "普攻伤害", kind: "attack", on: true, step: 0.05, unit: 0.01, keys: () => ["autoAttackDamage"] },
  { id: "healingAmplify", label: "治疗增幅", kind: "attack", on: false, step: 0.1, unit: 0.01, keys: () => ["healingAmplify"] },
  { id: "evasion", label: "闪避（全部）", kind: "defense", on: true, step: 0.1, unit: 0.01, keys: () => EVASIONS },
  { id: "armor", label: "护甲", kind: "defense", on: true, step: 20, unit: 1, keys: () => ["armor"] },
  { id: "resistance", label: "抗性（全部）", kind: "defense", on: true, step: 20, unit: 1, keys: () => RESISTANCES },
  { id: "maxHitpoints", label: "最大生命值", kind: "defense", on: true, step: 200, unit: 100, keys: () => ["maxHitpoints"] },
  { id: "maxManapoints", label: "最大法力值", kind: "defense", on: true, step: 200, unit: 100, keys: () => ["maxManapoints"] },
  { id: "hpRegen", label: "HP恢复", kind: "defense", on: false, step: 0.005, unit: 0.001, keys: () => ["hpRegenPer10"] },
  { id: "mpRegen", label: "MP恢复", kind: "defense", on: true, step: 0.005, unit: 0.001, keys: () => ["mpRegenPer10"] },
  { id: "lifeSteal", label: "生命窃取", kind: "defense", on: false, step: 0.02, unit: 0.01, keys: () => ["lifeSteal"] },
  { id: "manaLeech", label: "法力吸取", kind: "defense", on: false, step: 0.02, unit: 0.01, keys: () => ["manaLeech"] },
  { id: "tenacity", label: "韧性", kind: "defense", on: false, step: 20, unit: 1, keys: () => ["tenacity"] },
  { id: "threat", label: "威胁", kind: "defense", on: false, step: 50, unit: 10, keys: () => ["threat"] },
  { id: "dropRate", label: "战斗掉落率", kind: "loot", on: true, step: 0.05, unit: 0.01, keys: () => ["combatDropRate"] },
  { id: "dropQuantity", label: "战斗掉落数量", kind: "loot", on: false, step: 0.05, unit: 0.01, keys: () => ["combatDropQuantity"] },
  { id: "rareFind", label: "稀有发现", kind: "loot", on: true, step: 0.1, unit: 0.01, keys: () => ["combatRareFind"] },
  { id: "experience", label: "战斗经验", kind: "loot", on: false, step: 0.05, unit: 0.01, keys: () => ["combatExperience"] },
  // skill levels; "level:power" is the member's melee / ranged / magic by weapon
  ...["stamina", "intelligence", "attack", "defense", "power"].map(s => ({
    id: `level:${s}`, label: s === "power" ? "近战/远程/魔法等级（武器类型）" : `${SKILL_ZH[s]}等级`, kind: "level", on: true, step: 5, unit: 1,
    levels: (style) => [s !== "power" ? s : style === "ranged" ? "ranged" : style === "magic" ? "magic" : "melee"],
    name: (style) => `${SKILL_ZH[s !== "power" ? s : style === "ranged" ? "ranged" : style === "magic" ? "magic" : "melee"]}等级`,
  })),
]

/** Weapon style ("stab".."magic") and damage type ("physical".."fire") of a member config. */
export function styleOf(maps, cfg) {
  const cs = maps.itemDetailMap[cfg.equipment?.weapon?.itemHrid]?.equipmentDetail?.combatStats
  return {
    style: String(cs?.combatStyleHrids?.[0] || "/combat_styles/smash").split("/").pop(),
    dtype: String(cs?.damageType || "/damage_types/physical").split("/").pop(),
  }
}

/** The groups for one member: concrete keys / levels and labels. */
export function statGroups(maps, cfg) {
  const { style, dtype } = styleOf(maps, cfg)
  return STAT_GROUPS.map(g => ({
    id: g.id, kind: g.kind, on: g.on, step: g.step, unit: g.unit, pct: g.unit < 1,
    label: g.name ? g.name(style, dtype) : g.label,
    keys: g.keys ? g.keys(style, dtype) : undefined,
    levels: g.levels ? g.levels(style) : undefined,
  }))
}
