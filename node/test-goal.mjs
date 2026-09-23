// Runs the goal planner end to end on a private server instance.
//   node test-goal.mjs <zone name part> <tier> [budgets M, comma separated]
import { spawn } from "node:child_process"
const port = 8799
const base = `http://127.0.0.1:${port}`
const srv = spawn(process.execPath, ["server.mjs", "--port", String(port)], { stdio: ["ignore", "inherit", "inherit"] })
const call = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || r.status)
  return j
}
const M = v => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(1)}M`)
try {
  let st
  for (let i = 0; i < 120; i++) {
    try {
      st = await call("GET", "/api/state")
      if (st.engine) break
    } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  const o = await call("GET", "/api/options")
  const team = st.team
  const members = team.selected.map(id => team.members.find(p => String(p.id) === String(id))).filter(Boolean)
  const s = team.settings || {}
  const target = { kind: "zone", zoneHrid: (s.useDungeon ? s.dungeonHrid : s.zoneHrid) || o.zones[0].hrid, difficultyTier: Number(s.difficultyTier || 0) }
  const pick = [...o.zones, ...o.dungeons].filter(z => z.name.includes(process.argv[2] || "魔像") || z.hrid.includes(process.argv[2] || "golem"))
  console.log("zones:", pick.map(z => `${z.name} ${z.hrid} max ${z.maxDifficulty}`).join("; "))
  const goal = { kind: "zone", zoneHrid: pick[0].hrid, difficultyTier: Number(process.argv[3] || 4) }
  const timeGrid = process.argv[5] ? process.argv[5].split(",").map(Number) : undefined
  const t0 = Date.now()
  const { id } = await call("POST", "/api/jobs", { type: "goal", params: { members, goal, current: target, extra: { mooPass: true, comExp: 20, comDrop: 20 }, budgets: (process.argv[4] || "1000,1000,1000").split(",").map(v => Number(v) * 1e6), tax: 0.05, timeGrid } })
  let j
  do {
    await new Promise(r => setTimeout(r, 3000))
    try {
      j = await call("GET", `/api/jobs/${id}`)
    } catch (e) {
      j = { status: "running" }
    }
  } while (j.status === "running")
  console.log(`status ${j.status} ${((Date.now() - t0) / 1000).toFixed(0)}s ${j.error || ""}`)
  for (const l of j.log) console.log(" log:", l.msg)
  const r = j.result
  if (r) {
    for (const c of r.changes) console.log(`  ${c.memberName} ${c.slotName} ${c.from} -> ${c.to} [${c.how}] ${M(c.cost)}`)
    for (const c of r.consumableChanges) console.log(`  药品 ${c.when} ${c.memberName} ${c.kind}${c.slot + 1} ${c.what} ${c.from} -> ${c.to}`)
    for (const p of r.perMember) console.log(`  ${p.name}: cost ${M(p.cost)} save ${p.saveDays} level ${p.levelDays.toFixed(1)}d`)
    console.log(`  ready in ${r.readyDays} days; final ${M(r.final.profit)}/d deaths ${r.final.deaths}`)
  }
} catch (e) {
  console.log("ERROR", e.stack, e.cause)
} finally {
  srv.kill()
  process.exit(0)
}
