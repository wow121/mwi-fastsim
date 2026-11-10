<script setup>
import { computed, onMounted, ref, watchEffect } from "vue"
import { useRoute } from "vue-router"
import { call, changeLang, detectMode, loadState, store } from "./api.js"
import { dateTime, joinList, lang, t, timeOnly, tk } from "./i18n.js"
import zhCn from "element-plus/es/locale/lang/zh-cn"
import enEl from "element-plus/es/locale/lang/en"
import { ElMessage } from "element-plus"
import { commit, releases, version } from "./changelog.js"

const route = useRoute()
const elLocale = computed(() => (lang.value === "en" ? enEl : zhCn))
watchEffect(() => (document.title = t("MWI 战斗工具")))
const switching = ref(false)
async function switchLang(v) {
  switching.value = true
  try {
    await changeLang(v)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    switching.value = false
  }
}
const error = ref("")
const dark = ref(localStorage.getItem("fastsim-dark") !== "0")
function applyDark() {
  document.documentElement.classList.toggle("dark", dark.value)
  localStorage.setItem("fastsim-dark", dark.value ? "1" : "0")
}
// browser mode: the userscript hands over what it captured on the game page / the sim site
async function onUserscript(e) {
  const d = e.data
  if (e.origin === location.origin && d?.source === "mwi-fastsim-ironcow-userscript" && d.type === "ironcow") return onIroncow(d)
  if (e.origin !== location.origin || d?.source !== "mwi-fastsim-userscript" || d.type !== "data") return
  const seen = Number(localStorage.getItem("fastsim-userscript-seen") || 0)
  const items = [["game", "/api/game", tk("游戏")], ["site", "/api/sync", tk("模拟网站")]].filter(([k]) => d[k] && d[k].capturedAt > seen)
  for (const [k, path, label] of items) {
    try {
      const r = await call("POST", path, d[k].body)
      localStorage.setItem("fastsim-userscript-seen", String(d[k].capturedAt))
      ElMessage.success(t("已从{label}导入 {n} 人", { label: t(label), n: r.members }) + (r.missing?.length ? t("（缺：{list}）", { list: joinList(r.missing) }) : ""))
      await loadState()
      error.value = ""
    } catch (err) {
      ElMessage.error(t("从{label}导入失败：{msg}", { label: t(label), msg: err.message }))
    }
  }
}
// browser mode: characters captured by the separate ironcow userscript go to the ironcow team
async function onIroncow(d) {
  const seen = Number(localStorage.getItem("fastsim-ironcow-seen") || 0)
  const fresh = (d.captures || []).filter(c => c?.character && c.capturedAt > seen).sort((a, b) => a.capturedAt - b.capturedAt)
  let clientData = d.initClientData
  for (const c of fresh) {
    try {
      await call("POST", "/api/ironcow/game", { character: c.character, initClientData: clientData || undefined })
      clientData = null
      localStorage.setItem("fastsim-ironcow-seen", String(c.capturedAt))
      ElMessage.success(t("铁牛：已导入 {name}", { name: c.name }))
    } catch (err) {
      ElMessage.error(t("铁牛导入 {name} 失败：{msg}", { name: c.name, msg: err.message }))
    }
  }
  if (fresh.length) window.dispatchEvent(new Event("fastsim-ironcow-updated"))
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
const engineLabel = e => (e.mode === "rust" ? t("Rust 原生") : e.mode === "wasm" || String(e.mode).startsWith("wasm") ? t("Rust wasm（浏览器）") : t("原版 JS"))
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
// matched in both languages (the message comes from the backend in the page's language)
const noData = computed(() => /还没有游戏数据|No game data yet/.test(error.value)) // i18n-ok
const menu = [
  ["/team", tk("队伍")], ["/simulate", tk("模拟")], ["/zones", tk("刷图推荐")], ["/skills", tk("技能与触发优化")],
  ["/consumables", tk("药水触发优化")], ["/upgrades", tk("整队提升规划")], ["/goal", tk("目标区域提升")], ["/stat-value", tk("属性价值")], ["/scrolls", tk("卷轴价值")], ["/gear-cost", tk("装备获取成本")], ["/labyrinth", tk("迷宫配置推荐")], ["/queue", tk("批量队列")], ["/jobs", tk("任务")],
]
// Ironcow (铁牛) mode lives apart from the market-based pages; titles are t() keys
const ironMenu = [["/ironcow", tk("铁牛模式")]]

// release notes: "新" until the current version's notes have been opened once
const showLog = ref(false)
const lastSeen = ref((() => {
  try {
    return localStorage.getItem("fastsim-seen-version")
  } catch {
    return version
  }
})())
const isNew = computed(() => lastSeen.value !== null && lastSeen.value !== version)
function openLog() {
  showLog.value = true
  lastSeen.value = version
  try {
    localStorage.setItem("fastsim-seen-version", version)
  } catch {}
}
// first visit: nothing to announce, remember the version silently
if (lastSeen.value === null) {
  lastSeen.value = version
  try {
    localStorage.setItem("fastsim-seen-version", version)
  } catch {}
}
</script>

<template>
  <el-config-provider :locale="elLocale">
  <el-container style="height: 100%">
    <el-aside width="190px" style="border-right: 1px solid var(--el-border-color)">
      <div style="padding: 16px 16px 8px">
        <div style="font-weight: 600">{{ t("MWI 战斗工具") }}</div>
        <el-link :underline="false" class="muted" @click="openLog" :title="commit ? t('构建 {commit}，点击查看更新日志', { commit }) : t('点击查看更新日志')">{{ version }}</el-link>
        <el-tag v-if="isNew" type="danger" size="small" effect="dark" round style="margin-left: 6px; cursor: pointer" @click="openLog">{{ t("新") }}</el-tag>
      </div>
      <el-menu :default-active="'/' + (route.path.split('/')[1] || 'team')" router style="border: none">
        <el-menu-item v-for="[p, title] in menu" :key="p" :index="p">{{ t(title) }}</el-menu-item>
        <el-menu-item-group :title="t('铁牛')">
          <el-menu-item v-for="[p, title] in ironMenu" :key="p" :index="p">{{ t(title) }}</el-menu-item>
        </el-menu-item-group>
      </el-menu>
      <div class="muted" style="padding: 12px 16px; line-height: 1.8">
        <div v-if="store.engine">{{ t("引擎：{engine} · {n} 线程", { engine: engineLabel(store.engine), n: store.engine.threads }) }}</div>
        <div v-if="store.engine">{{ t("游戏数据：") }}{{ store.engine.gameVersion }}{{ store.engine.bundled ? t("（内置）") : "" }}</div>
        <div v-if="store.market">{{ t("市场价：") }}{{ timeOnly(store.market.timestamp * 1000) }}</div>
        <div v-if="store.team.syncedAt">{{ t("同步：") }}{{ dateTime(store.team.syncedAt) }}</div>
        <el-switch v-model="dark" :active-text="t('深色')" @change="applyDark" size="small" />
        <el-radio-group :model-value="lang" size="small" :disabled="switching" style="margin-left: 12px; vertical-align: middle" @change="switchLang">
          <el-radio-button value="zh">中文</el-radio-button><!-- i18n-ok: language names stay in their own language -->
          <el-radio-button value="en">EN</el-radio-button>
        </el-radio-group>
        <div style="margin-top: 8px">
          <el-link type="primary" :href="SCRIPT_URL" target="_blank">{{ t("安装油猴脚本") }}</el-link>
          <span> · </span>
          <el-link :href="REPO_URL" target="_blank">GitHub</el-link>
          <span> · </span>
          <el-link @click="openLog">{{ t("更新日志") }}</el-link>
        </div>
        <div>{{ t("如需反馈，游戏中私聊 Dawant，有空会处理") }}</div>
      </div>
    </el-aside>
    <el-main style="padding: 0">
      <el-card v-if="noData" class="page" style="margin: 16px">
        <h3 style="margin-top: 0">{{ t("第一次使用：先读取游戏数据") }}</h3>
        <ol style="line-height: 2">
          <li>{{ t("浏览器安装") }} <el-link type="primary" href="https://www.tampermonkey.net/" target="_blank">{{ t("Tampermonkey（油猴）") }}</el-link> {{ t("扩展。") }}</li>
          <li>{{ t("点这里") }} <el-link type="primary" :href="SCRIPT_URL" target="_blank">{{ t("安装 mwi-fastsim 油猴脚本") }}</el-link>{{ t("，在弹出的页面点「安装」。") }}</li>
          <li>{{ t("打开") }} <el-link href="https://www.milkywayidle.com/" target="_blank">{{ t("游戏页面") }}</el-link>{{ t("（队伍里任意一个号都可以），左下角出现绿色提示就说明读到了。") }}</li>
          <li>{{ t("回到本页刷新，会自动导入队伍和游戏数据。") }}</li>
        </ol>
        <p class="muted" style="margin-bottom: 0">{{ t("所有数据只保存在你自己的浏览器里。缺哪个队友，就在游戏里点开对方的资料，脚本会自动补上。") }}</p>
      </el-card>
      <el-alert v-if="store.engine?.bundled && !bundledClosed" type="info" show-icon @close="closeBundled"
        :title="t('正在使用内置的游戏数据（{v}），装备获取成本等功能可以直接用。模拟和优化要用你自己的队伍：安装油猴脚本后打开一次游戏页面，会自动同步最新的游戏数据和队伍。', { v: store.engine.gameVersion })">
        <el-link type="primary" :href="SCRIPT_URL" target="_blank">{{ t("安装油猴脚本") }}</el-link>
      </el-alert>
      <el-alert v-if="error && !noData" type="error" :title="(store.mode === 'browser' ? t('浏览器引擎启动失败') : t('连接本地服务失败')) + t('：') + error" show-icon :closable="false" />
      <!-- keyed by language: pages remount and fetch their names again after a switch -->
      <router-view v-if="store.loaded" v-slot="{ Component }">
        <component :is="Component" :key="lang" />
      </router-view>
      <div v-else-if="!error" class="page muted">{{ t("加载中…") }}{{ store.mode === "browser" ? t("（浏览器模式：下载市场价并启动引擎，第一次要几秒）") : "" }}</div>
    </el-main>
  </el-container>
  <el-dialog v-model="showLog" :title="t('更新日志')" width="min(640px, 92vw)">
    <div class="muted" style="margin-top: -8px; margin-bottom: 8px">{{ t("当前版本 {v}", { v: version }) }}{{ commit ? t("（构建 {commit}）", { commit }) : "" }}</div>
    <div v-if="lang === 'en'" class="muted" style="margin-bottom: 8px">{{ t("更新日志只有中文。") }}</div>
    <div v-for="r in releases" :key="r.version" style="margin-bottom: 12px">
      <div style="font-weight: 600">{{ r.version }} <span class="muted" style="font-weight: normal">{{ r.date }}</span></div>
      <div v-for="(t, i) in r.intro" :key="`p${i}`" style="margin: 4px 0; line-height: 1.7">{{ t }}</div>
      <ul style="margin: 4px 0; padding-left: 20px; line-height: 1.7">
        <li v-for="(t, i) in r.items" :key="i">
          {{ t.text }}
          <ul v-if="t.sub.length" style="margin: 2px 0; padding-left: 18px">
            <li v-for="(x, j) in t.sub" :key="j">{{ x }}</li>
          </ul>
        </li>
      </ul>
    </div>
  </el-dialog>
  </el-config-provider>
</template>
