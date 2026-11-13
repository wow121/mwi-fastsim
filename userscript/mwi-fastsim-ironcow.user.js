// ==UserScript==
// @name         MWI 战斗工具 · 铁牛导入（已并入主脚本，可卸载）
// @name:en      MWI Combat Tools · Ironcow import (merged into the main script, uninstall)
// @namespace    mwi-fastsim-ironcow
// @version      0.2.0
// @description  已停用：铁牛角色（连同点开过资料的队友）现在由「MWI 战斗工具」主脚本读取。装好主脚本后卸载本脚本。
// @description:en Retired: ironcow characters (and the teammates whose profiles you open) are now read by the main "MWI Combat Tools" script. Install it and uninstall this one.
// @match        https://www.milkywayidle.com/*
// @match        https://milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @match        https://milkywayidlecn.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/wow121/mwi-fastsim
// @updateURL    https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim-ironcow.user.js
// @downloadURL  https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim-ironcow.user.js
// ==/UserScript==

// Since main script 0.5.0 the ironcow import lives in mwi-fastsim.user.js (one script for both
// kinds of characters). This stub only points users who installed nothing else to it.
(function () {
  "use strict"
  const MAIN = "https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim.user.js"
  let zh = true
  try { zh = !/^en/i.test(localStorage.getItem("i18nextLng") || document.documentElement.lang || navigator.language || "") } catch {}
  setTimeout(() => {
    const hasMain = document.documentElement.hasAttribute("data-fastsim-main")
    const b = document.createElement("a")
    b.href = MAIN
    b.target = "_blank"
    b.style.cssText = "position:fixed;left:8px;bottom:36px;z-index:99999;padding:4px 8px;border-radius:6px;font:12px sans-serif;color:#fff;background:#9a6700;opacity:.9;text-decoration:none"
    b.textContent = hasMain
      ? (zh ? "铁牛导入已并入「MWI 战斗工具」主脚本，可以卸载本脚本" : "Ironcow import is now part of the main MWI Combat Tools script; you can uninstall this one")
      : (zh ? "铁牛导入已并入「MWI 战斗工具」主脚本：点这里安装，再卸载本脚本" : "Ironcow import moved into the main MWI Combat Tools script: click to install it, then uninstall this one")
    b.onclick = e => { if (hasMain) { e.preventDefault(); b.remove() } }
    document.body.appendChild(b)
  }, 5000)
})()
