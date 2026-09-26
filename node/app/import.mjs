// Game data -> player configs. Port of the combat-sim site's import path (CombatHeader `hu`, `q0`
// current character, `U0` shared profile, `qr` normalization) applied to the envelope our
// userscript builds on the game page (same shape as the site's data bridge: members[]).
import { normalizeConditions } from "./model.mjs"

const LEVEL_KEYS = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]
const SLOT_KEYS = ["head", "body", "legs", "feet", "hands", "weapon", "off_hand", "pouch", "neck", "earrings", "ring", "back", "charm", "trinket"]
const NON_WEAPON = SLOT_KEYS.filter(s => s !== "weapon")
const WEAPON_LOCATIONS = new Set(["/item_locations/main_hand", "/item_locations/two_hand"])
const ABILITY_SLOTS = 5
const SPECIAL = 0
const FIRST_NORMAL = 1
const COMBAT = "/action_types/combat"
const ABILITY_ALIASES = {
  "/abilities/aqua_aura": "/abilities/mystic_aura",
  "/abilities/flame_aura": "/abilities/mystic_aura",
  "/abilities/sylvan_aura": "/abilities/mystic_aura",
  "/abilities/arcane_reflection": "/abilities/retribution",
}

const num = (e, t = 0) => (Number.isFinite(Number(e)) ? Number(e) : t)
const clone = v => JSON.parse(JSON.stringify(v))
const nonNeg = e => Math.max(0, Math.floor(num(e, 0)))
const alias = h => ABILITY_ALIASES[String(h || "")] || String(h || "")
const list = e => (Array.isArray(e) ? e : e && typeof e === "object" ? Object.values(e) : [])
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k)

/** `ar`: empty player config. */
export function emptyPlayer(id, maps) {
  return {
    id: String(id),
    name: `Player ${id}`,
    selected: Number(id) === 1,
    levels: Object.fromEntries(LEVEL_KEYS.map(k => [k, 1])),
    equipment: Object.fromEntries(SLOT_KEYS.map(k => [k, { itemHrid: "", enhancementLevel: 0 }])),
    food: ["", "", ""],
    drinks: ["", "", ""],
    abilities: Array.from({ length: 5 }, () => ({ abilityHrid: "", level: 1 })),
    abilityLevelMap: {},
    triggerMap: {},
    houseRooms: Object.fromEntries(Object.keys(maps.houseRoomDetailMap || {}).map(k => [k, 0])),
    guildBuffs: Object.fromEntries(combatGuildBuffs(maps).map(k => [k, 0])),
    achievements: {},
  }
}

function combatGuildBuffs(maps) {
  return Object.values(maps.guildBuffDetailMap || {})
    .filter(g => g?.isCombat === true && g.hrid)
    .sort((a, b) => num(a.sortIndex) - num(b.sortIndex))
    .map(g => g.hrid)
}

/** `VI` */
function guildBuffMaxLevel(maps, hrid) {
  const g = maps.guildBuffDetailMap?.[hrid]
  if (!g || g.isCombat !== true) return 0
  const shrine = num(maps.guildShrineDetailMap?.[g.shrineHrid]?.maxLevel, 0)
  const costs = Math.max(0, ...Object.keys(g.levelCosts || {}).map(k => num(k, 0)))
  return Math.max(0, Math.min(shrine || costs, costs || shrine))
}

/** `A5` */
function normalizeGuildBuffs(maps, source, base = {}) {
  const s = source && typeof source === "object" && !Array.isArray(source) ? source : {}
  return Object.fromEntries(combatGuildBuffs(maps).map(h => {
    const max = guildBuffMaxLevel(maps, h)
    const o = has(s, h) ? s[h] : base[h]
    const v = Math.floor(Number(o?.level ?? o))
    return [h, !Number.isFinite(v) || v <= 0 ? 0 : Math.min(v, Math.max(0, max))]
  }))
}

/** `vs`: item location hrid -> config slot key. */
function slotOf(maps, loc) {
  const t = String(loc || "").trim()
  if (!t) return ""
  const r = maps.itemLocationDetailMap?.[t]
  if (!r || String(r.type || "") !== "/item_location_types/equipment") return ""
  if (WEAPON_LOCATIONS.has(t)) return "weapon"
  if (!t.startsWith("/item_locations/")) return ""
  const n = t.slice("/item_locations/".length)
  return n === "trinket" || NON_WEAPON.includes(n) ? n : ""
}

