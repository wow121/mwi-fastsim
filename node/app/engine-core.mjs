// Compiles a worker payload ("start_simulation" message) into the scenario format the Rust
// engine runs, from the game data (`game`, see game.mjs). No Node APIs: shared by the local server
// and the browser build.
import { ABILITY_ALIASES, EXTRA_ABILITIES, extraBuffs, generatePermanentBuffs, labyrinthBuffs, playerFromDTO, zoneBuffs } from "./game.mjs"

const PLAYER_KEYS = [
  "stabAccuracy", "slashAccuracy", "smashAccuracy", "rangedAccuracy", "magicAccuracy",
  "stabDamage", "slashDamage", "smashDamage", "rangedDamage", "magicDamage", "defensiveDamage",
  "taskDamage", "physicalAmplify", "waterAmplify", "natureAmplify", "fireAmplify",
  "healingAmplify", "stabEvasion", "slashEvasion", "smashEvasion", "rangedEvasion",
  "magicEvasion", "armor", "waterResistance", "natureResistance", "fireResistance",
  "maxHitpoints", "maxManapoints", "lifeSteal", "hpRegenPer10", "mpRegenPer10",
  "physicalThorns", "elementalThorns", "combatDropRate", "combatRareFind",
  "combatDropQuantity", "combatExperience", "criticalRate", "criticalDamage",
  "armorPenetration", "waterPenetration", "naturePenetration", "firePenetration",
  "abilityHaste", "tenacity", "manaLeech", "castSpeed", "threat", "parry", "mayhem", "pierce",
  "curse", "fury", "weaken", "ripple", "bloom", "blaze", "attackSpeed", "foodHaste",
  "drinkConcentration", "autoAttackDamage", "abilityDamage", "staminaExperience",
  "intelligenceExperience", "attackExperience", "defenseExperience", "meleeExperience",
  "rangedExperience", "magicExperience", "retaliation",
]
const SKILLS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]

function trig(t) {
  return {
    dependencyHrid: t.dependencyHrid,
    conditionHrid: t.conditionHrid,
    comparatorHrid: t.comparatorHrid,
    value: t.value,
  }
}

function buffDef(b) {
  return {
    uniqueHrid: b.uniqueHrid,
    typeHrid: b.typeHrid,
    ratioBoost: b.ratioBoost,
    ratioBoostLevelBonus: 0,
    flatBoost: b.flatBoost,
    flatBoostLevelBonus: 0,
    duration: b.duration,
    multiplierForSkillHrid: b.multiplierForSkillHrid,
    multiplierPerSkillLevel: b.multiplierPerSkillLevel,
  }
}

function consumable(c) {
  if (!c) return null
  return {
    hrid: c.hrid,
    cooldownDuration: c.cooldownDuration,
    hitpointRestore: c.hitpointRestore,
    manapointRestore: c.manapointRestore,
    recoveryDuration: c.recoveryDuration,
    categoryHrid: c.catagoryHrid,
    buffs: c.buffs.map(buffDef),
    triggers: c.triggers.map(trig),
  }
}

/** Scenario player from a set-up player (permanent buffs already generated). */
export function scenarioPlayer(p) {
  const eq = p.equipment
  const w = eq["/equipment_types/main_hand"] || eq["/equipment_types/two_hand"]
  const equipStats = {}
  for (const k of PLAYER_KEYS) {
    equipStats[k] = Object.values(eq).filter(i => i != null).map(i => i.getCombatStat(k)).reduce((i, a) => i + a, 0)
  }
  const pouch = eq["/equipment_types/pouch"]
  const charm = eq["/equipment_types/charm"]
  return {
    hrid: p.hrid,
    levels: SKILLS.map(s => p[`${s}Level`]),
    equipStats,
    combatStyleHrid: w ? w.getCombatStyle() : "/combat_styles/smash",
    damageType: w ? w.getDamageType() : "/damage_types/physical",
    attackInterval: w ? w.getCombatStat("attackInterval") : 3e9,
    primaryTraining: w ? (w.getPrimaryTraining() ?? "") : "/skills/melee",
    focusTraining: charm ? (charm.getFocusTraining() ?? "") : "",
    foodSlots: pouch ? 1 + pouch.getCombatStat("foodSlots") : 1,
    drinkSlots: pouch ? 1 + pouch.getCombatStat("drinkSlots") : 1,
    bulwark: !!eq["/equipment_types/two_hand"]?.hrid.includes("bulwark"),
    abilities: p.abilities.map(a => a ? { hrid: a.hrid, level: a.level, triggers: a.triggers.map(trig) } : null),
    food: p.food.map(consumable),
    drinks: p.drinks.map(consumable),
    permanentBuffs: Object.values(p.permanentBuffs).map(b => ({
      uniqueHrid: b.uniqueHrid,
      typeHrid: b.typeHrid,
      flatBoost: b.flatBoost,
      ratioBoost: b.ratioBoost,
      duration: b.duration,
    })),
    debuffOnLevelGap: p.debuffOnLevelGap,
    taskDamageEnabled: p.taskDamageEnabled === true,
  }
}

/** Mirrors the worker's `Oi` setup (a `gameDataEnvelope` in the payload is the caller's job). */
export function compilePayload(game, r) {
  const t = r.combatMode || (r.labyrinth ? "labyrinth" : "normal")
  if (!["normal", "labyrinth", "task"].includes(t)) throw new Error("Unsupported combat mode")
  const task = t === "task"
  if (task && (!r.zone?.zoneHrid || r.taskContext?.zoneHrid !== r.zone.zoneHrid))
    throw new Error("Task combat requires a matching zone context")
  const extra = extraBuffs(game, r.extra)
  const zone = r.zone ? { hrid: r.zone.zoneHrid, difficultyTier: r.zone.difficultyTier, buffs: zoneBuffs(game, r.zone.zoneHrid) } : null
  const lab = r.labyrinth ? { monsterHrid: r.labyrinth.labyrinthHrid, roomLevel: r.labyrinth.roomLevel, buffs: labyrinthBuffs(game, r.labyrinth.crates) } : null
  const players = (r.players || []).map((h) => {
    const H = playerFromDTO(game, h)
    H.zoneBuffs = zone?.buffs || lab?.buffs || []
    H.extraBuffs = extra
    H.taskDamageEnabled = task
    return H
  })
  return {
    combatMode: t,
    seed: r.seed,
    simulationTimeLimit: r.simulationTimeLimit,
    zone: zone ? { hrid: zone.hrid, difficultyTier: zone.difficultyTier, combatZoneInfo: game.$e.actionDetailMap[zone.hrid].combatZoneInfo } : null,
    labyrinth: lab ? { monsterHrid: lab.monsterHrid, roomLevel: lab.roomLevel } : null,
    players: players.map((p) => {
      generatePermanentBuffs(p)
      return scenarioPlayer(p)
    }),
  }
}

/** Everything the Rust engine reads from the game data. */
export function exportGameData(game) {
  const maps = game.$e
  return {
    abilities: { ...EXTRA_ABILITIES, ...maps.abilityDetailMap },
    abilityAliases: ABILITY_ALIASES,
    monsters: maps.combatMonsterDetailMap,
    combatStyles: maps.combatStyleDetailMap,
    triggerDependencies: maps.combatTriggerDependencyDetailMap,
  }
}
