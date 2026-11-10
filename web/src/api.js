import { reactive } from "vue"
import { applyLang, lang, t, tk } from "./i18n.js"

// Two ways to run: the local server (node server.mjs + native engine) answers /api/*, or, when the
// page is served statically (no server), everything runs in the browser (wasm engine).
let modeP = null
export function detectMode() {
  modeP ||= fetch("api/state", { cache: "no-store" })
    .then(async r => (r.ok && (r.headers.get("content-type") || "").includes("json") && (await r.json()).team ? "server" : "browser"))
    .catch(() => "browser")
  return modeP
}

export async function call(method, path, body) {
  if ((await detectMode()) === "browser") {
    const { localApi } = await import("./local/api.js")
    // plain JSON copies, like the server's replies
    return JSON.parse(JSON.stringify(await localApi(method, path, body ? JSON.parse(JSON.stringify(body)) : {})))
  }
  const r = await fetch(path.replace(/^\//, ""), { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j?.error) throw new Error(j?.error || `HTTP ${r.status}`)
  return j
}

// console / test hook
globalThis.__fastsim = { call: (...a) => call(...a), detectMode }

/** Shared app state: team, engine info, options (names, lists). */
export const store = reactive({
  loaded: false,
  mode: null, // "server" | "browser"
  team: { members: [], selected: [], settings: {} },
  engine: null,
  market: null,
  options: null,
  loadouts: [],
})

export async function loadState() {
  store.mode = await detectMode()
  // the backend builds names and messages in the page's language
  await call("PUT", "/api/lang", { lang: lang.value }).catch(() => {})
  // options first: it starts the engine, so the state below reports it
  const [opts, loadouts] = await Promise.all([call("GET", "/api/options"), call("GET", "/api/loadouts")])
  const st = await call("GET", "/api/state")
  store.team = st.team
  store.engine = st.engine
  store.market = st.market
  store.options = opts
  store.loadouts = loadouts
  store.loaded = true
}

/** Switches the UI language and reloads what the backend named in the old one. */
export async function changeLang(v) {
  applyLang(v)
  await call("PUT", "/api/lang", { lang: lang.value }).catch(() => {})
  if (store.loaded) store.options = await call("GET", "/api/options")
}

export async function saveTeam() {
  await call("PUT", "/api/team", { members: store.team.members, selected: store.team.selected, settings: store.team.settings })
}

export function selectedMembers() {
  return store.team.selected.map(id => store.team.members.find(m => String(m.id) === String(id))).filter(Boolean)
}

export const clone = v => JSON.parse(JSON.stringify(v))

// ---- formatting (game units: K / M / B)
export function money(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—"
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(digits)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(digits)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(0)
}
export const perDay = v => money(v * 24)
/** "±x" from a result's 95% range (`ci`, filled when there are 2+ seeds), formatted with `fmt`. */
export function ci(row, key, fmt = v => v.toFixed(2)) {
  const v = row?.ci?.[key]
  return v == null || !Number.isFinite(v) || v <= 0 ? "" : `±${fmt(v)}`
}
/** A fresh seed base for "换一组随机种子". */
export const randomSeedBase = () => 1 + Math.floor(Math.random() * 2 ** 31)

/** Item counts: K / M for large ones (coins, essences). */
export const qty = v => (v == null || !Number.isFinite(v) ? "—" : Math.abs(v) >= 1e4 ? money(v, 2) : v.toFixed(1))
export const int = v => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString())
export const pct = v => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`)

/** Hours as "x 小时" / "x 天". */
export function duration(h) {
  if (h == null || !Number.isFinite(h)) return "—"
  if (h <= 0) return t("已达到")
  if (h < 1) return t("{n} 分钟", { n: Math.max(1, Math.round(h * 60)) })
  return h < 48 ? t("{n} 小时", { n: h.toFixed(1) }) : t("{n} 天", { n: (h / 24).toFixed(1) })
}

/** [key, label] — labels are t() keys. */
export const COMBAT_SKILLS = [["stamina", tk("耐力")], ["intelligence", tk("智力")], ["attack", tk("攻击")], ["melee", tk("近战")], ["defense", tk("防御")], ["ranged", tk("远程")], ["magic", tk("魔法")]]

const ATTACK_NAMES = { autoAttack: tk("普攻"), damageOverTime: tk("持续伤害"), parry: tk("招架"), retaliation: tk("反击"), physicalThorns: tk("物理荆棘"), elementalThorns: tk("元素荆棘"), unknown: tk("未知") }
/** Ability / attack kind keys of a simResult's `attacks` and `deathCauses`. */
export function attackName(k) {
  return store.options?.names.abilities[k] || (ATTACK_NAMES[k] ? t(ATTACK_NAMES[k]) : k)
}
export function monsterName(h) {
  return (h && store.options?.names.monsters[h]) || (h === "unknown" ? t("未知") : h) || "—"
}

export function itemName(h) {
  return (h && store.options?.names.items[h]) || h || "—"
}
export function abilityName(h) {
  return (h && store.options?.names.abilities[h]) || h || "—"
}
export function zoneName(h) {
  return (h && store.options?.names.zones[h]) || h || "—"
}
export function targetLabel(x) {
  if (!x) return "—"
  if (x.kind === "labyrinth") return t("迷宫 {name} · 房间 {room}", { name: store.options?.names.monsters[x.labyrinthHrid] || x.labyrinthHrid, room: x.roomLevel })
  return `${zoneName(x.zoneHrid)} · T${x.difficultyTier}`
}

// last chosen target / community buffs, shared by all pages
function remembered(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null")
  } catch {
    return null
  }
}
export function rememberTarget(t) {
  try {
    localStorage.setItem("fastsim-target", JSON.stringify(t))
  } catch {}
}
export function rememberExtra(e) {
  try {
    localStorage.setItem("fastsim-extra", JSON.stringify(e))
  } catch {}
}

/** Last chosen target, else the synced site settings, else the first group zone. */
export function defaultTarget() {
  const r = remembered("fastsim-target")
  const valid = r && (r.kind === "labyrinth" ? store.options?.labyrinths.some(x => x.hrid === r.labyrinthHrid) : [...(store.options?.zones || []), ...(store.options?.dungeons || [])].some(z => z.hrid === r.zoneHrid))
  if (valid) return r
  const s = store.team.settings || {}
  if (s.mode === "labyrinth") return { kind: "labyrinth", labyrinthHrid: s.labyrinthHrid, roomLevel: Number(s.roomLevel || 100) }
  const z = (s.useDungeon ? s.dungeonHrid : s.zoneHrid) || store.options?.zones[0]?.hrid
  return { kind: "zone", zoneHrid: z, difficultyTier: Number(s.difficultyTier || 0) }
}
/** Community buffs and scrolls; unset means the site's defaults (Moo Pass on, levels 20, no scrolls). */
export function defaultExtra() {
  const r = remembered("fastsim-extra")
  if (r && typeof r === "object") return { ...r, seals: Array.isArray(r.seals) ? r.seals : [] }
  const s = store.team.settings || {}
  const lv = (v, on) => (on === false ? 0 : Math.max(0, Math.min(20, Math.floor(Number.isFinite(Number(v)) ? Number(v) : 20))))
  return { mooPass: s.mooPass ?? true, comExp: lv(s.comExp, s.comExpEnabled), comDrop: lv(s.comDrop, s.comDropEnabled), seals: [] }
}

/** Readable trigger of an ability/consumable in a member config ("游戏默认" when not set). */
export function triggerText(member, hrid) {
  if (!member?.triggerMap || !Object.prototype.hasOwnProperty.call(member.triggerMap, hrid)) return t("游戏默认")
  const list = member.triggerMap[hrid]
  if (!list.length) return t("无条件（冷却好就用）")
  const o = store.options.trigger
  const n = (list, h) => list.find(x => x.hrid === h)?.name || h.split("/").pop()
  return list.map(c => {
    const cmp = o.comparators.find(x => x.hrid === c.comparatorHrid)
    return `${n(o.dependencies, c.dependencyHrid)}${lang.value === "en" ? " " : ""}${n(o.conditions, c.conditionHrid)} ${cmp?.name || ""}${cmp?.allowValue ? ` ${c.value}` : ""}`
  }).join(t(" 且 "))
}
