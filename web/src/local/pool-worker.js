// One wasm engine per Web Worker.
import { WasmEngine } from "@app/wasm-engine.mjs"

let module = null
let engine = null
let gamedata = null

async function fresh() {
  engine = await WasmEngine.create(module)
  if (gamedata) engine.loadGameData(gamedata)
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === "init") {
      module = m.module
      gamedata = m.gamedata
      await fresh()
      self.postMessage({ type: "ready" })
    } else if (m.type === "gamedata") {
      gamedata = m.gamedata
      engine.loadGameData(gamedata)
      self.postMessage({ type: "ready" })
    } else if (m.type === "run") {
      const t0 = performance.now()
      let text
      try {
        text = engine.run(m.scenario, m.attacks)
      } catch (e) {
        // a panic traps the instance: start a new one for the next job
        text = JSON.stringify({ error: `engine crashed: ${e?.message || e}` })
        await fresh()
      }
      self.postMessage({ type: "result", id: m.id, text, ms: performance.now() - t0 })
    }
  } catch (e) {
    self.postMessage({ type: "error", id: m.id, error: String(e?.message || e) })
  }
}
