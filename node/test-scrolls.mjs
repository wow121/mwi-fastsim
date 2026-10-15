// Runs the scroll value analysis end to end on a private server instance, and checks that every
// member opening a scroll on their own equals the team-wide scroll.
//   node test-scrolls.mjs [hours] [seeds]
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
const M = v => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${(v / 1e3).toFixed(1)}K`)
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
  console.log("target", target, "members", members.map(m => m.name).join(", "))
  const t0 = Date.now()
  const extra = { mooPass: true, comExp: 20, comDrop: 20, seals: [] }
  const hours = Number(process.argv[2] || 24), seeds = Number(process.argv[3] || 16)
  const { id } = await call("POST", "/api/jobs", { type: "scrolls", params: { members, target, extra, hours, seeds, single: true } })
  let j
  do {
    await new Promise(r => setTimeout(r, 2000))
    j = await call("GET", `/api/jobs/${id}`)
  } while (j.status === "running")
  console.log(`status ${j.status} ${((Date.now() - t0) / 1000).toFixed(0)}s ${j.error || ""}`)
  const r = j.result
  if (r) {
    console.log(`base ${M(r.base.profitPerHour * 24)}/d xp ${r.base.xpPerHour.toFixed(0)}/h deaths ${r.base.deathsPerHour.toFixed(2)}`)
    for (const x of r.rows)
      console.log(`${x.key.padEnd(14)} ${x.member == null ? "team" : r.names[x.member]}`.padEnd(32), `profit ${M(x.profit.mean * 24)}/d ±${M((x.profit.high - x.profit.mean) * 24)}`, `cost ${x.costPerHour == null ? "-" : M(x.costPerHour * 24)}/d`, `per scroll ${M(x.perScroll.profit)} xp ${x.perScroll.xp.toFixed(0)}`, `xp ${x.xp.mean.toFixed(0)}/h`, `price ${x.price.ask}`)
  }
  // all members' own scroll == the team scroll
  const all = members.map(c => ({ ...c, seals: ["damage"] }))
  const a = await call("POST", "/api/simulate", { members: all, target, extra, hours: 6, seeds: 2 })
  const b = await call("POST", "/api/simulate", { members, target, extra: { ...extra, seals: ["damage"] }, hours: 6, seeds: 2 })
  const same = a.mean.profitPerHour === b.mean.profitPerHour && a.mean.xpPerHour === b.mean.xpPerHour
  console.log(`per-member == team: ${same ? "OK" : `MISMATCH ${a.mean.profitPerHour} vs ${b.mean.profitPerHour}`}`)
} catch (e) {
  console.log("ERROR", e.stack, e.cause)
} finally {
  srv.kill()
  process.exit(0)
}
