// Game data + player setup, without the combat-sim site's bundle. The data is the game's own client
// data (initClientData maps, captured by the userscript); the setup is a port of the site worker's
// classes that turn a worker DTO into a combat unit: buffs (`G`), equipment (`Ve`), consumables
// (`He`), abilities (`se`), house rooms (`Ce`), guild buffs (`fe`), achievements (`xe`), the player
// (`Qe` + `Oe.generatePermanentBuffs` / `updateCombatDetails`), zones (`jt`), labyrinths (`Ut`) and
// community buffs (`ei`). Arithmetic and summation order follow the original exactly (the Rust
// engine's results depend on the float bits).

export const ENGINE_VERSION = "combat-events-2.3.0"

// maps the engine needs (`Ye`) + optional ones (`It`)
export const REQUIRED_MAPS = [
  "abilityDetailMap", "abilitySlotsLevelRequirementList", "achievementDetailMap", "achievementTierDetailMap",
  "actionDetailMap", "buffTypeDetailMap", "combatMonsterDetailMap", "combatStyleDetailMap",
  "combatTriggerComparatorDetailMap", "combatTriggerConditionDetailMap", "combatTriggerDependencyDetailMap",
  "communityBuffTypeDetailMap", "damageTypeDetailMap", "enhancementLevelSuccessRateTable",
  "enhancementLevelTotalBonusMultiplierTable", "equipmentTypeDetailMap", "guildBuffDetailMap", "guildShrineDetailMap",
  "houseRoomDetailMap", "itemCategoryDetailMap", "itemDetailMap", "itemLocationDetailMap", "labyrinthCrateDetailMap",
  "levelExperienceTable", "openableLootDropMap", "skillDetailMap",
]
export const OPTIONAL_MAPS = ["shopItemDetailMap"]

// the engine's two extra abilities (fury-style "blaze" / "bloom" procs), part of the engine port
export const ABILITY_ALIASES = Object.freeze({ blaze: "/abilities/blaze", bloom: "/abilities/bloom" })
const EFFECT = {
  bonusAccuracyRatio: 0, bonusAccuracyRatioLevelBonus: 0, damageOverTimeRatio: 0, damageOverTimeDuration: 0,
  armorDamageRatio: 0, armorDamageRatioLevelBonus: 0, hpDrainRatio: 0, pierceChance: 0, blindChance: 0, blindDuration: 0,
  silenceChance: 0, silenceDuration: 0, stunChance: 0, stunDuration: 0, spendHpRatio: 0, buffs: null,
}
const T = (dep, cond, cmp, value) => ({
  dependencyHrid: `/combat_trigger_dependencies/${dep}`, conditionHrid: `/combat_trigger_conditions/${cond}`, comparatorHrid: `/combat_trigger_comparators/${cmp}`, value,
})
export const EXTRA_ABILITIES = Object.freeze({
  "/abilities/blaze": {
    hrid: "/abilities/blaze", name: "Blaze", description: "", isSpecialAbility: false, manaCost: 0, cooldownDuration: 0, castDuration: 0,
    abilityEffects: [{
      targetType: "allEnemies", effectType: "/ability_effect_types/damage", combatStyleHrid: "/combat_styles/magic", damageType: "/damage_types/fire",
      baseDamageFlat: 0, baseDamageFlatLevelBonus: 0, baseDamageRatio: 0.3, baseDamageRatioLevelBonus: 0, ...EFFECT,
    }],
    defaultCombatTriggers: [T("all_enemies", "number_of_active_units", "greater_than_equal", 1), T("all_enemies", "current_hp", "greater_than_equal", 1)],
  },
  "/abilities/bloom": {
    hrid: "/abilities/bloom", name: "Bloom", description: "", isSpecialAbility: false, manaCost: 0, cooldownDuration: 0, castDuration: 0,
    abilityEffects: [{
      targetType: "lowestHpAlly", effectType: "/ability_effect_types/heal", combatStyleHrid: "/combat_styles/magic", damageType: "",
      baseDamageFlat: 10, baseDamageFlatLevelBonus: 0, baseDamageRatio: 0.15, baseDamageRatioLevelBonus: 0, ...EFFECT,
    }],
    defaultCombatTriggers: [T("all_allies", "lowest_hp_percentage", "less_than_equal", 100)],
  },
})

/** `qt`: all required maps present and non-empty. */
export function validMaps(r) {
  if (!r || typeof r !== "object") return false
  return REQUIRED_MAPS.every((e) => {
    const t = r[e]
    return Array.isArray(t) ? t.length > 0 : !!(t && typeof t === "object" && Object.keys(t).length > 0)
  })
}

