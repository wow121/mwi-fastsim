// Labyrinth loadouts for one character. For every labyrinth monster: the gear (from what the
// character owns) and abilities that clear the highest room level at a success rate of at least
// `threshold`, then single purchases that would raise that level further.
//
// A room is won when the monster dies within 120 s. The success rate at a room level is
// wins / ended rooms over a few long runs with fixed seeds (common random numbers), so it falls
// with the level and the highest level is found by a doubling + binary search. Candidates are
// screened by their success rate a little above the current best level, and only the best few
// get the exact search.
import { compilePayload } from "./engine-core.mjs"
import { buildPayload, EQUIPMENT_SLOTS } from "./model.mjs"
import { seedList } from "./evaluator.mjs"
import { pool } from "./search.mjs"
import { groups, memberPool, presetVariants } from "./skill-pools.mjs"
import { applyGroup } from "./opt-skills.mjs"
import { GearPrices, pricedBook } from "./opt-upgrades.mjs"
import { zh } from "./i18n.mjs"

const clone = v => JSON.parse(JSON.stringify(v))
const INF = Number.POSITIVE_INFINITY
const MAX_LEVEL = 1000
const CONCURRENCY = 32
const SLOT_ZH = { weapon: "武器", off_hand: "副手", head: "头部", body: "身体", legs: "腿部", hands: "手部", feet: "脚部", back: "背部", neck: "项链", earrings: "耳环", ring: "戒指", pouch: "袋子", charm: "护符", trinket: "饰品" }
const BUY_LEVELS = [0, 5, 8, 10, 12, 14]

/** Slot of an equipment item in the team config ("weapon" for main / two hand). */
function slotOf(maps, h) {
  const t = maps.itemDetailMap[h]?.equipmentDetail?.type || ""
  const s = t === "/equipment_types/main_hand" || t === "/equipment_types/two_hand" ? "weapon" : t.replace("/equipment_types/", "")
  return EQUIPMENT_SLOTS.includes(s) ? s : ""
}
const isTwoHand = (maps, h) => maps.itemDetailMap[h]?.equipmentDetail?.type === "/equipment_types/two_hand"

function meetsLevels(maps, cfg, h) {
  const req = maps.itemDetailMap[h]?.equipmentDetail?.levelRequirements || []
  return req.every(q => Number(cfg.levels?.[String(q.skillHrid).split("/").pop()] || 1) >= Number(q.level || 0))
}

/** cfg with `slot` set to (h, n); a two-handed weapon empties the off hand. */
function withItem(maps, cfg, slot, h, n) {
  const c = clone(cfg)
  c.equipment = { ...(c.equipment || {}), [slot]: { itemHrid: h, enhancementLevel: n } }
  if (slot === "weapon" && isTwoHand(maps, h)) c.equipment.off_hand = { itemHrid: "", enhancementLevel: 0 }
  return c
}
const sameItem = (e, h, n) => (e?.itemHrid || "") === h && Number(e?.enhancementLevel || 0) === n

class Lab {
  constructor(ev, params, api) {
    this.ev = ev
    this.api = api
    this.m = ev.ctx.m
    this.maps = this.m.$e
    this.extra = params.extra
    this.crates = params.crates || []
    this.threshold = Math.min(0.999, Math.max(0.5, Number(params.threshold || 0.95)))
    this.hours = Number(params.hours || 12)
    this.seeds = seedList(Number(params.seedBase || 31337), Number(params.seeds || 2))
    this.cache = new Map()
  }

  /** { attempts, wins, clearTime } summed over the seeds at one room level. */
  async rate(cfg, monster, level, { seeds = this.seeds, hours = this.hours } = {}) {
    const key = `${monster}|${level}|${hours}|${seeds.join(",")}|${JSON.stringify([cfg.equipment, cfg.abilities, cfg.triggerMap])}`
    if (this.cache.has(key)) return this.cache.get(key)
    if (this.api.signal?.aborted) throw new Error("cancelled")
    const target = { kind: "labyrinth", labyrinthHrid: monster, roomLevel: level, crates: this.crates }
    const runs = await Promise.all(seeds.map(async seed => {
      const payload = buildPayload(this.m, [cfg], target, { hours, seed, extra: this.extra })
      const out = await this.ev.ctx.rust.run(compilePayload(this.m, payload), { attacks: false })
      this.ev.sims++
      this.ev.simHours += hours
      return out.result
    }))
    const r = { attempts: 0, wins: 0, clearTime: 0 }
    for (const x of runs) {
      r.attempts += Number(x.labyrinthAttempts || 0)
      r.wins += Number(x.encounters || 0)
      r.clearTime += Number(x.labyrinthClearTime || 0)
    }
    r.p = r.attempts ? r.wins / r.attempts : 0
    r.avgClear = r.wins ? r.clearTime / r.wins / 1e9 : null
    if (this.cache.size > 20000) this.cache.clear()
    this.cache.set(key, r)
    return r
  }

