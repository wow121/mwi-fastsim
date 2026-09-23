import { reactive } from "vue"

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
export const int = v => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString())
export const pct = v => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`)

export function itemName(h) {
  return (h && store.options?.names.items[h]) || h || "—"
}
export function abilityName(h) {
  return (h && store.options?.names.abilities[h]) || h || "—"
}
export function zoneName(h) {
  return (h && store.options?.names.zones[h]) || h || "—"
}
export function targetLabel(t) {
  if (!t) return "—"
  if (t.kind === "labyrinth") return `迷宫 ${store.options?.names.monsters[t.labyrinthHrid] || t.labyrinthHrid} · 房间 ${t.roomLevel}`
  return `${zoneName(t.zoneHrid)} · T${t.difficultyTier}`
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
/** Community buffs; unset means the site's defaults (Moo Pass on, levels 20). */
export function defaultExtra() {
  const r = remembered("fastsim-extra")
  if (r && typeof r === "object") return r
  const s = store.team.settings || {}
  const lv = (v, on) => (on === false ? 0 : Math.max(0, Math.min(20, Math.floor(Number.isFinite(Number(v)) ? Number(v) : 20))))
  return { mooPass: s.mooPass ?? true, comExp: lv(s.comExp, s.comExpEnabled), comDrop: lv(s.comDrop, s.comDropEnabled) }
}

/** Readable trigger of an ability/consumable in a member config ("游戏默认" when not set). */
export function triggerText(member, hrid) {
  if (!member?.triggerMap || !Object.prototype.hasOwnProperty.call(member.triggerMap, hrid)) return "游戏默认"
  const t = member.triggerMap[hrid]
  if (!t.length) return "无条件（冷却好就用）"
  const o = store.options.trigger
  const n = (list, h) => list.find(x => x.hrid === h)?.name || h.split("/").pop()
  return t.map(c => {
    const cmp = o.comparators.find(x => x.hrid === c.comparatorHrid)
    return `${n(o.dependencies, c.dependencyHrid)}${n(o.conditions, c.conditionHrid)} ${cmp?.name || ""}${cmp?.allowValue ? ` ${c.value}` : ""}`
  }).join(" 且 ")
}
