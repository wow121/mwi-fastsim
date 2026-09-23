// Team model: the site's player config ("simulator" store players) -> worker payload.
// Ported from the site's playerMapper (`ra`, `oa`) and CombatHeader (`lt`, `ps`, `lA`).

import { playerStats } from "./game.mjs"

export const SKILLS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]
export const EQUIPMENT_SLOTS = ["head", "body", "legs", "feet", "hands", "weapon", "off_hand", "pouch", "neck", "earrings", "ring", "back", "charm"]
const MAX_CONDITIONS = 4

const clone = (v) => JSON.parse(JSON.stringify(v))

/** `lt`: keep at most 4 well-formed conditions whose hrids exist in the game data. */
export function normalizeConditions(m, list) {
  if (!Array.isArray(list)) return []
  const deps = m.$e.combatTriggerDependencyDetailMap
  const conds = m.$e.combatTriggerConditionDetailMap
  const cmps = m.$e.combatTriggerComparatorDetailMap
  const out = []
  for (const r of list.slice(0, MAX_CONDITIONS)) {
    const c = {
      dependencyHrid: String(r?.dependencyHrid || ""),
      conditionHrid: String(r?.conditionHrid || ""),
      comparatorHrid: String(r?.comparatorHrid || ""),
      value: Number(r?.value ?? 0),
    }
    if (!c.dependencyHrid || !c.conditionHrid || !c.comparatorHrid) continue
    if (!deps[c.dependencyHrid] || !conds[c.conditionHrid] || !cmps[c.comparatorHrid]) continue
    if (!Number.isFinite(c.value)) c.value = 0
    out.push(c)
  }
  return out
}

/** `ps`: the game's default triggers for an ability or consumable. */
export function defaultTriggers(m, hrid) {
  const a = m.$e.abilityDetailMap[hrid]
  if (Array.isArray(a?.defaultCombatTriggers)) return normalizeConditions(m, a.defaultCombatTriggers)
  const i = m.$e.itemDetailMap[hrid]?.consumableDetail
  if (Array.isArray(i?.defaultCombatTriggers)) return normalizeConditions(m, i.defaultCombatTriggers)
  return []
}

/** Triggers used for `hrid`: absent from triggerMap -> game default; [] -> none (fire on cooldown). */
export function triggersFor(m, triggerMap, hrid) {
  if (triggerMap && Object.prototype.hasOwnProperty.call(triggerMap, hrid)) return normalizeConditions(m, triggerMap[hrid])
  return defaultTriggers(m, hrid)
}

/** `lA` */
export function combatLevel(l) {
  return 0.1 * (l.stamina + l.intelligence + l.attack + l.defense + Math.max(l.melee, l.ranged, l.magic))
    + 0.5 * Math.max(l.attack, l.defense, l.melee, l.ranged, l.magic)
}

function levelsOf(cfg) {
  const t = cfg.levels ?? {}
  return Object.fromEntries(SKILLS.map(s => [s, Number(t[s] ?? 1)]))
}

function weaponType(m, hrid) {
  const it = m.$e.itemDetailMap[hrid]
  const t = String(it?.equipmentDetail?.type || it?.equipmentType || "")
  return t === "/equipment_types/main_hand" || t === "/equipment_types/two_hand" ? t : ""
}

/** Equipment DTO keyed by equipment type, as `ra` builds it. */
export function equipmentDTO(m, cfg) {
  const eq = {}
  for (const [slot, e] of Object.entries(cfg.equipment ?? {})) {
    const hrid = e?.itemHrid || ""
    if (!hrid || !EQUIPMENT_SLOTS.includes(slot)) continue
    const lvl = Math.max(0, Math.floor(Number(e?.enhancementLevel ?? 0)) || 0)
    if (slot === "weapon") {
      const t = weaponType(m, hrid)
      if (t) eq[t] = { hrid, enhancementLevel: lvl }
      continue
    }
    eq[`/equipment_types/${slot}`] = { hrid, enhancementLevel: lvl }
  }
  return eq
}

/** Food/drink slots granted by the equipment (pouch). */
function consumableSlots(m, dto) {
  const s = playerStats(m, { ...dto, food: [], drinks: [], abilities: [] })
  return { food: s.foodSlots, drinks: s.drinkSlots }
}