  /** Highest room level with success rate >= threshold (0 if not even level 1), with its stats. */
  async maxLevel(cfg, monster, hint = 100) {
    const ok = async l => (await this.rate(cfg, monster, l)).p >= this.threshold
    let lo = 0
    let hi = null
    let probe = Math.max(1, Math.round(hint))
    if (await ok(probe)) {
      lo = probe
      for (let step = Math.max(4, Math.round(probe * 0.1)); ; step *= 2) {
        const next = Math.min(MAX_LEVEL, lo + step)
        if (next === lo) break
        if (await ok(next)) lo = next
        else {
          hi = next
          break
        }
      }
      if (hi === null) hi = MAX_LEVEL + 1
    } else {
      hi = probe
      for (let step = Math.max(4, Math.round(probe * 0.1)); ; step *= 2) {
        const next = Math.max(1, hi - step)
        if (await ok(next)) {
          lo = next
          break
        }
        hi = next
        if (next === 1) break
      }
    }
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (await ok(mid)) lo = mid
      else hi = mid
    }
    const at = lo > 0 ? await this.rate(cfg, monster, lo) : null
    const above = await this.rate(cfg, monster, lo + 1)
    return { level: lo, p: at?.p ?? 0, avgClear: at?.avgClear ?? null, pAbove: above.p }
  }

  /** Higher is better: the level, then the success rate one level above it. */
  static better(a, b) {
    return a.level - b.level || a.pAbove - b.pAbove
  }

  /**
   * Best of `cands` ([{ cfg, ...}]) against the incumbent `cur` ({ cfg, best }): screen at a level a
   * bit above the incumbent's, exact search for the top `keep`. Returns the winner or null.
   */
  async pick(cur, cands, monster, keep = 3) {
    if (!cands.length) return null
    const probe = cur.best.level + Math.max(2, Math.round(cur.best.level * 0.04))
    const screen = { seeds: this.seeds.slice(0, 1), hours: this.hours / 2 }
    const base = await this.rate(cur.cfg, monster, probe, screen)
    const scored = await pool(cands, CONCURRENCY, async c => ({ ...c, s: await this.rate(c.cfg, monster, probe, screen) }))
    const top = scored.filter(c => c.s.p > base.p).sort((a, b) => b.s.p - a.s.p).slice(0, keep)
    let win = null
    for (const c of top) {
      c.best = await this.maxLevel(c.cfg, monster, cur.best.level)
      if (Lab.better(c.best, (win || cur).best) > 0) win = c
    }
    return win
  }
}

/** Owned gear per slot: [{ h, n }], level requirements met. */
function ownedBySlot(maps, cfg) {
  const out = Object.fromEntries(EQUIPMENT_SLOTS.map(s => [s, []]))
  const add = (h, n) => {
    const s = slotOf(maps, h)
    if (!s || !meetsLevels(maps, cfg, h) || out[s].some(x => x.h === h && x.n === n)) return
    out[s].push({ h, n })
  }
  for (const e of cfg.ownedEquipment || []) add(e.itemHrid, Number(e.enhancementLevel || 0))
  for (const [s, e] of Object.entries(cfg.equipment || {})) if (e?.itemHrid && EQUIPMENT_SLOTS.includes(s)) add(e.itemHrid, Number(e.enhancementLevel || 0))
  return out
}

