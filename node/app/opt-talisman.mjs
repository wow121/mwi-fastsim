// Talisman reroll planner (符石洗练): the cheapest way, in expected coin cost, from a talisman to a target
// (a set of modifier types with a minimum grade each). Monte Carlo over a family of strategies.
//
// Rules from the game data (talismanInfo + item descriptions, test server 2026-11):
//   reshaping / reforging orb  all unlocked lines get a new type and grade (grade cap 4 / 6)
//   mutation orb               two random unlocked lines get a new type and grade (cap 6; ≥ 2 unlocked)
//   focus orb                  all unlocked lines get a new type, grades kept; picked types weigh ×focusWeight
//                              (≤ focusPickLimit picks, special "unique" modifiers cannot be picked)
//   attunement orb             each unlocked line: −1 grade 65 %, same 20 %, +1 grade 15 % (clamped to G1..G6)
//   exchange orb               the unlocked lines' grades are shuffled among them (≥ 2 unlocked)
//   binding orb                locks one line (one per talisman); locked lines are never changed
//   cores                      line 2: 5 basic cores, line 3: 1 advanced, line 4: 1 expert
// A reroll shows the new lines first; the orb is used whether or not the result is taken.
// Observed on the test server (130 rerolls): a talisman never holds the same type twice; types are drawn by
// `weight` (1, specials 0.1). The grade odds of a new line are NOT in the game data: by default each grade is
// half as likely as the one below (fits the 432 observed lines of reshaping + reforging mixed), editable.
import { SEP, t } from "./lang.mjs"

export const ORBS = {
  reshape: "/items/reshaping_orb",
  reforge: "/items/reforging_orb",
  mutate: "/items/mutation_orb",
  focus: "/items/focus_orb",
  attune: "/items/attunement_orb",
  exchange: "/items/exchange_orb",
  bind: "/items/binding_orb",
  core1: "/items/basic_talisman_core",
  core2: "/items/advanced_talisman_core",
  core3: "/items/expert_talisman_core",
}
export const DEFAULT_GRADE_WEIGHTS = [32, 16, 8, 4, 2, 1]

// ------------------------------------------------------------------ model

/** Rules + type pool of one talisman type from the game data; `opts.gradeWeights` overrides the grade odds. */
export function talismanModel(maps, typeHrid = "/talisman_types/combat", opts = {}) {
  const info = maps.talismanInfo
  const mods = Object.values(maps.talismanModifierDetailMap || {}).filter(d => d.talismanTypeHrid === typeHrid)
  if (!info || !mods.length) throw new Error(t("游戏数据里没有符石（打开左侧栏的「测试服数据」）"))
  const rr = info.rerollInputMap || {}
  const mode = h => rr[h] || {}
  const at = mode(ORBS.attune)
  const add = info.addModifierInputMap || {}
  return {
    types: mods.map(d => ({ hrid: d.hrid, weight: Number(d.weight) || 0, special: String(d.groupHrid || "").endsWith("/special") })),
    maxGrade: info.maxGrade || 6,
    maxLines: info.maxModifierCount || 4,
    focusWeight: info.focusWeight || 5,
    focusPickLimit: info.focusPickLimit || 10,
    caps: { reshape: mode(ORBS.reshape).gradeCap || 4, reforge: mode(ORBS.reforge).gradeCap || 6, mutate: mode(ORBS.mutate).gradeCap || 6 },
    mutateLines: mode(ORBS.mutate).lineCount || 2,
    attune: { down: at.shiftDownChance ?? 0.65, up: at.shiftUpChance ?? 0.15 },
    gradeWeights: (Array.isArray(opts.gradeWeights) && opts.gradeWeights.length ? opts.gradeWeights : DEFAULT_GRADE_WEIGHTS).map(Number),
    // cores to add line n (index = number of lines after adding)
    addCost: { 2: add[2] || { itemHrid: ORBS.core1, count: 5 }, 3: add[3] || { itemHrid: ORBS.core2, count: 1 }, 4: add[4] || { itemHrid: ORBS.core3, count: 1 } },
  }
}

// mulberry32: small, seedable
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function gradeRoll(M, cap, r) {
  const w = M.gradeWeights.slice(0, cap)
  let x = r() * w.reduce((a, b) => a + b, 0)
  for (let i = 0; i < w.length; i++) if ((x -= w[i]) < 0) return i + 1
  return w.length
}

/** A type not in `taken`, by weight (× focusWeight for focused types). */
function typeRoll(M, taken, r, focus) {
  let total = 0
  const ws = M.types.map(x => {
    const w = taken.has(x.hrid) ? 0 : x.weight * (focus?.has(x.hrid) ? M.focusWeight : 1)
    total += w
    return w
  })
  let v = r() * total
  for (let i = 0; i < ws.length; i++) if ((v -= ws[i]) < 0) return M.types[i].hrid
  return M.types[ws.findLastIndex(w => w > 0)].hrid
}

