// Writes data/team.json with a realistic 3-mage party in the site's player-config format (for
// testing without a synced team).
import fs from "node:fs"

const T = (dep, cond, cmp, value) => ({ dependencyHrid: `/combat_trigger_dependencies/${dep}`, conditionHrid: `/combat_trigger_conditions/${cond}`, comparatorHrid: `/combat_trigger_comparators/${cmp}`, value })
const learned = ["water_strike", "ice_spear", "frost_surge", "mana_spring", "fireball", "flame_blast", "firestorm", "elemental_affinity", "entangle", "toxic_pollen", "natures_veil", "heal", "minor_heal", "life_drain", "mystic_aura"]
function mage(id, element) {
  const weapon = { water: "rippling_trident", fire: "blazing_trident", nature: "blooming_trident" }[element]
  const abil = {
    water: ["water_strike", "ice_spear", "frost_surge", "mana_spring"],
    fire: ["fireball", "flame_blast", "firestorm", "elemental_affinity"],
    nature: ["entangle", "toxic_pollen", "natures_veil", "heal"],
  }[element]
  const eq = (h, l) => ({ itemHrid: `/items/${h}`, enhancementLevel: l })
  return {
    id: String(id), name: `法师${id}`, selected: true,
    levels: { stamina: 120, intelligence: 120, attack: 120, melee: 90, defense: 120, ranged: 90, magic: 125 },
    equipment: {
      weapon: eq(weapon, 10), head: eq("magicians_hat", 10), body: eq(`royal_${element}_robe_top`, 10), legs: eq(`royal_${element}_robe_bottoms`, 10),
      hands: eq("chrono_gloves", 10), feet: eq("pathseeker_boots", 10), back: eq("enchanted_cloak", 5), neck: eq("philosophers_necklace", 5),
      earrings: eq("philosophers_earrings", 5), ring: eq("philosophers_ring", 5), pouch: eq("guzzling_pouch", 5),
      off_hand: { itemHrid: "", enhancementLevel: 0 }, charm: { itemHrid: "", enhancementLevel: 0 },
    },
    food: ["/items/star_fruit_yogurt", "/items/star_fruit_gummy", "/items/spaceberry_cake"],
    drinks: ["/items/super_magic_coffee", "/items/super_intelligence_coffee", "/items/channeling_coffee"],
    abilities: [{ abilityHrid: "", level: 1 }, ...abil.map(a => ({ abilityHrid: `/abilities/${a}`, level: 60 }))],
    // equipped abilities at their equipped level (the game keeps both consistent)
    abilityLevelMap: Object.fromEntries(learned.map((a, i) => [`/abilities/${a}`, abil.includes(a) ? 60 : 40 + (i % 5) * 5])),
    triggerMap: {
      "/items/star_fruit_yogurt": [T("self", "missing_mp", "greater_than_equal", 300)],
      "/items/star_fruit_gummy": [T("self", "missing_mp", "greater_than_equal", 200)],
      "/items/spaceberry_cake": [T("self", "missing_hp", "greater_than_equal", 400)],
      "/items/super_magic_coffee": [], "/items/super_intelligence_coffee": [], "/items/channeling_coffee": [],
      ...Object.fromEntries(abil.map(a => [`/abilities/${a}`, []])),
    },
    houseRooms: { "/house_rooms/dining_room": 6, "/house_rooms/library": 6, "/house_rooms/dojo": 6, "/house_rooms/gym": 6, "/house_rooms/armory": 6, "/house_rooms/archery_range": 6, "/house_rooms/mystical_study": 6 },
    guildBuffs: {}, achievements: {},
  }
}
fs.mkdirSync("data", { recursive: true })
const members = [mage(1, "water"), mage(2, "fire"), mage(3, "nature")]
const settings = { mode: "zone", zoneHrid: "/actions/combat/sorcerers_tower", difficultyTier: 0, mooPass: true, comExpEnabled: true, comExp: 10, comDropEnabled: true, comDrop: 10 }
if (!fs.existsSync("data/team.json") || process.argv.includes("--force"))
  fs.writeFileSync("data/team.json", JSON.stringify({ members, selected: ["1", "2", "3"], settings, syncedAt: 0, sample: true }))
console.log("sample team written")
