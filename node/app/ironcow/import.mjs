// Ironcow (铁牛) import: the logged-in character from the game page (the ironcow userscript), kept
// in its own team, apart from the market-mode team. Besides the combat setup (the shared importer)
// it reads what hand-crafting speed depends on, the way milkonomy's player buffs do:
// life skill levels, tools and worn gear (noncombat stats + enhancement), house rooms, the teas in
// each life skill's drink slots (× drink concentration) and community buffs.
import { emptyPlayer, importMember } from "../import.mjs"
import { LIFE_SKILLS, isGathering, normalizeCraftCfg } from "./craft.mjs"

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const list = v => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [])
const MAX_MEMBERS = 10

/** Hand-crafting config (craft.mjs cfg, % units) of a current-character payload. */
export function lifeFromCharacter(maps, e) {
  const cfg = { levels: {}, levelBonus: {}, speed: {}, efficiency: {}, artisan: {}, output: {} }
  for (const s of LIFE_SKILLS) for (const k of Object.keys(cfg)) cfg[k][s] = k === "levels" ? 1 : 0
  for (const f of list(e?.characterSkills)) {
    const s = String(f?.skillHrid || "").replace("/skills/", "")
    if (LIFE_SKILLS.includes(s)) cfg.levels[s] = Math.max(1, Math.floor(num(f.level, 1)))
  }

  // tools and worn gear
  const mult = maps.enhancementLevelTotalBonusMultiplierTable || []
  const stats = {}
  const items = []
  for (const it of list(e?.characterItems)) {
    const loc = String(it?.itemLocationHrid || "")
    if (!loc || loc === "/item_locations/inventory") continue
    const d = maps.itemDetailMap[it.itemHrid]?.equipmentDetail
    if (!d?.noncombatStats) continue
    const lv = Math.max(0, Math.floor(num(it.enhancementLevel)))
    items.push({ itemHrid: it.itemHrid, enhancementLevel: lv, location: loc.replace("/item_locations/", "") })
    for (const [k, v] of Object.entries(d.noncombatStats)) stats[k] = (stats[k] || 0) + num(v) + num(d.noncombatEnhancementBonuses?.[k]) * num(mult[lv])
  }
  const conc = 1 + (stats.drinkConcentration || 0)

  // buffs that apply to one action type
  const apply = (s, b, v) => {
    const t = String(b?.typeHrid || "")
    if (t === "/buff_types/efficiency") cfg.efficiency[s] += v * 100
    else if (t === "/buff_types/action_speed") cfg.speed[s] += v * 100
    else if (t === "/buff_types/artisan") cfg.artisan[s] += v * 100
    else if (t === "/buff_types/gourmet" && !isGathering(s)) cfg.output[s] += v * 100
    else if (t === "/buff_types/gathering" && isGathering(s)) cfg.output[s] += v * 100
    else if (t === `/buff_types/${s}_level`) cfg.levelBonus[s] += v
    else if (t === "/buff_types/action_level") cfg.levelBonus[s] -= v // artisan tea: recipes count as 5 levels higher
  }
  const teas = {}
  for (const s of LIFE_SKILLS) {
    cfg.speed[s] += ((stats[`${s}Speed`] || 0) + (stats.skillingSpeed || 0)) * 100
    cfg.efficiency[s] += ((stats[`${s}Efficiency`] || 0) + (stats.skillingEfficiency || 0)) * 100
    if (isGathering(s)) cfg.output[s] += (stats.gatheringQuantity || 0) * 100
    teas[s] = list(e?.actionTypeDrinkSlotsMap?.[`/action_types/${s}`]).map(d => (typeof d === "string" ? d : d?.itemHrid)).filter(Boolean)
    for (const h of teas[s]) for (const b of maps.itemDetailMap[h]?.consumableDetail?.buffs || []) {
      // the level debuff of artisan tea is not concentrated (as in milkonomy)
      apply(s, b, b.typeHrid === "/buff_types/action_level" ? num(b.flatBoost) : num(b.flatBoost) * conc)
    }
  }

  // house rooms: flat + per level after the first
  const houses = {}
  for (const [k, r] of Object.entries(e?.characterHouseRoomMap && typeof e.characterHouseRoomMap === "object" ? e.characterHouseRoomMap : {})) {
    const h = String(r?.houseRoomHrid || k)
    const lv = Math.floor(num(r?.level ?? r))
    const room = maps.houseRoomDetailMap?.[h]
    if (!room || lv <= 0) continue
    houses[h] = lv
    for (const at of Object.keys(room.usableInActionTypeMap || {})) {
      const s = at.replace("/action_types/", "")
      if (!LIFE_SKILLS.includes(s)) continue
      for (const b of room.actionBuffs || []) apply(s, b, num(b.flatBoost) + num(b.flatBoostLevelBonus) * (lv - 1))
    }
  }

  // community buffs
  for (const cb of list(e?.communityBuffs)) {
    const h = String(cb?.hrid || cb?.communityBuffTypeHrid || "")
    const lv = Math.floor(num(cb?.level))
    const det = maps.communityBuffTypeDetailMap?.[h]
    if (!det?.buff || lv <= 0) continue
    for (const at of Object.keys(det.usableInActionTypeMap || {})) {
      const s = at.replace("/action_types/", "")
      if (LIFE_SKILLS.includes(s)) apply(s, det.buff, num(det.buff.flatBoost) + num(det.buff.flatBoostLevelBonus) * (lv - 1))
    }
  }

  const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]))
  const out = normalizeCraftCfg(Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, round(v)])))
  return { ...out, source: { items, teas, houses, drinkConcentration: stats.drinkConcentration || 0 } }
}

/** Game mode of a current-character payload ("standard", "ironcow", ...; "" when unknown). */
export function gameModeOf(e) {
  return String(e?.character?.gameMode || e?.gameMode || "")
}

/**
 * Adds / replaces the captured character in the ironcow team (matched by name).
 * payload: the current-character payload (as the main userscript's compactProfile(…, true)).
 */
export function ironcowFromGame(m, payload, prev) {
  const team = prev && Array.isArray(prev.members) ? JSON.parse(JSON.stringify(prev)) : { members: [], selected: [] }
  const name = String(payload?.character?.name || "").trim()
  if (!name) throw new Error("没有读到角色名")
  const old = team.members.find(p => p.name === name)
  const id = old?.id ?? Math.max(0, ...team.members.map(p => Number(p.id) || 0)) + 1
  const p = importMember(m, payload, emptyPlayer(id, m.$e))
  p.name = name
  p.gameMode = gameModeOf(payload)
  p.life = lifeFromCharacter(m.$e, payload)
  p.syncedAt = Date.now()
  if (old) team.members[team.members.indexOf(old)] = p
  else {
    team.members.push(p)
    if (team.members.length > MAX_MEMBERS) team.members.shift()
    if ((team.selected || []).length < 5) team.selected = [...(team.selected || []), String(id)]
  }
  team.selected = (team.selected || []).filter(s => team.members.some(x => String(x.id) === s))
  team.syncedAt = Date.now()
  return { team, reply: { ok: true, name, gameMode: p.gameMode, members: team.members.length, replaced: !!old } }
}