/** New lines for an orb (the talisman itself is not changed). s = { lines: [{ hrid, grade }], lock: index | -1 } */
function applyOrb(M, s, op, r, focus) {
  const lines = s.lines.map(l => ({ ...l }))
  const free = lines.map((_, i) => i).filter(i => i !== s.lock)
  if (op === "reshape" || op === "reforge" || op === "focus") {
    const taken = new Set(s.lock >= 0 ? [lines[s.lock].hrid] : [])
    for (const i of free) {
      lines[i].hrid = typeRoll(M, taken, r, op === "focus" ? focus : null)
      taken.add(lines[i].hrid)
      if (op !== "focus") lines[i].grade = gradeRoll(M, M.caps[op], r)
    }
  } else if (op === "mutate") {
    const pick = free.slice()
    for (let k = pick.length - 1; k > 0; k--) {
      const j = Math.floor(r() * (k + 1));
      [pick[k], pick[j]] = [pick[j], pick[k]]
    }
    const change = pick.slice(0, M.mutateLines)
    const taken = new Set(lines.filter((_, i) => !change.includes(i)).map(l => l.hrid))
    for (const i of change) {
      lines[i].hrid = typeRoll(M, taken, r)
      taken.add(lines[i].hrid)
      lines[i].grade = gradeRoll(M, M.caps.mutate, r)
    }
  } else if (op === "attune") {
    for (const i of free) {
      const x = r()
      const d = x < M.attune.down ? -1 : x < M.attune.down + M.attune.up ? 1 : 0
      lines[i].grade = Math.min(M.maxGrade, Math.max(1, lines[i].grade + d))
    }
  } else if (op === "exchange") {
    // "each type takes another line's grade": a random derangement of the unlocked lines' grades
    const g = free.map(i => lines[i].grade)
    let p
    do {
      p = free.map((_, k) => k)
      for (let k = p.length - 1; k > 0; k--) {
        const j = Math.floor(r() * (k + 1));
        [p[k], p[j]] = [p[j], p[k]]
      }
    } while (p.some((v, k) => v === k))
    free.forEach((i, k) => (lines[i].grade = g[p[k]]))
  }
  return lines
}

/** How close lines are to the target: per requirement the grade of its line (0 = type missing). */
function status(lines, target) {
  let types = 0, ok = 0, deficit = 0
  for (const q of target) {
    const l = lines.find(x => x.hrid === q.hrid)
    if (l) {
      types++
      if (l.grade >= q.min) ok++
      else deficit += q.min - l.grade
    } else deficit += q.min
  }
  return { types, ok, deficit, done: ok === target.length }
}

const better = (a, b, prio) => {
  const k = prio === "ok" ? [a.ok - b.ok, a.types - b.types, b.deficit - a.deficit] : [a.types - b.types, a.ok - b.ok, b.deficit - a.deficit]
  for (const d of k) if (d) return d > 0
  return false
}

// ------------------------------------------------------------------ strategies

/**
 * A strategy: { add: "need" | "max", typeOp, lastTypeOp, gradeOp, lock: "none" | "ok" | "type", prio: "types" | "ok" }
 *   add         fill the talisman to the lines the target needs, or to the maximum (more lines = more draws)
 *   typeOp      orb while ≥ 2 target types are missing; lastTypeOp while 1 is missing
 *   gradeOp     orb once every type is there but some grade is short ("attune+" = exchange first when an
 *               unneeded line holds a higher grade)
 *   lock        bind the first target line that reaches its grade ("ok") or just has its type ("type")
 *   prio        which result counts as better: more types first, or more finished lines first
 * Results of a reroll are taken only when better than the current lines.
 */
export function describe(st) {
  const op = { reshape: t("重塑"), reforge: t("重铸"), mutate: t("突变"), focus: t("专注"), attune: t("调谐"), "attune+": t("置换 + 调谐"), exchange: t("置换") }
  const parts = [
    st.add === "max" ? t("先加满词条") : t("只加到目标需要的条数"),
    t("凑类型用{a}，只差 1 个时用{b}", { a: op[st.typeOp], b: op[st.lastTypeOp] }),
    t("类型齐了用{c}提品级", { c: op[st.gradeOp] }),
    st.lock === "none" ? t("不锁定") : st.lock === "ok" ? t("第一条达标的词条锁定") : t("第一条类型对的词条锁定"),
    st.prio === "ok" ? t("结果按达标条数优先取舍") : t("结果按类型数优先取舍"),
  ]
  return parts.join(SEP())
}