/** `ra`: one player config -> worker DTO (debuffOnLevelGap filled in by teamDTO). */
export function playerDTO(m, cfg, index) {
  const lv = levelsOf(cfg)
  const dto = {
    hrid: `player${index + 1}`,
    staminaLevel: lv.stamina,
    intelligenceLevel: lv.intelligence,
    attackLevel: lv.attack,
    meleeLevel: lv.melee,
    defenseLevel: lv.defense,
    rangedLevel: lv.ranged,
    magicLevel: lv.magic,
    equipment: equipmentDTO(m, cfg),
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [null, null, null, null, null],
    houseRooms: clone(cfg.houseRooms ?? {}),
    guildBuffs: clone(cfg.guildBuffs ?? {}),
    achievements: clone(cfg.achievements ?? {}),
    debuffOnLevelGap: 0,
  }
  const slots = consumableSlots(m, dto)
  const tm = cfg.triggerMap ?? {}
  for (let l = 0; l < 3; l++) {
    const f = cfg.food?.[l] || ""
    if (f && l < slots.food) dto.food[l] = { hrid: f, triggers: triggersFor(m, tm, f) }
    const d = cfg.drinks?.[l] || ""
    if (d && l < slots.drinks) dto.drinks[l] = { hrid: d, triggers: triggersFor(m, tm, d) }
  }
  const req = m.$e.abilitySlotsLevelRequirementList || []
  for (let l = 0; l < 5; l++) {
    const a = cfg.abilities?.[l] ?? { abilityHrid: "", level: 1 }
    const hrid = a.abilityHrid || ""
    const level = Number(a.level ?? 1)
    if (hrid && Number.isFinite(level) && level > 0 && lv.intelligence >= (req[l + 1] ?? 0))
      dto.abilities[l] = { hrid, level, triggers: triggersFor(m, tm, hrid) }
  }
  return dto
}

/** `ve` + `oa`: the selected members -> DTOs with the level-gap debuff. */
export function teamDTO(m, members) {
  const dtos = members.map((c, i) => playerDTO(m, c, i))
  const cls = members.map(c => combatLevel(levelsOf(c)))
  const top = Math.max(1, ...cls)
  dtos.forEach((d, i) => {
    const r = top / cls[i]
    d.debuffOnLevelGap = r > 1.2 ? -1 * Math.min(0.9, 3 * (r - 1.2)) : 0
  })
  return dtos
}

/** Community buff level as the site reads it (`og`): 0..20, default 20 when unset. */
export function communityLevel(v, enabled) {
  if (enabled === false) return 0
  const n = Number(v)
  return Math.max(0, Math.min(20, Math.floor(Number.isFinite(n) ? n : 20)))
}

/** Community buffs from the site's simulationSettings; unset means the site's defaults
 *  (Moo Pass on, community experience / drop at 20). */
export function extraFromSettings(s = {}) {
  return {
    mooPass: s.mooPass ?? true,
    comExp: communityLevel(s.comExp, s.comExpEnabled),
    comDrop: communityLevel(s.comDrop, s.comDropEnabled),
    enableHpMpVisualization: false,
  }
}

/**
 * Target of a simulation: { kind: "zone", zoneHrid, difficultyTier } |
 * { kind: "labyrinth", labyrinthHrid, roomLevel, crates }.
 */
export function buildPayload(m, members, target, { hours, seed, extra }) {
  const p = {
    type: "start_simulation",
    players: teamDTO(m, members),
    simulationTimeLimit: Math.round(hours * 3600) * 1e9,
    seed,
    extra: extra ?? { mooPass: false, comExp: 0, comDrop: 0 },
  }
  if (target.kind === "labyrinth") {
    p.combatMode = "labyrinth"
    p.labyrinth = { labyrinthHrid: target.labyrinthHrid, roomLevel: target.roomLevel, crates: target.crates || [] }
  } else {
    p.zone = { zoneHrid: target.zoneHrid, difficultyTier: Number(target.difficultyTier || 0) }
    p.labyrinth = null
  }
  return p
}
