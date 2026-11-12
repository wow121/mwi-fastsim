// ==UserScript==
// @name         MWI 战斗工具 · 铁牛导入
// @name:en      MWI Combat Tools · Ironcow import
// @namespace    mwi-fastsim-ironcow
// @version      0.1.3
// @description  游戏页面：读取当前铁牛角色（战斗配置 + 生活技能、工具装备、茶、房子、社区加成），导入到 MWI 战斗工具的「铁牛模式」，和普通队伍分开保存
// @description:en Game page: reads the current ironcow character (combat setup + gathering/production skills, tools, teas, houses, community buffs) into the Ironcow mode of MWI Combat Tools, kept apart from the normal team
// 网页版：https://wow121.github.io/mwi-fastsim/ ；部署在自己的域名上、或在本机静态运行（如 http://localhost:5173）时，照下面的写法加一行 @match。
// 本地服务模式（http://127.0.0.1:8765）默认关闭：在游戏页面的油猴菜单里点「本地服务」开启，
// Tampermonkey 会询问一次是否允许访问 127.0.0.1（也可以自己在头部加 // @connect 127.0.0.1）
// @match        https://www.milkywayidle.com/*
// @match        https://milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://milkywayidlecn.com/*
// @match        https://wow121.github.io/mwi-fastsim/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @homepageURL  https://github.com/wow121/mwi-fastsim
// @updateURL    https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim-ironcow.user.js
// @downloadURL  https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim-ironcow.user.js
// ==/UserScript==