/** `Cl` */
function skillKey(h) {
  const t = String(h || "").trim()
  if (!t.startsWith("/skills/")) return ""
  const r = t.slice(8)
  return r === "power" ? "melee" : LEVEL_KEYS.includes(r) ? r : ""
}

/** `P0` */
function abilityEntry(maps, e) {
  if (!e || typeof e !== "object") return null
  const h = alias(e.abilityHrid || e.ability?.abilityHrid || e.ability || "")
  if (!h) return null
  const slot = Math.floor(num(e.slotNumber ?? e.slot ?? e.slotIndex ?? e.position, NaN))
  return {
    abilityHrid: h,
    level: Math.max(1, Math.floor(num(e.level ?? e.abilityLevel, 1))),
    isSpecial: maps.abilityDetailMap?.[h]?.isSpecialAbility === true,
    slot,
    hasSlot: Number.isFinite(slot),
  }
}

/** `N0` */
function slotScheme(normals, specials) {
  const s = specials.map(a => a.slot).filter(Number.isFinite)
  if (s.some(a => a <= 0)) return "zero-based-all-slots"
  if (s.length > 0) return "one-based-all-slots"
  const n = normals.map(a => a.slot).filter(Number.isFinite)
  if (!n.length) return "one-based-standard-slots"
  const lo = Math.min(...n)
  const hi = Math.max(...n)
  return lo <= 0 ? (hi <= ABILITY_SLOTS - 2 ? "zero-based-standard-slots" : "zero-based-all-slots") : hi >= ABILITY_SLOTS || lo >= FIRST_NORMAL + 1 ? "one-based-all-slots" : "one-based-standard-slots"
}

/** `x0` */
function slotIndex(e, scheme) {
  if (!Number.isFinite(e)) return null
  if (scheme === "zero-based-all-slots") return e
  if (scheme === "zero-based-standard-slots") return e + 1
  if (scheme === "one-based-all-slots") return e - 1
  return e
}

/** `Fl`: equipped abilities -> 5 slots (0 = special). */
function equippedAbilities(maps, src) {
  const out = Array.from({ length: ABILITY_SLOTS }, () => ({ abilityHrid: "", level: 1 }))
  const all = list(src).map(e => abilityEntry(maps, e)).filter(Boolean)
  const specSlot = all.filter(a => a.isSpecial && a.hasSlot)
  const specFree = all.filter(a => a.isSpecial && !a.hasSlot)
  const normSlot = all.filter(a => !a.isSpecial && a.hasSlot)
  const normFree = all.filter(a => !a.isSpecial && !a.hasSlot)
  if (specSlot.length) out[SPECIAL] = { abilityHrid: specSlot.at(-1).abilityHrid, level: specSlot.at(-1).level }
  else if (specFree.length) out[SPECIAL] = { abilityHrid: specFree[0].abilityHrid, level: specFree[0].level }
  const scheme = slotScheme(normSlot, specSlot)
  for (const a of normSlot) {
    const i = slotIndex(a.slot, scheme)
    if (!Number.isFinite(i) || i < FIRST_NORMAL || i >= ABILITY_SLOTS) {
      normFree.push(a)
      continue
    }
    out[i] = { abilityHrid: a.abilityHrid, level: a.level }
  }
  let s = FIRST_NORMAL
  for (const a of normFree) {
    while (s < ABILITY_SLOTS && String(out[s]?.abilityHrid || "").trim()) s++
    if (s >= ABILITY_SLOTS) break
    out[s] = { abilityHrid: a.abilityHrid, level: a.level }
    s++
  }
  return out
}

/** `Pl`: learned ability levels. */
function abilityLevels(maps, ...sources) {
  const out = {}
  for (const src of sources)
    for (const i of list(src)) {
      const o = i?.currentAbility && typeof i.currentAbility === "object" ? i.currentAbility : i
      const h = alias(o?.abilityHrid || o?.hrid || o?.ability || "")
      if (!h || !maps.abilityDetailMap?.[h]) continue
      out[h] = Math.max(1, Math.floor(num(o?.level ?? o?.abilityLevel, 1)))
    }
  return out
}

