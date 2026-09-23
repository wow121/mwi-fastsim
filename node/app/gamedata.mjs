// Decodes the plugin's game data (localStorage "new_combat_game_data_v1") into an envelope the
// worker accepts, like the site's `z()` does.
import LZString from "lz-string"

// the worker's required + optional map names (`Ye` + `It`)
const MAP_KEYS = [
  "abilityDetailMap", "abilitySlotsLevelRequirementList", "achievementDetailMap", "achievementTierDetailMap",
  "actionDetailMap", "buffTypeDetailMap", "combatMonsterDetailMap", "combatStyleDetailMap",
  "combatTriggerComparatorDetailMap", "combatTriggerConditionDetailMap", "combatTriggerDependencyDetailMap",
  "communityBuffTypeDetailMap", "damageTypeDetailMap", "enhancementLevelSuccessRateTable",
  "enhancementLevelTotalBonusMultiplierTable", "equipmentTypeDetailMap", "guildBuffDetailMap", "guildShrineDetailMap",
  "houseRoomDetailMap", "itemCategoryDetailMap", "itemDetailMap", "itemLocationDetailMap", "labyrinthCrateDetailMap",
  "levelExperienceTable", "openableLootDropMap", "skillDetailMap", "shopItemDetailMap",
]

export function decodeGameData(raw) {
  let e = typeof raw === "string" ? JSON.parse(raw) : raw
  if (!e || typeof e !== "object") return null
  if (e.maps && typeof e.maps === "object") return e
  const packed = typeof e.compressedInitClientData === "string" ? e.compressedInitClientData : ""
  if (!packed) return null
  const text = LZString.decompressFromUTF16(packed)
  const y = text ? JSON.parse(text) : null
  const h = y?.clientData || y?.data || y
  if (!h || typeof h !== "object") return null
  const maps = Object.fromEntries(MAP_KEYS.filter(k => h[k] && typeof h[k] === "object").map(k => [k, h[k]]))
  return {
    schemaVersion: 1,
    source: "plugin",
    capturedAt: Number(e.capturedAt || Date.now()),
    gameVersion: String(e.gameVersion || h.gameVersion || "unknown"),
    versionTimestamp: String(e.versionTimestamp || h.versionTimestamp || ""),
    maps,
  }
}
