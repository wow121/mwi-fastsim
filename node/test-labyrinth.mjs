// Runs the labyrinth recommender end to end on a private server instance.
//   node test-labyrinth.mjs [monster name part] [member index]
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
  const member = st.team.members[Number(process.argv[3] || 0)]
  // UPG=12 sets every labyrinth combat upgrade to that level
  if (process.env.UPG) member.labyrinthUpgrades = Object.fromEntries(["attackSpeed", "castSpeed", "combatDamage", "criticalRate"].map(k => [k, Number(process.env.UPG)]))
  // OWNED="/items/x:5,/items/y:0" adds fake inventory items
  if (process.env.OWNED) member.ownedEquipment = process.env.OWNED.split(",").map(x => ({ itemHrid: x.split(":")[0], enhancementLevel: Number(x.split(":")[1] || 0), count: 1 }))
  const part = process.argv[2] || ""
  const monsters = o.labyrinths.filter(z => z.name.includes(part) || z.hrid.includes(part)).map(z => z.hrid)
  console.log(`member ${member.name}; monsters ${monsters.length}; owned ${member.ownedEquipment?.length ?? "none"}`)
  const t0 = Date.now()
  const { id } = await call("POST", "/api/jobs", { type: "labyrinth", params: { member, monsters, extra: { mooPass: true, comExp: 20, comDrop: 20 }, threshold: 0.95, buy: process.env.BUY !== "0" } })
  let j
  let shown = 0
  do {
    await new Promise(r => setTimeout(r, 2000))
    j = await call("GET", `/api/jobs/${id}`)
    for (; shown < j.log.length; shown++) console.log("  " + j.log[shown].msg)
  } while (j.status === "running")
  console.log(`status ${j.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  if (j.error) console.log(j.error)
  for (const r of j.result?.results || []) {
    console.log(`${r.name}: ${r.current.level} -> ${r.best.level} (p ${(r.best.p * 100).toFixed(1)}%, ${r.best.avgClear?.toFixed(1)} s)`)
    console.log("  gear: " + r.best.equipment.filter(e => e.itemHrid).map(e => `${e.slotName} ${e.name}+${e.enhancementLevel}`).join(", "))
    console.log("  abilities: " + r.best.abilities.filter(Boolean).map(a => `${a.name} ${a.level}`).join(", "))
    for (const b of r.purchases) console.log(`  buy ${b.slotName} ${b.name} +${b.enhancementLevel} ${M(b.cost)} -> ${b.level} (+${b.gain})`)
  }
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  srv.kill()
}
