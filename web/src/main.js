import { createApp } from "vue"
import { createRouter, createWebHashHistory } from "vue-router"
import ElementPlus, { ElMessageBox } from "element-plus"
import zhCn from "element-plus/es/locale/lang/zh-cn"
import "element-plus/dist/index.css"
import "element-plus/theme-chalk/dark/css-vars.css"
import App from "./App.vue"
import "./style.css"

const routes = [
  { path: "/", redirect: "/team" },
  { path: "/team", component: () => import("./pages/Team.vue"), meta: { title: "队伍" } },
  { path: "/simulate", component: () => import("./pages/Simulate.vue"), meta: { title: "模拟" } },
  { path: "/zones", component: () => import("./pages/Zones.vue"), meta: { title: "刷图推荐" } },
  { path: "/skills", component: () => import("./pages/Skills.vue"), meta: { title: "技能与触发优化" } },
  { path: "/consumables", component: () => import("./pages/Consumables.vue"), meta: { title: "药水触发优化" } },
  { path: "/goal", component: () => import("./pages/Goal.vue"), meta: { title: "目标区域提升" } },
  { path: "/upgrades", component: () => import("./pages/Upgrades.vue"), meta: { title: "整队提升规划" } },
  { path: "/gear-cost", component: () => import("./pages/GearCost.vue"), meta: { title: "装备获取成本" } },
  { path: "/ironcow", component: () => import("./pages/Ironcow.vue"), meta: { title: "铁牛模式" } },
  { path: "/stat-value", component: () => import("./pages/StatValue.vue"), meta: { title: "属性价值" } },
  { path: "/scrolls", component: () => import("./pages/Scrolls.vue"), meta: { title: "卷轴价值" } },
  { path: "/labyrinth", component: () => import("./pages/Labyrinth.vue"), meta: { title: "迷宫配置推荐" } },
  { path: "/queue", component: () => import("./pages/Queue.vue"), meta: { title: "批量队列" } },
  { path: "/jobs/:id?", component: () => import("./pages/Jobs.vue"), meta: { title: "任务" } },
]

const router = createRouter({ history: createWebHashHistory(), routes })

// A tab opened before a new deploy still refers to the old page chunks, which the deploy
// removed: the import fails and the menu seems dead. Offer a reload (not automatic: in
// browser mode a reload stops the running jobs).
let askingReload = false
function offerReload(path) {
  if (askingReload) return
  askingReload = true
  ElMessageBox.confirm("网页版已更新，需要刷新页面才能继续。刷新会中断正在运行的任务。", "有新版本", {
    confirmButtonText: "刷新",
    cancelButtonText: "稍后",
    type: "info",
  }).then(() => {
    if (path) location.hash = path
    location.reload()
  }).catch(() => {}).finally(() => (askingReload = false))
}
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Failed to fetch|Unable to preload CSS|error loading dynamically/i
router.onError((err, to) => {
  if (CHUNK_ERROR.test(String(err?.message || err))) offerReload(to?.fullPath)
  else console.error(err)
})
window.addEventListener("vite:preloadError", e => {
  e.preventDefault()
  offerReload()
})

createApp(App).use(router).use(ElementPlus, { locale: zhCn }).mount("#app")
