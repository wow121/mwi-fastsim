// Chinese display names, following the combat-sim site's translator (combatTranslation `s`/`k`):
// hrid table first, then its English-name dictionary (refined "★" items looked up as "X (R)"),
// trigger conditions via the ability of the same name. zh-names.mjs is extracted from the
// site's bundle by node/extract-zh.mjs.
import names from "./zh-names.mjs"

const { byName, byHrid } = names

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
export function zh(maps, hrid) {
  if (!hrid) return ""
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
