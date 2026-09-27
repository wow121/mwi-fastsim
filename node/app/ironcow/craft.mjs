// Ironcow (铁牛) mode: nothing can be bought, so every consumable costs the time to make it by hand.
// Seconds of work per unit of an item, down to the gathered raw materials: production actions
// (cooking, brewing, crafting, ...) and gathering actions (milking, foraging, woodcutting).
// Items no action makes (key fragments, combat-only drops) cost no time here and are listed as
// "missing"; actions above the player's level are still used but listed as "locked".
import { zh } from "../i18n.mjs"

export const LIFE_SKILLS = ["milking", "foraging", "woodcutting", "cheesesmithing", "crafting", "tailoring", "cooking", "brewing"]
export const SKILL_NAMES = { milking: "挤奶", foraging: "采摘", woodcutting: "伐木", cheesesmithing: "奶酪锻造", crafting: "制作", tailoring: "缝纫", cooking: "烹饪", brewing: "冲泡" }
const GATHERING = new Set(["milking", "foraging", "woodcutting"])
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const skillOf = a => String(a?.type || "").replace("/action_types/", "")

export const isGathering = skill => GATHERING.has(skill)

/**
 * cfg, per life skill: { levels, levelBonus (tea levels; artisan tea's −5 included),
 *   speed %, efficiency % (tools, gear, house, teas, community), artisan % (fewer inputs),
 *   output % (gourmet for production, gathering quantity for gathering) }.
 * Older configs with artisan / gourmet booleans and a single gatherQty are still read.
 */
export function normalizeCraftCfg(cfg = {}) {
  const per = (o, d, f = () => d) => Object.fromEntries(LIFE_SKILLS.map(s => [s, num(o && typeof o === "object" ? o[s] : undefined, f(s))]))
  const legacyArtisan = s => (cfg.artisan === true && !GATHERING.has(s) ? 10 : 0)
  const legacyOutput = s => (GATHERING.has(s) ? num(cfg.gatherQty, 0) : cfg.gourmet === true && (s === "cooking" || s === "brewing") ? 12 : 0)
  const out = {
    levels: per(cfg.levels, 1),
    levelBonus: per(cfg.levelBonus, 0),
    speed: per(cfg.speed, 0),
    efficiency: per(cfg.efficiency, 0),
    artisan: per(cfg.artisan, 0, legacyArtisan),
    output: per(cfg.output, 0, legacyOutput),
  }
  for (const s of LIFE_SKILLS) {
    out.levels[s] = Math.max(1, out.levels[s])
    for (const k of ["speed", "efficiency", "output"]) out[k][s] = Math.max(0, out[k][s])
    out.artisan[s] = Math.min(100, Math.max(0, out.artisan[s]))
  }
  return out
}

export class CraftTimes {
  constructor(maps, cfg) {
    this.maps = maps
    this.cfg = normalizeCraftCfg(cfg)
    this.memo = new Map()
    // producers per item: production actions by output, gathering actions by drop
    this.makers = new Map()
    const push = (h, e) => (this.makers.get(h) || this.makers.set(h, []).get(h)).push(e)
    for (const a of Object.values(maps.actionDetailMap)) {
      const skill = skillOf(a)
      if (!LIFE_SKILLS.includes(skill)) continue
      if (GATHERING.has(skill)) {
        for (const d of a.dropTable || []) {
          const n = num(d.dropRate) * (num(d.minCount) + num(d.maxCount)) / 2
          if (n > 0) push(d.itemHrid, { action: a, skill, gather: n })
        }
      } else for (const o of a.outputItems || []) if (num(o.count) > 0) push(o.itemHrid, { action: a, skill, count: num(o.count) })
    }
  }

  /** Seconds one action takes, after level efficiency, extra efficiency and speed. */
  actionSeconds(a, skill) {
    const c = this.cfg
    const req = num(a.levelRequirement?.level, 1)
    const eff = Math.max(0, c.levels[skill] + c.levelBonus[skill] - req) / 100 + c.efficiency[skill] / 100
    return num(a.baseTimeCost) / 1e9 / (1 + c.speed[skill] / 100) / (1 + eff)
  }

  /** { seconds, action, skill, inputs: [{hrid, count}], missing: Set, locked: Set } per unit of `hrid`. */
  of(hrid, stack = new Set()) {
    if (this.memo.has(hrid)) return this.memo.get(hrid)
    const c = this.cfg
    let best = null
    if (!stack.has(hrid)) {
      const s2 = new Set(stack).add(hrid)
      for (const mk of this.makers.get(hrid) || []) {
        const a = mk.action
        const t = this.actionSeconds(a, mk.skill)
        const locked = new Set(c.levels[mk.skill] + c.levelBonus[mk.skill] < num(a.levelRequirement?.level, 1) ? [`${zh(this.maps, a.hrid)}（${SKILL_NAMES[mk.skill]} ${a.levelRequirement.level} 级）`] : [])
        let r
        if (mk.gather) r = { seconds: t / (mk.gather * (1 + c.output[mk.skill] / 100)), action: a.hrid, skill: mk.skill, inputs: [], missing: new Set(), locked }
        else {
          const out = mk.count * (1 + c.output[mk.skill] / 100)
          const inputs = (a.inputItems || []).map(i => ({ hrid: i.itemHrid, count: num(i.count) * (1 - c.artisan[mk.skill] / 100) / out }))
          if (a.upgradeItemHrid) inputs.push({ hrid: a.upgradeItemHrid, count: 1 / out })
          r = { seconds: t / out, action: a.hrid, skill: mk.skill, inputs, missing: new Set(), locked }
          for (const i of inputs) {
            const sub = this.of(i.hrid, s2)
            r.seconds += sub.seconds * i.count
            for (const x of sub.missing) r.missing.add(x)
            for (const x of sub.locked) r.locked.add(x)
          }
        }
        // prefer paths the player can do now, then the fastest
        if (!best || (best.locked.size > 0) - (r.locked.size > 0) > 0 || ((best.locked.size > 0) === (r.locked.size > 0) && r.seconds < best.seconds)) best = r
      }
    }
    if (!best) best = { seconds: 0, action: "", skill: "", inputs: [], missing: new Set(hrid === "/items/coin" ? [] : [hrid]), locked: new Set() }
    if (!stack.has(hrid)) this.memo.set(hrid, best)
    return best
  }

  seconds(hrid) {
    return this.of(hrid).seconds
  }

  /** Expanded tree for display (depth-limited). */
  tree(hrid, count = 1, depth = 0) {
    const r = this.of(hrid)
    return {
      hrid,
      name: zh(this.maps, hrid),
      count,
      seconds: r.seconds * count,
      skill: r.skill,
      action: r.action ? zh(this.maps, r.action) : "",
      ownSeconds: r.action ? (r.seconds - r.inputs.reduce((s, i) => s + this.of(i.hrid).seconds * i.count, 0)) * count : 0,
      missing: !r.action,
      children: depth < 6 ? r.inputs.map(i => this.tree(i.hrid, i.count * count, depth + 1)) : [],
    }
  }
}
