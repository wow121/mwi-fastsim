// Lists and names the web UI needs, from the engine's game data maps (Chinese names).
import { zh } from "./i18n.mjs"

const bySort = (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0) || String(a.name).localeCompare(String(b.name))

export function options(m, book) {
  const maps = m.$e
  const n = h => zh(maps, h)
  const items = Object.values(maps.itemDetailMap)
  const equipment = {}
  for (const it of items) {
    const t = it.equipmentDetail?.type
    if (it.categoryHrid !== "/item_categories/equipment" || !t) continue
    const slot = t === "/equipment_types/main_hand" || t === "/equipment_types/two_hand" ? "weapon" : t.replace("/equipment_types/", "")
    ;(equipment[slot] ||= []).push({ hrid: it.hrid, name: n(it.hrid), itemLevel: it.itemLevel ?? 0, sortIndex: it.sortIndex })
  }
  for (const l of Object.values(equipment)) l.sort(bySort)
  const consumables = cat => items
    .filter(i => i.categoryHrid === cat && i.consumableDetail?.cooldownDuration > 0)
    .map(i => ({ hrid: i.hrid, name: n(i.hrid), sortIndex: i.sortIndex, hp: i.consumableDetail.hitpointRestore || 0, mp: i.consumableDetail.manapointRestore || 0 }))
    .sort(bySort)
  const actions = Object.values(maps.actionDetailMap).filter(a => a.type === "/action_types/combat" && a.combatZoneInfo)
  const zone = a => ({ hrid: a.hrid, name: n(a.hrid), maxDifficulty: a.maxDifficulty ?? 0, sortIndex: a.sortIndex, isDungeon: !!a.combatZoneInfo.isDungeon })
  return {
    equipment,
    food: consumables("/item_categories/food"),
    drinks: consumables("/item_categories/drink"),
    abilities: Object.values(maps.abilityDetailMap).map(a => ({ hrid: a.hrid, name: n(a.hrid), isSpecial: !!a.isSpecialAbility, sortIndex: a.sortIndex, manaCost: a.manaCost })).sort(bySort),
    // group zones only (like the site's groupZoneHrids): nobody farms single-monster zones
    zones: actions.filter(a => !a.combatZoneInfo.isDungeon && Number(a.combatZoneInfo.fightInfo?.randomSpawnInfo?.maxSpawnCount || 0) > 1).map(zone).sort(bySort),
    dungeons: actions.filter(a => a.combatZoneInfo.isDungeon).map(zone).sort(bySort),
    labyrinths: Object.values(maps.combatMonsterDetailMap).filter(x => x.isLabyrinthMonster).map(x => ({ hrid: x.hrid, name: n(x.hrid) })),
    trigger: {
      dependencies: Object.values(maps.combatTriggerDependencyDetailMap).sort(bySort).map(d => ({ hrid: d.hrid, name: n(d.hrid), single: !!d.isSingleTarget })),
      conditions: Object.values(maps.combatTriggerConditionDetailMap).sort(bySort).map(c => ({ hrid: c.hrid, name: n(c.hrid), single: !!c.isSingleTarget, multi: !!c.isMultiTarget, comparators: c.allowedComparatorHrids || [] })),
      comparators: Object.values(maps.combatTriggerComparatorDetailMap).sort(bySort).map(c => ({ hrid: c.hrid, name: n(c.hrid), allowValue: !!c.allowValue })),
    },
    names: {
      items: Object.fromEntries(items.map(i => [i.hrid, n(i.hrid)])),
      abilities: Object.fromEntries(Object.values(maps.abilityDetailMap).map(a => [a.hrid, n(a.hrid)])),
      monsters: Object.fromEntries(Object.values(maps.combatMonsterDetailMap).map(x => [x.hrid, n(x.hrid)])),
      zones: Object.fromEntries(actions.map(a => [a.hrid, n(a.hrid)])),
    },
    houseRooms: Object.values(maps.houseRoomDetailMap || {}).map(h => ({ hrid: h.hrid, name: n(h.hrid) })),
    enhancementCap: (maps.enhancementLevelSuccessRateTable || []).length || 20,
    slotRequirements: maps.abilitySlotsLevelRequirementList || [],
    prices: book ? Object.fromEntries(Object.entries(book.table).filter(([, v]) => v.ask > 0 || v.bid > 0).map(([k, v]) => [k, [v.ask, v.bid]])) : {},
  }
}
