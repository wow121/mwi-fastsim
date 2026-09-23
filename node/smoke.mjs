// Smoke test of the app API against a running server: state, options, simulate, and each job
// type with tiny settings.   node smoke.mjs [http://127.0.0.1:8765]
const base = process.argv[2] || "http://127.0.0.1:8765"
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(`${method} ${p}: ${j.error || r.status}`)
  return j
}
const out = (...a) => process.stdout.write(a.join(" ") + "\n")

const st = await call("GET", "/api/state")
out("engine", JSON.stringify(st.engine), "members", st.team.members.length)
const opts = await call("GET", "/api/options")
out("options: zones", opts.zones.length, "abilities", opts.abilities.length, "slots", Object.keys(opts.equipment).join(","))
const members = st.team.members.filter(p => st.team.selected.includes(String(p.id)))
const target = { kind: "zone", zoneHrid: "/actions/combat/sorcerers_tower", difficultyTier: 0 }
const extra = { mooPass: true, comExp: 10, comDrop: 10 }
let t = Date.now()
const sim = await call("POST", "/api/simulate", { members, target, hours: 24, seeds: 4, extra })
out(`simulate 4x24h in ${Date.now() - t}ms: profit/day ${(sim.mean.profitPerHour * 24 / 1e6).toFixed(2)}M, xp/h ${Math.round(sim.mean.xpPerHour)}, deaths/h ${sim.mean.deathsPerHour.toFixed(2)}`)

const small = [{ hours: 1, seeds: 1, keep: 0.1, min: 4 }, { hours: 2, seeds: 2, keep: 2 }]
const jobsToRun = [
  ["zones", { members, extra, hours: 6, seeds: 1, targets: opts.zones.slice(0, 12).map(z => ({ kind: "zone", zoneHrid: z.hrid, difficultyTier: 0 })) }],
  ["upgrades", { members, target, extra, hours: 2, seeds: 2 }],
  ["consumables", { members, target, extra, rounds: 1 }],
  ["skills", { members, target, extra, rounds: 1, stages: small, tuneTriggers: true }],
]
for (const [type, params] of jobsToRun) {
  t = Date.now()
  const { id } = await call("POST", "/api/jobs", { type, params })
  let j
  for (;;) {
    await new Promise(r => setTimeout(r, 1000))
    j = await call("GET", `/api/jobs/${id}`)
    if (j.status !== "running") break
  }
  out(`job ${type}: ${j.status} in ${((Date.now() - t) / 1000).toFixed(1)}s ${j.error ? j.error.split("\n")[0] : ""}`)
  for (const l of j.log.slice(-6)) out("   ", l.msg)
  if (type === "upgrades" && j.result) for (const r of j.result.rows.slice(0, 5)) out("   ", r.memberName, r.label, `Δ${(r.dProfitPerDay / 1e6).toFixed(2)}M/天`, r.cost != null ? `cost ${(r.cost / 1e6).toFixed(0)}M` : "", r.paybackDays != null ? `回本 ${r.paybackDays.toFixed(1)} 天` : "")
  if (type === "zones" && j.result) for (const r of j.result.rows.slice(0, 5)) out("   ", r.name, r.metrics ? `${(r.metrics.profitPerHour * 24 / 1e6).toFixed(2)}M/天 xp/h ${Math.round(r.metrics.xpPerHour)}` : r.error)
}
