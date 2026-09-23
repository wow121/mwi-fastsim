// Talks to the Rust engine process (`mwi-fastsim serve`) over JSON lines.
import { spawn } from "node:child_process"
import readline from "node:readline"

export class RustEngine {
  constructor(binary, gamedataFile, threads) {
    this.proc = spawn(binary, ["serve", gamedataFile, String(threads)], { stdio: ["pipe", "pipe", "inherit"] })
    this.pending = new Map()
    this.nextId = 1
    this.waiters = []
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      // fast path: {"id":N,"ms":..,"events":..,"result":{...}} -> keep the result text raw
      const fast = /^\{"id":(\d+),"ms":([^,]+),"events":(\d+),"result":/.exec(line)
      if (fast) {
        const p = this.pending.get(Number(fast[1]))
        if (!p) return
        this.pending.delete(Number(fast[1]))
        const raw = line.slice(fast[0].length, -1)
        p.resolve({ ms: Number(fast[2]), events: Number(fast[3]), raw, get result() { return JSON.parse(raw) } })
        return
      }
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.gamedataLoaded) {
        const w = this.waiters.shift()
        w?.()
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg)
    })
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`rust engine exited (${code})`))
      this.pending.clear()
    })
  }

  /** Swaps the game data the engine uses for jobs sent after this call. */
  reloadGameData(file) {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
      this.proc.stdin.write(`${JSON.stringify({ gamedata: file })}\n`)
    })
  }

  /** Runs a compiled scenario; resolves to { result, ms, events }. */
  run(scenario, { attacks = true } = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(`${JSON.stringify({ id, scenario, attacks })}\n`)
    })
  }

  close() {
    this.proc.stdin.end()
  }
}
