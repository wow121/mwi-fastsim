// Background jobs (optimizations) with progress, cancellation and persisted results.
import fs from "node:fs"
import path from "node:path"
import { calibration, paramsKey, trackProgress } from "./job-progress.mjs"

export class Jobs {
  constructor(dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
    this.jobs = new Map()
    this.next = Date.now()
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
        if (j.status === "running") j.status = "interrupted"
        this.jobs.set(j.id, j)
      } catch {}
    }
  }

  list() {
    return [...this.jobs.values()]
      .map(({ result, log, ...j }) => j)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id) {
    return this.jobs.get(id)
  }

  save(j) {
    const { controller, ...rest } = j
    fs.writeFileSync(path.join(this.dir, `${j.id}.json`), JSON.stringify(rest))
  }

  remove(id) {
    const j = this.jobs.get(id)
    if (!j) return false
    j.controller?.abort()
    this.jobs.delete(id)
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.json`))
    } catch {}
    return true
  }

  cancel(id) {
    const j = this.jobs.get(id)
    j?.controller?.abort()
    return !!j
  }

  /** Finished jobs of one type, newest first. */
  finished(type) {
    return [...this.jobs.values()].filter(j => j.type === type && j.status === "done").sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Latest finished job with the same type and parameters (its `work` is this job's exact total). */
  prior(key) {
    return [...this.jobs.values()].filter(j => j.key === key && j.status === "done" && j.work > 0).sort((a, b) => b.createdAt - a.createdAt)[0] || null
  }

  /** run(params, api) where api = { progress(done, total, stage), work(simHours), remaining(simHours), log(msg), partial(result), signal } */
  start(type, title, params, run) {
    const id = String(this.next++)
    const controller = new AbortController()
    const key = paramsKey(type, params)
    const prior = this.prior(key)
    const j = { id, type, title, params, key, status: "running", createdAt: Date.now(), progress: { done: 0, total: 0, stage: "准备中" }, log: [], result: null, controller }
    this.jobs.set(id, j)
    let lastSave = 0
    const api = {
      signal: controller.signal,
      progress: (done, total, stage) => {
        j.progress = { done, total, stage: stage ?? j.progress.stage }
      },
      log: (msg) => {
        j.log.push({ t: Date.now(), msg })
        if (j.log.length > 500) j.log.shift()
      },
      partial: (result) => {
        j.result = result
        if (Date.now() - lastSave > 5000) {
          lastSave = Date.now()
          this.save(j)
        }
      },
    }
    trackProgress(j, api, prior, calibration(this.finished(type)))
    ;(async () => {
      try {
        j.result = await run(params, api)
        j.status = controller.signal.aborted ? "cancelled" : "done"
        if (j.status === "done") api.finish()
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
