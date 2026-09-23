// Host side of the wasm build of the Rust engine (engine/src/wasm.rs). Works in Node and in a
// browser Web Worker: one instance runs one simulation at a time.
const enc = new TextEncoder()
const dec = new TextDecoder()

export class WasmEngine {
  /** module: a WebAssembly.Module (or bytes) */
  static async create(module) {
    const mod = module instanceof WebAssembly.Module ? module : await WebAssembly.compile(module)
    const inst = await WebAssembly.instantiate(mod, {})
    return new WasmEngine(inst.exports)
  }

  constructor(x) {
    this.x = x
  }

  put(text) {
    const b = enc.encode(text)
    const p = this.x.alloc(b.length)
    new Uint8Array(this.x.memory.buffer, p, b.length).set(b)
    return [p, b.length]
  }

  out() {
    return dec.decode(new Uint8Array(this.x.memory.buffer, this.x.out_ptr(), this.x.out_len()))
  }

  /** Game data JSON text (exportGameData). */
  loadGameData(text) {
    if (this.x.load_gamedata(...this.put(text)) !== 0) throw new Error(`game data: ${this.out()}`)
  }

  /** Compiled scenario JSON text -> `{"events":N,"result":{..}}` or `{"error":".."}` text. */
  run(scenarioText, attacks = true) {
    this.x.run(...this.put(scenarioText), attacks ? 1 : 0)
    return this.out()
  }
}
