// Request handling shared by the local server (server.mjs) and the browser build
// (web/src/local/api.js). `st` is the engine context: { m, book, ev }.
import { profit } from "./metrics.mjs"
import { seedList, SPREAD_KEYS, spread } from "./evaluator.mjs"
import { importTeam } from "./import.mjs"
import { memberPool, presets } from "./skill-pools.mjs"
import { zh } from "./i18n.mjs"
import { SEP, t, tk } from "./lang.mjs"
import { optimizeSkills } from "./opt-skills.mjs"
import { optimizeConsumables } from "./opt-consumables.mjs"
import { adviseUpgrades } from "./opt-upgrades.mjs"
import { planGoal } from "./opt-goal.mjs"
import { recommendZones, runQueue } from "./opt-zones.mjs"
import { optimizeLabyrinth } from "./opt-labyrinth.mjs"
import { gearCost } from "./gear-cost.mjs"
import { statValue } from "./opt-statvalue.mjs"
import { scrollValue } from "./opt-scrolls.mjs"
import { planTalisman } from "./opt-talisman.mjs"
import { EMPTY_IRONCOW_TEAM, IRONCOW_JOBS, ironcowRoutes } from "./ironcow/jobs.mjs"
import { countRuns } from "./job-progress.mjs"

export { EMPTY_IRONCOW_TEAM, gearCost, ironcowRoutes }

export const JOB_TYPES = {
  skills: { title: tk("整队技能与触发优化"), run: optimizeSkills },
  consumables: { title: tk("药水触发优化"), run: optimizeConsumables },
  upgrades: { title: tk("整队提升规划"), run: adviseUpgrades },
  goal: { title: tk("目标区域提升"), run: planGoal },
  zones: { title: tk("刷图推荐"), run: recommendZones },
  queue: { title: tk("批量队列"), run: runQueue },
  labyrinth: { title: tk("迷宫配置推荐"), run: optimizeLabyrinth },
  statvalue: { title: tk("属性价值"), run: statValue },
  scrolls: { title: tk("卷轴价值"), run: scrollValue },
  talisman: { title: tk("符石洗练"), run: planTalisman },
  ...IRONCOW_JOBS,
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
  // Belt and talismans set by hand (test-server preview) survive a sync from a game without them:
  // a member whose data has no talismans keeps the previous belt / talismans of the same name.
  for (const pl of players) {
    const old = (prev?.members || []).find(o => o.name === pl.name)
    if (!pl.talismansFromGame && old && !pl.equipment?.belt?.itemHrid) {
      if (old.equipment?.belt?.itemHrid) pl.equipment.belt = { ...old.equipment.belt }
      if (Array.isArray(old.talismans)) pl.talismans = JSON.parse(JSON.stringify(old.talismans))
      if (Array.isArray(old.talismanLibrary) && !pl.talismanLibrary) pl.talismanLibrary = JSON.parse(JSON.stringify(old.talismanLibrary))
    }
    delete pl.talismansFromGame
  }
  if (!players.length) throw new Error(t("没有可导入的角色") + (problems.length ? t("：") + problems.join(SEP()) : ""))
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
      ci: spread(per, SPREAD_KEYS),
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
    const jt = JOB_TYPES[body.type]
    if (!jt) throw new Error(`unknown job type ${body.type}`)
    // prices pinned at the start: the market refresh replaces `st.book`, and a job's comparisons
    // must not mix two price lists. The job's own engine handle counts its simulated hours (progress).
    const j = jobs.start(body.type, body.title || jt.title, body.params, (params, a) => {
      const ev = Object.create(st.ev, { ctx: { value: { ...st.ev.ctx, rust: countRuns(st.ev.ctx.rust, a.work) } } })
      return jt.run(ev, params, a)
    })
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
