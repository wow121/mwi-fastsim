// Runs the upgrade planner end to end on a private server instance.   node test-upgrades.mjs [budgetM]
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
  const t0 = Date.now()
  const { id } = await call("POST", "/api/jobs", { type: "upgrades", params: { members, target, extra: { mooPass: true, comExp: 20, comDrop: 20 }, hours: 12, seeds: 8, budgets: (process.argv[2] || "400,400,400").split(",").map(v => Number(v) * 1e6), horizons: [30, 60], tax: 0.05, keepEnd: process.argv[3] === "keep" } })
  let j
  do {
    await new Promise(r => setTimeout(r, 2000))
    try {
      j = await call("GET", `/api/jobs/${id}`)
    } catch (e) {
      console.log(`poll failed at ${((Date.now() - t0) / 1000).toFixed(0)}s: ${e.cause?.code || e.message}`)
      j = { status: "running" }
    }
  } while (j.status === "running")
  console.log(`status ${j.status} ${((Date.now() - t0) / 1000).toFixed(0)}s ${j.error || ""}`)
  for (const l of j.log) console.log(" log:", l.msg)
  const r = j.result
  if (r) {
    console.log(`\nhouse / guild rows:`)
    for (const x of [...r.rows.filter(x => x.slotName.startsWith("房子") && /食堂|图书馆|道场|健身房|军械库|射箭场|神秘/.test(x.label) && x.memberName === "法师1"), ...r.rows.filter(x => x.guild).slice(0, 3)]) console.log(`  ${x.memberName} ${x.from} -> ${x.label} [${x.how}] cost ${x.guild ? x.guildPoints + " pts" : M(x.cost)} dP ${M(x.dProfitPerDay)}/d net60 ${M(x.net[60])}`)
    console.log(`\ntop rows by 60d net:`)
    for (const x of r.rows.slice(0, 15)) console.log(`  ${x.memberName} ${x.from} -> ${x.label} [${x.how}] cost ${M(x.cost)} loss ${M(x.loss)} dP ${M(x.dProfitPerDay)}/d net30 ${M(x.net[30])} net60 ${M(x.net[60])}`)
    for (const p of r.plans) {
      console.log(`\nplan ${p.days}d gain ${M(p.gain)} ${p.perMember.map(x => `${x.name} ${M(x.startIncome)}->${M(x.income)}/d cash ${M(x.cash)}`).join("; ")}`)
      for (const x of p.steps) console.log(`  day ${x.day.toFixed(1)} ${x.memberName} ${x.from} -> ${x.to} [${x.how}] cost ${M(x.cost)} loss ${M(x.loss)} dP ${M(x.dProfitPerDay)} cash ${M(x.cashAfter)}`)
    }
  }
} catch (e) {
  console.log("ERROR", e.stack, e.cause)
} finally {
  srv.kill()
  process.exit(0)
}
