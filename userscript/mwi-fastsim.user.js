// ==UserScript==
// @name         MWI 战斗工具（本地）
// @namespace    mwi-fastsim
// @version      0.4.0
// @description  游戏页面：读取当前角色和队友数据发给本地工具 / 网页版；战斗模拟网站：模拟转发到本地 Rust 引擎加速
// 网页版部署在自己的域名上时，照下面 localhost 的写法加一行 @match（例如 // @match https://mwi.example.com/*）
// @match        https://www.milkywayidle.com/*
// @match        https://milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://milkywayidlecn.com/*
// @match        https://combat.43.167.210.211.sslip.io/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict"
  const SERVER = "http://127.0.0.1:8765"
  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window
  const isGame = /milkywayidle(cn)?\.com$/.test(location.hostname)
  const isSimSite = location.hostname === "combat.43.167.210.211.sslip.io"
  // what the tool page (browser mode) picks up: the latest capture from the game / the sim site
  const GAME_KEY = "fastsim_game_capture_v1"
  const SITE_KEY = "fastsim_site_capture_v1"
  const TOOL_URL = "fastsim_tool_url_v1"

  function post(path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: SERVER + path,
        headers: { "content-type": "application/json" },
        data: JSON.stringify(body),
        timeout: 30000,
        onload: r => {
          let j = null
          try { j = JSON.parse(r.responseText) } catch {}
          if (r.status >= 200 && r.status < 300 && !j?.error) resolve(j)
          else reject(new Error(j?.error || `HTTP ${r.status}`))
        },
        onerror: () => reject(new Error("连不上本地服务（start-server 开了吗？）")),
        ontimeout: () => reject(new Error("本地服务超时")),
      })
    })
  }

  if (isGame) gamePage()
  else if (isSimSite) simSitePage()
  else toolPage()

  // =====================================================================================
  // The tool page (browser mode): hand over the latest captures when the page says hello.
  // =====================================================================================
  function toolPage() {
    W.addEventListener("message", e => {
      if (e.origin !== location.origin || e.data?.source !== "mwi-fastsim-page" || e.data.type !== "hello") return
      GM_setValue(TOOL_URL, location.href.split("#")[0])
      const data = { source: "mwi-fastsim-userscript", type: "data", game: GM_getValue(GAME_KEY, null), site: GM_getValue(SITE_KEY, null) }
      W.postMessage(JSON.parse(JSON.stringify(data)), location.origin)
    })
  }

  // =====================================================================================
  // Game page: same capture as the combat-sim site's data bridge, sent to the local server.
  // =====================================================================================
  function gamePage() {
    const PROFILE_CACHE = "fastsim_profile_cache_v1"
    const clone = v => { try { return JSON.parse(JSON.stringify(v)) } catch { return null } }
    const values = s => (Array.isArray(s) ? s : s && typeof s.values === "function" && typeof s.get === "function" ? Array.from(s.values()) : s && typeof s === "object" ? Object.values(s) : [])
    const valueOf = (s, k) => (!s || typeof s !== "object" ? null : typeof s.get === "function" ? s.get(k) || s.get(String(k)) || null : s[k] || s[String(k)] || null)
    let lastRaw = null
    let partyNames = []
    let done = false

    function profileName(p) {
      const s = p && p.profile ? p.profile : p || {}
      return String(s.character?.name || s.sharableCharacter?.name || s.characterName || s.name || "").trim()
    }
    function charName(s) {
      return String(s && (s.name || s.characterName || s.character?.name || s.sharableCharacter?.name || s.profile?.sharableCharacter?.name) || "").trim()
    }

    // --- compactProfile (bridge) ---------------------------------------------------------
    function equipmentLocation(key, entry, item) {
      const loc = String(item?.itemLocationHrid || entry?.itemLocationHrid || key || "").trim()
      if (!loc) return ""
      if (loc.startsWith("/item_locations/")) return loc
      return ["main_hand", "off_hand", "two_hand", "head", "body", "hands", "feet", "legs", "back", "neck", "earrings", "ring", "trinket", "charm", "pouch", "inventory"].includes(loc) ? `/item_locations/${loc}` : ""
    }
    function wearableItemMap(profile) {
      const src = profile && profile.profile ? profile.profile : profile || {}
      const sh = src.sharableCharacter || {}
      const cu = src.combatUnit || {}
      const out = {}
      for (const root of [src.wearableItemMap, sh.wearableItemMap, src.characterItems, src.equippedItems, src.equipment, src.characterEquipment, src.equipmentMap, src.characterItemMap, sh.characterItems, sh.equippedItems, sh.equipment, sh.equipmentMap, cu.wearableItemMap, cu.characterItems, cu.equipment]) {
        if (!root || typeof root !== "object") continue
        const entries = Array.isArray(root) ? root.map((e, i) => [String(i), e]) : Object.entries(root)
        for (const [key, entry] of entries) {
          if (!entry || typeof entry !== "object") continue
          const item = entry.currentItem && typeof entry.currentItem === "object" ? entry.currentItem : entry.item && typeof entry.item === "object" ? entry.item : entry.characterItem && typeof entry.characterItem === "object" ? entry.characterItem : entry.wearableItem && typeof entry.wearableItem === "object" ? entry.wearableItem : entry
          const loc = equipmentLocation(key, entry, item)
          const hrid = String(item.itemHrid || item.hrid || entry.itemHrid || entry.hrid || "").trim()
          if (!loc || !hrid || out[loc]) continue
          out[loc] = { itemLocationHrid: loc, itemHrid: hrid, enhancementLevel: Number(item.enhancementLevel != null ? item.enhancementLevel : entry.enhancementLevel || 0) || 0 }
        }
      }
      return out
    }
    function profileLoadouts(src) {
      const out = []
      const add = v => { if (v && typeof v === "object" && !out.includes(v)) out.push(v) }
      add(src.currentCombatLoadout); add(src.combatLoadout); add(src.currentLoadout); add(src.loadout)
      if (src.characterLoadoutMap && typeof src.characterLoadoutMap === "object") Object.values(src.characterLoadoutMap).forEach(add)
      add(src)
      return out
    }
    function itemHrids(v) {
      const entries = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []
      return entries.map(e => {
        if (typeof e === "string") return e
        if (!e || typeof e !== "object") return ""
        const it = e.currentItem && typeof e.currentItem === "object" ? e.currentItem : e.item && typeof e.item === "object" ? e.item : e
        return String(it.itemHrid || it.hrid || "").trim()
      }).filter(Boolean).slice(0, 3)
    }
    function combatConsumables(src, kind) {
      const direct = kind === "food" ? "foodItemHrids" : "drinkItemHrids"
      const slots = kind === "food" ? "actionTypeFoodSlotsMap" : "actionTypeDrinkSlotsMap"
      const cands = []
      for (const l of profileLoadouts(src)) {
        cands.push(l[direct])
        if (l.combatConsumables && typeof l.combatConsumables === "object") cands.push(l.combatConsumables[direct])
      }
      for (const m of [src[slots], src.sharableCharacter && src.sharableCharacter[slots]]) {
        if (!m || typeof m !== "object") continue
        cands.push(m["/action_types/combat"]); cands.push(m.combat)
      }
      for (const c of cands) {
        const v = itemHrids(c)
        if (v.length) return v
      }
      return []
    }
    function equippedAbilities(src) {
      const cands = [src.equippedAbilities, src.combatUnit && src.combatUnit.combatAbilities, src.sharableCharacter && src.sharableCharacter.equippedAbilities]
      for (const l of profileLoadouts(src)) {
        cands.push(l.equippedAbilities); cands.push(l.abilities); cands.push(l.combatAbilities && l.combatAbilities.abilities)
        if (Array.isArray(l.combatAbilities)) cands.push(l.combatAbilities)
      }
      for (const v of cands) {
        const list = (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []).filter(e => (typeof e === "string" ? e.startsWith("/abilities/") : e && (e.abilityHrid || e.hrid || e.ability)))
        if (list.length) return clone(list)
      }
      return []
    }
    function triggerMap(src, field) {
      const out = {}
      for (const c of [src, src.combatUnit, src.sharableCharacter].concat(profileLoadouts(src))) {
        if (!c || typeof c !== "object") continue
        const maps = [c[field], c.combatAbilities && c.combatAbilities[field], c.combatConsumables && c.combatConsumables[field]]
        if (field === "abilityCombatTriggersMap") maps.push(c.triggerMap)
        for (const m of maps) if (m && typeof m === "object" && !Array.isArray(m)) for (const k of Object.keys(m)) out[k] = clone(m[k])
      }
      return out
    }
    function compactProfile(profile, isCurrent) {
      const src = profile && profile.profile ? profile.profile : profile || {}
      const fields = isCurrent
        ? ["character", "characterSkills", "characterItems", "combatUnit", "characterAbilities", "characterAbilityMap", "abilityMap", "combatAbilityMap", "actionTypeFoodSlotsMap", "actionTypeDrinkSlotsMap", "consumableCombatTriggersMap", "abilityCombatTriggersMap", "characterHouseRoomMap", "characterAchievements", "characterGuildBuffMap", "guildBuildingLevelMap", "communityBuffTypeMap", "communityBuffMap", "communityBuffs"]
        : ["name", "characterName", "sharableCharacter", "characterSkills", "wearableItemMap", "equippedAbilities", "characterAbilities", "characterAbilityMap", "abilityMap", "combatAbilityMap", "actionTypeFoodSlotsMap", "actionTypeDrinkSlotsMap", "consumableCombatTriggersMap", "abilityCombatTriggersMap", "currentCombatLoadout", "combatLoadout", "currentLoadout", "loadout", "characterLoadoutMap", "characterHouseRoomMap", "characterAchievements", "characterGuildBuffMap", "guildBuildingLevelMap", "communityBuffTypeMap", "communityBuffMap", "communityBuffs"]
      const out = {}
      for (const k of fields) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = clone(src[k])
      if (!isCurrent) {
        const wm = wearableItemMap(src)
        if (Object.keys(wm).length) out.wearableItemMap = wm
        const food = combatConsumables(src, "food")
        const drink = combatConsumables(src, "drink")
        const abil = equippedAbilities(src)
        const ct = triggerMap(src, "consumableCombatTriggersMap")
        const at = triggerMap(src, "abilityCombatTriggersMap")
        const all = []
        for (const h of food.concat(drink, Object.keys(ct))) if (h && !all.includes(h)) all.push(h)
        if (food.length) out.foodItemHrids = food
        if (drink.length) out.drinkItemHrids = drink
        if (all.length) out.combatConsumables = all.map(itemHrid => ({ itemHrid }))
        if (abil.length) out.equippedAbilities = abil
        if (Object.keys(ct).length) out.consumableCombatTriggersMap = ct
        if (Object.keys(at).length) out.abilityCombatTriggersMap = at
      }
      return out
    }

    // --- teammates -----------------------------------------------------------------------
    function readCache() {
      const v = GM_getValue(PROFILE_CACHE, {})
      return v && typeof v === "object" ? v : {}
    }
    function rememberProfile(profile) {
      const name = profileName(profile)
      if (!name) return
      const cache = readCache()
      cache[name.toLowerCase()] = { characterName: name, capturedAt: Date.now(), payload: compactProfile(profile, false) }
      const keys = Object.keys(cache).sort((a, b) => (cache[b].capturedAt || 0) - (cache[a].capturedAt || 0)).slice(0, 50)
      GM_setValue(PROFILE_CACHE, Object.fromEntries(keys.map(k => [k, cache[k]])))
    }
    function gameState() {
      for (const c of [W.mwi, W.MWI, W.Mwi]) {
        const s = c && c.game && c.game.state
        if (s && typeof s === "object") return s
      }
      return null
    }
    function resolvePartyNames(info, state) {
      if (!info || typeof info !== "object") return []
      const slotSource = info.partySlotMap || info.partySlotsMap || info.partyMemberMap || info.partySlots
      const shared = info.sharableCharacterMap || info.sharedCharacterMap || info.partyCharacterMap
      const slots = values(slotSource).filter(e => e && typeof e === "object")
      const ownName = charName(state && state.character) || profileName(lastRaw)
      const ownId = String(state?.character?.id ?? lastRaw?.character?.id ?? "")
      if (!slots.length) {
        const names = values(shared).map(charName).filter(Boolean)
        if (ownName && !names.some(n => n.toLowerCase() === ownName.toLowerCase())) names.unshift(ownName)
        return Array.from(new Set(names.map(n => n.trim()))).slice(0, 5)
      }
      let members = slots.map((slot, order) => {
        const id = slot.characterID ?? slot.characterId ?? slot.character?.id ?? null
        const sc = id != null ? valueOf(shared, id) : null
        let name = charName(sc) || charName(slot)
        const isCurrent = !!(ownId && id != null && String(id) === ownId) || !!(ownName && name && name.toLowerCase() === ownName.toLowerCase())
        if (!name && isCurrent) name = ownName
        return { name, isCurrent, order }
      }).filter(m => m.name)
      members.sort((a, b) => (a.isCurrent !== b.isCurrent ? (a.isCurrent ? -1 : 1) : a.order - b.order))
      const seen = {}
      return members.map(m => m.name).filter(n => (seen[n.toLowerCase()] ? false : (seen[n.toLowerCase()] = true))).slice(0, 5)
    }
    function refreshParty() {
      const st = gameState()
      const names = resolvePartyNames(st && st.partyInfo, st)
      if (names.length) partyNames = names
      for (const p of values(st && st.partyInfo && st.partyInfo.sharableCharacterMap))
        if (Object.keys(wearableItemMap(p)).length) rememberProfile(p)
    }
    function buildEnvelope() {
      const cache = readCache()
      const own = profileName(lastRaw)
      const roster = partyNames.length ? partyNames.slice(0, 5) : [own]
      const members = []
      const missing = []
      for (const name of roster) {
        if (!name) continue
        if (name.toLowerCase() === own.toLowerCase()) {
          members.push({ characterName: own, isCurrent: true, format: "main-site-current-character", payload: compactProfile(lastRaw, true) })
          continue
        }
        const c = cache[name.toLowerCase()]
        if (c && c.payload) members.push({ characterName: name, isCurrent: false, format: "shareable-profile", payload: { profile: c.payload } })
        else missing.push(name)
      }
      return { schemaVersion: 1, capturedAt: Date.now(), source: "milkywayidle", currentCharacter: compactProfile(lastRaw, true), members, missingMembers: missing }
    }

    // --- send ----------------------------------------------------------------------------
    let sendTimer = null
    let lastClientData = null
    function scheduleSend() {
      clearTimeout(sendTimer)
      sendTimer = setTimeout(async () => {
        if (!lastRaw) return
        refreshParty()
        let initClientData = null
        try { initClientData = W.localStorage.getItem("initClientData") } catch {}
        const body = { envelope: buildEnvelope() }
        // for the browser-mode tool page (always with the game data: it keeps its own copy)
        GM_setValue(GAME_KEY, { capturedAt: Date.now(), body: { ...body, initClientData } })
        const missing = body.envelope.missingMembers || []
        if (initClientData && initClientData !== lastClientData) body.initClientData = initClientData
        try {
          const r = await post("/api/game", body)
          if (body.initClientData) lastClientData = initClientData
          badge(`已同步 ${r.members} 人${r.missing?.length ? `（缺：${r.missing.join("、")}，在游戏里点开他们的资料）` : ""}`, !r.missing?.length)
        } catch (e) {
          // no local server: the web version picks it up when opened
          badge(`已读取${missing.length ? `（缺：${missing.join("、")}，在游戏里点开他们的资料）` : ""}，打开网页版工具即可导入`, !missing.length)
        }
      }, 1000)
    }
    function badge(text, ok) {
      const add = () => {
        let b = document.getElementById("fastsim-badge")
        if (!b) {
          b = document.createElement("div")
          b.id = "fastsim-badge"
          b.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;padding:4px 8px;border-radius:6px;font:12px sans-serif;color:#fff;opacity:.9;cursor:pointer"
          b.title = "MWI 战斗工具（本地），点击隐藏"
          b.onclick = () => b.remove()
          document.body.appendChild(b)
        }
        b.style.background = ok ? "#1a7f37" : "#9a6700"
        b.textContent = `本地工具：${text}`
      }
      if (document.body) add()
      else document.addEventListener("DOMContentLoaded", add, { once: true })
    }

    // --- WebSocket capture (bridge) -------------------------------------------------------
    function onMessage(event) {
      if (typeof event.data !== "string") return
      if (!done && event.data.includes("init_character_data")) {
        try {
          const o = JSON.parse(event.data)
          if (o.type === "init_character_data") {
            done = true
            lastRaw = o
            partyNames = resolvePartyNames(o.partyInfo || o.data?.partyInfo, gameState())
            scheduleSend()
          }
        } catch (e) {
          console.error("[fastsim] init_character_data", e)
        }
        return
      }
      if (event.data.includes("profile_shared")) {
        try {
          const o = JSON.parse(event.data)
          if (o.type !== "profile_shared") return
          const p = o.profile || o.data?.profile || o.payload?.profile
          if (!p) return
          rememberProfile(p)
          if (lastRaw) scheduleSend()
        } catch (e) {
          console.error("[fastsim] profile_shared", e)
        }
      }
    }
    const WS = W.WebSocket
    const origAdd = WS.prototype.addEventListener
    const origOn = Object.getOwnPropertyDescriptor(WS.prototype, "onmessage")
    const seen = new Set()
    function observe(socket) {
      if (seen.has(socket)) return
      seen.add(socket)
      origAdd.call(socket, "message", onMessage)
    }
    WS.prototype.addEventListener = function (type, listener, options) {
      if (type === "message") observe(this)
      return origAdd.call(this, type, listener, options)
    }
    if (origOn && origOn.configurable && origOn.get && origOn.set) {
      Object.defineProperty(WS.prototype, "onmessage", {
        get() { return origOn.get.call(this) },
        set(h) { observe(this); return origOn.set.call(this, h) },
        configurable: true,
        enumerable: origOn.enumerable,
      })
    }
  }

  // =====================================================================================
  // Combat-sim site: route its single-simulation worker to the local Rust engine.
  // Runs in the page (needs the page's Worker constructor and Vue app).
  // =====================================================================================
  function simSitePage() {
    // the page-context code cannot call GM_*: it hands the site capture over with an event
    document.addEventListener("fastsim-site-capture", e => {
      try { GM_setValue(SITE_KEY, { capturedAt: Date.now(), body: JSON.parse(e.detail) }) } catch {}
    })
    const code = `(${pageAccelerator.toString()})(${JSON.stringify(SERVER)}, ${JSON.stringify(GM_getValue(TOOL_URL, SERVER))})`
    const s = document.createElement("script")
    s.textContent = code
    ;(document.head || document.documentElement).appendChild(s)
    s.remove()
  }

  function pageAccelerator(SERVER, TOOL) {
    const RealWorker = window.Worker
    const WORKER_RE = /\/assets\/worker-[\w-]+\.js$/
    let serverUp = null
    let lastProbe = 0
    async function probe() {
      if (serverUp !== null && Date.now() - lastProbe < 10000) return serverUp
      lastProbe = Date.now()
      try {
        serverUp = (await fetch(`${SERVER}/status`, { cache: "no-store" })).ok
      } catch {
        serverUp = false
      }
      return serverUp
    }
    class FastWorker extends EventTarget {
      constructor(url, options) {
        super()
        this._url = new URL(String(url), location.href).href
        this._options = options
        this._real = null
        this._aborts = new Set()
        this._envelope = null
        this.onmessage = null
        this.onerror = null
      }
      _emit(data) {
        const ev = new MessageEvent("message", { data })
        this.onmessage?.(ev)
        this.dispatchEvent(ev)
      }
      _fallback(msg) {
        if (!this._real) {
          this._real = new RealWorker(this._url, this._options)
          this._real.onmessage = e => {
            this.onmessage?.(e)
            this.dispatchEvent(new MessageEvent("message", { data: e.data }))
          }
          this._real.onerror = e => this.onerror?.(e)
        }
        if (this._envelope && !msg.gameDataEnvelope) msg = { ...msg, gameDataEnvelope: this._envelope }
        this._real.postMessage(msg)
      }
      postMessage(msg) {
        if (this._real || !msg || msg.type !== "start_simulation") return this._fallback(msg)
        if (msg.gameDataEnvelope) this._envelope = msg.gameDataEnvelope
        const ctl = new AbortController()
        this._aborts.add(ctl)
        ;(async () => {
          if (!(await probe())) return this._fallback(msg)
          try {
            const r = await fetch(`${SERVER}/simulate`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workerUrl: this._url, payload: msg, lite: location.pathname.includes("skill-optimizer") }),
              signal: ctl.signal,
            })
            const body = await r.json()
            if (!r.ok || body.error) throw new Error(body.error || `HTTP ${r.status}`)
            this._emit({ type: "simulation_progress", progress: 1 })
            this._emit({ type: "simulation_result", simResult: body.simResult })
          } catch (e) {
            if (ctl.signal.aborted) return
            console.warn("[fastsim] 本地加速失败，改用网站原版 Worker：", e)
            serverUp = false
            lastProbe = Date.now()
            this._fallback(msg)
          } finally {
            this._aborts.delete(ctl)
          }
        })()
      }
      terminate() {
        for (const c of this._aborts) c.abort()
        this._aborts.clear()
        this._real?.terminate()
      }
    }
    window.Worker = function (url, options) {
      let path = ""
      try { path = new URL(String(url), location.href).pathname } catch {}
      return WORKER_RE.test(path) ? new FastWorker(url, options) : new RealWorker(url, options)
    }
    window.Worker.prototype = RealWorker.prototype

    // "同步到本地": the site's normalized team + plugin game data (alternative to the game page)
    async function syncToLocal(btn) {
      const store = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get("simulator")
      if (!store) return alert("还没读到网站的队伍数据：请先打开“战斗配置”页面")
      btn.textContent = "同步中…"
      try {
        const body = {
          store: JSON.parse(JSON.stringify({ players: store.players, simulationSettings: store.simulationSettings, activePlayerId: store.activePlayerId })),
          gameDataRaw: localStorage.getItem("new_combat_game_data_v1"),
        }
        document.dispatchEvent(new CustomEvent("fastsim-site-capture", { detail: JSON.stringify(body) }))
        try {
          const r = await fetch(`${SERVER}/api/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          const out = await r.json()
          if (!r.ok || out.error) throw new Error(out.error || `HTTP ${r.status}`)
          btn.textContent = `已同步 ${out.members} 人 ✓`
        } catch {
          btn.textContent = "已保存，打开网页版工具即可导入"
        }
      } catch (e) {
        btn.textContent = "同步失败"
        alert(`同步失败：${e.message}`)
      }
      setTimeout(() => (btn.textContent = "网站队伍同步到本地"), 4000)
    }
    function addButtons() {
      if (document.getElementById("fastsim-bar")) return
      const bar = document.createElement("div")
      bar.id = "fastsim-bar"
      bar.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:99999;display:flex;gap:6px;font:13px sans-serif"
      const mk = (text, fn) => {
        const b = document.createElement("button")
        b.textContent = text
        b.style.cssText = "padding:6px 10px;border-radius:6px;border:1px solid #888;background:#1f6feb;color:#fff;cursor:pointer"
        b.onclick = () => fn(b)
        bar.appendChild(b)
      }
      mk("网站队伍同步到本地", syncToLocal)
      mk("打开工具", () => window.open(TOOL, "_blank"))
      document.body.appendChild(bar)
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButtons)
    else addButtons()
    probe().then(up => console.info(`[fastsim] 本地加速${up ? "已连接" : "未启动，使用网站原版模拟"}`))
  }
})()
