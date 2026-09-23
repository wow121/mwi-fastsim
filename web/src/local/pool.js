// Pool of Web Workers running the wasm engine; same interface as the Node RustEngine client:
// run(scenario, { attacks }) -> { result, ms, events }.
export class WasmPool {
  static async create(wasmUrl, gamedataText, threads = navigator.hardwareConcurrency || 4) {
    const module = await WebAssembly.compileStreaming(fetch(wasmUrl)).catch(async () => WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()))
    const pool = new WasmPool(threads)
    await Promise.all(pool.workers.map(w => pool.send(w, { type: "init", module, gamedata: gamedataText })))
    return pool
  }

  constructor(threads) {
    this.threads = threads
    this.queue = []
    this.pending = new Map()
    this.nextId = 1
    this.workers = Array.from({ length: threads }, () => {
      const w = new Worker(new URL("./pool-worker.js", import.meta.url), { type: "module" })
      w.busy = false
      w.onmessage = ({ data }) => this.onMessage(w, data)
      return w
    })
  }

  send(w, msg) {
    return new Promise((resolve, reject) => {
      w.waiter = { resolve, reject }
      w.busy = true
      w.postMessage(msg)
    })
  }

  onMessage(w, d) {
    if (d.type === "ready" || (d.type === "error" && !d.id)) {
      w.busy = false
      const x = w.waiter
      w.waiter = null
      d.type === "ready" ? x?.resolve() : x?.reject(new Error(d.error))
      return this.pump()
    }
    const p = this.pending.get(d.id)
    this.pending.delete(d.id)
    w.busy = false
    if (p) {
      if (d.type === "error") p.reject(new Error(d.error))
      else {
        const o = JSON.parse(d.text)
        if (o.error) p.reject(new Error(o.error))
        else p.resolve({ result: o.result, events: o.events, ms: d.ms })
      }
    }
    this.pump()
  }

  pump() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue
      const job = this.queue.shift()
      w.busy = true
      this.pending.set(job.id, job)
      w.postMessage({ type: "run", id: job.id, scenario: job.scenario, attacks: job.attacks })
    }
  }

  run(scenario, { attacks = true } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, scenario: JSON.stringify(scenario), attacks, resolve, reject })
      this.pump()
    })
  }

  /** New game data for jobs sent after this call (waits for running jobs to finish). */
  async reloadGameData(text) {
    while (this.workers.some(w => w.busy) || this.queue.length) await new Promise(r => setTimeout(r, 20))
    await Promise.all(this.workers.map(w => this.send(w, { type: "gamedata", gamedata: text })))
  }
}