/** One run of a strategy; returns { cost, counts: { item: n }, steps, done, log? }. */
export function runOnce(M, start, target, st, prices, r, { maxCost = Infinity, maxSteps = 20000, log = false } = {}) {
  const s = { lines: start.lines.map(l => ({ ...l })), lock: start.lock ?? -1, bound: (start.lock ?? -1) >= 0 }
  // a lock on a line the target does not need is taken off first (the game has an unlock; assumed free)
  if (s.lock >= 0 && !target.some(q => q.hrid === s.lines[s.lock]?.hrid)) {
    s.lock = -1
    s.bound = false
  }
  const counts = {}
  let cost = 0
  const out = log ? [] : null
  const pay = (item, n = 1) => {
    counts[item] = (counts[item] || 0) + n
    cost += (prices[item] || 0) * n
  }
  const focus = new Set(target.map(q => q.hrid).filter(h => !M.types.find(x => x.hrid === h)?.special).slice(0, M.focusPickLimit))
  const want = st.add === "max" ? M.maxLines : Math.max(target.length, s.lines.length)
  let steps = 0
  // add lines (a new line gets a random new type and a grade like a reforge)
  while (s.lines.length < want) {
    const n = s.lines.length + 1
    if (n === 1) pay(ORBS.core1)
    else pay(M.addCost[n].itemHrid, M.addCost[n].count)
    const taken = new Set(s.lines.map(l => l.hrid))
    s.lines.push({ hrid: typeRoll(M, taken, r), grade: gradeRoll(M, M.caps.reforge, r) })
    out?.push({ op: "add", lines: s.lines.map(l => ({ ...l })), taken: true })
  }
  let cur = status(s.lines, target)
  while (!cur.done && steps < maxSteps && cost < maxCost) {
    steps++
    // lock
    if (!s.bound && st.lock !== "none") {
      const i = s.lines.findIndex(l => target.some(q => q.hrid === l.hrid && (st.lock === "type" || l.grade >= q.min)))
      const freeAfter = s.lines.length - 1
      if (i >= 0 && freeAfter >= 1) {
        pay(ORBS.bind)
        s.lock = i
        s.bound = true
        out?.push({ op: "bind", lines: s.lines.map(l => ({ ...l })), lock: i, taken: true })
        continue
      }
    }
    const missing = target.length - cur.types
    let op = missing >= 2 ? st.typeOp : missing === 1 ? st.lastTypeOp : st.gradeOp
    const unlocked = s.lines.length - (s.lock >= 0 ? 1 : 0)
    if (op === "attune+") {
      // exchange pays off when a line the target does not need holds a higher grade than a short line
      const spare = s.lines.filter((l, i) => i !== s.lock && !target.some(q => q.hrid === l.hrid)).map(l => l.grade)
      const short = s.lines.filter((l, i) => i !== s.lock && target.some(q => q.hrid === l.hrid && l.grade < q.min)).map(l => l.grade)
      op = spare.length && short.length && Math.max(...spare) > Math.min(...short) && unlocked >= 2 ? "exchange" : "attune"
    }
    if ((op === "mutate" || op === "exchange") && unlocked < 2) op = op === "mutate" ? "reforge" : "attune"
    if (unlocked < 1) return { cost: Infinity, counts, steps, done: false, log: out }
    pay(ORBS[op])
    const lines = applyOrb(M, s, op, r, focus)
    const next = status(lines, target)
    const take = better(next, cur, st.prio)
    out?.push({ op, lines, taken: take, before: s.lines.map(l => ({ ...l })) })
    if (take) {
      s.lines = lines
      cur = next
    }
  }
  return { cost: cur.done ? cost : Infinity, counts, steps, done: cur.done, log: out }
}

const OPTION_SETS = {
  add: ["max", "need"],
  typeOp: ["reshape", "reforge", "focus", "mutate"],
  lastTypeOp: ["reshape", "reforge", "focus", "mutate"],
  gradeOp: ["attune", "attune+", "reforge", "mutate", "reshape"],
  lock: ["ok", "type", "none"],
  prio: ["types", "ok"],
}
const DEFAULT_STRATEGY = { add: "max", typeOp: "reshape", lastTypeOp: "reshape", gradeOp: "attune", lock: "ok", prio: "types" }

function summarize(runs) {
  const costs = runs.map(x => x.cost).sort((a, b) => a - b)
  const ok = costs.filter(Number.isFinite)
  const q = p => costs[Math.min(costs.length - 1, Math.floor(p * costs.length))]
  const counts = {}
  for (const x of runs) for (const [k, v] of Object.entries(x.counts)) counts[k] = (counts[k] || 0) + v / runs.length
  return {
    mean: ok.length === costs.length ? ok.reduce((a, b) => a + b, 0) / ok.length : Infinity,
    median: q(0.5), p90: q(0.9), success: ok.length / costs.length,
    steps: runs.reduce((a, x) => a + x.steps, 0) / runs.length,
    counts,
  }
}

