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
import { SEP, joinList, t } from "./lang.mjs"
import { zh } from "./i18n.mjs"

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

/**
 * The strategy as steps to follow by hand: which orb, what result to keep, when to stop and switch.
 * `counts`: average items used (by item hrid), shown next to each orb.
 */
export function strategySteps(maps, st, target, start, counts = {}) {
  const n = h => zh(maps, h)
  const orb = op => n(ORBS[op])
  const avg = op => (counts[ORBS[op]] ? t("（平均 {n} 个）", { n: counts[ORBS[op]].toFixed(1) }) : "")
  const want = q => `${n(q.hrid)} ≥G${q.min}`
  const all = joinList(target.map(want))
  const types = joinList(target.map(q => n(q.hrid)))
  const steps = []
  const have = start?.lines?.length || 0
  const lines = st.add === "max" ? Math.max(have, 4) : Math.max(have, target.length)
  if (lines > have) steps.push(t("用符石核心把词条加到 {n} 条（新词条随机）。", { n: lines }))
  const keep = st.prio === "ok"
    ? t("洗出来的结果，达标的词条更多才采用，否则放弃")
    : t("洗出来的结果，目标词条（{types}）的个数更多才采用；个数一样时达标的更多、或品级更接近目标才采用；否则放弃", { types })
  const lockWhen = st.lock === "ok"
    ? t("一旦有一条目标词条达到要求的品级（{all}），马上用{orb}锁住它（只锁一次）。", { all, orb: n(ORBS.bind) })
    : t("一旦洗出任意一条目标词条（{types}），马上用{orb}锁住它（只锁一次）。", { types, orb: n(ORBS.bind) })
  const typeStep = (op, until) => {
    if (op === "focus") return t("反复用{orb}{avg}：每次洗之前把目标词条（{types}）都选为专注，品级不变只换类型。{keep}。{until}", { orb: orb(op), avg: avg(op), types, keep, until })
    if (op === "mutate") return t("反复用{orb}{avg}：每次随机重洗 2 条没锁的词条。{keep}。{until}", { orb: orb(op), avg: avg(op), keep, until })
    return t("反复用{orb}{avg}：每次重洗所有没锁的词条（类型和品级，{orb}最高 G{cap}）。{keep}。{until}", { orb: orb(op), avg: avg(op), keep, until, cap: op === "reshape" ? 4 : 6 })
  }
  if (target.length >= 2 && st.typeOp !== st.lastTypeOp)
    steps.push(typeStep(st.typeOp, t("洗到只差 1 个目标词条时停下，换下一步。")))
  else steps.push(typeStep(st.typeOp, t("洗到目标词条（{types}）全部出现时停下，换下一步。", { types })))
  if (st.lock !== "none") steps.push(lockWhen)
  if (target.length >= 2 && st.typeOp !== st.lastTypeOp) steps.push(typeStep(st.lastTypeOp, t("洗到最后一个目标词条也出现时停下，换下一步。")))
  if (st.gradeOp === "attune" || st.gradeOp === "attune+") {
    if (st.gradeOp === "attune+") steps.push(t("如果有不需要的词条品级比某条目标词条高，先用{orb}{avg}（品级在没锁的词条之间互换），结果更接近目标才采用。", { orb: orb("exchange"), avg: avg("exchange") }))
    steps.push(t("然后反复用{orb}{avg}：每条没锁的词条 65% 降一级、20% 不变、15% 升一级。结果更接近目标（{all}）才采用，否则放弃。全部达标就完成。", { orb: orb("attune"), avg: avg("attune"), all }))
  } else {
    steps.push(t("类型齐了以后继续用{orb}{avg}洗，同样只采用更接近目标的结果，直到 {all} 全部达标。", { orb: orb(st.gradeOp), avg: avg(st.gradeOp), all }))
  }
  return steps
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

// item slots of the engine's talisman job (engine/src/talisman.rs), in this order
const ITEM_ORDER = ["reshape", "reforge", "mutate", "focus", "attune", "exchange", "bind", "core1", "core2", "core3"]
const CHUNK = 64 // runs per engine job: one strategy spreads over all engine threads / wasm workers

/** Mean / median / p90 / success from per-run costs (−1 = not reached). */
function summarize(costs, steps, counts) {
  const c = costs.map(x => (x < 0 ? Infinity : x)).sort((a, b) => a - b)
  const ok = c.filter(Number.isFinite)
  const q = p => c[Math.min(c.length - 1, Math.floor(p * c.length))]
  return {
    mean: ok.length === c.length ? ok.reduce((a, b) => a + b, 0) / ok.length : Infinity,
    median: q(0.5), p90: q(0.9), success: ok.length / c.length,
    steps: steps / c.length,
    counts: Object.fromEntries(ITEM_ORDER.map((k, i) => [ORBS[k], counts[i] / c.length]).filter(([, v]) => v > 0)),
  }
}

/**
 * Job: params { typeHrid, start: { lines: [{ hrid, grade }], lockHrid }, target: [{ hrid, min }], prices: { item: coins },
 *   gradeWeights, runs, seed }. Coordinate search over the strategy options (all values of one option at once, the
 *   best kept, two rounds), then the best few again with 4× the runs. The rerolls run in the engine
 *   (engine/src/talisman.rs), split into chunks over all its threads.
 */
export async function planTalisman(ev, params, api) {
  const maps = ev.ctx.m.$e
  const rust = ev.ctx.rust
  const M = talismanModel(maps, params.typeHrid, { gradeWeights: params.gradeWeights })
  const idx = Object.fromEntries(M.types.map((x, i) => [x.hrid, i]))
  const target = (params.target || []).filter(q => q?.hrid && q.hrid in idx).map(q => ({ hrid: q.hrid, min: Math.max(1, Math.min(M.maxGrade, Math.floor(q.min) || 1)) }))
  if (!target.length) throw new Error(t("请填写目标词条"))
  if (new Set(target.map(q => q.hrid)).size !== target.length) throw new Error(t("目标里有重复的词条"))
  if (target.length > M.maxLines) throw new Error(t("目标最多 {n} 条", { n: M.maxLines }))
  const lines = (params.start?.lines || []).filter(l => l?.hrid && l.hrid in idx).slice(0, M.maxLines).map(l => ({ hrid: l.hrid, grade: Math.max(1, Math.min(M.maxGrade, Math.floor(l.grade) || 1)) }))
  const start = { lines, lock: params.start?.lockHrid ? lines.findIndex(l => l.hrid === params.start.lockHrid) : -1 }
  const prices = params.prices || {}
  const runs = Math.max(64, Math.min(20000, Number(params.runs) || 400))
  const seed = (Number(params.seed) || 20261112) >>> 0
  const itemSlot = h => ITEM_ORDER.findIndex(k => ORBS[k] === h)
  const base = {
    model: {
      types: M.types.map(x => ({ weight: x.weight, special: x.special })),
      focusWeight: M.focusWeight, focusPickLimit: M.focusPickLimit, maxGrade: M.maxGrade, maxLines: M.maxLines,
      caps: M.caps, mutateLines: M.mutateLines, attuneDown: M.attune.down, attuneUp: M.attune.up, gradeWeights: M.gradeWeights,
      addCost: Object.fromEntries(Object.entries(M.addCost).map(([n, c]) => [n, { item: itemSlot(c.itemHrid), count: c.count }])),
    },
    start: { lines: start.lines.map(l => [idx[l.hrid], l.grade]), lock: start.lock },
    target: target.map(q => [idx[q.hrid], q.min]),
    prices: ITEM_ORDER.map(k => Number(prices[ORBS[k]]) || 0),
  }
  const job = async extra => {
    if (api.signal?.aborted) throw new Error("cancelled")
    return (await rust.run({ talisman: { ...base, ...extra } }, { attacks: false })).result
  }
  // a run that costs more than this is cut off (counts as not reached): 50× the default strategy's median, ≥ 1B
  let maxCost = 1e15
  const cache = new Map()
  let done = 0
  const keys = Object.keys(OPTION_SETS)
  const total = 1 + 2 * keys.reduce((a, k) => a + OPTION_SETS[k].length - 1, 0) + 6
  const evalSt = async (st, n = runs, salt = 0) => {
    const key = JSON.stringify(st) + ":" + n
    if (cache.has(key)) return cache.get(key)
    const p = (async () => {
      const chunks = Math.ceil(n / CHUNK)
      const outs = await Promise.all(Array.from({ length: chunks }, (_, k) =>
        job({ strategy: st, runs: Math.min(CHUNK, n - k * CHUNK), seed: (seed + salt * 1000003 + k * 7919) >>> 0, maxCost })))
      const counts = ITEM_ORDER.map((_, i) => outs.reduce((a, o) => a + o.counts[i], 0))
      const s = { strategy: st, ...summarize(outs.flatMap(o => o.costs), outs.reduce((a, o) => a + o.steps, 0), counts) }
      api.progress(++done, total, t("模拟洗练策略"))
      return s
    })()
    cache.set(key, p)
    return p
  }
  const score = s => (s.success < 1 ? Infinity : s.mean)
  const pick = (a, b) => (score(b) < score(a) || (!Number.isFinite(score(a)) && b.success > a.success) ? b : a)
  let best = await evalSt(DEFAULT_STRATEGY)
  if (Number.isFinite(best.median)) maxCost = Math.max(1e9, best.median * 50)
  const all = [best]
  for (let round = 0; round < 2; round++) {
    for (const k of keys) {
      const list = await Promise.all(OPTION_SETS[k].filter(v => v !== best.strategy[k]).map(v => evalSt({ ...best.strategy, [k]: v })))
      all.push(...list)
      best = list.reduce(pick, best)
    }
  }
  // the best few again with 4× the runs (other seeds), so the winner is not a lucky draw
  const uniq = [...new Map(all.map(s => [JSON.stringify(s.strategy), s])).values()].sort((a, b) => score(a) - score(b) || b.success - a.success)
  const top = await Promise.all(uniq.slice(0, 6).map(s => evalSt(s.strategy, runs * 4, 1)))
  top.sort((a, b) => score(a) - score(b) || b.success - a.success)
  api.progress(total, total, t("模拟洗练策略"))
  // an example run of the winner whose cost is near its median: find it, then run again logging that one
  const exSeed = (seed + 99991) >>> 0
  const probe = await job({ strategy: top[0].strategy, runs: 200, seed: exSeed, maxCost })
  const costs = probe.costs.map(x => (x < 0 ? Infinity : x))
  let at = 0
  for (let i = 1; i < costs.length; i++) if (Math.abs(costs[i] - top[0].median) < Math.abs(costs[at] - top[0].median)) at = i
  const ex = await job({ strategy: top[0].strategy, runs: at + 1, seed: exSeed, maxCost, logRun: at })
  const toLines = a => a.map(([i, g]) => ({ hrid: M.types[i].hrid, grade: g }))
  const log = (ex.log || []).map(x => ({ op: x.op, taken: x.taken, lock: x.lock, lines: toLines(x.lines) }))
  return {
    target, start, gradeWeights: M.gradeWeights, maxCost,
    best: { ...top[0], text: describe(top[0].strategy), plan: strategySteps(maps, top[0].strategy, target, start, top[0].counts) },
    top: top.map(s => ({ ...s, text: describe(s.strategy) })),
    example: { cost: costs[at], steps: log.filter(x => x.op !== "add").length, log: log.slice(0, 400), truncated: log.length > 400 },
  }
}