/** `fu` */
function combatSlots(map) {
  const t = Array.isArray(map?.[COMBAT]) ? map[COMBAT] : []
  return [0, 1, 2].map(r => {
    const e = t[r]
    return !e ? "" : typeof e === "string" ? e : String(e.itemHrid || e.hrid || "")
  })
}

/** `T0` */
function equipmentFromItems(maps, items) {
  const out = Object.fromEntries(SLOT_KEYS.map(k => [k, { itemHrid: "", enhancementLevel: 0 }]))
  for (const n of list(items)) {
    const i = n?.currentItem && typeof n.currentItem === "object" ? n.currentItem : n?.item && typeof n.item === "object" ? n.item : n
    const loc = String(i?.itemLocationHrid || n?.itemLocationHrid || "").trim()
    const hrid = String(i?.itemHrid || i?.hrid || "").trim()
    if (!loc || !hrid) continue
    const s = slotOf(maps, loc)
    if (s) out[s] = { itemHrid: hrid, enhancementLevel: nonNeg(i?.enhancementLevel ?? n?.enhancementLevel) }
  }
  return out
}

/** `O0` / `H0` */
function triggerMapOf(m, e) {
  const out = {}
  for (const map of [e?.consumableCombatTriggersMap, e?.abilityCombatTriggersMap])
    if (map && typeof map === "object" && !Array.isArray(map))
      for (const [k, v] of Object.entries(map)) {
        const h = String(k || "").trim()
        if (h) out[h] = normalizeConditions(m, list(v))
      }
  return out
}

/** `xl` */
function houseRooms(e, base) {
  if (!has(e, "characterHouseRoomMap") && !has(e, "houseRooms")) return undefined
  const src = e.characterHouseRoomMap && typeof e.characterHouseRoomMap === "object" ? e.characterHouseRoomMap : e.houseRooms && typeof e.houseRooms === "object" ? e.houseRooms : {}
  const out = base?.houseRooms && typeof base.houseRooms === "object" ? clone(base.houseRooms) : {}
  for (const k of Object.keys(out)) out[k] = 0
  for (const [k, a] of Object.entries(src)) {
    const h = String(a?.houseRoomHrid || a?.roomHrid || a?.hrid || k || "").trim()
    if (h) out[h] = Math.max(0, Math.floor(num(a?.level ?? a, 0)))
  }
  return out
}

/** `Bl` */
function achievements(e) {
  if (!has(e, "characterAchievements") && !has(e, "achievements")) return undefined
  const done = a => a === true || a?.isCompleted === true || a?.completed === true
  if (Array.isArray(e.characterAchievements)) {
    const r = {}
    for (const n of e.characterAchievements) {
      const h = String(n?.achievementHrid || "").trim()
      if (h && n?.isCompleted === true) r[h] = true
    }
    return r
  }
  const src = e.characterAchievements && typeof e.characterAchievements === "object" ? e.characterAchievements : e.achievements && typeof e.achievements === "object" ? e.achievements : null
  if (!src) return {}
  const entries = Object.entries(src)
  if (src === e.achievements && entries.every(([k]) => String(k || "").trim().startsWith("/achievements/"))) return clone(src)
  const r = {}
  for (const [k, a] of entries) {
    const h = String(a?.achievementHrid || a?.hrid || k || "").trim()
    if (h && done(a)) r[h] = true
  }
  return r
}

/** `Il` */
function guildBuffs(maps, e) {
  if (!has(e, "characterGuildBuffMap") || !has(e, "guildBuildingLevelMap")) return undefined
  const n = e.characterGuildBuffMap
  const b = e.guildBuildingLevelMap
  const lv = {}
  const entries = Array.isArray(n) ? n.map((s, l) => [String(l), s]) : Object.entries(n && typeof n === "object" ? n : {})
  for (const [k, l] of entries) {
    const h = String(l?.guildBuffHrid || l?.hrid || k || "").trim()
    if (h) lv[h] = Math.max(0, Math.floor(num(l?.level ?? l, 0)))
  }
  const out = {}
  for (const h of combatGuildBuffs(maps)) {
    const g = maps.guildBuffDetailMap[h]
    const f = b && typeof b === "object" ? b[g.shrineHrid] : 0
    const d = Math.max(0, Math.floor(num(f?.level ?? f, 0)))
    out[h] = Math.min(lv[h] || 0, d, guildBuffMaxLevel(maps, h))
  }
  return normalizeGuildBuffs(maps, out)
}

