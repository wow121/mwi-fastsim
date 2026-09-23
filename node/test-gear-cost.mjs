// Gear cost API on a private server instance.   node test-gear-cost.mjs [item] [level] [heldItem] [heldLevel]
import { spawn } from "node:child_process"
const port = 8798
const srv = spawn(process.execPath, ["server.mjs", "--port", String(port)], { stdio: ["ignore", "ignore", "inherit"] })
const M = v => (v == null ? "—" : Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(1)}M`)
try {
  let r
  for (let i = 0; i < 60; i++) {
    await new Promise(res => setTimeout(res, 500))
    try {
      r = await fetch(`http://127.0.0.1:${port}/api/gear-cost`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hrid: process.argv[2] || "/items/blooming_trident_refined", level: Number(process.argv[3] || 13), tax: 0.05, held: process.argv[4] ? { hrid: process.argv[4], level: Number(process.argv[5] || 0) } : null }),
      }).then(x => x.json())
      break
    } catch {}
  }
  if (r.error) throw new Error(r.error)
  console.log(`${r.target.name} +${r.target.level}: market ${M(r.market.ask)}/${M(r.market.bid)} mirror ${M(r.mirrorPrice)} refine ${M(r.refine?.cost)} best=${r.best}`)
  for (const o of r.options) {
    console.log(`  ${o.label}: ${M(o.cost)} net ${M(o.net)} ${o.note || ""}`)
    if (o.key === r.best) for (const l of o.lines) console.log(`      ${l.text} ${M(l.cost)}`)
  }
  console.log("  table:", r.table.filter(t => t.n >= 8 && t.n <= 15).map(t => `+${t.n} base ${M(t.base?.cost)}(${t.base?.kind}) ref ${M(t.refined?.cost)}(${t.refined?.kind})`).join(" | "))
} catch (e) {
  console.log("ERROR", e.message)
} finally {
  srv.kill()
  process.exit(0)
}
