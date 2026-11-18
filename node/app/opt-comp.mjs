// Team composition ranking (配队排行): for a map, a team size and one gear budget for the whole team,
// which mix of roles (water / fire / nature mage, healer, sword, mace, spear, bow, crossbow, bulwark tank)
// earns the most, each with the gear the budget buys for it. The team is made up from scratch: every member has
// the combat levels set on the page, a fixed skill set and consumables of its role (house rooms at one level, all achievements or none; no guild buffs).
//
// Gear is chosen by a knapsack on a linear value model: what one point of each combat stat is worth to the
// team on this map (measured by simulation, as in 属性价值), so an item at +n is worth the sum of its stats ×
// their values; weapons and pouches (attack style, food / drink slots) are measured as whole items at +0
// with their enhancement linear on top. The knapsack picks, over all slots of all members, the gear with the
// most value whose total cost (cheapest way to get it: market, mirror, refining) fits in the budget.
//
//  0. rough kits from a stat prior (each stat in units of its typical size on an item), budget split evenly;
//     every composition is simulated briefly.
//  1. for each role, the stat values are measured inside the best composition with that role; each role
//     then has a kit for every budget, and a composition splits the budget among its members where the
//     values add most. All compositions are screened again (successive halving).
//  2. the best few are refined on their own: values measured in that team, knapsack over the whole team,
//     simulated, a few rounds (values averaged over the rounds), the best kit kept; then a long final run.
import { halving, pool } from "./search.mjs"
import { objectiveValue, seedList, vsBase, withRunCache } from "./evaluator.mjs"
import { PLAYER_KEYS } from "./engine-core.mjs"
import { GearPrices, pricedBook, SLOT_ZH } from "./opt-upgrades.mjs"
import { classOf } from "./skill-pools.mjs"
import { statGroups } from "./stat-groups.mjs"
import { maxPartySize } from "./model.mjs"
import { zh } from "./i18n.mjs"
import { joinList, t, tk } from "./lang.mjs"

