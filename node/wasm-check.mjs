// Checks the wasm engine (browser build) against the native engine on the synced team across
// zones: results must be identical.   node wasm-check.mjs [n]
// Needs data/envelope.json (game data, saved when the userscript syncs from the game) and
// data/team.json.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { compilePayload, exportGameData } from "./app/engine-core.mjs"
import { Game } from "./app/game.mjs"
import { WasmEngine } from "./app/wasm-engine.mjs"
import { buildPayload } from "./app/model.mjs"
import { RustEngine } from "./rust-client.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const out = (...a) => process.stdout.write(a.join(" ") + "\n")
const game = new Game(JSON.parse(fs.readFileSync(path.join(here, "data", "envelope.json"), "utf8")))
const gdText = JSON.stringify(exportGameData(game))
const gdFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mwi-wasm-")), "gamedata.json")
fs.writeFileSync(gdFile, gdText)
const exe = process.platform === "win32" ? "mwi-fastsim.exe" : "mwi-fastsim"
const native = new RustEngine(path.join(here, "..", "engine", "target", "release", exe), gdFile, 1)
const bytes = fs.readFileSync(path.join(here, "..", "engine", "target", "wasm32-unknown-unknown", "wasm", "mwi_engine.wasm"))
out("wasm imports:", JSON.stringify(WebAssembly.Module.imports(new WebAssembly.Module(bytes))))
const wasm = await WasmEngine.create(bytes)
wasm.loadGameData(gdText)

const team = JSON.parse(fs.readFileSync(path.join(here, "data", "team.json"), "utf8"))
const members = team.selected.map(id => team.members.find(p => String(p.id) === String(id))).filter(Boolean)
const zones = Object.values(game.$e.actionDetailMap).filter(a => a.type === "/action_types/combat").map(a => a.hrid)
const n = Number(process.argv[2] || 16)
let ok = 0
let msW = 0
let msN = 0
for (let i = 0; i < n; i++) {
  const zone = zones[(i * 7) % zones.length]
  const payload = buildPayload(game, members, { kind: "zone", zoneHrid: zone, difficultyTier: i % 3 }, { hours: 2, seed: 1000 + i, extra: { mooPass: true, comExp: 20, comDrop: 20 } })
  const sc = compilePayload(game, payload)
  const a = await native.run(sc)
  msN += a.ms
  const t = performance.now()
  const w = JSON.parse(wasm.run(JSON.stringify(sc), true))
  msW += performance.now() - t
  if (w.error) out(`  ${zone} T${i % 3}: wasm error ${w.error}`)
  else if (JSON.stringify(w.result) === JSON.stringify(JSON.parse(a.raw))) ok++
  else out(`  ${zone} T${i % 3}: MISMATCH`)
}
out(`wasm vs native: ${ok}/${n} identical; wasm ${(msW / n).toFixed(1)} ms, native ${(msN / n).toFixed(1)} ms per 2h run`)
native.close()
process.exit(ok === n ? 0 : 1)
