// Regression check after an engine change: runs the synced team (data/team.json, data/envelope.json)
// across zones / tiers / seeds on two native builds and compares the raw results byte for byte.
//   node engine-diff.mjs <old engine binary> [n]
// Build the old one from git, e.g. `git archive HEAD engine` into a temp dir + cargo build --release.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { compilePayload, exportGameData } from "./app/engine-core.mjs"
import { Game } from "./app/game.mjs"
import { buildPayload } from "./app/model.mjs"
import { RustEngine } from "./rust-client.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const out = (...a) => process.stdout.write(a.join(" ") + "\n")
const oldBin = process.argv[2]
if (!oldBin || !fs.existsSync(oldBin)) throw new Error("usage: node engine-diff.mjs <old engine binary> [n]")
const game = new Game(JSON.parse(fs.readFileSync(path.join(here, "data", "envelope.json"), "utf8")))
const gdFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mwi-diff-")), "gamedata.json")
fs.writeFileSync(gdFile, JSON.stringify(exportGameData(game)))
const exe = process.platform === "win32" ? "mwi-fastsim.exe" : "mwi-fastsim"
const fresh = new RustEngine(path.join(here, "..", "engine", "target", "release", exe), gdFile, 8)
const old = new RustEngine(oldBin, gdFile, 8)
const team = JSON.parse(fs.readFileSync(path.join(here, "data", "team.json"), "utf8"))
const members = team.selected.map(id => team.members.find(p => String(p.id) === String(id))).filter(Boolean)
const zones = Object.values(game.$e.actionDetailMap).filter(a => a.type === "/action_types/combat" && !(a.maxPartySize < members.length)).map(a => a.hrid)
const n = Number(process.argv[3] || 60)
const jobs = []
for (let i = 0; i < n; i++) {
  const zone = zones[(i * 7) % zones.length]
  const payload = buildPayload(game, members, { kind: "zone", zoneHrid: zone, difficultyTier: i % 3 }, { hours: 4, seed: 7000 + i, extra: { mooPass: true, comExp: 20, comDrop: 20 } })
  jobs.push({ zone, sc: compilePayload(game, payload) })
}
let same = 0
// stats the old build may not know yet (unknown stat = error): dropped for it when they are 0
const NEW_KEYS = (process.env.NEW_KEYS || "damageTaken,smite,shatter,overkill,echo,fortify").split(",")
function forOld(sc) {
  const c = JSON.parse(JSON.stringify(sc))
  for (const p of c.players) for (const k of NEW_KEYS) {
    if (p.equipStats[k]) throw new Error(`${k} = ${p.equipStats[k]}: the old engine cannot run this team`)
    delete p.equipStats[k]
  }
  return c
}
const res = await Promise.all(jobs.map(async j => [j, await old.run(forOld(j.sc)), await fresh.run(j.sc)]))
for (const [j, a, b] of res) {
  if (a.raw === b.raw) same++
  else out("DIFF", j.zone, `tier ${j.sc.zone?.difficultyTier}`, `seed ${j.sc.seed}`)
}
out(`${same}/${n} identical`)
process.exit(same === n ? 0 : 1)