/** Levels of the guild's shrines per combat buff: a member's buff level can't go above them. */
function guildBuffCaps(maps, e) {
  if (!has(e, "guildBuildingLevelMap")) return undefined
  const b = e.guildBuildingLevelMap && typeof e.guildBuildingLevelMap === "object" ? e.guildBuildingLevelMap : {}
  return Object.fromEntries(combatGuildBuffs(maps).map(h => {
    const f = b[maps.guildBuffDetailMap[h].shrineHrid]
    return [h, Math.min(Math.max(0, Math.floor(num(f?.level ?? f, 0))), guildBuffMaxLevel(maps, h))]
  }))
}

/** `qr`: normalize a config against a base config. */
function normalizePlayer(m, e, base) {
  const maps = m.$e
  const n = clone(base)
  const i = e && typeof e === "object" ? e : {}
  const a = clone(n)
  a.id = String(i.id || n.id)
  a.name = String(i.name || n.name || `Player ${a.id}`)
  a.selected = i.selected == null ? n.selected : !!i.selected
  for (const f of LEVEL_KEYS) a.levels[f] = Math.max(1, Math.floor(num(i.levels?.[f], n.levels[f] || 1)))
  for (const f of SLOT_KEYS) {
    const d = i.equipment?.[f] ?? {}
    a.equipment[f] = { itemHrid: String(d.itemHrid || ""), enhancementLevel: nonNeg(d.enhancementLevel) }
  }
  a.food = [0, 1, 2].map(f => String(i.food?.[f] || ""))
  a.drinks = [0, 1, 2].map(f => String(i.drinks?.[f] || ""))
  a.abilities = [0, 1, 2, 3, 4].map(f => {
    const d = i.abilities?.[f] ?? {}
    return { abilityHrid: alias(d.abilityHrid || d.ability || ""), level: Math.max(1, Math.floor(num(d.level, 1))) }
  })
  a.abilityLevelMap = {}
  for (const [f, d] of Object.entries(i.abilityLevelMap && typeof i.abilityLevelMap === "object" ? i.abilityLevelMap : {})) {
    const h = alias(f)
    if (h && maps.abilityDetailMap?.[h]) a.abilityLevelMap[h] = Math.max(1, Math.floor(num(d, 1)))
  }
  for (const f of a.abilities) if (f.abilityHrid) a.abilityLevelMap[f.abilityHrid] = f.level
  const tm = i.triggerMap ?? n.triggerMap ?? {}
  a.triggerMap = Object.fromEntries(Object.entries(tm && typeof tm === "object" ? tm : {}).filter(([k]) => k).map(([k, v]) => [k, normalizeConditions(m, v)]))
  a.houseRooms = i.houseRooms && typeof i.houseRooms === "object" ? clone(i.houseRooms) : clone(n.houseRooms)
  a.guildBuffs = normalizeGuildBuffs(maps, i.guildBuffs, n.guildBuffs)
  const caps = i.guildBuffCaps ?? n.guildBuffCaps
  if (caps && typeof caps === "object") a.guildBuffCaps = normalizeGuildBuffs(maps, caps)
  else delete a.guildBuffCaps
  a.achievements = has(i, "achievements") ? (i.achievements && typeof i.achievements === "object" ? clone(i.achievements) : {}) : clone(n.achievements ?? {})
  return a
}

