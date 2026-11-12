// Chinese display names: the game's own Chinese names first (zh-game.mjs, by hrid; extracted by
// node/extract-zh-game.mjs), then the combat-sim site's translator (combatTranslation `s`/`k`) for
// what the game tables lack: its hrid table, then its English-name dictionary (refined "★" items
// looked up as "X (R)"), trigger conditions via the ability of the same name. zh-names.mjs is
// extracted from the site's bundle.
import names from "./zh-names.mjs"
import game from "./zh-game.mjs"
import { getLang } from "./lang.mjs"

const { byName, byHrid } = names
const OFFICIAL = Object.assign({}, ...Object.values(game))
const SYMBOLS = { ">=": "≥", "<=": "≤" } // comparators read better as symbols

// the site's trigger vocabulary (`I`) and comparators
const LABELS = {
  "Allies' Total": "所有队友总计",
  "Enemies' Total": "所有敌人总计",
  My: "自身",
  "Target Enemy's": "目标敌人",
  "Is Active": "已生效",
  "Is Inactive": "未生效",
  Hitpoints: "生命值",
  Manapoints: "法力值",
  "Missing Hitpoints": "已损失生命值",
  "Missing Manapoints": "已损失法力值",
  "Boss Status": "Boss状态", // newer than the game's Chinese name list here
  ">=": "≥",
  "<=": "≤",
}

function nameOf(maps, hrid) {
  const map = {
    items: maps.itemDetailMap,
    abilities: maps.abilityDetailMap,
    monsters: maps.combatMonsterDetailMap,
    actions: maps.actionDetailMap,
    house_rooms: maps.houseRoomDetailMap,
    combat_trigger_conditions: maps.combatTriggerConditionDetailMap,
    combat_trigger_dependencies: maps.combatTriggerDependencyDetailMap,
    combat_trigger_comparators: maps.combatTriggerComparatorDetailMap,
    talisman_modifiers: maps.talismanModifierDetailMap,
  }[hrid.split("/")[1]]
  return map?.[hrid]?.name || ""
}

function lookup(en) {
  if (!en) return ""
  for (const k of [en, en.replace(/\s*[★☆]\s*$/, " (R)"), en.replace(/\s*\((?:Refined|R)\)\s*$/i, " (R)")]) {
    if (LABELS[k]) return LABELS[k]
    if (byName[k]) return byName[k]
  }
  return ""
}

/** Chinese name of any hrid, falling back to the game's English name. */
// what each combat guild buff does (the site's name table has no entries for them)
const GUILD_ZH = {
  "/guild_buffs/force_combat": "伤害（公会）",
  "/guild_buffs/rarity_combat": "稀有发现（公会）",
  "/guild_buffs/scholar_combat": "经验（公会）",
  "/guild_buffs/spirit_combat": "生命与法力上限（公会）",
  "/guild_buffs/tempo_combat": "攻击与施法速度（公会）",
}
const GUILD_EN = {
  "/guild_buffs/force_combat": "Damage (guild)",
  "/guild_buffs/rarity_combat": "Rare find (guild)",
  "/guild_buffs/scholar_combat": "Experience (guild)",
  "/guild_buffs/spirit_combat": "Max HP & MP (guild)",
  "/guild_buffs/tempo_combat": "Attack & cast speed (guild)",
}
export function guildBuffName(maps, hrid) {
  if (getLang() === "en") return GUILD_EN[hrid] || maps.guildBuffDetailMap?.[hrid]?.name || nameOf(maps, hrid) || hrid
  return GUILD_ZH[hrid] || (zh(maps, hrid) !== hrid ? zh(maps, hrid) : maps.guildBuffDetailMap?.[hrid]?.name || hrid)
}

/** Display name of any hrid in the UI language: Chinese (see above), or in English the game's own name. */
export function zh(maps, hrid) {
  if (!hrid) return ""
  if (getLang() === "en") {
    const en = nameOf(maps, hrid)
    return SYMBOLS[en] || en || hrid
  }
  if (OFFICIAL[hrid]) return SYMBOLS[OFFICIAL[hrid]] || OFFICIAL[hrid]
  if (byHrid[hrid]) return byHrid[hrid]
  const en = nameOf(maps, hrid)
  const hit = lookup(en)
  if (hit) return hit
  if (hrid.startsWith("/combat_trigger_conditions/")) {
    const ab = `/abilities/${hrid.slice("/combat_trigger_conditions/".length)}`
    const t = byHrid[ab] || lookup(nameOf(maps, ab))
    if (t) return t
  }
  if (hrid.startsWith("/monsters/")) {
    const z = byHrid[hrid.replace("/monsters/", "/actions/combat/")]
    if (z) return z
  }
  return en || hrid
}
