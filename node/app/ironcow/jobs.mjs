// Ironcow (铁牛) jobs and routes. The searches are the shared ones (successive halving, the skill
// and food optimizers); only the evaluator differs — see evaluator.mjs.
import { pool } from "../search.mjs"
import { seedList } from "../evaluator.mjs"
import { zh } from "../i18n.mjs"
import { optimizeSkills } from "../opt-skills.mjs"
import { optimizeConsumables } from "../opt-consumables.mjs"
import { IronEvaluator, IRONCOW_OBJECTIVES, normalizeIronCfg } from "./evaluator.mjs"
import { CraftTimes, LIFE_SKILLS, SKILL_NAMES } from "./craft.mjs"
import { ironcowFromGame } from "./import.mjs"

const combatConsumables = maps => Object.values(maps.itemDetailMap)
  .filter(i => (i.categoryHrid === "/item_categories/food" || i.categoryHrid === "/item_categories/drink")
    && i.consumableDetail?.cooldownDuration > 0 && i.consumableDetail?.usableInActionTypeMap?.["/action_types/combat"])
  .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))

/** params: { members, targets: [{kind:"zone", zoneHrid, difficultyTier}], hours, seeds, extra, ironcow } */
async function zones(ev0, params, api) {
  const ev = new IronEvaluator(ev0.ctx, params.ironcow)
  const hours = params.hours || 24
  const seeds = seedList(424242, params.seeds || 2)
  const { m } = ev.ctx
  let done = 0
  const rows = await pool(params.targets, 16, async (t) => {
    let r
    try {
      r = await ev.evaluate(params.members, t, { hours, seeds, extra: params.extra, signal: api.signal })
    } catch (e) {
      if (api.signal.aborted) throw e
      return { target: t, error: String(e.message || e) }
    }
    done++
    api.progress(done, params.targets.length, "模拟各区域")
    return { target: t, name: zh(m.$e, t.zoneHrid), isDungeon: !!m.$e.actionDetailMap[t.zoneHrid]?.combatZoneInfo?.isDungeon, value: r.value, metrics: r.mean }
  })
  rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
  return { rows, hours, seeds: seeds.length, objective: ev.metrics.cfg.objective }
}

/** params: opt-skills params + ironcow */
async function skills(ev0, params, api) {
  const ev = new IronEvaluator(ev0.ctx, params.ironcow)
  return { ...(await optimizeSkills(ev, { ...params, objective: ev.objective }, api)), ironcowObjective: ev.metrics.cfg.objective }
}

/** params: opt-consumables params + ironcow + craftableOnly (only items with no missing / locked inputs) */
async function consumables(ev0, params, api) {
  const ev = new IronEvaluator(ev0.ctx, params.ironcow)
  let allowItems
  if (params.craftableOnly) {
    // craftable by at least one member (each member makes their own food)
    allowItems = combatConsumables(ev.ctx.m.$e).map(i => i.hrid).filter(h => ev.metrics.crafts.some(ct => {
      const c = ct.of(h)
      return c.action && !c.missing.size && !c.locked.size
    }))
    api.log(`只用现在能手搓的：${allowItems.length} 种`)
  }
  return { ...(await optimizeConsumables(ev, { ...params, objective: ev.objective, allowItems }, api)), ironcowObjective: ev.metrics.cfg.objective }
}

export const IRONCOW_JOBS = {
  "ironcow-zones": { title: "铁牛 · 刷图推荐", run: zones },
  "ironcow-skills": { title: "铁牛 · 技能优化", run: skills },
  "ironcow-consumables": { title: "铁牛 · 食物饮料优化", run: consumables },
}

/** Hand-work time of every combat food / drink (and optional extra items) with its recipe tree. */
export function craftTable(m, body) {
  const cfg = normalizeIronCfg(body.ironcow)
  const ct = new CraftTimes(m.$e, cfg.crafts[0])
  const list = [...combatConsumables(m.$e).map(i => i.hrid), ...(body.items || [])]
  return {
    skills: LIFE_SKILLS.map(k => ({ key: k, name: SKILL_NAMES[k] })),
    objectives: IRONCOW_OBJECTIVES,
    rows: [...new Set(list)].map(h => {
      const c = ct.of(h)
      const it = m.$e.itemDetailMap[h]
      return {
        hrid: h,
        name: zh(m.$e, h),
        kind: it?.categoryHrid === "/item_categories/drink" ? "drink" : it?.categoryHrid === "/item_categories/food" ? "food" : "other",
        seconds: c.seconds,
        skill: c.skill,
        missing: [...c.missing].map(x => zh(m.$e, x)),
        locked: [...c.locked],
        tree: ct.tree(h),
      }
    }),
  }
}

export const EMPTY_IRONCOW_TEAM = { members: [], selected: [], syncedAt: 0 }

/**
 * /api/ironcow/* routes; resolves to undefined when the path is not one.
 * host: { load(), save(team) } for the ironcow team, applyGameData(initClientData) → engine context.
 */
export async function ironcowRoutes(st, method, p, body, host) {
  if (p === "/api/ironcow/craft" && method === "POST") return craftTable(st.m, body)
  if (p === "/api/ironcow/team" && method === "GET") return host.load()
  if (p === "/api/ironcow/team" && method === "PUT") {
    await host.save({ ...(await host.load()), ...body })
    return { ok: true }
  }
  if (p === "/api/ironcow/game" && method === "POST") {
    // from the ironcow userscript: the logged-in character (+ the game's initClientData)
    if (body.initClientData) st = await host.applyGameData(body.initClientData)
    const { team, reply } = ironcowFromGame(st.m, body.character, await host.load())
    await host.save(team)
    return reply
  }
  return undefined
}
