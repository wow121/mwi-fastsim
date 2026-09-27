// ==UserScript==
// @name         MWI 战斗工具 · 铁牛导入
// @namespace    mwi-fastsim-ironcow
// @version      0.1.0
// @description  游戏页面：读取当前铁牛角色（战斗配置 + 生活技能、工具装备、茶、房子、社区加成），导入到 MWI 战斗工具的「铁牛模式」，和普通队伍分开保存
// 网页版：https://wow121.github.io/mwi-fastsim/ ；部署在自己的域名上时，照下面的写法加一行 @match
// @match        https://www.milkywayidle.com/*
// @match        https://milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://milkywayidlecn.com/*
// @match        https://wow121.github.io/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @homepageURL  https://github.com/wow121/mwi-fastsim
// @updateURL    https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim-ironcow.user.js
// @downloadURL  https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim-ironcow.user.js
// ==/UserScript==

(function () {
  "use strict"
  const SERVER = "http://127.0.0.1:8765"
  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window
  const isGame = /milkywayidle(cn)?\.com$/.test(location.hostname)
  // captured characters by name (several ironcow accounts can be kept) and the latest game data
  const CAPTURES = "fastsim_ironcow_captures_v1"
  const CLIENT_DATA = "fastsim_ironcow_client_data_v1"
  // what the ironcow import needs of the logged-in character (init_character_data)
  const FIELDS = ["character", "characterSkills", "characterItems", "combatUnit", "characterAbilities", "characterAbilityMap", "abilityMap", "combatAbilityMap",
    "actionTypeFoodSlotsMap", "actionTypeDrinkSlotsMap", "consumableCombatTriggersMap", "abilityCombatTriggersMap", "characterHouseRoomMap",
    "characterAchievements", "characterGuildBuffMap", "guildBuildingLevelMap", "communityBuffTypeMap", "communityBuffMap", "communityBuffs"]

  if (isGame) gamePage()
  else toolPage()

  // =====================================================================================
  // The tool page (browser mode): hand over the captures when the page says hello.
  // =====================================================================================
  function toolPage() {
    W.addEventListener("message", e => {
      if (e.origin !== location.origin || e.data?.source !== "mwi-fastsim-page" || e.data.type !== "hello") return
      const data = { source: "mwi-fastsim-ironcow-userscript", type: "ironcow", captures: Object.values(GM_getValue(CAPTURES, {}) || {}), initClientData: GM_getValue(CLIENT_DATA, null) }
      W.postMessage(JSON.parse(JSON.stringify(data)), location.origin)
    })
  }

  // =====================================================================================
  // Game page
  // =====================================================================================
  function gamePage() {
    let lastClientData = null

    function compact(raw) {
      const out = {}
      for (const k of FIELDS) if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = JSON.parse(JSON.stringify(raw[k]))
      // worn gear and tools only; the inventory is not needed
      if (Array.isArray(out.characterItems)) out.characterItems = out.characterItems.filter(i => i && i.itemLocationHrid && i.itemLocationHrid !== "/item_locations/inventory")
      return out
    }

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
          onerror: () => reject(new Error("连不上本地服务")),
          ontimeout: () => reject(new Error("本地服务超时")),
        })
      })
    }

    async function onCharacter(raw) {
      const character = compact(raw)
      const name = String(character.character?.name || "").trim()
      if (!name) return
      const mode = String(character.character?.gameMode || "")
      // a character that is known to be a normal one belongs to the main script
      if (mode && !/ironcow/i.test(mode)) return badge(`${name} 不是铁牛角色，未导入`, false)
      const captures = GM_getValue(CAPTURES, {}) || {}
      captures[name] = { name, capturedAt: Date.now(), character }
      GM_setValue(CAPTURES, captures)
      let initClientData = null
      try { initClientData = W.localStorage.getItem("initClientData") } catch {}
      if (initClientData) GM_setValue(CLIENT_DATA, initClientData)
      const body = { character }
      if (initClientData && initClientData !== lastClientData) body.initClientData = initClientData
      try {
        await post("/api/ironcow/game", body)
        if (body.initClientData) lastClientData = initClientData
        badge(`已导入 ${name}`, true)
      } catch {
        // no local server: the web version picks it up when opened
        badge(`已读取 ${name}，打开网页版工具即可导入`, true)
      }
    }

    function badge(text, ok) {
      const add = () => {
        let b = document.getElementById("fastsim-ironcow-badge")
        if (!b) {
          b = document.createElement("div")
          b.id = "fastsim-ironcow-badge"
          b.style.cssText = "position:fixed;left:8px;bottom:36px;z-index:99999;padding:4px 8px;border-radius:6px;font:12px sans-serif;color:#fff;opacity:.9;cursor:pointer"
          b.title = "MWI 战斗工具 · 铁牛导入，点击隐藏"
          b.onclick = () => b.remove()
          document.body.appendChild(b)
        }
        b.style.background = ok ? "#8250df" : "#9a6700"
        b.textContent = `铁牛导入：${text}`
      }
      if (document.body) add()
      else document.addEventListener("DOMContentLoaded", add, { once: true })
    }

    // --- WebSocket capture ----------------------------------------------------------------
    let done = false
    function onMessage(event) {
      if (done || typeof event.data !== "string" || !event.data.includes("init_character_data")) return
      try {
        const o = JSON.parse(event.data)
        if (o.type !== "init_character_data") return
        done = true
        setTimeout(() => onCharacter(o), 1000) // let the game store initClientData first
      } catch (e) {
        console.error("[fastsim-ironcow] init_character_data", e)
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
})()