(function () {
  "use strict"
  const SERVER = "http://127.0.0.1:8765"
  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window
  const isGame = /milkywayidle(cn)?\.com$/.test(location.hostname)
  // UI text in the game's language (the tool page: its own setting): Chinese unless it is English
  const zhUI = () => {
    try {
      const l = W.localStorage.getItem("i18nextLng") || W.localStorage.getItem("fastsim-lang") || document.documentElement.lang || navigator.language || ""
      return !/^en/i.test(l)
    } catch {
      return true
    }
  }
  const L = (zh, en) => (zhUI() ? zh : en)
  // Sending to the local server is opt-in (no @connect by default): the game page's userscript menu
  // turns it on, then Tampermonkey asks once to allow 127.0.0.1. Off: no request leaves the page.
  const LOCAL_KEY = "fastsim_local_server_v1"
  const localOn = () => !!GM_getValue(LOCAL_KEY, false)
  if (isGame && typeof GM_registerMenuCommand === "function")
    GM_registerMenuCommand(localOn() ? L("本地服务：已开启（点击关闭）", "Local server: on (click to turn off)") : L("本地服务：已关闭（点击开启）", "Local server: off (click to turn on)"), () => {  // i18n-ok
      GM_setValue(LOCAL_KEY, !localOn())
      location.reload()
    })
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
      if (!localOn()) return Promise.reject(new Error("local server off"))
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
          onerror: () => reject(new Error(L("连不上本地服务", "cannot reach the local server"))),  // i18n-ok
          ontimeout: () => reject(new Error(L("本地服务超时", "local server timed out"))),  // i18n-ok
        })
      })
    }

    async function onCharacter(raw) {
      const character = compact(raw)
      const name = String(character.character?.name || "").trim()
      if (!name) return
      const mode = String(character.character?.gameMode || "")
      // a character that is known to be a normal one belongs to the main script
      if (mode && !/ironcow/i.test(mode)) return badge(L(`${name} 不是铁牛角色，未导入`, `${name} is not an ironcow character, not imported`), false)  // i18n-ok
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
        badge(L(`已导入 ${name}`, `imported ${name}`), true)  // i18n-ok
      } catch {
        // no local server: the web version picks it up when opened
        badge(L(`已读取 ${name}，打开网页版工具即可导入`, `read ${name}, open the web tool to import`), true)  // i18n-ok
      }
    }

    function badge(text, ok) {
      const add = () => {
        let b = document.getElementById("fastsim-ironcow-badge")
        if (!b) {
          b = document.createElement("div")
          b.id = "fastsim-ironcow-badge"
          b.style.cssText = "position:fixed;left:8px;bottom:36px;z-index:99999;padding:4px 8px;border-radius:6px;font:12px sans-serif;color:#fff;opacity:.9;cursor:pointer"
          b.title = L("MWI 战斗工具 · 铁牛导入，点击隐藏", "MWI Combat Tools · Ironcow import, click to hide")  // i18n-ok
          b.onclick = () => b.remove()
          document.body.appendChild(b)
        }
        b.style.background = ok ? "#8250df" : "#9a6700"
        b.textContent = L(`铁牛导入：${text}`, `Ironcow import: ${text}`)  // i18n-ok
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
    hookSocket(["init_character_data"], data => onMessage({ data }))
    setTimeout(() => {
      if (done) return
      const o = characterFromStorage()
      if (!o) return badge(L("没读到角色数据，刷新游戏页面试试", "no character data found, try reloading the game page"), false)  // i18n-ok
      done = true
      onCharacter(o)
    }, 15000)
  }

  // =====================================================================================
  // WebSocket capture. Under Tampermonkey MV3 the script runs in an isolated world and
  // unsafeWindow is a Proxy that silently drops writes, so patching WebSocket.prototype from
  // here does nothing. Instead a hook is injected into the page's own world: it replaces the
  // WebSocket constructor (every listener style goes through it, other scripts' hooks chain)
  // and hands matching frames back with a DOM event. If the page refuses inline scripts, the
  // old prototype patch is used.
  // =====================================================================================
  function hookSocket(keys, onText) {
    const EVT = `fastsim-ws-${Math.random().toString(36).slice(2)}`
    document.addEventListener(EVT, e => { if (typeof e.detail === "string") onText(e.detail) })
    const s = document.createElement("script")
    s.textContent = `(${pageSocketHook.toString()})(${JSON.stringify(EVT)}, ${JSON.stringify(keys)})`
    ;(document.head || document.documentElement).appendChild(s)
    s.remove()
    if (document.documentElement.getAttribute("data-" + EVT) === "1") return
    const WS = W.WebSocket
    const origAdd = WS.prototype.addEventListener
    const origOn = Object.getOwnPropertyDescriptor(WS.prototype, "onmessage")
    const seen = new Set()
    const listener = e => { if (typeof e.data === "string" && keys.some(k => e.data.includes(k))) onText(e.data) }
    function observe(socket) {
      if (seen.has(socket)) return
      seen.add(socket)
      origAdd.call(socket, "message", listener)
    }
    WS.prototype.addEventListener = function (type, l, options) {
      if (type === "message") observe(this)
      return origAdd.call(this, type, l, options)
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

  function pageSocketHook(EVT, KEYS) {
    const Native = window.WebSocket
    if (!Native) return
    const forward = e => {
      if (typeof e.data === "string" && KEYS.some(k => e.data.includes(k))) document.dispatchEvent(new CustomEvent(EVT, { detail: e.data }))
    }
    function WrappedWebSocket(...args) {
      const ws = Reflect.construct(Native, args, new.target && new.target !== WrappedWebSocket ? new.target : Native)
      try { ws.addEventListener("message", forward) } catch {}
      return ws
    }
    WrappedWebSocket.prototype = Native.prototype
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(WrappedWebSocket, k, { value: Native[k], enumerable: true })
    window.WebSocket = WrappedWebSocket
    document.documentElement.setAttribute("data-" + EVT, "1")
  }

  // Last resort when no init_character_data frame was seen (e.g. the hook came too late):
  // another script (MWITools etc.) may have stored it in localStorage.
  function characterFromStorage() {
    let ls = null
    try { ls = window.localStorage } catch {}
    if (!ls) return null
    for (let i = 0; i < ls.length; i++) {
      const v = ls.getItem(ls.key(i))
      if (!v || !v.includes("characterSkills")) continue
      try {
        const o = JSON.parse(v)
        if (o && typeof o === "object" && o.characterSkills && o.character) return o
      } catch {}
    }
    return null
  }
})()