/** `zi`: normalizes an envelope ({ maps, ... } or bare maps). */
export function normalizeEnvelope(r) {
  let e = r
  if (typeof e === "string") e = JSON.parse(e)
  if (!e || typeof e !== "object") throw new Error("Combat game data envelope is invalid.")
  const t = e.maps && typeof e.maps === "object" ? e.maps : e
  if (!validMaps(t)) throw new Error("Combat game data is missing required maps.")
  return {
    schemaVersion: 1,
    source: String(e.source || "plugin"),
    capturedAt: Number(e.capturedAt || Date.now()),
    gameVersion: String(e.gameVersion || t.gameVersion || "unknown"),
    versionTimestamp: String(e.versionTimestamp || t.versionTimestamp || ""),
    maps: t,
  }
}

/** The game data the app works with; `$e` = the maps (same name the site's bundle used). */
export class Game {
  constructor(envelope) {
    const env = normalizeEnvelope(envelope)
    this.envelope = env
    this.$e = Object.fromEntries([...REQUIRED_MAPS, ...OPTIONAL_MAPS].filter(k => env.maps[k] != null).map(k => [k, env.maps[k]]))
    this.version = env.gameVersion
  }
}

// ---------------------------------------------------------------------------------- buffs

/** `new G(e, level)` */
function buff(e, t = 1) {
  return {
    uniqueHrid: e.uniqueHrid,
    typeHrid: e.typeHrid,
    ratioBoost: e.ratioBoost + (t - 1) * e.ratioBoostLevelBonus,
    flatBoost: e.flatBoost + (t - 1) * e.flatBoostLevelBonus,
    duration: e.duration,
    multiplierForSkillHrid: e.multiplierForSkillHrid ?? "",
    multiplierPerSkillLevel: e.multiplierPerSkillLevel ?? 0,
  }
}

/** `G.createFromDTO` */
function buffFromDTO(e) {
  return {
    uniqueHrid: e?.uniqueHrid ?? "",
    typeHrid: e?.typeHrid ?? "",
    ratioBoost: Number(e?.ratioBoost ?? 0),
    flatBoost: Number(e?.flatBoost ?? 0),
    duration: Number(e?.duration ?? 0),
    startTime: e?.startTime ?? null,
    multiplierForSkillHrid: e?.multiplierForSkillHrid ?? "",
    multiplierPerSkillLevel: Number(e?.multiplierPerSkillLevel ?? 0),
  }
}

// -------------------------------------------------------------------- player components

class Equipment {
  constructor(maps, hrid, enhancementLevel) {
    this.hrid = hrid
    const i = maps.itemDetailMap[hrid]
    if (!i) throw new Error("No equipment found for hrid: " + hrid)
    this.gameItem = i
    this.enhancementLevel = enhancementLevel
    this.table = maps.enhancementLevelTotalBonusMultiplierTable
  }
  getCombatStat(e) {
    const t = this.table[this.enhancementLevel]
    if (this.gameItem.equipmentDetail.combatStats[e]) {
      const i = this.gameItem.equipmentDetail.combatEnhancementBonuses[e] || 0
      return this.gameItem.equipmentDetail.combatStats[e] + t * i
    }
    return 0
  }
  getCombatStyle() {
    return this.gameItem.equipmentDetail.combatStats.combatStyleHrids[0]
  }
  getDamageType() {
    return this.gameItem.equipmentDetail.combatStats.damageType
  }
  getPrimaryTraining() {
    return this.gameItem.equipmentDetail.combatStats.primaryTraining
  }
  getFocusTraining() {
    return this.gameItem.equipmentDetail.combatStats.focusTraining
  }
}

const trigger = e => ({ dependencyHrid: e.dependencyHrid, conditionHrid: e.conditionHrid, comparatorHrid: e.comparatorHrid, value: e.value })

/** `He.createFromDTO` (triggers always come from the DTO) */
function consumable(maps, dto) {
  const i = maps.itemDetailMap[dto.hrid]
  if (!i) throw new Error("No consumable found for hrid: " + dto.hrid)
  const d = i.consumableDetail
  return {
    hrid: dto.hrid,
    cooldownDuration: d.cooldownDuration,
    hitpointRestore: d.hitpointRestore,
    manapointRestore: d.manapointRestore,
    recoveryDuration: d.recoveryDuration,
    catagoryHrid: i.categoryHrid,
    buffs: d.buffs ? d.buffs.map(a => buff(a)) : [],
    triggers: dto.triggers.map(trigger),
  }
}

