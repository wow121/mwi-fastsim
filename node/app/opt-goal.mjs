// Goal planner: the fastest combined way (gear, ability books, combat levels, consumables) to
// farm a harder target (zone / tier) without dying and with more profit than now. Money and
// experience build up at the same time, so the time to the goal is, per character, the longer of
// "save up for the gear" (own cash + own income) and "farm the levels" (current experience + the
// experience per day at the current spot), and the team is ready when the slowest one is. The
// planner sweeps that time: at T days every character can spend its cash + T days of income and
// has the levels of T days; it greedily buys the affordable gear that removes the most deaths (then
// adds the most profit) per day of income until the goal holds in a long check, else moves on to a
// later T. Consumables are optimized on the target before and after; finally gear that is not
// needed is dropped and levels are lowered as far as the goal allows, which gives the finishing time.
import { hash53 } from "./hash.mjs"
import { pool } from "./search.mjs"
import { seedList } from "./evaluator.mjs"
import { GearPrices, guildSlots, memberSlots } from "./opt-upgrades.mjs"
import { optimizeConsumables } from "./opt-consumables.mjs"
import { zh } from "./i18n.mjs"

const clone = v => JSON.parse(JSON.stringify(v))
const INF = Number.POSITIVE_INFINITY
const M = v => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(1)}M`)
const SKILLS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]
export const SKILL_ZH = { stamina: "耐力", intelligence: "智力", attack: "攻击", melee: "近战", defense: "防御", ranged: "远程", magic: "魔法" }

/**
 * params: { members, goal (target), current (target now), extra, optimize, budgets, otherIncomes,
 *           tax, maxLevelUp, replacements, maxDeaths (per hour), maxSteps, levels, consumables }
 */
export async function planGoal(ev, params, api) {
  const { extra, goal } = params
  let members = clone(params.members)
  const optimize = params.optimize?.length ? params.optimize : members.map((_, i) => i)
  const tax = Number.isFinite(Number(params.tax)) ? Number(params.tax) : 0.05
  const maxDeaths = Math.max(0, Number(params.maxDeaths ?? 0.01))
  const maxSteps = params.maxSteps || 80
  const useLevels = params.levels !== false
  const useConsumables = params.consumables !== false
  const budget = members.map((_, k) => Math.max(0, Number(params.budgets?.[k] || 0)))
  const other = members.map((_, k) => Number(params.otherIncomes?.[k] || 0))
  const name = k => members[k].name || `队员${k + 1}`
  const maps = ev.ctx.m.$e
  const xpTable = maps.levelExperienceTable || []
  const gp = new GearPrices(maps, ev.ctx.book, tax, { refinedResale: params.refinedResale })
  const quick = { hours: 4, seeds: seedList(4242, 3) }
  const main = { hours: 12, seeds: seedList(9191, 8) }
  const long = { hours: 24, seeds: seedList(55511, 12) }
  // memoized: attempts at different T share many configurations
  const memo = new Map()
  const run = (mem, t, cfg) => {
    const text = JSON.stringify([mem, t, cfg.hours, cfg.seeds])
    const key = `${hash53(text)}:${hash53(text, 7)}:${text.length}`
    if (!memo.has(key)) {
      const p = ev.evaluate(mem, t, { ...cfg, extra, objective: "profit", signal: api.signal })
      p.catch(() => memo.delete(key))
      memo.set(key, p)
    }
    return memo.get(key)
  }
  const stat = r => ({
    profit: r.mean.profitPerHour * 24, deaths: r.mean.deathsPerHour,
    players: r.mean.players.map(p => ({ profit: p.profitPerHour * 24, deaths: p.deathsPerHour, xp: Object.fromEntries(SKILLS.map(s => [s, (p[`xp_${s}`] || 0) * 24])) })),
  })

  const now = stat(await run(members, params.current, long))
  const ref = now.profit
  api.log(`现在：${M(now.profit)}/天，死亡 ${now.deaths.toFixed(2)}/小时`)
  const start = stat(await run(members, goal, long))
  api.log(`直接去目标：${M(start.profit)}/天，死亡 ${start.deaths.toFixed(2)}/小时`)
  const income = members.map((_, k) => now.players[k].profit + other[k])
  members.forEach((c, k) => api.log(`  ${name(k)} 经验/天：${SKILLS.map(s => `${SKILL_ZH[s]} Lv.${c.levels?.[s]} ${M(now.players[k].xp[s])}`).join("，")}${c.experience ? "" : "（没有当前经验数据，按整级算）"}`))
  const perDay = k => Math.max(income[k], 1e6) // coins -> days of the character's own income

  // consumables on the target (item swap + triggers), before any upgrade
  const consumableChanges = []
  const tuneConsumables = async (label, guard) => {
    if (!useConsumables) return
    const before = members
    api.log(`${label}：在目标上优化药品`)
    const res = await optimizeConsumables(ev, { members: config(), target: goal, extra, objective: "profit", rounds: 1, swapItems: true, optimize }, {
      signal: api.signal, progress: (d, t, s) => api.progress(d, t, `药品 · ${s}`), log: m => api.log(`  [药品] ${m}`), partial: () => {},
    })
    if (res.unchanged) return
    // keep food / drinks / consumable triggers, not the (temporary) upgrades inside config()
    members = members.map((c, k) => ({ ...c, food: res.members[k].food, drinks: res.members[k].drinks, triggerMap: { ...(c.triggerMap || {}), ...pickItems(res.members[k].triggerMap) } }))
    if (guard && !(await guard())) {
      members = before
      api.log("  [药品] 调整后不再达标（死亡变多），撤回")
      return
    }
    for (const ch of res.changes) consumableChanges.push({ ...ch, memberName: name(ch.member), when: label })
  }

  // gear / book states per slot (spending cap: own cash + 180 days of own income)
  const slots = optimize.flatMap(idx => memberSlots(ev.ctx, gp, members, idx, {
    maxSpend: budget[idx] + Math.max(0, income[idx]) * 180, maxLevelUp: params.maxLevelUp || 8, replacements: params.replacements !== false,
    houses: params.houses === false ? false : "combat",
  }))
  // guild buffs (opt-in): raised for the whole team, paid with guild points -> no personal coins
  if (params.guild) {
    for (const g of guildSlots(maps, members, { maxGuildUp: params.maxGuildUp ?? 5 })) {
      slots.push({
        key: g.key, member: -1, memberName: "全队（公会）", slotName: `公会·${g.name}`, states: g.states, guild: true,
        trans: (a, b) => (b.level > a.level ? { cost: 0, how: `公会升到 ${b.level} 级（${g.points(a.level, b.level).toLocaleString()} 公会点数）` } : { cost: INF, how: "" }),
        value: () => 0,
      })
    }
  }
  const applyState = (mem, s, j) => (slots[s].guild ? slots[s].states[j].apply(mem) : slots[s].states[j].apply(mem[slots[s].member]))
  const pay = slots.map(sl => sl.states.map(a => sl.states.map(b => (a === b ? { cost: 0, how: "" } : sl.trans(a, b)))))
  const held = slots.map(() => 0)
  // combat levels: target level per member / skill, days from the current experience
  const lv0 = members.map(c => ({ ...c.levels }))
  const lv = members.map(c => ({ ...c.levels }))
  const expOf = (k, s) => {
    const L = Number(lv0[k][s] || 1)
    const e = Number(members[k].experience?.[s])
    return Number.isFinite(e) && e >= Number(xpTable[L] || 0) && e < Number(xpTable[L + 1] ?? INF) ? e : Number(xpTable[L] || 0)
  }
  // charms: which one a member wears while farming decides how the experience is split (focus
  // skill 70% + its bonus) -> options per member with the experience per day they give now
  const charmOpts = members.map(() => null)
  const charmSel = members.map(() => 0)
  const rateOf = (k, s, c = charmSel[k]) => charmOpts[k]?.[c]?.rates[s] ?? now.players[k].xp[s]
  const levelDays = (k, s, to, c = charmSel[k]) => {
    const rate = rateOf(k, s, c)
    const need = Number(xpTable[to] ?? INF) - expOf(k, s)
    return need <= 0 ? 0 : rate > 0 ? need / rate : INF
  }
  const config = () => {
    const mem = clone(members)
    held.forEach((j, s) => j && applyState(mem, s, j))
    mem.forEach((c, k) => { c.levels = { ...c.levels, ...lv[k] } })
    return mem
  }
  api.log(`${slots.length} 个装备 / 技能书 / 房子${params.guild ? " / 公会" : ""}位置可提升${useLevels ? "，另加战斗等级" : ""}`)

  await tuneConsumables("开始")
  const ok = st => st.deaths <= maxDeaths + 1e-9 && st.profit > ref
  const fmtT = T => (Number.isInteger(T) ? String(T) : T.toFixed(1))
  const spent = members.map(() => 0)
  const budgetAt = (k, T) => budget[k] + Math.max(0, income[k]) * T
  const levelAt = (k, s, T, c = charmSel[k]) => {
    let L = lv0[k][s]
    while (L + 1 < xpTable.length && levelDays(k, s, L + 1, c) <= T + 1e-9) L++
    return L
  }
  const levelsWith = (k, c, T) => Object.fromEntries(SKILLS.map(s => [s, levelAt(k, s, T, c)]))
  if (useLevels && params.charms !== false) {
    const TIERS = ["trainee", "basic", "advanced", "expert", "master", "grandmaster"]
    const nm = h => zh(maps, h)
    const jobs = []
    for (const k of optimize) {
      const cur = members[k].equipment?.charm?.itemHrid || ""
      const list = [{ hrid: cur, label: cur ? `${nm(cur)}（现在戴的）` : "不戴护符（现在）", cost: 0, rates: now.players[k].xp, current: true }]
      for (const sk of SKILLS) for (const t of TIERS) {
        const h = `/items/${t}_${sk}_charm`
        const it = maps.itemDetailMap[h]
        if (!it || h === cur) continue
        const req = it.equipmentDetail?.levelRequirements || []
        if (req.some(q => Number(members[k].levels?.[String(q.skillHrid).split("/").pop()] || 1) < Number(q.level || 0))) continue
        const price = gp.quote(h, 0).ask
        if (!(price < INF)) continue
        const o = { hrid: h, label: nm(h), cost: price, rates: null }
        list.push(o)
        jobs.push({ k, o })
      }
      charmOpts[k] = list
    }
    let done = 0
    await pool(jobs, 48, async ({ k, o }) => {
      const mem = clone(members)
      mem[k].equipment = { ...mem[k].equipment, charm: { itemHrid: o.hrid, enhancementLevel: 0 } }
      o.rates = stat(await run(mem, params.current, main)).players[k].xp
      api.progress(++done, jobs.length, "护符经验")
    })
    for (const k of optimize) {
      const best = SKILLS.map(sk => charmOpts[k].reduce((a, o) => (o.rates[sk] > a.rates[sk] ? o : a)))
      api.log(`  ${name(k)} 各技能最快的护符：${SKILLS.filter(sk => now.players[k].xp[sk] > 0).map((sk, i) => `${SKILL_ZH[sk]} ${M(best[SKILLS.indexOf(sk)].rates[sk])}/天`).join("，")}`)
    }
  }
  // one attempt: from scratch, with T days of cash / income / experience; greedy on the target
  const attempt = async (T) => {
    held.fill(0)
    spent.fill(0)
    charmSel.fill(0)
    for (const k of members.keys()) lv[k] = { ...lv0[k] }
    if (useLevels) for (const k of optimize) for (const s of SKILLS) lv[k][s] = levelAt(k, s, T)
    const log = []
    let why = ""
    let checked = null
    let curMain = stat(await run(config(), goal, main))
    for (let r = 0; r < maxSteps; r++) {
      if (api.signal.aborted) throw new Error("cancelled")
      if (curMain.deaths <= maxDeaths + 1e-9 && curMain.profit > ref) {
        const c = stat(await run(config(), goal, long))
        if (ok(c)) {
          checked = c
          break
        }
        curMain = { ...curMain, deaths: Math.max(curMain.deaths, c.deaths), profit: Math.min(curMain.profit, c.profit) }
      }
      const phase = curMain.deaths > maxDeaths + 1e-9 ? "deaths" : "profit"
      const cands = []
      slots.forEach((sl, s) => sl.states.forEach((st, j) => {
        const c = pay[s][held[s]][j]
        if (j === held[s] || !(c.cost < INF)) return
        if (sl.guild) return cands.push({ s, j, member: -1, cost: 0, how: c.how, days: 0 })
        if (spent[sl.member] + c.cost > budgetAt(sl.member, T)) return
        cands.push({ s, j, member: sl.member, cost: c.cost, how: c.how, days: Math.max(0, c.cost) / perDay(sl.member) })
      }))
      // wearing another charm while farming: different levels after T days (one option per result)
      for (const k of optimize) {
        const seen = new Set([JSON.stringify(lv[k])])
        const opts = (charmOpts[k] || []).map((o, c) => ({ o, c })).filter(x => x.c !== charmSel[k]).sort((a, b) => a.o.cost - b.o.cost)
        for (const { o, c } of opts) {
          const nl = levelsWith(k, c, T)
          const key = JSON.stringify(nl)
          if (seen.has(key) || spent[k] + o.cost > budgetAt(k, T)) continue
          seen.add(key)
          cands.push({ kind: "charm", member: k, c, levels: nl, cost: o.cost, how: `刷经验时戴 ${o.label}`, days: o.cost / perDay(k) })
        }
      }
      if (!cands.length) {
        why = "预算内没有可买的"
        break
      }
      // deaths phase: fewer deaths first, but profit (a smooth number) keeps the search moving when
      // single steps change rare deaths less than the noise; 1 death/hour ~ 10 days of today's profit
      const W = 10 * Math.max(ref, 10e6)
      const score = (st, base) => (phase === "deaths" ? (base.deaths - st.deaths) * W + (st.profit - base.profit) : st.profit - base.profit)
      const rate = c => c.gain / Math.max(c.days, 0.05)
      const tryCand = (c) => {
        const mem = config()
        if (c.kind === "charm") mem[c.member].levels = { ...mem[c.member].levels, ...c.levels }
        else applyState(mem, c.s, c.j)
        return mem
      }
      // rare deaths need longer runs to be told apart
      const rare = phase === "deaths" && curMain.deaths < 0.3
      const screen = rare ? main : quick
      let done = 0
      let short = cands
      if (rare && cands.length > 40) {
        // pre-screen on short runs, keep the 40 best
        const b = stat(await run(config(), goal, quick))
        const pre = await pool(cands, 48, async c => {
          const st = stat(await run(tryCand(c), goal, quick))
          api.progress(++done, cands.length, `试 ${fmtT(T)} 天 · 预筛`)
          return { c, g: score(st, b) }
        })
        short = pre.sort((x, y) => y.g - x.g).slice(0, 40).map(x => x.c)
        done = 0
      }
      const base0 = stat(await run(config(), goal, screen))
      const screenAll = async list => {
        done = 0
        return pool(list, 48, async c => {
          const st = stat(await run(tryCand(c), goal, screen))
          api.progress(++done, list.length, `试 ${fmtT(T)} 天 · 粗筛（${phase === "deaths" ? "减少死亡" : "提高利润"}）`)
          return { ...c, gain: score(st, base0) }
        })
      }
      let q = await screenAll(short)
      // the short pre-screen can miss the useful ones when deaths are rare: screen them all
      if (!q.some(c => c.gain > 0) && short !== cands) {
        short = cands
        q = await screenAll(cands)
      }
      const pos = q.filter(c => c.gain > 0)
      // review the best per day and the biggest effects (cheap winners are often noise)
      const top = [...new Set([...[...pos].sort((a, b) => rate(b) - rate(a)).slice(0, 8), ...[...pos].sort((a, b) => b.gain - a.gain).slice(0, 8)])]
      if (!top.length) {
        why = `粗筛没有能改善的（${short.length} 个候选）`
        break
      }
      // compare against the current config on the same seeds
      const fineCfg = screen === main ? long : main
      const base1 = stat(await run(config(), goal, fineCfg))
      done = 0
      const fine = await pool(top, 16, async c => {
        const st = stat(await run(tryCand(c), goal, fineCfg))
        api.progress(++done, top.length, `试 ${fmtT(T)} 天 · 复核`)
        return { ...c, st, gain: score(st, base1) }
      })
      let best = fine.filter(c => c.gain > 0).sort((a, b) => rate(b) - rate(a))[0]
      if (!best) {
        // no single step helps: try the biggest effects of different slots together
        const bundle = []
        const cost = members.map(() => 0)
        for (const c of [...fine].sort((a, b) => b.gain - a.gain)) {
          if (c.kind === "charm" || bundle.length >= 3 || bundle.some(x => x.s === c.s)) continue
          if (c.member >= 0 && spent[c.member] + cost[c.member] + c.cost > budgetAt(c.member, T)) continue
          bundle.push(c)
          if (c.member >= 0) cost[c.member] += c.cost
        }
        if (bundle.length < 2) {
          why = "复核后单项都没改善"
          break
        }
        const mem = config()
        for (const c of bundle) applyState(mem, c.s, c.j)
        const st = stat(await run(mem, goal, fineCfg))
        if (!(score(st, base1) > 0)) {
          why = "复核后单项和组合都没改善"
          break
        }
        for (const c of bundle.slice(0, -1)) {
          const sl = slots[c.s]
          log.push({ T, memberName: sl.memberName, what: `${sl.slotName}：${sl.states[held[c.s]].label} → ${sl.states[c.j].label}`, cost: c.cost, days: c.days, how: `${c.how}（组合）`, phase, after: st })
          held[c.s] = c.j
          if (c.member >= 0) spent[c.member] += c.cost
        }
        best = { ...bundle.at(-1), st, how: `${bundle.at(-1).how}（组合）` }
      }
      if (best.kind === "charm") {
        const k = best.member
        log.push({ T, memberName: name(k), what: `护符（刷经验时）：${charmOpts[k][charmSel[k]].label} → ${charmOpts[k][best.c].label}`, cost: best.cost, days: best.days, how: best.how, phase, after: best.st })
        spent[k] += best.cost
        charmSel[k] = best.c
        lv[k] = { ...lv[k], ...best.levels }
      } else {
        const sl = slots[best.s]
        log.push({ T, memberName: sl.memberName, what: `${sl.slotName}：${sl.states[held[best.s]].label} → ${sl.states[best.j].label}`, cost: best.cost, days: best.days, how: best.how, phase, after: best.st })
        held[best.s] = best.j
        if (best.member >= 0) spent[best.member] += best.cost
      }
      curMain = best.st
    }
    const last = checked || curMain
    api.log(`试 ${fmtT(T)} 天（可花 ${optimize.map(k => `${name(k)} ${M(budgetAt(k, T))}`).join("，")}${useLevels ? `；等级 ${optimize.map(k => SKILLS.filter(s => lv[k][s] > lv0[k][s]).map(s => `${SKILL_ZH[s]}+${lv[k][s] - lv0[k][s]}`).join("/") || "不变").join("，")}` : ""}）：${checked ? "能达标" : `达不到${why ? `（${why}）` : ""}`}，${log.length} 步，死亡 ${last.deaths.toFixed(3)}/小时，${M(last.profit)}/天`)
    return { T, checked, steps: log, held: [...held], lv: lv.map(x => ({ ...x })), spent: [...spent], charmSel: [...charmSel] }
  }
  const restore = a => {
    a.held.forEach((j, s) => { held[s] = j })
    a.lv.forEach((x, k) => { lv[k] = { ...x } })
    a.charmSel.forEach((c, k) => { charmSel[k] = c })
  }

  // shortest T: coarse grid, then bisection between the last miss and the first hit
  let hit = null
  let lo = 0
  for (const T of params.timeGrid || [0, 7, 30, 90, 180]) {
    const a = await attempt(T)
    if (a.checked) {
      hit = a
      break
    }
    lo = T
  }
  if (hit && hit.T > 0) {
    let hiT = hit.T
    let loT = lo === hit.T ? 0 : lo
    while (hiT - loT > Math.max(1, hiT * 0.08)) {
      const mid = (loT + hiT) / 2
      const a = await attempt(mid)
      if (a.checked) {
        hit = a
        hiT = mid
      } else loT = mid
    }
  }
  if (hit) restore(hit)
  const steps = hit?.steps || []
  const checked = hit?.checked || null

  let cur = checked || stat(await run(config(), goal, long))
  const removed = []
  if (checked) {
    await tuneConsumables("达标后", async () => {
      const st = stat(await run(config(), goal, long))
      if (ok(st)) cur = st
      return ok(st)
    })
    // shorten the time: drop gear that is not needed and lower levels as far as the goal allows,
    // the item that sets the finishing time first
    const gearDays = s => (slots[s].guild ? 0 : Math.max(0, pay[s][0][held[s]].cost) / perDay(slots[s].member))
    const undo = [
      ...held.map((j, s) => ({ j, s })).filter(x => x.j).map(({ s }) => ({ kind: "gear", s, days: gearDays(s) })),
      ...optimize.flatMap(k => SKILLS.filter(s => lv[k][s] > lv0[k][s]).map(s => ({ kind: "level", k, s, days: levelDays(k, s, lv[k][s]) }))),
    ].sort((a, b) => b.days - a.days)
    const test = async () => {
      const st = stat(await run(config(), goal, long))
      if (ok(st)) cur = st
      return ok(st)
    }
    for (const u of undo) {
      if (api.signal.aborted) throw new Error("cancelled")
      if (u.kind === "gear") {
        const keep = held[u.s]
        held[u.s] = 0
        if (await test()) removed.push(`${slots[u.s].memberName} ${slots[u.s].slotName}`)
        else held[u.s] = keep
      } else {
        // lowest level that still reaches the goal (binary search)
        let lo = lv0[u.k][u.s]
        let hi = lv[u.k][u.s]
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2)
          lv[u.k][u.s] = mid
          if (await test()) hi = mid
          else lo = mid + 1
        }
        lv[u.k][u.s] = hi
      }
      api.progress(undo.indexOf(u) + 1, undo.length, "精简")
    }
    cur = stat(await run(config(), goal, long))
  }

  // what to do, per member: gear straight from the original state, levels from now
  const perMember = members.map((_, k) => ({ name: name(k), cost: 0, cash: budget[k], income: income[k], levelDays: 0 }))
  const gearCost = members.map(() => 0)
  held.forEach((j, s) => {
    if (j && !slots[s].guild) gearCost[slots[s].member] += pay[s][0][j].cost
  })
  // the charm to farm the needed levels with: the one that finishes first (levels vs saving up)
  for (const k of optimize) {
    if (!charmOpts[k]) continue
    const need = SKILLS.filter(sk => lv[k][sk] > lv0[k][sk])
    let bestC = 0
    let bestDays = INF
    charmOpts[k].forEach((o, c) => {
      const lvDays = Math.max(0, ...need.map(sk => levelDays(k, sk, lv[k][sk], c)))
      const cost = gearCost[k] + o.cost
      const save = cost <= budget[k] ? 0 : income[k] > 0 ? (cost - budget[k]) / income[k] : INF
      const d = Math.max(lvDays, save)
      if (d < bestDays - 1e-9 || (Math.abs(d - bestDays) <= 1e-9 && o.cost < charmOpts[k][bestC].cost)) {
        bestDays = d
        bestC = c
      }
    })
    charmSel[k] = need.length ? bestC : 0
  }
  const changes = []
  held.forEach((j, s) => {
    if (!j) return
    const sl = slots[s]
    const t = pay[s][0][j]
    if (sl.guild) return changes.push({ kind: "guild", memberName: sl.memberName, slotName: sl.slotName, from: sl.states[0].label, to: sl.states[j].label, cost: 0, how: t.how })
    perMember[sl.member].cost += t.cost
    changes.push({ kind: "gear", memberName: sl.memberName, slotName: sl.slotName, from: sl.states[0].label, to: sl.states[j].label, cost: t.cost, how: t.how })
  })
  members.forEach((_, k) => {
    const o = charmOpts[k]?.[charmSel[k]]
    if (o && !o.current) {
      perMember[k].cost += o.cost
      changes.push({ kind: "charm", memberName: name(k), slotName: "护符（刷经验时）", from: charmOpts[k][0].label, to: o.label, cost: o.cost, how: "买来戴着在现在的地方刷经验，练到需要的等级（到目标区域后可以换回）" })
    }
    perMember[k].charm = o ? o.label : null
  })
  members.forEach((_, k) => SKILLS.forEach(s => {
    if (lv[k][s] <= lv0[k][s]) return
    const d = levelDays(k, s, lv[k][s])
    perMember[k].levelDays = Math.max(perMember[k].levelDays, d)
    changes.push({ kind: "level", memberName: name(k), slotName: SKILL_ZH[s], from: `Lv.${lv0[k][s]}`, to: `Lv.${lv[k][s]}`, cost: 0, how: `现在的地方刷 ${d.toFixed(1)} 天（${M(rateOf(k, s))} 经验/天${charmOpts[k] && !charmOpts[k][charmSel[k]].current ? `，戴${charmOpts[k][charmSel[k]].label}` : ""}）`, days: d })
  }))
  for (const p of perMember) {
    p.saveDays = p.cost <= p.cash ? 0 : p.income > 0 ? (p.cost - p.cash) / p.income : null
    p.days = p.saveDays == null ? null : Math.max(p.saveDays, p.levelDays)
  }
  const reached = ok(cur)
  const readyDays = perMember.some(p => p.days == null) ? null : Math.max(0, ...perMember.map(p => p.days))
  api.log(reached
    ? `达标：目标 ${M(cur.profit)}/天（现在 ${M(ref)}/天），死亡 ${cur.deaths.toFixed(3)}/小时；共 ${changes.length} 项，约 ${readyDays == null ? "?" : readyDays.toFixed(1)} 天能全部做完`
    : `没能达标：目标 ${M(cur.profit)}/天（现在 ${M(ref)}/天），死亡 ${cur.deaths.toFixed(3)}/小时`)
  const levelOptions = members.flatMap((c, k) => SKILLS.filter(s => now.players[k].xp[s] > 0).map(s => ({
    memberName: name(k), skill: SKILL_ZH[s], level: lv0[k][s], perDay: now.players[k].xp[s], days1: levelDays(k, s, lv0[k][s] + 1, 0), days5: levelDays(k, s, lv0[k][s] + 5, 0),
    ...(() => {
      if (!charmOpts[k]) return {}
      let c = 0
      charmOpts[k].forEach((o, i) => { if (o.rates[s] > charmOpts[k][c].rates[s]) c = i })
      return { bestCharm: charmOpts[k][c].label, bestPerDay: charmOpts[k][c].rates[s], best1: levelDays(k, s, lv0[k][s] + 1, c), best5: levelDays(k, s, lv0[k][s] + 5, c) }
    })(),
  })))
  return {
    levelOptions, reached, now, start, final: cur, ref, maxDeaths, perMember, changes, removed, readyDays,
    consumableChanges: consumableChanges.map(c => ({ when: c.when, memberName: c.memberName, what: c.what, from: c.from, to: c.to, kind: c.kind, slot: c.slot })),
    steps: steps.map(x => ({ T: x.T, memberName: x.memberName, what: x.what, cost: x.cost, days: x.days, how: x.how, phase: x.phase, deaths: x.after.deaths, profit: x.after.profit })),
    members: config(), names: members.map((_, k) => name(k)),
  }
}

function pickItems(map) {
  return Object.fromEntries(Object.entries(map || {}).filter(([k]) => k.startsWith("/items/")))
}
