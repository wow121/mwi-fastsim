// Round trip: sample team configs -> synthetic game data (current character + shared profiles)
// -> importTeam -> same configs, and the same simulation results.   node test-import.mjs
// Needs data/envelope.json (game data) and data/team.json.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { compilePayload, exportGameData } from "./app/engine-core.mjs"
import { Game } from "./app/game.mjs"
import { importTeam } from "./app/import.mjs"
import { buildPayload, teamDTO } from "./app/model.mjs"
import { RustEngine } from "./rust-client.mjs"

const m = new Game(JSON.parse(fs.readFileSync("data/envelope.json", "utf8")))
const gdFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mwi-imp-")), "gamedata.json")
fs.writeFileSync(gdFile, JSON.stringify(exportGameData(m)))
const rust = new RustEngine(path.join("..", "engine", "target", "release", process.platform === "win32" ? "mwi-fastsim.exe" : "mwi-fastsim"), gdFile, 2)
const simulateRust = async (game, payload) => (await rust.run(compilePayload(game, payload))).result
const out = (...a) => process.stdout.write(a.join(" ") + "\n")
const team = JSON.parse(fs.readFileSync("data/team.json", "utf8"))
const cfgs = team.members

const SKILLS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]
const loc = (slot, hrid) => (slot === "weapon" ? `/item_locations/${m.$e.itemDetailMap[hrid].equipmentDetail.type.split("/").pop()}` : `/item_locations/${slot}`)
function common(c) {
  const trig = (pred) => Object.fromEntries(Object.entries(c.triggerMap).filter(([k]) => pred(k)))
  return {
    characterSkills: SKILLS.map(s => ({ skillHrid: `/skills/${s}`, level: c.levels[s], experience: 0 })),
    characterAbilities: Object.entries(c.abilityLevelMap).map(([h, l]) => ({ abilityHrid: h, level: l })),
    actionTypeFoodSlotsMap: { "/action_types/combat": c.food.map(h => (h ? { itemHrid: h } : null)) },
    actionTypeDrinkSlotsMap: { "/action_types/combat": c.drinks.map(h => (h ? { itemHrid: h } : null)) },
    consumableCombatTriggersMap: trig(k => k.startsWith("/items/")),
    abilityCombatTriggersMap: trig(k => k.startsWith("/abilities/")),
    characterHouseRoomMap: Object.fromEntries(Object.entries(c.houseRooms).map(([h, l]) => [h, { houseRoomHrid: h, level: l }])),
    characterAchievements: [],
  }
}
function current(c) {
  return {
    type: "init_character_data",
    character: { id: 1, name: c.name },
    ...common(c),
    characterItems: Object.entries(c.equipment).filter(([, e]) => e.itemHrid).map(([s, e]) => ({ itemLocationHrid: loc(s, e.itemHrid), itemHrid: e.itemHrid, enhancementLevel: e.enhancementLevel, count: 1 })),
    combatUnit: { combatAbilities: c.abilities.map((a, i) => (a.abilityHrid ? { abilityHrid: a.abilityHrid, level: a.level, slotNumber: i } : null)).filter(Boolean) },
  }
}
function shared(c) {
  const all = common(c)
  return {
    sharableCharacter: { name: c.name },
    characterSkills: all.characterSkills,
    characterAbilities: all.characterAbilities,
    wearableItemMap: Object.fromEntries(Object.entries(c.equipment).filter(([, e]) => e.itemHrid).map(([s, e]) => [loc(s, e.itemHrid), { itemLocationHrid: loc(s, e.itemHrid), itemHrid: e.itemHrid, enhancementLevel: e.enhancementLevel }])),
    equippedAbilities: c.abilities.map((a, i) => (a.abilityHrid ? { abilityHrid: a.abilityHrid, level: a.level, slotNumber: i } : null)).filter(Boolean),
    foodItemHrids: c.food, drinkItemHrids: c.drinks,
    consumableCombatTriggersMap: all.consumableCombatTriggersMap, abilityCombatTriggersMap: all.abilityCombatTriggersMap,
    characterHouseRoomMap: all.characterHouseRoomMap,
  }
}
const envelope = {
  members: cfgs.map((c, i) => (i === 0
    ? { characterName: c.name, isCurrent: true, payload: current(c) }
    : { characterName: c.name, isCurrent: false, payload: { profile: shared(c) } })),
}
const { players, problems } = importTeam(m, envelope)
if (problems.length) out("problems:", problems.join("; "))
let bad = 0
const pick = c => ({ levels: c.levels, food: c.food, drinks: c.drinks, abilities: c.abilities, triggerMap: c.triggerMap, abilityLevelMap: c.abilityLevelMap,
  equipment: Object.fromEntries(Object.entries(c.equipment).filter(([, e]) => e.itemHrid)), houseRooms: Object.fromEntries(Object.entries(c.houseRooms).filter(([, v]) => v)) })
const sort = v => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v)
players.forEach((p, i) => {
  const a = JSON.stringify(sort(pick(p)))
  const b = JSON.stringify(sort(pick(cfgs[i])))
  if (a !== b) {
    bad++
    for (const k of Object.keys(pick(p))) if (JSON.stringify(sort(pick(p)[k])) !== JSON.stringify(sort(pick(cfgs[i])[k]))) out(`  ${p.name}.${k}: imported=${JSON.stringify(pick(p)[k]).slice(0, 300)} expected=${JSON.stringify(pick(cfgs[i])[k]).slice(0, 300)}`)
  }
})
const d1 = JSON.stringify(sort(teamDTO(m, players)))
const d2 = JSON.stringify(sort(teamDTO(m, cfgs)))
// strongest check: both configs give the same simulation result
const target = { kind: "zone", zoneHrid: "/actions/combat/sorcerers_tower", difficultyTier: 0 }
let same = 0
for (const seed of [1, 2, 3]) {
  const a = await simulateRust(m, buildPayload(m, players, target, { hours: 2, seed }))
  const b = await simulateRust(m, buildPayload(m, cfgs, target, { hours: 2, seed }))
  const norm = r => JSON.stringify(sort({ ...JSON.parse(JSON.stringify(r)), wipeEvents: [], timeSeriesData: null }))
  if (norm(a) === norm(b)) same++
}
out(`imported ${players.length} (${players.map(p => p.source).join(",")}); config mismatches: ${bad}; worker DTO identical: ${d1 === d2}; simulation identical: ${same}/3`)
rust.close()
process.exit(0)
