// Lists and names the web UI needs, from the engine's game data maps (Chinese names).
import { guildBuffName, zh } from "./i18n.mjs"
import { getLang } from "./lang.mjs"
import { COMBAT_SEALS } from "./game.mjs"
import { ORBS as TALISMAN_ITEMS } from "./opt-talisman.mjs"

const sealName = s => (getLang() === "en" ? s.replace(/^Scroll Of\s+/i, "") : s.replace(/卷轴$/, "")) // i18n-ok
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
  const zone = a => ({ hrid: a.hrid, name: n(a.hrid), maxDifficulty: a.maxDifficulty ?? 0, maxPartySize: a.maxPartySize || null, sortIndex: a.sortIndex, isDungeon: !!a.combatZoneInfo.isDungeon })
  return {
    equipment,
    food: consumables("/item_categories/food"),
    drinks: consumables("/item_categories/drink"),
    abilities: Object.values(maps.abilityDetailMap).map(a => ({ hrid: a.hrid, name: n(a.hrid), isSpecial: !!a.isSpecialAbility, sortIndex: a.sortIndex, manaCost: a.manaCost })).sort(bySort),
    // group zones only (like the site's groupZoneHrids): nobody farms single-monster zones
    zones: actions.filter(a => !a.combatZoneInfo.isDungeon && Number(a.combatZoneInfo.fightInfo?.randomSpawnInfo?.maxSpawnCount || 0) > 1).map(zone).sort(bySort),
    dungeons: actions.filter(a => a.combatZoneInfo.isDungeon).map(zone).sort(bySort),
    labyrinths: Object.values(maps.combatMonsterDetailMap).filter(x => x.isLabyrinthMonster).map(x => ({ hrid: x.hrid, name: n(x.hrid) })),
    labyrinthCrates: Object.keys(maps.labyrinthCrateDetailMap || {}).map(h => ({ hrid: h, name: n(h) })),
    // "战斗掉落 +15%": the item name without the trailing 卷轴 (English: without the leading "Scroll Of")
    seals: COMBAT_SEALS.map(x => ({ key: x.key, name: `${sealName(n(`/items/seal_of_${x.key}`))} +${Math.round((x.flatBoost || x.ratioBoost) * 100)}%` })),
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
    // combat rooms (levels / speeds / regen) first; the rest only add their global wisdom + rare find
    houseRooms: Object.values(maps.houseRoomDetailMap || {})
      .map(h => ({ hrid: h.hrid, name: n(h.hrid), sortIndex: h.sortIndex, combat: !!h.usableInActionTypeMap?.["/action_types/combat"], maxLevel: Math.max(0, ...Object.keys(h.upgradeCostsMap || {}).map(Number).filter(Number.isFinite)) || 8 }))
      .sort((a, b) => b.combat - a.combat || bySort(a, b)),
    // combat guild buffs: a member's level, capped by the guild's shrine
    guildBuffs: Object.values(maps.guildBuffDetailMap || {}).filter(g => g?.isCombat === true).sort(bySort).map(g => ({
      hrid: g.hrid, name: guildBuffName(maps, g.hrid), shrine: n(g.shrineHrid),
      maxLevel: (sh => Math.min(sh || 20, Math.max(0, ...Object.keys(g.levelCosts || {}).map(Number).filter(Number.isFinite)) || sh || 20))(Number(maps.guildShrineDetailMap?.[g.shrineHrid]?.maxLevel) || 0),
    })),
    // combat talisman modifiers (test-server data only so far): value of grade g = gradeValues[g - 1]
    talismanModifiers: Object.values(maps.talismanModifierDetailMap || {})
      .filter(d => d.talismanTypeHrid === "/talisman_types/combat")
      .sort(bySort)
      .map(d => ({ hrid: d.hrid, name: n(d.hrid), group: String(d.groupHrid || "").split("/").pop(), isPercent: !!d.isPercent, gradeValues: d.gradeValues || [], weight: Number(d.weight) || 0 })),
    // talisman orbs and cores: market price when there is one, else the shop sell price (a placeholder)
    talismanItems: Object.values(TALISMAN_ITEMS).filter(h => maps.itemDetailMap[h]).map(h => ({
      hrid: h, name: n(h), ask: Math.max(0, Number(book?.table?.[h]?.ask) || 0), sell: maps.itemDetailMap[h].sellPrice || 0,
    })),
    talismanMaxModifiers: Number(maps.talismanInfo?.maxModifierCount) || 4,
    // belts: talisman slots and power (power + bonus × enhancementBonus[level])
    belts: Object.fromEntries(items.filter(i => i.equipmentDetail?.type === "/equipment_types/belt").map(i => {
      const c = i.equipmentDetail.combatStats || {}
      return [i.hrid, { slots: c.talismanSlots || 0, power: c.talismanPower || 0, bonus: i.equipmentDetail.combatEnhancementBonuses?.talismanPower || 0 }]
    })),
    enhancementBonus: maps.enhancementLevelTotalBonusMultiplierTable || [],
    enhancementCap: (maps.enhancementLevelSuccessRateTable || []).length || 20,
    levelXp: maps.levelExperienceTable || [],
    slotRequirements: maps.abilitySlotsLevelRequirementList || [],
    prices: book ? Object.fromEntries(Object.entries(book.table).filter(([, v]) => v.ask > 0 || v.bid > 0).map(([k, v]) => [k, [v.ask, v.bid]])) : {},
  }
}