/** `Gt`: ability definition by hrid or alias. */
export function abilityDef(maps, r) {
  const e = ABILITY_ALIASES[String(r || "")] || String(r || "")
  return (e && (maps.abilityDetailMap[e] || EXTRA_ABILITIES[e])) || null
}

/** `se.createFromDTO` (only what the engine input needs) */
function ability(maps, dto) {
  if (!abilityDef(maps, dto.hrid)) throw new Error("No ability found for hrid: " + dto.hrid)
  return { hrid: dto.hrid, level: dto.level === undefined ? 1 : dto.level, triggers: dto.triggers.map(trigger) }
}

/** `Ce.createFromDTO` */
function houseRoom(maps, e) {
  if (Array.isArray(e)) return houseRoom(maps, { hrid: e[0], level: e[1] })
  const t = String(e?.hrid ?? "")
  const i = Number(e?.level ?? 0)
  if (!t || i <= 0) return null
  const room = maps.houseRoomDetailMap[t]
  if (!room) throw new Error("No house room found for hrid: " + t)
  const buffs = []
  if (room.actionBuffs) for (const a of room.actionBuffs) buffs.push(buff(a, i))
  if (room.globalBuffs) for (const a of room.globalBuffs) buffs.push(buff(a, i))
  return { hrid: t, level: i, buffs }
}

/** `ht`: max usable level of a combat guild buff. */
function guildMaxLevel(maps, r) {
  const z = maps.guildBuffDetailMap || {}
  const Ke = maps.guildShrineDetailMap || {}
  const e = z[String(r || "")]
  if (!e || e.isCombat !== true) return 0
  const t = Number(Ke[e.shrineHrid]?.maxLevel || 0)
  const i = Math.max(0, ...Object.keys(e.levelCosts || {}).map(n => Number(n) || 0))
  return Math.max(0, Math.min(t || i, i || t))
}

/** `fe.createFromDTO` */
function guildBuff(maps, e) {
  if (Array.isArray(e)) return guildBuff(maps, { hrid: e[0], level: e[1] })
  const z = maps.guildBuffDetailMap || {}
  const t = String(e?.hrid || e?.guildBuffHrid || "")
  const i = Number(e?.level || 0)
  if (!t || i <= 0 || !z[t]?.isCombat) return null
  if (Array.isArray(e?.buffs)) return { hrid: t, level: Math.min(Math.floor(i), guildMaxLevel(maps, t)), buffs: e.buffs.map(buffFromDTO) }
  const level = Math.min(Math.max(0, Math.floor(Number(i) || 0)), guildMaxLevel(maps, t))
  return { hrid: t, level, buffs: level > 0 ? (z[t].buffs || []).map(a => buff(a, level)) : [] }
}

/** `xe.createFromDTO`: tier buffs for completed achievement tiers. */
function achievements(maps, e) {
  if (Array.isArray(e?.buffs)) return { buffs: e.buffs.map(buffFromDTO) }
  const t = e && typeof e === "object" ? e : {}
  const buffs = []
  for (const i of Object.values(maps.achievementTierDetailMap)) {
    let a = true
    const n = Object.values(maps.achievementDetailMap).filter(o => o.tierHrid == i.hrid)
    for (const o of Object.values(n)) {
      if (!t[o.hrid] || t[o.hrid] == false) {
        a = false
        break
      }
    }
    if (a) buffs.push(buff(i.buff))
  }
  return { buffs }
}

const EQUIPMENT_TYPES = ["head", "body", "legs", "feet", "hands", "main_hand", "two_hand", "off_hand", "pouch", "back"].map(t => `/equipment_types/${t}`)
const SKILLS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]

