<script setup>
import { computed, onMounted, ref } from "vue"
import { useRoute } from "vue-router"
import { call, detectMode, loadState, store } from "./api.js"
import { ElMessage } from "element-plus"

const route = useRoute()
const error = ref("")
const dark = ref(localStorage.getItem("fastsim-dark") !== "0")
function applyDark() {
  document.documentElement.classList.toggle("dark", dark.value)
  localStorage.setItem("fastsim-dark", dark.value ? "1" : "0")
}
// browser mode: the userscript hands over what it captured on the game page / the sim site
async function onUserscript(e) {
  const d = e.data
  if (e.origin !== location.origin || d?.source !== "mwi-fastsim-userscript" || d.type !== "data") return
  const seen = Number(localStorage.getItem("fastsim-userscript-seen") || 0)
  const items = [["game", "/api/game", "游戏"], ["site", "/api/sync", "模拟网站"]].filter(([k]) => d[k] && d[k].capturedAt > seen)
  for (const [k, path, label] of items) {
    try {
      const r = await call("POST", path, d[k].body)
      localStorage.setItem("fastsim-userscript-seen", String(d[k].capturedAt))
      ElMessage.success(`已从${label}导入 ${r.members} 人${r.missing?.length ? `（缺：${r.missing.join("、")}）` : ""}`)
      await loadState()
      error.value = ""
    } catch (err) {
      ElMessage.error(`从${label}导入失败：${err.message}`)
    }
  }
}
onMounted(async () => {
  applyDark()
  // browser mode: listen before loading, the first game data may come from the userscript
  if ((await detectMode()) === "browser") window.addEventListener("message", onUserscript)
  try {
    await loadState()
  } catch (e) {
    error.value = e.message
  }
  if (store.mode === "browser") window.postMessage({ source: "mwi-fastsim-page", type: "hello" }, location.origin)
})
const engineLabel = e => (e.mode === "rust" ? "Rust 原生" : e.mode === "wasm" || String(e.mode).startsWith("wasm") ? "Rust wasm（浏览器）" : "原版 JS")
const SCRIPT_URL = "https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim.user.js"
const REPO_URL = "https://github.com/wow121/mwi-fastsim"
const bundledClosed = ref((() => {
  try {
    return sessionStorage.getItem("fastsim-bundled-closed") === "1"
  } catch {
    return false
  }
})())
function closeBundled() {
  bundledClosed.value = true
  try {
    sessionStorage.setItem("fastsim-bundled-closed", "1")
  } catch {}
}
const noData = computed(() => /还没有游戏数据/.test(error.value))
const menu = [
  ["/team", "队伍"], ["/simulate", "模拟"], ["/zones", "刷图推荐"], ["/skills", "技能与触发优化"],
  ["/consumables", "药水触发优化"], ["/upgrades", "整队提升规划"], ["/goal", "目标区域提升"], ["/gear-cost", "装备获取成本"], ["/queue", "批量队列"], ["/jobs", "任务"],
]
</script>

<template>
  <el-container style="height: 100%">
    <el-aside width="190px" style="border-right: 1px solid var(--el-border-color)">
      <div style="padding: 16px 16px 8px; font-weight: 600">MWI 战斗工具</div>
      <el-menu :default-active="'/' + (route.path.split('/')[1] || 'team')" router style="border: none">
        <el-menu-item v-for="[p, t] in menu" :key="p" :index="p">{{ t }}</el-menu-item>
      </el-menu>
      <div class="muted" style="padding: 12px 16px; line-height: 1.8">
        <div v-if="store.engine">引擎：{{ engineLabel(store.engine) }} · {{ store.engine.threads }} 线程</div>
        <div v-if="store.engine">游戏数据：{{ store.engine.gameVersion }}{{ store.engine.bundled ? "（内置）" : "" }}</div>
        <div v-if="store.market">市场价：{{ new Date(store.market.timestamp * 1000).toLocaleTimeString() }}</div>
        <div v-if="store.team.syncedAt">同步：{{ new Date(store.team.syncedAt).toLocaleString() }}</div>
        <el-switch v-model="dark" active-text="深色" @change="applyDark" size="small" />
        <div style="margin-top: 8px">
          <el-link type="primary" :href="SCRIPT_URL" target="_blank">安装油猴脚本</el-link>
          <span> · </span>
          <el-link :href="REPO_URL" target="_blank">GitHub</el-link>
        </div>
      </div>
    </el-aside>
    <el-main style="padding: 0">
      <el-card v-if="noData" class="page" style="margin: 16px">
        <h3 style="margin-top: 0">第一次使用：先读取游戏数据</h3>
        <ol style="line-height: 2">
          <li>浏览器安装 <el-link type="primary" href="https://www.tampermonkey.net/" target="_blank">Tampermonkey（油猴）</el-link> 扩展。</li>
          <li>点这里 <el-link type="primary" :href="SCRIPT_URL" target="_blank">安装 mwi-fastsim 油猴脚本</el-link>，在弹出的页面点「安装」。</li>
          <li>打开 <el-link href="https://www.milkywayidle.com/" target="_blank">游戏页面</el-link>（队伍里任意一个号都可以），左下角出现绿色提示就说明读到了。</li>
          <li>回到本页刷新，会自动导入队伍和游戏数据。</li>
        </ol>
        <p class="muted" style="margin-bottom: 0">所有数据只保存在你自己的浏览器里。缺哪个队友，就在游戏里点开对方的资料，脚本会自动补上。</p>
      </el-card>
      <el-alert v-if="store.engine?.bundled && !bundledClosed" type="info" show-icon @close="closeBundled"
        :title="`正在使用内置的游戏数据（${store.engine.gameVersion}），装备获取成本等功能可以直接用。模拟和优化要用你自己的队伍：安装油猴脚本后打开一次游戏页面，会自动同步最新的游戏数据和队伍。`">
        <el-link type="primary" :href="SCRIPT_URL" target="_blank">安装油猴脚本</el-link>
      </el-alert>
      <el-alert v-if="error && !noData" type="error" :title="`${store.mode === 'browser' ? '浏览器引擎启动失败' : '连接本地服务失败'}：${error}`" show-icon :closable="false" />
      <router-view v-if="store.loaded" />
      <div v-else-if="!error" class="page muted">加载中…{{ store.mode === "browser" ? "（浏览器模式：下载市场价并启动引擎，第一次要几秒）" : "" }}</div>
    </el-main>
  </el-container>
</template>
