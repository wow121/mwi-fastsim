// Request handling shared by the local server (server.mjs) and the browser build
// (web/src/local/api.js). `st` is the engine context: { m, book, ev }.
import { profit } from "./metrics.mjs"
import { seedList } from "./evaluator.mjs"
import { importTeam } from "./import.mjs"
import { memberPool, presets } from "./skill-pools.mjs"
import { zh } from "./i18n.mjs"
import { optimizeSkills } from "./opt-skills.mjs"
import { optimizeConsumables } from "./opt-consumables.mjs"
import { adviseUpgrades } from "./opt-upgrades.mjs"
import { planGoal } from "./opt-goal.mjs"
import { recommendZones, runQueue } from "./opt-zones.mjs"
import { gearCost } from "./gear-cost.mjs"

export { gearCost }

export const JOB_TYPES = {
  skills: { title: "整队技能与触发优化", run: optimizeSkills },
  consumables: { title: "药水触发优化", run: optimizeConsumables },
  upgrades: { title: "整队提升规划", run: adviseUpgrades },
  goal: { title: "目标区域提升", run: planGoal },
  zones: { title: "刷图推荐", run: recommendZones },
  queue: { title: "批量队列", run: runQueue },
}

export function targetOf(s = {}) {
  if (s.mode === "labyrinth") return { kind: "labyrinth", labyrinthHrid: s.labyrinthHrid, roomLevel: Number(s.roomLevel || 100), crates: [] }
  return { kind: "zone", zoneHrid: s.useDungeon ? s.dungeonHrid : s.zoneHrid, difficultyTier: Number(s.difficultyTier || 0) }
}

export function selectedMembers(team, ids) {
  const want = (ids?.length ? ids : team.selected || []).map(String)
  return want.map(id => team.members.find(p => String(p.id) === id)).filter(Boolean)
}

/** First group (multi-monster) zone, for when no target has been chosen yet. */
export function defaultZone(m) {
  return Object.values(m.$e.actionDetailMap)
    .filter(a => a.type === "/action_types/combat" && !a.combatZoneInfo?.isDungeon && Number(a.combatZoneInfo?.fightInfo?.randomSpawnInfo?.maxSpawnCount || 0) > 1)
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))[0]?.hrid
}

/** Team from the combat-sim site's "simulator" store (userscript "同步" on the site). */
export function teamFromSite(body) {
  const players = (body.store?.players || []).filter(pl => Object.values(pl.equipment || {}).some(e => e?.itemHrid))
  return {
    members: players,
    selected: players.filter(pl => pl.selected).map(pl => String(pl.id)),
    settings: body.store?.simulationSettings || {},
    syncedAt: Date.now(),
  }
}

/** Team from the game page's envelope (current character + teammates' shared profiles). */
export function teamFromGame(m, envelope, prev) {
  const { players, missing, problems } = importTeam(m, envelope)
  if (!players.length) throw new Error(`没有可导入的角色${problems.length ? `：${problems.join("；")}` : ""}`)
  const team = {
    members: players,
    selected: players.map(pl => String(pl.id)),
    settings: prev?.sample ? {} : prev?.settings || {},
    syncedAt: Date.now(),
    source: "game",
    missing,
    problems,
  }
  return { team, reply: { ok: true, members: players.length, names: players.map(pl => pl.name), missing, problems } }
}

export function skillPools(m, body) {
  return (body.members || []).map(c => {
    const mp = memberPool(m, c)
    return { ...mp, pool: mp.pool.map(a => ({ ...a, name: zh(m.$e, a.hrid), presets: presets(m, a.hrid).map(x => ({ label: x.label, checked: x.checked })) })) }
  })
}

/** /api/simulate: mean metrics over seeds + the first run's detail. */
export async function simulate(st, body) {
  const { members, target, hours = 24, seeds = 4, extra } = body
  const list = seedList(Number(body.seedBase || 20260923), seeds)
  const runs = await Promise.all(list.map((seed, i) => st.ev.runOnce(members, target, { hours, seed, extra, detail: i === 0 })))
  const per = runs.map(r => r.metrics)
  const avg = get => per.reduce((a, x) => a + get(x), 0) / per.length
  const first = runs[0].result
  return {
    mean: {
      xpPerHour: avg(x => x.xpPerHour),
      profitPerHour: avg(x => x.profitPerHour),
      profitMidpointPerHour: avg(x => x.profitMidpointPerHour),
      deathsPerHour: avg(x => x.deathsPerHour),
      encountersPerHour: avg(x => x.encountersPerHour),
      players: members.map((_, i) => Object.fromEntries(Object.keys(per[0].players[i]).map(k => [k, avg(x => x.players[i][k])]))),
    },
    detail: {
      result: first,
      players: members.map((_, i) => profit(st.book, first, `player${i + 1}`, { dropMode: "bid", consumableMode: "ask" })),
    },
  }
}

/** /api/jobs* routes; returns undefined when the path is not a jobs route. */
export function jobRoutes(jobs, st, method, p, body) {
  if (p === "/api/jobs" && method === "GET") return jobs.list()
  if (p === "/api/jobs" && method === "POST") {
    const t = JOB_TYPES[body.type]
    if (!t) throw new Error(`unknown job type ${body.type}`)
    const j = jobs.start(body.type, body.title || t.title, body.params, (params, a) => t.run(st.ev, params, a))
    return { id: j.id }
  }
  const jm = /^\/api\/jobs\/(\w+)(\/cancel)?$/.exec(p)
  if (!jm) return undefined
  if (method === "GET") {
    const j = jobs.get(jm[1])
    if (!j) throw new Error("no such job")
    const { controller, ...rest } = j
    return rest
  }
  if (method === "POST" && jm[2]) return { ok: jobs.cancel(jm[1]) }
  if (method === "DELETE") return { ok: jobs.remove(jm[1]) }
  return undefined
}
