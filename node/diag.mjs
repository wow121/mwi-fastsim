// Diagnostic summary for comparing with the combat-sim site. Needs the server running.
//   node diag.mjs [http://127.0.0.1:8765]
// Prints: imported team (levels / gear / abilities / consumables / triggers), the target
// settings, per-player metrics over 4x24h, and the biggest revenue/expense items.
const base = process.argv[2] || "http://127.0.0.1:8765"
const call = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || r.status)
  return j
}
const st = await call("GET", "/api/state")
const o = await call("GET", "/api/options")
const n = h => o.names.items[h] || o.names.abilities[h] || h
const M = v => `${(v / 1e6).toFixed(2)}M`
const team = st.team
const members = team.selected.map(id => team.members.find(p => String(p.id) === String(id))).filter(Boolean)
console.log(`engine ${JSON.stringify(st.engine)} market ${st.market ? new Date(st.market.timestamp * 1000).toISOString() : "none"}`)
console.log(`source ${team.source || "site"} synced ${new Date(team.syncedAt).toISOString()} missing ${JSON.stringify(team.missing || [])} problems ${JSON.stringify(team.problems || [])}`)
console.log(`settings ${JSON.stringify(team.settings)}`)
for (const p of members) {
  console.log(`\n== ${p.name} (${p.source || ""}) levels ${JSON.stringify(p.levels)}`)
  console.log(`  gear: ${Object.entries(p.equipment).filter(([, e]) => e.itemHrid).map(([s, e]) => `${s}=${n(e.itemHrid)}+${e.enhancementLevel}`).join(", ")}`)
  console.log(`  abilities: ${p.abilities.map(a => (a.abilityHrid ? `${n(a.abilityHrid)} ${a.level}` : "-")).join(" / ")}`)
  console.log(`  food: ${p.food.map(n).join(" / ")}  drinks: ${p.drinks.map(n).join(" / ")}`)
  console.log(`  triggers: ${Object.entries(p.triggerMap || {}).map(([h, t]) => `${n(h)}=${t.length ? t.map(c => `${c.conditionHrid.split("/").pop()} ${c.comparatorHrid.split("/").pop()} ${c.value}`).join("&") : "always"}`).join("; ")}`)
  console.log(`  houseRooms: ${JSON.stringify(Object.fromEntries(Object.entries(p.houseRooms || {}).filter(([, v]) => v)))} guildBuffs: ${JSON.stringify(Object.fromEntries(Object.entries(p.guildBuffs || {}).filter(([, v]) => v)))} achievements: ${Object.keys(p.achievements || {}).length}`)
}
const s = team.settings || {}
const target = s.mode === "labyrinth"
  ? { kind: "labyrinth", labyrinthHrid: s.labyrinthHrid, roomLevel: Number(s.roomLevel || 100) }
  : { kind: "zone", zoneHrid: (s.useDungeon ? s.dungeonHrid : s.zoneHrid) || process.argv[3] || o.zones[0].hrid, difficultyTier: Number(s.difficultyTier || 0) }
const lv = (v, on) => (on === false ? 0 : Math.max(0, Math.min(20, Math.floor(Number.isFinite(Number(v)) ? Number(v) : 20))))
const extra = { mooPass: s.mooPass ?? true, comExp: lv(s.comExp, s.comExpEnabled), comDrop: lv(s.comDrop, s.comDropEnabled) }
console.log(`\ntarget ${JSON.stringify(target)} extra ${JSON.stringify(extra)}`)
const r = await call("POST", "/api/simulate", { members, target, extra, hours: 24, seeds: 4 })
console.log(`team: profit(low) ${M(r.mean.profitPerHour * 24)}/day, profit(mid) ${M(r.mean.profitMidpointPerHour * 24)}/day, xp ${Math.round(r.mean.xpPerHour)}/h, encounters ${r.mean.encountersPerHour.toFixed(1)}/h, deaths ${r.mean.deathsPerHour.toFixed(2)}/h`)
r.mean.players.forEach((p, i) => console.log(`  ${members[i].name}: revenue ${M(p.revenuePerHour * 24)} expenses ${M(p.expensesPerHour * 24)} profit(low) ${M(p.profitPerHour * 24)} profit(high) ${M(p.profitUpperPerHour * 24)} /day, xp ${Math.round(p.xpPerHour)}/h, deaths ${p.deathsPerHour.toFixed(2)}/h, out-of-mana ${(p.outOfManaTimeRatio * 100).toFixed(1)}%`))
const h = r.detail.result.simulatedTime / 3600e9
const p0 = r.detail.players[0]
console.log(`\n${members[0].name} top revenue (per day, first run):`)
for (const x of p0.revenueItems.slice(0, 10)) console.log(`  ${n(x.itemHrid)}: ${(x.amount / h * 24).toFixed(2)} x ${M(x.unitPrice)} = ${M(x.total / h * 24)}`)
console.log(`${members[0].name} expenses (per day):`)
for (const x of p0.expenseItems) console.log(`  ${n(x.itemHrid)}: ${(x.amount / h * 24).toFixed(1)} x ${(x.unitPrice / 1e3).toFixed(1)}K = ${M(x.total / h * 24)}`)
console.log(`\nkills/h: ${Object.entries(r.detail.result.deaths).filter(([k]) => !k.startsWith("player")).map(([k, v]) => `${o.names.monsters[k] || k} ${(v / h).toFixed(1)}`).join(", ")}`)
console.log(`dropRate ${JSON.stringify(r.detail.result.dropRateMultiplier)} rareFind ${JSON.stringify(r.detail.result.rareFindMultiplier)} qty ${JSON.stringify(r.detail.result.combatDropQuantity)} levelGap ${JSON.stringify(r.detail.result.debuffOnLevelGap)}`)
