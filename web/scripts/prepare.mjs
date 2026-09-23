// Puts the browser build's runtime file into public/ (run before dev / build):
//   public/engine/mwi_engine.wasm  the Rust engine (cargo build --profile wasm --target wasm32-unknown-unknown --lib)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, "..")

const wasm = path.join(root, "..", "engine", "target", "wasm32-unknown-unknown", "wasm", "mwi_engine.wasm")
fs.mkdirSync(path.join(root, "public", "engine"), { recursive: true })
if (fs.existsSync(wasm)) fs.copyFileSync(wasm, path.join(root, "public", "engine", "mwi_engine.wasm"))
else console.warn(`[prepare] ${wasm} missing: browser mode will not work (build it: cd engine && cargo build --profile wasm --target wasm32-unknown-unknown --lib)`)

// the combat-sim site's bundle is no longer used: remove what older builds put here
fs.rmSync(path.join(root, "public", "site"), { recursive: true, force: true })
console.log(`[prepare] engine ${fs.existsSync(wasm) ? "ok" : "MISSING"}`)
