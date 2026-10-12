// Runs the stat value analysis end to end on a private server instance.
//   node test-statvalue.mjs [hours] [seeds]
import { spawn } from "node:child_process"
const port = 8798
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
  const { id } = await call("POST", "/api/jobs", { type: "statvalue", params: { members, target, extra: { mooPass: true, comExp: 20, comDrop: 20 }, hours: Number(process.argv[2] || 24), seeds: Number(process.argv[3] || 16) } })
  let j
  do {
    await new Promise(r => setTimeout(r, 2000))
    j = await call("GET", `/api/jobs/${id}`)
  } while (j.status === "running")
  console.log(`status ${j.status} ${((Date.now() - t0) / 1000).toFixed(0)}s ${j.error || ""}`)
  const r = j.result
  if (r) {
    console.log(`base ${M(r.base.profitPerHour * 24)}/d xp ${r.base.xpPerHour.toFixed(0)}/h deaths ${r.base.deathsPerHour.toFixed(2)}`)
    for (const x of r.rows) {
      const u = x.perUnit
      console.log(`  ${r.names[x.member]} ${x.label.padEnd(8)} per ${x.unit}: ${M(u.profitPerHour * 24)}/d ±${M(u.profitHalf * 24)}  xp ${u.xpPerHour.toFixed(0)} ±${u.xpHalf.toFixed(0)}  (step ${M(x.profit.mean * 24)}/d)`)
    }
    for (const e of r.enhancements)
      for (const it of e.items) console.log(`  ${r.names[e.member]} ${it.name} +${it.from}->+${it.to}: ${M(it.profitPerHour * 24)}/d xp ${it.xpPerHour.toFixed(0)} missing ${it.missing.join(",")}`)
  }
} catch (e) {
  console.log("ERROR", e.stack, e.cause)
} finally {
  srv.kill()
  process.exit(0)
}