/** `q0`: the logged-in character (init_character_data). */
function fromCurrentCharacter(m, e, base) {
  const maps = m.$e
  const p = {
    id: base.id,
    name: String(e?.character?.name || base.name),
    levels: Object.fromEntries(LEVEL_KEYS.map(k => [k, 1])),
    equipment: equipmentFromItems(maps, e?.characterItems),
    food: combatSlots(e?.actionTypeFoodSlotsMap),
    drinks: combatSlots(e?.actionTypeDrinkSlotsMap),
    abilities: equippedAbilities(maps, e?.combatUnit?.combatAbilities),
    abilityLevelMap: abilityLevels(maps, e?.characterAbilities, e?.characterAbilityMap, e?.abilityMap, e?.combatAbilityMap, e?.combatUnit?.combatAbilities),
  }
  for (const f of list(e?.characterSkills)) {
    const k = skillKey(f?.skillHrid)
    if (k) p.levels[k] = Math.max(1, Math.floor(num(f?.level, 1)))
    if (k && Number.isFinite(Number(f?.experience))) (p.experience ||= {})[k] = Number(f.experience)
  }
  if (has(e, "consumableCombatTriggersMap") || has(e, "abilityCombatTriggersMap")) p.triggerMap = triggerMapOf(m, e)
  const h = houseRooms(e, base)
  if (h !== undefined) p.houseRooms = h
  const a = achievements(e)
  if (a !== undefined) p.achievements = a
  const g = guildBuffs(maps, e)
  if (g !== undefined) p.guildBuffs = g
  const gc = guildBuffCaps(maps, e)
  if (gc !== undefined) p.guildBuffCaps = gc
  return normalizePlayer(m, p, base)
}

/** `w0`: loadouts of a shared profile, most combat-relevant first. */
function loadouts(e) {
  const out = []
  const add = i => {
    if (i && typeof i === "object" && !out.includes(i)) out.push(i)
  }
  add(e?.currentCombatLoadout)
  add(e?.combatLoadout)
  add(e?.currentLoadout)
  add(e?.loadout)
  const score = i => (String(i?.actionTypeHrid || "") === COMBAT ? 8 : 0) + (i?.isDefault === true ? 4 : 0)
    + (Array.isArray(i?.foodItemHrids) ? 2 : 0) + (Array.isArray(i?.drinkItemHrids) ? 2 : 0)
    + (i?.consumableCombatTriggersMap && typeof i.consumableCombatTriggersMap === "object" ? 1 : 0)
    + (i?.abilityCombatTriggersMap && typeof i.abilityCombatTriggersMap === "object" ? 1 : 0)
  const map = e?.characterLoadoutMap && typeof e.characterLoadoutMap === "object"
    ? Object.values(e.characterLoadoutMap).filter(i => i && typeof i === "object").sort((a, b) => score(b) - score(a))
    : []
  for (const i of map) add(i)
  add(e)
  return out
}

/** `R0` / `k0` */
function sharedConsumables(maps, ls, kind) {
  const field = kind === "food" ? "foodItemHrids" : "drinkItemHrids"
  const cat = kind === "food" ? "/item_categories/food" : "/item_categories/drink"
  const alt = kind === "food" ? "foodHrids" : "drinkHrids"
  const byCat = v => {
    if (!Array.isArray(v)) return null
    const r = v.map(n => String(n?.itemHrid || n?.hrid || "").trim()).filter(h => h && maps.itemDetailMap?.[h]?.categoryHrid === cat).slice(0, 3)
    return r.length ? [0, 1, 2].map(i => String(r[i] || "")) : null
  }
  for (const o of ls)
    for (const f of [o => (Array.isArray(o?.[field]) ? o[field] : null), o => (Array.isArray(o?.combatConsumables?.[field]) ? o.combatConsumables[field] : null), o => byCat(o?.combatConsumables), o => (Array.isArray(o?.[alt]) ? o[alt] : null)]) {
      const v = f(o)
      if (v != null) return [0, 1, 2].map(i => String(v[i] || ""))
    }
  return ["", "", ""]
}

/** `$0` / `z0` */
function sharedTriggerMap(m, ls) {
  const out = {}
  let found = false
  for (let l = ls.length - 1; l >= 0; l--) {
    const c = ls[l]
    for (const d of [c?.consumableCombatTriggersMap, c?.abilityCombatTriggersMap, c?.triggerMap, c?.combatConsumables?.consumableCombatTriggersMap, c?.combatAbilities?.abilityCombatTriggersMap]) {
      if (!d || typeof d !== "object" || Array.isArray(d)) continue
      found = true
      for (const [k, v] of Object.entries(d)) {
        const h = String(k || "").trim()
        if (h) out[h] = normalizeConditions(m, list(v))
      }
    }
  }
  return found ? out : undefined
}