function describeCfg(m, cfg) {
  const maps = m.$e
  const equipment = EQUIPMENT_SLOTS.map(s => {
    const e = cfg.equipment?.[s]
    return { slot: s, slotName: SLOT_ZH[s], itemHrid: e?.itemHrid || "", name: e?.itemHrid ? zh(maps, e.itemHrid) : "—", enhancementLevel: Number(e?.enhancementLevel || 0) }
  })
  const abilities = (cfg.abilities || []).map(a => (a?.abilityHrid ? { hrid: a.abilityHrid, name: zh(maps, a.abilityHrid), level: a.level } : null))
  return { equipment, abilities }
}

/** Gear search over owned items: coordinate descent over slots. */
async function optimizeGear(lab, cur, monster, owned, label) {
  const maps = lab.maps
  let changed = false
  for (const slot of EQUIPMENT_SLOTS) {
    const now = cur.cfg.equipment?.[slot]
    if (slot === "off_hand" && isTwoHand(maps, cur.cfg.equipment?.weapon?.itemHrid)) continue
    const cands = owned[slot].filter(x => !sameItem(now, x.h, x.n)).map(x => ({ cfg: withItem(maps, cur.cfg, slot, x.h, x.n) }))
    if (slot === "weapon")
      for (const x of owned.off_hand) for (const c of cands.filter(c => !isTwoHand(maps, c.cfg.equipment.weapon.itemHrid) && !c.cfg.equipment.off_hand?.itemHrid))
        cands.push({ cfg: withItem(maps, c.cfg, "off_hand", x.h, x.n) })
    lab.api.progress(0, cands.length, `${label} · 装备 ${SLOT_ZH[slot]}`)
    const win = await lab.pick(cur, cands, monster)
    if (win) {
      cur = { cfg: win.cfg, best: win.best }
      changed = true
    }
  }
  return { cur, changed }
}

/** Ability search: every group of the class pool with the checked trigger presets. */
async function optimizeAbilities(lab, cur, monster, label) {
  const mp = memberPool(lab.m, cur.cfg)
  if (!mp.cls) return { cur, changed: false }
  const poolH = mp.pool.filter(p => p.learned).map(p => p.hrid)
  const levels = Object.fromEntries(mp.pool.map(p => [p.hrid, p.level]))
  const cands = []
  for (const g of groups(poolH, mp.slots, mp.cls))
    for (const v of presetVariants(lab.m, g, true)) cands.push({ cfg: applyGroup([cur.cfg], 0, g, v, levels).members[0] })
  lab.api.progress(0, cands.length, `${label} · 技能（${mp.className}，${cands.length} 个方案）`)
  const win = await lab.pick(cur, cands, monster, 4)
  return win ? { cur: { cfg: win.cfg, best: win.best }, changed: true } : { cur, changed: false }
}

/** Single purchases on top of `cur`: each slot, market items at a few enhancement levels. */
async function purchases(lab, cur, monster, gp, owned, label, maxSpend) {
  const maps = lab.maps
  const cands = []
  for (const h of Object.keys(maps.itemDetailMap)) {
    const slot = slotOf(maps, h)
    if (!slot || !meetsLevels(maps, cur.cfg, h)) continue
    if (slot === "off_hand" && isTwoHand(maps, cur.cfg.equipment?.weapon?.itemHrid)) continue
    let table
    try {
      table = gp.acq(h)
    } catch {
      continue
    }
    for (const n of BUY_LEVELS) {
      const cost = table?.[n]?.cost
      if (!(cost < INF) || cost > maxSpend || owned[slot].some(x => x.h === h && x.n === n)) continue
      cands.push({ cfg: withItem(maps, cur.cfg, slot, h, n), slot, h, n, cost, how: table[n].how })
    }
  }
  if (!cands.length) return []
  lab.api.progress(0, cands.length, `${label} · 可买装备（${cands.length} 件）`)
  const probe = cur.best.level + Math.max(2, Math.round(cur.best.level * 0.04))
  const screen = { seeds: lab.seeds.slice(0, 1), hours: lab.hours / 2 }
  const base = await lab.rate(cur.cfg, monster, probe, screen)
  let done = 0
  const scored = await pool(cands, CONCURRENCY, async c => {
    const s = await lab.rate(c.cfg, monster, probe, screen)
    lab.api.progress(++done, cands.length)
    return { ...c, s }
  })
  // per slot keep the few best by screened rate, then exact levels
  const bySlot = new Map()
  for (const c of scored.filter(c => c.s.p > base.p).sort((a, b) => b.s.p - a.s.p)) {
    const l = bySlot.get(c.slot) || []
    if (l.length < 3) l.push(c)
    bySlot.set(c.slot, l)
  }
  const out = []
  for (const c of [...bySlot.values()].flat()) {
    const best = await lab.maxLevel(c.cfg, monster, cur.best.level)
    if (best.level <= cur.best.level) continue
    out.push({ slot: c.slot, slotName: SLOT_ZH[c.slot], itemHrid: c.h, name: zh(maps, c.h), enhancementLevel: c.n, cost: c.cost, how: c.how, level: best.level, gain: best.level - cur.best.level, p: best.p })
  }
  // keep the cost / gain frontier: drop anything a cheaper option matches or beats
  out.sort((a, b) => a.cost - b.cost || b.gain - a.gain)
  const front = []
  for (const x of out) if (!front.some(f => f.gain >= x.gain)) front.push(x)
  return front.sort((a, b) => b.gain - a.gain || a.cost - b.cost)
}