const clone = v => JSON.parse(JSON.stringify(v))
const INF = Number.POSITIVE_INFINITY
const A = x => `/abilities/${x}`
const I = x => `/items/${x}`
const M = v => (Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(1)}M`)
const COMBAT = ["stamina", "intelligence", "attack", "melee", "defense", "ranged", "magic"]

const MAGE_DRINKS = ["ultra_magic_coffee", "ultra_attack_coffee", "lucky_coffee"]
const MELEE_DRINKS = ["ultra_melee_coffee", "ultra_attack_coffee", "lucky_coffee"]
const RANGED_DRINKS = ["ultra_ranged_coffee", "ultra_attack_coffee", "lucky_coffee"]
const FOOD = ["dragon_fruit_yogurt", "peach_gummy", "spaceberry_donut"]

/**
 * Roles: weapon class (skill-pools classOf), armour school, special-slot preference (an aura the team already
 * has is not taken twice: the same aura does not stack), the four abilities in cast order, drinks.
 */
export const BUILDS = {
  water: { cls: "water", name: tk("水法"), school: "magic", special: ["mystic_aura", "critical_aura", "speed_aura"], abilities: ["elemental_affinity", "frost_surge", "mana_spring", "water_strike"], drinks: MAGE_DRINKS },
  fire: { cls: "fire", name: tk("火法"), school: "magic", special: ["mystic_aura", "critical_aura", "speed_aura"], abilities: ["elemental_affinity", "smoke_burst", "firestorm", "fireball"], drinks: MAGE_DRINKS },
  nature: { cls: "nature", name: tk("自然法"), school: "magic", special: ["mystic_aura", "critical_aura", "speed_aura"], abilities: ["elemental_affinity", "toxic_pollen", "natures_veil", "entangle"], drinks: MAGE_DRINKS },
  healer: { cls: "nature", name: tk("自然奶"), school: "magic", heal: true, special: ["speed_aura", "mystic_aura", "critical_aura"], abilities: ["rejuvenate", "quick_aid", "elemental_affinity", "entangle"], drinks: ["ultra_magic_coffee", "ultra_intelligence_coffee", "lucky_coffee"] },
  sword: { cls: "sword", name: tk("剑"), school: "melee", special: ["fierce_aura", "critical_aura", "speed_aura"], abilities: ["berserk", "precision", "crippling_slash", "cleave"], drinks: MELEE_DRINKS },
  mace: { cls: "mace", name: tk("锤"), school: "melee", special: ["fierce_aura", "critical_aura", "speed_aura"], abilities: ["berserk", "precision", "fracturing_impact", "stunning_blow"], drinks: MELEE_DRINKS },
  spear: { cls: "spear", name: tk("枪"), school: "melee", special: ["fierce_aura", "critical_aura", "speed_aura"], abilities: ["berserk", "precision", "impale", "puncture"], drinks: MELEE_DRINKS },
  bow: { cls: "bow", name: tk("弓"), school: "ranged", special: ["critical_aura", "fierce_aura", "speed_aura"], abilities: ["rain_of_arrows", "penetrating_shot", "steady_shot", "pestilent_shot"], drinks: RANGED_DRINKS },
  crossbow: { cls: "crossbow", name: tk("弩"), school: "ranged", special: ["critical_aura", "fierce_aura", "speed_aura"], abilities: ["rain_of_arrows", "penetrating_shot", "steady_shot", "pestilent_shot"], drinks: RANGED_DRINKS },
  shield: { cls: "shield", name: tk("盾"), school: "tank", tank: true, special: ["guardian_aura", "invincible"], abilities: ["provoke", "taunt", "toughness", "spike_shell"], drinks: ["ultra_defense_coffee", "ultra_stamina_coffee", "lucky_coffee"] },
}
const AURAS = ["mystic_aura", "critical_aura", "speed_aura", "fierce_aura", "guardian_aura"]
// combat skills whose level requirement puts an armour piece into a school (others: no school, fits anyone)
const SCHOOL = { magic: ["magic"], melee: ["melee", "attack", "defense"], tank: ["defense", "melee", "attack"], ranged: ["ranged"] }
const SLOTS = ["weapon", "off_hand", "head", "body", "legs", "feet", "hands", "back", "neck", "earrings", "ring", "pouch"]
const ARMOR = new Set(["off_hand", "head", "body", "legs", "feet", "hands", "back"])
const EVASIONS = ["stabEvasion", "slashEvasion", "smashEvasion", "rangedEvasion", "magicEvasion"]
const RESISTANCES = ["waterResistance", "natureResistance", "fireResistance"]
const STYLES = ["stab", "slash", "smash", "ranged", "magic"]
const DTYPES = ["physical", "water", "nature", "fire"]
// stats that only move experience or task damage: no value for profit, and not measured
const NO_VALUE = new Set(["combatExperience", "staminaExperience", "intelligenceExperience", "attackExperience", "defenseExperience", "meleeExperience", "rangedExperience", "magicExperience", "taskDamage"])

/** Weapon style ("stab".."magic") and damage type of a role, from its weapons. */
function styleOf(maps, weapons) {
  const cs = maps.itemDetailMap[weapons[0]]?.equipmentDetail?.combatStats || {}
  return { style: String(cs.combatStyleHrids?.[0] || "/combat_styles/smash").split("/").pop(), dtype: String(cs.damageType || "/damage_types/physical").split("/").pop() }
}

/** Stats a member of this style can use (other styles' accuracy / damage, other damage types' amplify / penetration
 *  do nothing). */
function usable(style, dtype, k) {
  for (const s of STYLES) if (s !== style && (k === `${s}Accuracy` || k === `${s}Damage`)) return false
  for (const d of DTYPES) if (d !== dtype && (k === `${d}Amplify` || k === (d === "physical" ? "armorPenetration" : `${d}Penetration`))) return false
  return !NO_VALUE.has(k) && PLAYER_KEYS.includes(k)
}

const slotOf = type => {
  const s = String(type || "").split("/").pop()
  return s === "main_hand" || s === "two_hand" ? "weapon" : s
}

/**
 * Gear a role can wear with the given levels: per slot the items (level requirements on combat skills met;
 * requirements on other skills are not checked), each with its states (+n, cost = cheapest way to get it).
 */
function catalog(maps, gp, key, levels) {
  const b = BUILDS[key]
  const items = Object.values(maps.itemDetailMap).filter(it => it?.equipmentDetail?.combatStats && SLOTS.includes(slotOf(it.equipmentDetail.type)))
  const meets = it => (it.equipmentDetail.levelRequirements || []).every(r => {
    const s = String(r.skillHrid).split("/").pop()
    return !COMBAT.includes(s) || Number(levels[s] || 1) >= Number(r.level || 0)
  })
  const weapons = items.filter(it => slotOf(it.equipmentDetail.type) === "weapon" && classOf({ $e: maps }, it.hrid) === b.cls && meets(it))
    // gobo two-handers and the werewolf slasher are their class's odd ones out: mains with an off-hand only
    .filter(it => (["bow", "shield"].includes(b.cls) ? it.equipmentDetail.type.endsWith("two_hand") : it.equipmentDetail.type.endsWith("main_hand")))
  if (!weapons.length) return null
  const { style, dtype } = styleOf(maps, weapons.map(w => w.hrid))
  const twoHand = weapons[0].equipmentDetail.type.endsWith("two_hand")
  const school = SCHOOL[b.school]
  const fits = it => {
    const slot = slotOf(it.equipmentDetail.type)
    if (slot === "pouch") return true
    if (!Object.keys(it.equipmentDetail.combatStats).some(k => usable(style, dtype, k) && it.equipmentDetail.combatStats[k])) return false
    if (!ARMOR.has(slot)) return true
    const req = (it.equipmentDetail.levelRequirements || []).map(r => String(r.skillHrid).split("/").pop()).filter(s => COMBAT.includes(s))
    return !req.length || req.some(s => school.includes(s))
  }
  const slots = {}
  for (const slot of SLOTS) {
    if (slot === "off_hand" && twoHand) continue
    const list = slot === "weapon" ? weapons : items.filter(it => slotOf(it.equipmentDetail.type) === slot && meets(it) && fits(it))
    const states = []
    for (const it of list) {
      const acq = gp.acq(it.hrid)
      let last = INF
      // from the top down: a level that costs at least as much as a higher one is never worth taking
      const own = []
      for (let n = acq.length - 1; n >= 0; n--) {
        const c = acq[n].cost
        if (!(c < INF) || c >= last) continue
        last = c
        own.push({ h: it.hrid, n, cost: c, how: acq[n].how })
      }
      states.push(...own.reverse())
    }
    if (states.length || slot !== "weapon") slots[slot] = states
  }
  if (!slots.weapon?.length) return null
  return { key, style, dtype, twoHand, slots, weapons: [...new Set(slots.weapon.map(s => s.h))], pouches: [...new Set((slots.pouch || []).map(s => s.h))] }
}

/** Stat of an item at +n (the game: base + bonus × table[n], only for stats the item has). */
function itemStats(maps, h, n) {
  const ed = maps.itemDetailMap[h]?.equipmentDetail || {}
  const tb = maps.enhancementLevelTotalBonusMultiplierTable || []
  const out = {}
  for (const [k, v] of Object.entries(ed.combatStats || {})) if (typeof v === "number" && v) out[k] = v + (ed.combatEnhancementBonuses?.[k] || 0) * (tb[n] || 0)
  return out
}
function enhStats(maps, h, n) {
  const ed = maps.itemDetailMap[h]?.equipmentDetail || {}
  const tb = maps.enhancementLevelTotalBonusMultiplierTable || []
  const out = {}
  for (const [k, v] of Object.entries(ed.combatStats || {})) if (typeof v === "number" && v && ed.combatEnhancementBonuses?.[k]) out[k] = ed.combatEnhancementBonuses[k] * (tb[n] || 0)
  return out
}

/** Value of a state under a model { w (per stat unit), D (whole weapons / pouches at +0) }. */
function stateValue(maps, model, slot, st) {
  const dot = s => Object.entries(s).reduce((a, [k, v]) => a + v * (model.w[k] || 0), 0)
  if ((slot === "weapon" || slot === "pouch") && model.D && st.h in model.D) return model.D[st.h] + dot(enhStats(maps, st.h, st.n))
  return dot(itemStats(maps, st.h, st.n)) + (slot === "pouch" ? model.slotPrior * pouchSlots(maps, st.h) : 0)
}
const pouchSlots = (maps, h) => {
  const cs = maps.itemDetailMap[h]?.equipmentDetail?.combatStats || {}
  return Number(cs.foodSlots || 0) + Number(cs.drinkSlots || 0)
}

/** Prior: each usable stat in units of its typical size on an item (median of the non-zero values). */
function priorModel(maps, cat) {
  const vals = {}
  for (const it of Object.values(maps.itemDetailMap)) {
    for (const [k, v] of Object.entries(it?.equipmentDetail?.combatStats || {})) if (typeof v === "number" && v) (vals[k] ||= []).push(Math.abs(v))
  }
  const w = {}
  for (const [k, list] of Object.entries(vals)) {
    if (!usable(cat.style, cat.dtype, k)) continue
    list.sort((a, b) => a - b)
    const med = list[Math.floor(list.length / 2)]
    // damage taken: negative is good
    w[k] = (k === "damageTaken" ? -1 : 1) / med
  }
  return { w, D: null, slotPrior: 3 }
}

// ------------------------------------------------------------------------------------- knapsack

/**
 * Multiple-choice knapsack: one option per group, total cost ≤ budget, most value. Costs are rounded up to
 * whole 1/G of the budget, so whatever fits a budget in units fits it in coins too (a pick is checked anyway). Returns { best(j) → value, pick(budget) → option index per group, null if none fits }.
 */
function knapsack(groups, budget, G = 2000) {
  const u = Math.max(1, budget / G)
  let dp = new Float64Array(G + 1)
  const choice = []
  const units = groups.map(g => g.options.map(o => Math.max(0, Math.ceil(o.cost / u - 1e-9))))
  groups.forEach((g, gi) => {
    const nd = new Float64Array(G + 1).fill(-INF)
    const ch = new Int16Array(G + 1).fill(-1)
    g.options.forEach((o, i) => {
      const c = units[gi][i]
      if (c > G) return
      // a hair less for what costs more: among equal values the cheaper one
      const v = o.value - o.cost * 1e-12
      for (let j = c; j <= G; j++) {
        const x = dp[j - c] + v
        if (x > nd[j]) {
          nd[j] = x
          ch[j] = i
        }
      }
    })
    dp = nd
    choice.push(ch)
  })
  const at = j => {
    const out = new Array(groups.length)
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      const i = choice[gi][j]
      if (i < 0) return null
      out[gi] = i
      j -= units[gi][i]
    }
    return out
  }
  return {
    u,
    value: j => dp[Math.max(0, Math.min(G, j))],
    pick(b) {
      for (let j = Math.min(G, Math.floor(b / u)); j >= 0; j--) {
        const p = at(j)
        if (!p) return null
        const cost = p.reduce((s, i, gi) => s + groups[gi].options[i].cost, 0)
        if (cost <= b + 1e-6) return p
        j = Math.min(j, Math.floor((b - (cost - b)) / u) + 1)
      }
      return null
    },
  }
}

/** Option groups of a member's slots under a model (an empty slot is an option, except the weapon). */
function slotGroups(maps, cat, model, member = 0) {
  const out = []
  for (const [slot, states] of Object.entries(cat.slots)) {
    const options = states.map(st => ({ ...st, slot, value: stateValue(maps, model, slot, st) }))
    if (slot !== "weapon") options.unshift({ slot, h: "", n: 0, cost: 0, how: "", value: slot === "pouch" && model.D?.[""] != null ? model.D[""] : 0 })
    out.push({ member, slot, options })
  }
  return out
}

/** The cheapest weapon and nothing else (when a member's share buys no set at all). */
function cheapestKit(cat) {
  const w = cat.slots.weapon.reduce((a, b) => (b.cost < a.cost ? b : a))
  return { weapon: { ...w, slot: "weapon" } }
}

/** Kit (slot → state) from picked options. */
function kitOf(groups, pick) {
  const kit = {}
  groups.forEach((g, i) => { kit[g.slot] = g.options[pick[i]] })
  return kit
}
const kitCost = kit => Object.values(kit).reduce((s, x) => s + (x?.cost || 0), 0)
const kitKey = kit => SLOTS.map(s => (kit[s]?.h ? `${kit[s].h}+${kit[s].n}` : "")).join("|")

// ------------------------------------------------------------------------------------- members

function memberConfig(maps, levels, key, kit, special, abilityLevel, idx, opt) {
  const b = BUILDS[key]
  const have = h => !!maps.itemDetailMap[h]
  const abilities = [special ? A(special) : "", ...b.abilities.map(A)].map(h => ({ abilityHrid: maps.abilityDetailMap[h] ? h : "", level: abilityLevel }))
  const equipment = {}
  for (const s of SLOTS) equipment[s] = kit[s]?.h ? { itemHrid: kit[s].h, enhancementLevel: kit[s].n } : { itemHrid: "", enhancementLevel: 0 }
  return {
    id: `comp-${idx + 1}`,
    name: `${idx + 1}·${t(b.name)}`,
    build: key,
    levels: { ...levels },
    equipment,
    food: FOOD.map(I).filter(have),
    drinks: b.drinks.map(I).filter(have),
    abilities,
    abilityLevelMap: Object.fromEntries(abilities.filter(a => a.abilityHrid).map(a => [a.abilityHrid, abilityLevel])),
    triggerMap: {},
    // every house room at the chosen level (capped at its top level)
    houseRooms: Object.fromEntries(Object.values(maps.houseRoomDetailMap || {}).map(r => [r.hrid, Math.min(opt.house, Math.max(0, ...Object.keys(r.upgradeCostsMap || {}).map(Number)))]).filter(([, l]) => l > 0)),
    guildBuffs: {},
    achievements: opt.achievements ? Object.fromEntries(Object.keys(maps.achievementDetailMap || {}).map(h => [h, true])) : {},
    labyrinthUpgrades: {},
  }
}

/** Special-slot abilities of a composition: each member its first preferred aura nobody has yet. */
function specials(keys) {
  const taken = new Set()
  return keys.map(k => {
    const s = [...BUILDS[k].special, ...AURAS].find(x => !taken.has(x))
    if (s) taken.add(s)
    return s || ""
  })
}

/** Compositions: multisets of `n` roles from `allowed` containing the `required` ones. */
function compositions(allowed, n, required = []) {
  const out = []
  const need = {}
  for (const r of required) need[r] = (need[r] || 0) + 1
  const rec = (start, acc) => {
    if (acc.length === n) {
      const c = {}
      for (const k of acc) c[k] = (c[k] || 0) + 1
      if (Object.entries(need).every(([k, v]) => (c[k] || 0) >= v)) out.push([...acc])
      return
    }
    for (let i = start; i < allowed.length; i++) rec(i, [...acc, allowed[i]])
  }
  rec(0, [])
  return out
}

// ------------------------------------------------------------------------------------- the job

/**
 * params: { target, extra, objective ("profit" | "eph" | "xp"), size, budget (coins, whole team), builds (allowed role
 *   keys), required (role keys that must be in), levels (combat levels of every member, default 130), house (level of every house room, default 8), achievements (all done, default true),
 *   abilityLevel, top (compositions refined), rounds (refine rounds), tax, buyPrice, sellPrice, even (budget split evenly among the members), maxDeaths (per hour; teams over it rank last, default 0.1) }
 */
export async function rankCompositions(ev0, params, api) {
  // deaths above the cap (per hour) cost the score 10× its size per death: a team over it ranks below any
  // team under it, and the stat values / gear choice lean towards surviving (EPH and experience barely
  // notice deaths on their own: a dead member just waits to come back while the others go on)
  const maxDeaths = Math.max(0, Number(params.maxDeaths ?? 0.1))
  const penal = (v, d) => v - 10 * Math.max(Math.abs(v), 1e-9) * Math.max(0, d - maxDeaths)
  const cached = withRunCache(ev0)
  const ev = {
    ctx: cached.ctx,
    evaluate: async (mem, tg, o) => {
      const r = await cached.evaluate(mem, tg, o)
      const perSeed = r.perSeed.map((v, i) => penal(v, r.per[i].deathsPerHour))
      return { ...r, raw: r.value, perSeed, value: perSeed.reduce((a, v) => a + v, 0) / perSeed.length }
    },
  }
  const maps = ev.ctx.m.$e
  const { target, extra } = params
  const objective = ["xp", "eph"].includes(params.objective) ? params.objective : "profit"
  const budget = Math.max(0, Number(params.budget || 0))
  const n = Math.max(1, Math.floor(Number(params.size || 3)))
  const max = maxPartySize(ev.ctx.m, target)
  if (n > max) throw new Error(t("{zone} 最多 {max} 人", { zone: zh(maps, target.zoneHrid), max }))
  const abilityLevel = Math.max(1, Math.floor(Number(params.abilityLevel || 60)))
  // even: every member spends at most budget / size (otherwise the split is searched with the gear)
  const even = params.even === true
  const memberOpt = { house: Math.max(0, Math.min(8, Math.floor(Number(params.house ?? 8)))), achievements: params.achievements !== false }
  const levels = Object.fromEntries(COMBAT.map(s => [s, Math.max(1, Math.floor(Number(params.levels?.[s] || 130)))]))
  const tax = Number.isFinite(Number(params.tax)) ? Number(params.tax) : 0.04
  const gp = new GearPrices(maps, pricedBook(ev.ctx.book, params), tax)
  const TOP = Math.max(1, Math.floor(Number(params.top || 5)))
  const ROUNDS = Math.max(1, Math.floor(Number(params.rounds || 3)))
  const common = { target, extra, objective, signal: api.signal }
  const name = k => t(BUILDS[k].name)
  const compName = keys => keys.map(name).join(" + ")

  // roles and their gear
  const allowed = (params.builds?.length ? params.builds : Object.keys(BUILDS)).filter(k => BUILDS[k])
  const cats = {}
  for (const k of allowed) {
    const c = catalog(maps, gp, k, levels)
    if (c) cats[k] = c
    else api.log(t("{role}：这个等级穿不了任何这一类武器（或市场上买不到），不参与", { role: name(k) }))
  }
  const roles = Object.keys(cats)
  if (!roles.length) throw new Error(t("没有可用的职业"))
  const comps = compositions(roles, n, (params.required || []).filter(k => cats[k]))
  if (!comps.length) throw new Error(t("没有满足条件的配队"))
  api.log(t("{n} 种职业，{c} 种配队；预算 {b}（全队）", { n: roles.length, c: comps.length, b: M(budget) }))

  const build = (keys, kits) => {
    const sp = specials(keys)
    return keys.map((k, i) => memberConfig(maps, levels, k, kits[i], sp[i], abilityLevel, i, memberOpt))
  }
  // planned work (sim-hours) for the progress bar
  const screen0 = { hours: 4, seeds: seedList(31001, 2) }
  const STAGES = [{ hours: 4, seeds: 2, keep: 0.1, min: Math.max(12, TOP * 2) }, { hours: 12, seeds: 6, keep: TOP }]
  const MEAS = { hours: 8, seeds: 6 }
  const CHECK = { hours: 12, seeds: seedList(42421, 12) }
  const FINAL = { hours: 24, seeds: seedList(90909, 16) }
  const measWork = cat => (cat.weapons.length + cat.pouches.length + 1 + 30) * MEAS.hours * MEAS.seeds + MEAS.hours * MEAS.seeds * 4
  let left = comps.length * 8 + roles.reduce((s, k) => s + measWork(cats[k]), 0) + comps.length * 8 + 40 * 72 + TOP * (ROUNDS * (n * 300 * 8 + 144) + 384)
  const spent = h => api.remaining?.((left = Math.max(0, left - h)))
  api.remaining?.(left)

  // ---- 0. rough kits from the stat prior, the budget split evenly
  const share = budget / n
  const prior = Object.fromEntries(roles.map(k => [k, priorModel(maps, cats[k])]))
  const roughKit = {}
  for (const k of roles) {
    const groups = slotGroups(maps, cats[k], prior[k])
    const p = knapsack(groups, share).pick(share)
    if (!p) throw new Error(t("{role}：预算连最便宜的武器都买不起", { role: name(k) }))
    roughKit[k] = kitOf(groups, p)
  }
  let done = 0
  const r0 = await pool(comps, 48, async keys => {
    const r = await ev.evaluate(build(keys, keys.map(k => roughKit[k])), target, { ...screen0, ...common })
    api.progress(++done, comps.length, t("初筛（预算平分）"))
    spent(screen0.hours * screen0.seeds)
    return { keys, value: r.value }
  })
  r0.sort((a, b) => b.value - a.value)
  api.log(t("初筛最好：{c}（{v}）", { c: compName(r0[0].keys), v: fmtObj(r0[0].value, objective) }))

  // ---- 1. stat values of each role inside the best composition that has it
  done = 0
  const models = {}
  await pool(roles, 4, async k => {
    const ref = r0.find(r => r.keys.includes(k))
    const idx = ref.keys.indexOf(k)
    const team = build(ref.keys, ref.keys.map(x => roughKit[x]))
    models[k] = await measure(ev, maps, team, idx, cats[k], { ...common, ...MEAS, seedBase: 6100 + roles.indexOf(k) }, spent)
    api.progress(++done, roles.length, t("测各职业的属性价值"))
    api.log(t("{role}（在 {c} 里测）：{top}", { role: name(k), c: compName(ref.keys), top: topWeights(models[k], cats[k], maps, objective) }))
  })
  // each role's best kit for every budget
  const ladders = {}
  for (const k of roles) {
    const groups = slotGroups(maps, cats[k], models[k])
    ladders[k] = { groups, ks: knapsack(groups, budget) }
  }
  const STEPS = 100
  const ladderValue = (k, j) => ladders[k].ks.value(Math.floor((j * budget) / STEPS / ladders[k].ks.u))
  const splitKits = keys => {
    // even split: every member its share
    if (even) return keys.map(k => {
      const p = ladders[k].ks.pick(share)
      return p ? kitOf(ladders[k].groups, p) : cheapestKit(cats[k])
    })
    // budget split among the members (in 1% steps) where the values add up most
    let dp = new Float64Array(STEPS + 1)
    const ch = []
    for (const k of keys) {
      const nd = new Float64Array(STEPS + 1).fill(-INF)
      const c = new Int16Array(STEPS + 1).fill(-1)
      for (let j = 0; j <= STEPS; j++)
        for (let x = 0; x <= j; x++) {
          const v = dp[j - x] + ladderValue(k, x)
          if (v > nd[j]) {
            nd[j] = v
            c[j] = x
          }
        }
      dp = nd
      ch.push(c)
    }
    const parts = new Array(keys.length)
    let j = STEPS
    for (let i = keys.length - 1; i >= 0; i--) {
      parts[i] = ch[i][j]
      j -= parts[i]
    }
    return keys.map((k, i) => {
      const b = (parts[i] * budget) / STEPS
      const p = ladders[k].ks.pick(b)
      return p ? kitOf(ladders[k].groups, p) : cheapestKit(cats[k])
    })
  }

  // ---- screening with the measured values
  const cands = comps.map((keys, i) => {
    const kits = splitKits(keys)
    return { key: String(i), keys, kits, members: build(keys, kits) }
  })
  let all0 = []
  const ranked = await halving(ev, cands, {
    ...common, stages: STAGES, seedBase: 8800,
    onStage: (s, d, tot) => {
      api.progress(d, tot, t("筛选配队 · 阶段 {s}/{n}", { s: s + 1, n: STAGES.length }))
      spent(STAGES[s].hours * STAGES[s].seeds)
    },
    onScored: (s, sorted) => { if (s === 0) all0 = sorted },
  })
  const screen = all0.slice(0, 40).map(c => ({ builds: c.keys, value: objectiveValue(c.mean, objective), over: c.mean.deathsPerHour > maxDeaths, deaths: c.mean.deathsPerHour, cost: c.kits.reduce((s, k) => s + kitCost(k), 0) }))
  api.partial?.({ ...header(), rows: [], screen })

  // ---- 2. refine the best ones on their own
  const rows = []
  for (const [ci, c] of ranked.slice(0, TOP).entries()) {
    if (api.signal.aborted) throw new Error("cancelled")
    const label = t("精调 {i}/{n} · {c}", { i: ci + 1, n: Math.min(TOP, ranked.length), c: compName(c.keys) })
    api.progress(0, 1, label)
    // hill climb: each round the members' stat values are measured in the current team and a few gear
    // proposals are simulated against it (the whole team re-picked over the whole budget, and each member
    // re-picked on its own spend plus what is left over); the best one is taken only when it earns more.
    // The linear values are a guide, the simulation decides: a jump that drops the defence a team needs
    // loses there.
    const kitsCost = kits => kits.reduce((s, k) => s + kitCost(k), 0)
    let best = { kits: c.kits, team: c.members, value: (await ev.evaluate(c.members, target, { ...CHECK, ...common })).value }
    spent(CHECK.hours * CHECK.seeds.length)
    const hist = c.keys.map(() => [])
    const seen = new Set([best.kits.map(kitKey).join("/")])
    for (let round = 1; round <= ROUNDS; round++) {
      const ms = await pool(c.keys.map((k, i) => i), 5, i => measure(ev, maps, best.team, i, cats[c.keys[i]], { ...common, ...MEAS, seedBase: 7000 + 131 * ci + 17 * round + i }, spent))
      ms.forEach((m, i) => hist[i].push(m))
      const models = hist.map(averaged)
      const proposals = []
      const groups = c.keys.flatMap((k, i) => slotGroups(maps, cats[k], models[i], i))
      // even split: no proposal moves money between members
      const p = even ? null : knapsack(groups, budget).pick(budget)
      if (p) proposals.push(c.keys.map((_, i) => {
        const kit = {}
        groups.forEach((g, gi) => { if (g.member === i) kit[g.slot] = g.options[p[gi]] })
        return kit
      }))
      const spare = Math.max(0, budget - kitsCost(best.kits))
      c.keys.forEach((k, i) => {
        const g = slotGroups(maps, cats[k], models[i])
        const b = even ? share : kitCost(best.kits[i]) + spare
        const q = knapsack(g, b).pick(b)
        if (q) proposals.push(best.kits.map((kit, j) => (j === i ? kitOf(g, q) : kit)))
      })
      const fresh = proposals.filter(kits => {
        const key = kits.map(kitKey).join("/")
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!fresh.length) {
        api.log(t("  {c}：第 {r} 轮配装没有变化", { c: compName(c.keys), r: round }))
        break
      }
      const tried = await pool(fresh, 8, async kits => {
        const team = build(c.keys, kits)
        const r = await ev.evaluate(team, target, { ...CHECK, ...common })
        spent(CHECK.hours * CHECK.seeds.length)
        return { kits, team, value: r.value }
      })
      tried.sort((a, b) => b.value - a.value)
      const top = tried[0]
      api.log(t("  {c}：第 {r} 轮试 {n} 种调整，最好 {v}（花 {cost}），现在 {cur}", { c: compName(c.keys), r: round, n: tried.length, v: fmtObj(top.value, objective), cost: M(kitsCost(top.kits)), cur: fmtObj(best.value, objective) }))
      if (!(top.value > best.value)) break
      best = top
    }
    const fin = await ev0.evaluate(best.team, target, { ...FINAL, ...common, items: true })
    spent(FINAL.hours * FINAL.seeds.length)
    // shown: the objective itself; ranked: with the deaths over the cap counted against it
    rows.push({ ...rowOf(maps, c.keys, best, fin, name), score: penal(fin.value, fin.mean.deathsPerHour), over: fin.mean.deathsPerHour > maxDeaths })
    rows.sort((a, b) => b.score - a.score)
    api.partial?.({ ...header(), rows, screen })
  }
  return { ...header(), rows, screen }

  function header() {
    return { target, size: n, budget, objective, abilityLevel, levels, maxDeaths, house: memberOpt.house, achievements: memberOpt.achievements, even, roles, count: comps.length, final: { hours: FINAL.hours, seeds: FINAL.seeds.length }, screenRun: { hours: STAGES[0].hours, seeds: STAGES[0].seeds } }
  }
}

function fmtObj(v, objective) {
  if (objective === "eph") return `${v.toFixed(1)} EPH`
  return objective === "xp" ? t("{v} 经验/小时", { v: Math.round(v).toLocaleString() }) : t("{v}/天", { v: M(v * 24) })
}

function rowOf(maps, keys, best, fin, name) {
  const members = keys.map((k, i) => {
    const cfg = best.team[i]
    const kit = best.kits[i]
    return {
      build: k, buildName: name(k),
      special: cfg.abilities[0]?.abilityHrid || "",
      abilities: cfg.abilities.map(a => a.abilityHrid).filter(Boolean),
      drinks: cfg.drinks, food: cfg.food,
      gear: SLOTS.filter(s => kit[s]?.h).map(s => ({ slot: s, slotName: SLOT_ZH[s] || s, h: kit[s].h, name: zh(maps, kit[s].h), n: kit[s].n, cost: kit[s].cost, how: kit[s].how })),
      cost: kitCost(kit),
      metrics: fin.mean.players[i],
    }
  })
  const items = fin.mean.items ? { revenue: fin.mean.items.revenue.slice(0, 8), expenses: fin.mean.items.expenses.slice(0, 8) } : null
  return { builds: keys, value: fin.value, mean: { ...fin.mean, items: undefined }, items, cost: members.reduce((s, m) => s + m.cost, 0), members, configs: best.team }
}

/** Mean of several measurements (weights and whole-item values). */
function averaged(list) {
  const w = {}
  const D = {}
  for (const m of list) {
    for (const [k, v] of Object.entries(m.w)) w[k] = (w[k] || 0) + v / list.length
    for (const [k, v] of Object.entries(m.D)) D[k] = (D[k] || 0) + v / list.length
  }
  return { w, D, slotPrior: 0 }
}

function topWeights(model, cat, maps, objective) {
  // the stats that matter most for this role, as the value of the measuring step (about one good item's worth)
  const labels = {}
  for (const g of statGroups(maps, { equipment: { weapon: { itemHrid: cat.weapons[0] } } })) for (const k of g.keys || []) labels[k] ||= g.label
  labels.evasion = t("闪避")
  labels.resistance = t("抗性")
  labels.defensiveDamage = t("防御伤害")
  const keysOf = g => (g === "evasion" ? EVASIONS : g === "resistance" ? RESISTANCES : [g])
  const vals = Object.entries(model.steps || {}).map(([g, step]) => [g, keysOf(g).reduce((a, k) => a + (model.w[k] || 0), 0) * step]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
  return joinList(vals.map(([g, v]) => `${labels[g] || g} ${objective === "eph" ? v.toFixed(2) : objective === "xp" ? Math.round(v).toLocaleString() : M(v * 24)}`)) || t("（都不明显）")
}

/**
 * Stat values of member `idx` in `team` at its current gear: each usable stat that the role's gear has is raised
 * by the largest amount one item gives (+10), weapons and pouches are swapped in whole at +0; all against
 * the unchanged team over 4× the seeds. Returns { w: per stat unit (objective per hour), D: whole items
 * (difference to the current one), steps }.
 */
async function measure(ev, maps, team, idx, cat, o, spent) {
  const seeds = seedList(o.seedBase, o.seeds)
  const baseSeeds = seedList(o.seedBase, o.seeds * 4)
  const run = async (mem, s = seeds) => {
    const r = await ev.evaluate(mem, o.target, { hours: o.hours, seeds: s, extra: o.extra, objective: o.objective, signal: o.signal })
    spent?.(o.hours * s.length)
    return r.perSeed
  }
  const withMember = f => team.map((c, j) => (j === idx ? f(clone(c)) : c))
  // steps: per stat the largest value of one item at +10 among the role's gear
  const steps = {}
  for (const [slot, states] of Object.entries(cat.slots)) {
    if (slot === "weapon" || slot === "pouch") continue
    for (const h of new Set(states.map(s => s.h))) {
      for (const [k, v] of Object.entries(itemStats(maps, h, 10))) {
        if (!usable(cat.style, cat.dtype, k)) continue
        const g = EVASIONS.includes(k) ? "evasion" : RESISTANCES.includes(k) ? "resistance" : k
        if (Math.abs(v) > Math.abs(steps[g] || 0)) steps[g] = v
      }
    }
  }
  // weapon stats are measured with the weapons themselves; their enhancement needs the per-stat values too
  for (const h of cat.weapons) for (const [k, v] of Object.entries(enhStats(maps, h, 10))) if (usable(cat.style, cat.dtype, k) && !(k in steps)) steps[k] = v * 3
  const keysOf = g => (g === "evasion" ? EVASIONS : g === "resistance" ? RESISTANCES : [g])
  const base = await run(team, baseSeeds)
  const jobs = [
    ...Object.entries(steps).map(([g, step]) => ({ kind: "stat", g, step, mem: withMember(c => { c.statBonus = { ...(c.statBonus || {}) }; for (const k of keysOf(g)) c.statBonus[k] = (c.statBonus[k] || 0) + step; return c }) })),
    ...cat.weapons.map(h => ({ kind: "D", h, mem: withMember(c => { c.equipment.weapon = { itemHrid: h, enhancementLevel: 0 }; return c }) })),
    ...[...cat.pouches, ""].map(h => ({ kind: "D", h, mem: withMember(c => { c.equipment.pouch = { itemHrid: h, enhancementLevel: 0 }; return c }) })),
  ]
  const res = await pool(jobs, 48, async j => ({ ...j, d: vsBase(await run(j.mem), base) }))
  const w = {}
  const D = {}
  for (const r of res) {
    if (r.kind === "D") {
      D[r.h] = r.d.mean
      continue
    }
    // noise: an unclear rise is shrunk towards 0, an unclear fall counts as 0
    const m = r.d.mean
    const shrink = m !== 0 ? Math.max(0, 1 - (r.d.se / m) ** 2) : 0
    const per = (r.d.high < 0 || m > 0 ? m * (m > 0 ? shrink : 1) : 0) / r.step
    for (const k of keysOf(r.g)) w[k] = per / keysOf(r.g).length
  }
  return { w, D, steps, slotPrior: 0 }
}
