<script setup>
import { onMounted, ref } from "vue"
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
        <div v-if="store.engine">游戏数据：{{ store.engine.gameVersion }}</div>
        <div v-if="store.market">市场价：{{ new Date(store.market.timestamp * 1000).toLocaleTimeString() }}</div>
        <div v-if="store.team.syncedAt">同步：{{ new Date(store.team.syncedAt).toLocaleString() }}</div>
        <el-switch v-model="dark" active-text="深色" @change="applyDark" size="small" />
      </div>
    </el-aside>
    <el-main style="padding: 0">
      <el-alert v-if="error" type="error" :title="`${store.mode === 'browser' ? '浏览器引擎启动失败' : '连接本地服务失败'}：${error}`" show-icon :closable="false" />
      <router-view v-if="store.loaded" />
      <div v-else-if="!error" class="page muted">加载中…{{ store.mode === "browser" ? "（浏览器模式：下载模拟脚本、市场价并启动引擎，第一次要几秒）" : "" }}</div>
    </el-main>
  </el-container>
</template>