/** `Qe.createFromDTO` */
export function playerFromDTO(game, t) {
  const maps = game.$e
  const equipment = Object.fromEntries(EQUIPMENT_TYPES.map(k => [k, null]))
  for (const [o, s] of Object.entries(t.equipment)) equipment[o] = s ? new Equipment(maps, s.hrid, s.enhancementLevel) : null
  const p = {
    hrid: t.hrid,
    equipment,
    food: t.food.map(o => (o ? consumable(maps, o) : null)),
    drinks: t.drinks.map(o => (o ? consumable(maps, o) : null)),
    abilities: t.abilities.map(o => (o ? ability(maps, o) : null)),
    houseRooms: [],
    guildBuffs: [],
    achievements: null,
    debuffOnLevelGap: t.debuffOnLevelGap,
    permanentBuffs: {},
    zoneBuffs: [],
    extraBuffs: [],
  }
  for (const s of SKILLS) p[`${s}Level`] = t[`${s}Level`]
  let a = []
  if (Array.isArray(t.houseRooms)) a = t.houseRooms
  else if (t.houseRooms && typeof t.houseRooms === "object") a = Object.entries(t.houseRooms).map(([o, s]) => ({ hrid: o, level: s }))
  for (const o of a) {
    const s = houseRoom(maps, o)
    if (s) p.houseRooms.push(s)
  }
  for (const o of Array.isArray(t.guildBuffs) ? t.guildBuffs : Object.entries(t.guildBuffs || {}).map(([k, v]) => ({ hrid: k, level: v }))) {
    const s = guildBuff(maps, o)
    if (s) p.guildBuffs.push(s)
  }
  p.achievements = achievements(maps, t.achievements)
  return p
}

/** `addPermanentBuff`: merged per buff type. */
function addPermanentBuff(p, r) {
  const b = p.permanentBuffs[r.typeHrid]
  if (b) {
    b.flatBoost += r.flatBoost
    b.ratioBoost += r.ratioBoost
  } else {
    p.permanentBuffs[r.typeHrid] = { uniqueHrid: r.uniqueHrid, typeHrid: r.typeHrid, flatBoost: r.flatBoost, ratioBoost: r.ratioBoost, duration: r.duration }
  }
}

/** `generatePermanentBuffs` */
export function generatePermanentBuffs(p) {
  for (const room of p.houseRooms) room.buffs.forEach(i => addPermanentBuff(p, i))
  for (const g of p.guildBuffs) g.buffs.forEach(i => addPermanentBuff(p, i))
  if (p.achievements) p.achievements.buffs.forEach(e => addPermanentBuff(p, e))
  if (p.zoneBuffs) p.zoneBuffs.forEach(e => addPermanentBuff(p, e))
  if (p.extraBuffs) p.extraBuffs.forEach(e => addPermanentBuff(p, e))
}

// ------------------------------------------------------------------- zone / labyrinth / extra

/** `jt`: zone buffs; also sets `battlesPerBoss` on the zone's fight info like the original. */
export function zoneBuffs(game, zoneHrid) {
  const i = game.$e.actionDetailMap[zoneHrid]
  i.combatZoneInfo.fightInfo.battlesPerBoss = 10
  return i.buffs
}

/** `Ut`: labyrinth crate buffs. */
export function labyrinthBuffs(game, crates = []) {
  let buffs = []
  if (crates) for (const a of crates) buffs = buffs.concat(game.$e.labyrinthCrateDetailMap[a])
  return buffs
}

const NO_TIME = "0001-01-01T00:00:00Z"
const MOO_PASS = Object.freeze({
  uniqueHrid: "/buff_uniques/experience_moo_pass_buff", typeHrid: "/buff_types/wisdom", ratioBoost: 0, ratioBoostLevelBonus: 0,
  flatBoost: 0.05, flatBoostLevelBonus: 0, startTime: NO_TIME, duration: 0,
})
const COM_EXP = "/community_buff_types/experience"
const COM_DROP = "/community_buff_types/combat_drop_quantity"
const COMMUNITY_FALLBACK = Object.freeze({
  [COM_EXP]: { uniqueHrid: "/buff_uniques/experience_community_buff", typeHrid: "/buff_types/wisdom", ratioBoost: 0, ratioBoostLevelBonus: 0, flatBoost: 0.2, flatBoostLevelBonus: 0.005, startTime: NO_TIME, duration: 0 },
  [COM_DROP]: { uniqueHrid: "/buff_uniques/combat_community_buff", typeHrid: "/buff_types/combat_drop_quantity", ratioBoost: 0, ratioBoostLevelBonus: 0, flatBoost: 0.2, flatBoostLevelBonus: 0.005, startTime: NO_TIME, duration: 0 },
})
const num = (r, e = 0) => (Number.isFinite(Number(r)) ? Number(r) : e)
const clampLevel = (r, e = 20) => {
  const t = Math.max(0, Math.min(20, Math.floor(num(e, 20))))
  return Math.max(0, Math.min(20, Math.floor(num(r, t))))
}
const isBuff = r => !!(r && typeof r === "object" && typeof r.uniqueHrid === "string" && r.uniqueHrid && typeof r.typeHrid === "string" && r.typeHrid)
function leveledBuff(r, e = 1) {
  if (!isBuff(r)) return null
  const t = Math.max(1, num(e, 1))
  return {
    uniqueHrid: r.uniqueHrid,
    typeHrid: r.typeHrid,
    ratioBoost: num(r.ratioBoost, 0) + num(r.ratioBoostLevelBonus, 0) * (t - 1),
    ratioBoostLevelBonus: 0,
    flatBoost: num(r.flatBoost, 0) + num(r.flatBoostLevelBonus, 0) * (t - 1),
    flatBoostLevelBonus: 0,
    startTime: typeof r.startTime === "string" && r.startTime ? r.startTime : NO_TIME,
    duration: Math.max(0, num(r.duration, 0)),
  }
}

