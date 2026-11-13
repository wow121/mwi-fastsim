// Ironcow party import: logged-in ironcow + teammates' shared profiles (one marked standard, one
// without a game mode) -> ironcowFromEnvelope.   node test-ironcow-import.mjs   (needs data/envelope.json)
import fs from "node:fs"
import { Game } from "./app/game.mjs"
import { ironcowFromEnvelope, ironcowFromGame } from "./app/ironcow/import.mjs"

const m = new Game(JSON.parse(fs.readFileSync("data/envelope.json", "utf8")))
let fail = 0
const check = (ok, msg) => { if (!ok) fail++; process.stdout.write(`${ok ? "ok  " : "FAIL"} ${msg}\n`) }
const skills = lv => ["stamina", "attack", "melee", "defense", "milking", "cooking", "brewing"].map(s => ({ skillHrid: `/skills/${s}`, level: lv }))
const sword = { itemLocationHrid: "/item_locations/main_hand", itemHrid: "/items/cheese_sword", enhancementLevel: 3 }
const brush = { itemLocationHrid: "/item_locations/milking_tool", itemHrid: "/items/cheese_brush", enhancementLevel: 0 }
const current = {
  character: { id: 1, name: "IcMe", gameMode: "ironcow" },
  characterSkills: skills(40),
  characterItems: [sword, brush, { itemLocationHrid: "/item_locations/inventory", itemHrid: "/items/milk", count: 9 }],
  combatUnit: { combatAbilities: [] },
  actionTypeDrinkSlotsMap: { "/action_types/milking": [{ itemHrid: "/items/milking_tea" }] },
  communityBuffs: [],
}
const mate = (name, mode, lv) => ({ profile: { sharableCharacter: { name, ...(mode ? { gameMode: mode } : {}) }, characterSkills: skills(lv), wearableItemMap: { "/item_locations/main_hand": sword, "/item_locations/milking_tool": brush } } })
const envelope = {
  currentCharacter: current,
  members: [
    { characterName: "IcMe", isCurrent: true, payload: current },
    { characterName: "IcMate", isCurrent: false, payload: mate("IcMate", "ironcow", 55) },
    { characterName: "NoMode", isCurrent: false, payload: mate("NoMode", "", 30) },
    { characterName: "Normal", isCurrent: false, payload: mate("Normal", "standard", 70) },
  ],
  missingMembers: ["Unopened"],
}
const prev = ironcowFromGame(m, { ...current, character: { id: 9, name: "OtherIc", gameMode: "ironcow" } }, null).team
const { team, reply } = ironcowFromEnvelope(m, envelope, prev)
console.log(JSON.stringify(reply))
check(reply.names.join() === "IcMe,IcMate,NoMode", "party imported, standard teammate skipped")
check(reply.skipped.join() === "Normal" && reply.missing.join() === "Unopened", "skipped / missing reported")
check(team.members.length === 4 && team.members[0].name === "OtherIc", "earlier ironcow character kept")
const by = n => team.members.find(p => p.name === n)
check(team.selected.join() === [by("IcMe"), by("IcMate"), by("NoMode")].map(p => String(p.id)).join(), "party is the selected team")
check(by("IcMate").gameMode === "ironcow" && by("NoMode").gameMode === "ironcow", "teammate game mode (given / from the party)")
check(by("IcMate").life.levels.milking === 55 && by("IcMate").life.levels.cooking === 55, "teammate life skill levels")
check(by("IcMate").life.source.items.some(i => i.itemHrid === "/items/cheese_brush"), "teammate tools from the profile")
check(by("IcMate").equipment && Object.values(by("IcMate").equipment).some(e => e?.itemHrid === "/items/cheese_sword"), "teammate combat gear")
check(by("IcMe").life.source.teas.milking?.[0] === "/items/milking_tea" && by("IcMe").life.speed.milking > 0, "own teas + tool speed")
// re-import replaces by name, ids stable
const again = ironcowFromEnvelope(m, envelope, team)
check(again.team.members.length === 4 && again.team.selected.join() === team.selected.join(), "re-import replaces by name")
process.exit(fail ? 1 : 0)