/**
 * params: { member (config), monsters?: [hrid], threshold (0.95), crates: [hrid], extra,
 *           hours, seeds, buy (true), maxSpend, tax, buyPrice, sellPrice }
 */
export async function optimizeLabyrinth(ev, params, api) {
  const lab = new Lab(ev, params, api)
  const maps = lab.maps
  const member = clone(params.member)
  const all = Object.values(maps.combatMonsterDetailMap).filter(x => x.isLabyrinthMonster).map(x => x.hrid)
  const monsters = params.monsters?.length ? params.monsters.filter(h => all.includes(h)) : all
  const owned = ownedBySlot(maps, member)
  const nOwned = Object.values(owned).reduce((a, l) => a + l.length, 0)
  if (!member.ownedEquipment) api.log("没有读到背包（请更新油猴脚本后重新同步），只在身上穿的装备里选")
  api.log(`${member.name || "角色"}：可选装备 ${nOwned} 件，通关率阈值 ${(lab.threshold * 100).toFixed(0)}%`)
  const lu = member.labyrinthUpgrades
  api.log(lu ? `迷宫升级：攻速 ${lu.attackSpeed} · 施法 ${lu.castSpeed} · 伤害 ${lu.combatDamage} · 暴击 ${lu.criticalRate}` : "没有读到迷宫升级，按 0 级算")
  const gp = params.buy === false ? null : new GearPrices(maps, pricedBook(ev.ctx.book, params), Number.isFinite(Number(params.tax)) ? Number(params.tax) : 0.04)
  const maxSpend = Number(params.maxSpend) > 0 ? Number(params.maxSpend) : INF
  const results = []
  let hint = 100
  for (const [i, monster] of monsters.entries()) {
    const name = zh(maps, monster)
    const label = `${i + 1}/${monsters.length} ${name}`
    api.progress(0, 1, `${label} · 当前配置`)
    const current = await lab.maxLevel(member, monster, hint)
    let cur = { cfg: clone(member), best: current }
    for (let round = 0; round < 2; round++) {
      const g = await optimizeGear(lab, cur, monster, owned, label)
      const a = await optimizeAbilities(lab, g.cur, monster, label)
      cur = a.cur
      if (!g.changed && !a.changed) break
    }
    hint = cur.best.level || hint
    const buys = gp ? await purchases(lab, cur, monster, gp, owned, label, maxSpend) : []
    const r = {
      monster,
      name,
      current: { level: current.level, p: current.p, avgClear: current.avgClear },
      best: { level: cur.best.level, p: cur.best.p, avgClear: cur.best.avgClear, ...describeCfg(lab.m, cur.cfg) },
      triggerMap: cur.cfg.triggerMap,
      config: cur.cfg,
      purchases: buys.slice(0, 8),
    }
    results.push(r)
    api.log(`${name}：当前 ${current.level} 级 → 推荐 ${cur.best.level} 级${buys[0] ? `；买 ${buys[0].name} +${buys[0].enhancementLevel} 可到 ${buys[0].level} 级` : ""}`)
    api.partial({ results, threshold: lab.threshold })
  }
  api.log(`完成，共模拟 ${ev.sims} 次`)
  return { results, threshold: lab.threshold, memberName: member.name }
}