/** `ei`: Moo Pass + community experience / drop quantity buffs. */
export function extraBuffs(game, r = {}) {
  const e = { mooPass: !!r?.mooPass, comExp: clampLevel(r?.comExp, 0), comDrop: clampLevel(r?.comDrop, 0) }
  const community = type => {
    const b = game.$e.communityBuffTypeDetailMap?.[type]?.buff
    return leveledBuff(isBuff(b) ? b : COMMUNITY_FALLBACK[type] ?? null, type === COM_EXP ? e.comExp : e.comDrop)
  }
  const t = []
  if (e.mooPass) t.push(leveledBuff(MOO_PASS, 1))
  if (e.comExp > 0) t.push(community(COM_EXP))
  if (e.comDrop > 0) t.push(community(COM_DROP))
  return t.filter(Boolean)
}

// ------------------------------------------------------------------------ combat details

/** Strongest buff per unique hrid among the permanent buffs (`clearBuffs` + `selectStrongestBuff`). */
function activeBuffs(p) {
  const strength = r => Math.abs(r.ratioBoost || 0) + Math.abs(r.flatBoost || 0)
  const best = {}
  let id = 0
  for (const r of Object.values(p.permanentBuffs)) {
    const c = { ...r, startTime: Number.NEGATIVE_INFINITY, candidateId: id++ }
    const cur = best[r.uniqueHrid]
    if (!cur) best[r.uniqueHrid] = c
    else {
      const a = strength(c) - strength(cur)
      if (a > 0 || (a === 0 && c.startTime >= cur.startTime && c.candidateId > cur.candidateId)) best[r.uniqueHrid] = c
    }
  }
  return Object.values(best)
}

/**
 * Out-of-combat stats of a player DTO (levels with level buffs, max HP / MP, consumable slots):
 * `Qe.updateCombatDetails` + the parts of `Oe.updateCombatDetails` they need.
 */
export function playerStats(game, dto, { zoneBuffs: zb = [], extraBuffs: xb = [] } = {}) {
  const p = playerFromDTO(game, dto)
  p.zoneBuffs = zb
  p.extraBuffs = xb
  generatePermanentBuffs(p)
  const buffs = activeBuffs(p)
  const boosts = type => buffs.filter(b => b.typeHrid == type)
  const boost = type => boosts(type).reduce((a, b) => ({ ratioBoost: a.ratioBoost + (b.ratioBoost ?? 0), flatBoost: a.flatBoost + (b.flatBoost ?? 0) }), { ratioBoost: 0, flatBoost: 0 })
  const eq = Object.values(p.equipment).filter(i => i != null)
  const stat = k => eq.map(i => i.getCombatStat(k)).reduce((i, a) => i + a, 0)
  const levels = {}
  for (const s of SKILLS) {
    levels[s] = p[`${s}Level`]
    for (const D of boosts(`/buff_types/${s}_level`)) {
      levels[s] += p[`${s}Level`] * D.ratioBoost
      levels[s] += D.flatBoost
    }
  }
  const hp = boost("/buff_types/max_hitpoints")
  const mp = boost("/buff_types/max_manapoints")
  const pouch = p.equipment["/equipment_types/pouch"]
  return {
    levels,
    maxHitpoints: Math.floor((10 * (10 + levels.stamina) + stat("maxHitpoints") + hp.flatBoost) * (1 + 0 + hp.ratioBoost)),
    maxManapoints: Math.floor((10 * (10 + levels.intelligence) + stat("maxManapoints") + mp.flatBoost) * (1 + 0 + mp.ratioBoost)),
    foodSlots: pouch ? 1 + pouch.getCombatStat("foodSlots") : 1,
    drinkSlots: pouch ? 1 + pouch.getCombatStat("drinkSlots") : 1,
  }
}
