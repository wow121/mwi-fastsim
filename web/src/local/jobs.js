// Background jobs in the browser (same interface as node/app/jobs.mjs); finished jobs are kept in
// IndexedDB so results survive a reload. A reload interrupts running jobs.
import { kvDel, kvGet, kvKeys, kvSet } from "./kv.js"

export class Jobs {
  constructor() {
    this.jobs = new Map()
    this.next = Date.now()
    this.ready = kvKeys("job:").then(async keys => {
      for (const k of keys) {
        const j = await kvGet(k)
        if (!j) continue
        if (j.status === "running") j.status = "interrupted"
        this.jobs.set(j.id, j)
      }
    })
  }

  list() {
    return [...this.jobs.values()].map(({ result, log, controller, ...j }) => j).sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id) {
    return this.jobs.get(id)
  }

  save(j) {
    const { controller, ...rest } = j
    return kvSet(`job:${j.id}`, JSON.parse(JSON.stringify(rest))).catch(() => {})
  }

  remove(id) {
    const j = this.jobs.get(id)
    if (!j) return false
    j.controller?.abort()
    this.jobs.delete(id)
    kvDel(`job:${id}`)
    return true
  }

  cancel(id) {
    const j = this.jobs.get(id)
    j?.controller?.abort()
    return !!j
  }

  start(type, title, params, run) {
    const id = String(this.next++)
    const controller = new AbortController()
    const j = { id, type, title, params, status: "running", createdAt: Date.now(), progress: { done: 0, total: 0, stage: "准备中" }, log: [], result: null, controller }
    this.jobs.set(id, j)
    const api = {
      signal: controller.signal,
      progress: (done, total, stage) => { j.progress = { done, total, stage: stage ?? j.progress.stage } },
      log: (msg) => {
        j.log.push({ t: Date.now(), msg })
        if (j.log.length > 500) j.log.shift()
      },
      partial: (result) => { j.result = result },
    }
    ;(async () => {
      try {
        j.result = await run(params, api)
        j.status = controller.signal.aborted ? "cancelled" : "done"
      } catch (e) {
        j.status = controller.signal.aborted ? "cancelled" : "error"
        j.error = String(e?.stack || e)
      }
      j.finishedAt = Date.now()
      this.save(j)
    })()
    return j
  }
}
