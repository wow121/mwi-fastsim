// temp runner (Claude): zone recommendation for players given as combat-sim site exports
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { exportGameData } from "./app/engine-core.mjs"
import { Game } from "./app/game.mjs"
import { RustEngine } from "./rust-client.mjs"
import { PriceBook } from "./app/metrics.mjs"
import { Evaluator } from "./app/evaluator.mjs"
import { emptyPlayer } from "./app/import.mjs"
import { recommendZones } from "./app/opt-zones.mjs"
import { options } from "./app/options.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const [, , outFile, ...inFiles] = process.argv
const env = JSON.parse(fs.readFileSync(path.join(here, "data", "envelope.json"), "utf8"))
let market
try {
  market = await (await fetch("https://www.milkywayidle.com/game_data/marketplace.json")).json()
} catch { market = JSON.parse(fs.readFileSync(path.join(here, "data", "market.json"), "utf8")) }
const game = new Game(env)
const gd = exportGameData(game)
const gdFile = path.join(os.tmpdir(), `claude-gd-${crypto.createHash("sha1").update(JSON.stringify(gd)).digest("hex").slice(0, 12)}.json`)
fs.writeFileSync(gdFile, JSON.stringify(gd))
const st = { m: game, rust: new RustEngine(path.join(here, "..", "engine", "target", "release", "mwi-fastsim.exe"), gdFile, os.cpus().length), mode: "rust" }
st.book = new PriceBook(game.$e, market.marketData)
st.ev = new Evaluator(st)

const LV = { stamina: "staminaLevel", intelligence: "intelligenceLevel", attack: "attackLevel", melee: "meleeLevel", defense: "defenseLevel", ranged: "rangedLevel", magic: "magicLevel" }
function convert(x, i) {
  const p = emptyPlayer(i + 1, game.$e)
  p.name = x.name || `P${i + 1}`
  p.selected = true
  for (const [k, s] of Object.entries(LV)) p.levels[k] = x.player[s] || 1
  for (const e of x.player.equipment) {
    const n = e.itemLocationHrid.split("/").pop()
    const slot = n === "main_hand" || n === "two_hand" ? "weapon" : n
    if (p.equipment[slot]) p.equipment[slot] = { itemHrid: e.itemHrid, enhancementLevel: e.enhancementLevel }
  }
  p.food = (x.food["/action_types/combat"] || []).slice(0, 3).map(f => f.itemHrid || "")
  p.drinks = (x.drinks["/action_types/combat"] || []).slice(0, 3).map(f => f.itemHrid || "")
  p.abilities = x.abilities.map(a => ({ abilityHrid: a.abilityHrid, level: a.level }))
  p.abilityLevelMap = Object.fromEntries(x.abilities.filter(a => a.abilityHrid).map(a => [a.abilityHrid, a.level]))
  p.triggerMap = x.triggerMap || {}
  p.houseRooms = { ...p.houseRooms, ...x.houseRooms }
  p.achievements = x.achievements || {}
  return p
}
const members = inFiles.map((f, i) => convert(JSON.parse(fs.readFileSync(f, "utf8")), i))
const o = options(game)
const targets = []
for (const z of [...o.zones, ...o.dungeons]) for (let t = 0; t <= (z.maxDifficulty || 0); t++) targets.push({ kind: "zone", zoneHrid: z.hrid, difficultyTier: t })
const extra = { mooPass: true, comExp: 0, comDrop: 0 }
const t0 = Date.now()
const res = await recommendZones(st.ev, { members, targets, hours: 24, seeds: 3, extra }, { signal: new AbortController().signal, progress: () => {} })
fs.writeFileSync(outFile, JSON.stringify({ members, market: market.timestamp, ...res }))
process.stderr.write(`done ${targets.length} targets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
process.exit(0)
