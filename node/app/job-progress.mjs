// Overall progress and time left of a background job (Node and the browser share it).
//
// Work is counted in simulated hours, as the engine finishes runs (see `countRuns`), so every job type
// is measured the same way and the time left follows the machine's actual throughput. The total comes
// from, in this order:
//   1. a finished earlier job of the same type and parameters: the searches are deterministic, so it
//      did exactly the same work;
//   2. the job's own estimate: optimizers call `api.remaining(simHours)` with the work still ahead at each
//      step (an optimizer run inside another gets an api that adds what its caller still has to do);
//   3. otherwise the stage counter (`api.progress(done, total)`), right for single-stage jobs.
// Estimates of a job type that keep missing in one direction are scaled by how the last finished jobs of that
// type came out (actual work / first estimate). The bar never moves backwards.
import { hash53 } from "./hash.mjs"

export const paramsKey = (type, params) => `${type}:${hash53(JSON.stringify(params ?? null))}`

/** Per-job engine wrapper: `onWork(simHours)` after each finished run. */
export function countRuns(rust, onWork) {
  return Object.create(rust, {
    run: { value: (sc, o) => rust.run(sc, o).then(r => (onWork((sc?.simulationTimeLimit || 0) / 3600e9), r)) },
  })
}

const RATE_WINDOW = 60e3

/** Median of actual work / first estimate over finished jobs (newest first) of one type; 1 without any. */
export function calibration(finished) {
  const r = finished.filter(j => j.work > 0 && j.estimate > 0).slice(0, 5).map(j => j.work / j.estimate).sort((a, b) => a - b)
  return r.length ? Math.min(4, Math.max(0.25, r[Math.floor(r.length / 2)])) : 1
}

/** Adds `work`, `remaining`, `workDone` and the overall fields to the `api` of job `j`; `prior` = earlier
 *  finished job with the same paramsKey (or null), `scale` = calibration of the type. j.progress gets
 *  { overall (0-1), eta (ms or null), basis, simHours }; a finished job keeps `work` and `estimate`. */
export function trackProgress(j, api, prior, scale = 1) {
  let done = 0, expected = null, shown = 0
  const samples = [[Date.now(), 0]]
  const exact = prior?.work > 0 ? prior.work : null

  const update = () => {
    const now = Date.now()
    const p = j.progress
    let f = null, basis = null, total = exact || expected
    if (total) {
      f = Math.min(0.99, done / total)
      basis = exact ? "same" : "estimate"
    } else if (p.total) {
      f = Math.min(0.99, p.done / p.total)
      basis = "stage"
    }
    if (f != null) shown = Math.max(shown, f)
    // throughput over the last minute (whole run until then)
    while (samples.length > 2 && now - samples[1][0] > RATE_WINDOW) samples.shift()
    const [t0, w0] = samples[0]
    const rate = now - t0 > 2000 ? (done - w0) / (now - t0) : null
    let eta = null
    if (total && rate > 0) eta = Math.max(0, total - done) / rate
    else if (basis === "stage" && shown > 0) eta = ((now - j.createdAt) * (1 - shown)) / shown
    j.progress = { ...p, overall: f == null ? null : shown, eta: eta == null ? null : Math.round(eta), basis, simHours: Math.round(done * 10) / 10 }
  }

  const stage = api.progress
  api.progress = (d, t, s) => { stage(d, t, s); update() }
  api.work = h => {
    done += h
    const now = Date.now()
    if (now - samples.at(-1)[0] > 1000) samples.push([now, done])
    update()
  }
  /** Estimated sim-hours still to run; call again whenever the estimate improves. `measured`: the estimate comes
   *  from work measured in this job (not scaled by the calibration). */
  api.remaining = (rest, { measured = false } = {}) => {
    if (j.estimate == null) j.estimate = done + Math.max(0, rest) // unscaled, for the calibration
    expected = done + Math.max(0, rest) * (measured ? 1 : scale)
    update()
  }
  api.workDone = () => done
  api.finish = () => { j.work = done; j.progress = { ...j.progress, overall: 1, eta: 0 } }
  update()
  return api
}