/** `U0`: a teammate's shared profile (profile_shared / partyInfo.sharableCharacterMap). */
function fromSharedProfile(m, payload, base) {
  const maps = m.$e
  const e = payload?.profile && typeof payload.profile === "object" && payload.profile.sharableCharacter ? payload.profile : payload
  const ls = loadouts(e)
  const p = {
    id: base.id,
    name: String(e?.sharableCharacter?.name || e?.name || base.name || `Player ${base.id}`),
    levels: Object.fromEntries(LEVEL_KEYS.map(k => [k, 1])),
    equipment: {},
    food: sharedConsumables(maps, ls, "food"),
    drinks: sharedConsumables(maps, ls, "drink"),
    abilities: equippedAbilities(maps, e?.equippedAbilities),
    abilityLevelMap: abilityLevels(maps, e?.characterAbilities, e?.characterAbilityMap, e?.abilityMap, e?.combatAbilityMap, e?.equippedAbilities),
  }
  for (const f of list(e?.characterSkills)) {
    const k = skillKey(f?.skillHrid)
    if (k) p.levels[k] = Math.max(1, Math.floor(num(f?.level, 1)))
    if (k && Number.isFinite(Number(f?.experience))) (p.experience ||= {})[k] = Number(f.experience)
  }
  for (const w of Object.values(e?.wearableItemMap && typeof e.wearableItemMap === "object" ? e.wearableItemMap : {})) {
    const it = w?.currentItem && typeof w.currentItem === "object" ? w.currentItem : w
    const loc = String(it?.itemLocationHrid || "").trim()
    const hrid = String(it?.itemHrid || "").trim()
    if (!loc || !hrid) continue
    const s = slotOf(maps, loc)
    if (s) p.equipment[s] = { itemHrid: hrid, enhancementLevel: nonNeg(it?.enhancementLevel) }
  }
  const tm = sharedTriggerMap(m, ls)
  if (tm !== undefined) p.triggerMap = tm
  const h = houseRooms(e, base)
  if (h !== undefined) p.houseRooms = h
  const a = achievements(e)
  if (a !== undefined) p.achievements = a
  const g = guildBuffs(maps, e)
  if (g !== undefined) p.guildBuffs = g
  const gc = guildBuffCaps(maps, e)
  if (gc !== undefined) p.guildBuffCaps = gc
  return normalizePlayer(m, p, base)
}

/** `hu` for the two bridge formats. */
export function importMember(m, payload, base) {
  const e = payload?.profile && typeof payload.profile === "object" && payload.profile.sharableCharacter ? payload.profile : payload
  if (e?.sharableCharacter && Array.isArray(e.characterSkills)) return fromSharedProfile(m, payload, base)
  if (e?.character && typeof e.character === "object" && Array.isArray(e.characterSkills)) return fromCurrentCharacter(m, e, base)
  throw new Error("无法识别的角色数据格式")
}

/**
 * The team envelope (members[] from the game page) -> player configs, like the site's
 * "从插件导入": members in party order, ids 1..5, all selected.
 */
export function importTeam(m, envelope) {
  const members = Array.isArray(envelope?.members) && envelope.members.length
    ? envelope.members
    : envelope?.currentCharacter ? [{ payload: envelope.currentCharacter, characterName: "" }] : []
  const players = []
  const problems = []
  members.slice(0, 5).forEach((mem, i) => {
    const base = emptyPlayer(i + 1, m.$e)
    try {
      const p = importMember(m, mem.payload || {}, base)
      p.selected = true
      if (mem.characterName) p.name = mem.characterName
      p.source = mem.isCurrent ? "current" : "shared"
      players.push(p)
    } catch (e) {
      problems.push(`${mem.characterName || `队员${i + 1}`}: ${e.message}`)
    }
  })
  return { players, missing: envelope?.missingMembers || [], problems }
}