/**
 * Job: params { typeHrid, start: { lines: [{ hrid, grade }], lock }, target: [{ hrid, min }], prices: { item: coins },
 *   gradeWeights, runs, seed }. Coordinate search over the strategy options (each option changed in turn,
 *   the better one kept, two rounds), then the best few again with more runs.
 */
export async function planTalisman(ev, params, api) {
  const maps = ev.ctx.m.$e
  const M = talismanModel(maps, params.typeHrid, { gradeWeights: params.gradeWeights })
  const target = (params.target || []).filter(q => q?.hrid && M.types.some(x => x.hrid === q.hrid)).map(q => ({ hrid: q.hrid, min: Math.max(1, Math.min(M.maxGrade, Math.floor(q.min) || 1)) }))
  if (!target.length) throw new Error(t("请填写目标词条"))
  if (new Set(target.map(q => q.hrid)).size !== target.length) throw new Error(t("目标里有重复的词条"))
  if (target.length > M.maxLines) throw new Error(t("目标最多 {n} 条", { n: M.maxLines }))
  const start = { lines: (params.start?.lines || []).filter(l => l?.hrid && M.types.some(x => x.hrid === l.hrid)).map(l => ({ hrid: l.hrid, grade: Math.max(1, Math.min(M.maxGrade, Math.floor(l.grade) || 1)) })), lock: -1 }
  if (params.start?.lockHrid) start.lock = start.lines.findIndex(l => l.hrid === params.start.lockHrid)
  const prices = params.prices || {}
  const runs = Math.max(50, Math.min(20000, Number(params.runs) || 400))
  const seed = Number(params.seed || 20261112)
  // a run that costs more than this is cut off (counts as failed): 50× the default strategy's median, at least 1B
  let maxCost = Infinity
  const cache = new Map()
  let done = 0
  const evalSt = async (st, n = runs) => {
    const key = JSON.stringify(st) + ":" + n
    if (cache.has(key)) return cache.get(key)
    const r = rng(seed)
    const list = []
    for (let i = 0; i < n; i++) {
      list.push(runOnce(M, start, target, st, prices, r, { maxCost }))
      if (i % 50 === 49) {
        if (api.signal?.aborted) throw new Error("cancelled")
        await new Promise(res => setTimeout(res, 0))
      }
    }
    const s = { strategy: st, ...summarize(list) }
    cache.set(key, s)
    api.progress(++done, total, t("模拟洗练策略"))
    return s
  }
  const keys = Object.keys(OPTION_SETS)
  const total = 1 + 2 * keys.reduce((a, k) => a + OPTION_SETS[k].length - 1, 0) + 6
  let best = await evalSt(DEFAULT_STRATEGY)
  if (Number.isFinite(best.median)) maxCost = Math.max(1e9, best.median * 50)
  const all = [best]
  const score = s => (s.success < 1 ? Infinity : s.mean)
  for (let round = 0; round < 2; round++) {
    for (const k of keys) {
      for (const v of OPTION_SETS[k]) {
        if (v === best.strategy[k]) continue
        const s = await evalSt({ ...best.strategy, [k]: v })
        all.push(s)
        if (score(s) < score(best) || (!Number.isFinite(score(best)) && s.success > best.success)) best = s
      }
    }
  }
  // the best few again with 4× the runs (a fresh seed), so the winner is not a lucky draw
  const uniq = [...new Map(all.map(s => [JSON.stringify(s.strategy), s])).values()].sort((a, b) => score(a) - score(b) || b.success - a.success)
  const top = []
  for (const s of uniq.slice(0, 6)) top.push(await evalSt(s.strategy, runs * 4))
  top.sort((a, b) => score(a) - score(b) || b.success - a.success)
  api.progress(total, total, t("模拟洗练策略"))
  // an example run of the winner whose cost is near its median
  const r = rng(seed + 1)
  let example = null
  for (let i = 0; i < 200; i++) {
    const x = runOnce(M, start, target, top[0].strategy, prices, r, { maxCost, log: true })
    if (!example || Math.abs(x.cost - top[0].median) < Math.abs(example.cost - top[0].median)) example = x
  }
  return {
    target, start, gradeWeights: M.gradeWeights, maxCost,
    best: { ...top[0], text: describe(top[0].strategy) },
    top: top.map(s => ({ ...s, text: describe(s.strategy) })),
    example: example && { cost: example.cost, steps: example.steps, log: example.log.slice(0, 400), truncated: example.log.length > 400 },
  }
}
