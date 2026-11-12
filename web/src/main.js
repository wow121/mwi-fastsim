import { createApp } from "vue"
import { createRouter, createWebHashHistory } from "vue-router"
import ElementPlus, { ElMessageBox } from "element-plus"
import "element-plus/dist/index.css"
import "element-plus/theme-chalk/dark/css-vars.css"
import App from "./App.vue"
import { t } from "./i18n.js"
import "./style.css"

const routes = [
  { path: "/", redirect: "/team" },
  { path: "/team", component: () => import("./pages/Team.vue") },
  { path: "/simulate", component: () => import("./pages/Simulate.vue") },
  { path: "/zones", component: () => import("./pages/Zones.vue") },
  { path: "/skills", component: () => import("./pages/Skills.vue") },
  { path: "/consumables", component: () => import("./pages/Consumables.vue") },
  { path: "/goal", component: () => import("./pages/Goal.vue") },
  { path: "/upgrades", component: () => import("./pages/Upgrades.vue") },
  { path: "/gear-cost", component: () => import("./pages/GearCost.vue") },
  { path: "/ironcow", component: () => import("./pages/Ironcow.vue") },
  { path: "/stat-value", component: () => import("./pages/StatValue.vue") },
  { path: "/scrolls", component: () => import("./pages/Scrolls.vue") },
  { path: "/talisman", component: () => import("./pages/Talisman.vue") },
  { path: "/labyrinth", component: () => import("./pages/Labyrinth.vue") },
  { path: "/queue", component: () => import("./pages/Queue.vue") },
  { path: "/jobs/:id?", component: () => import("./pages/Jobs.vue") },
]

const router = createRouter({ history: createWebHashHistory(), routes })

// A tab opened before a new deploy still refers to the old page chunks, which the deploy
// removed: the import fails and the menu seems dead. Offer a reload (not automatic: in
// browser mode a reload stops the running jobs).
let askingReload = false
function offerReload(path) {
  if (askingReload) return
  askingReload = true
  ElMessageBox.confirm(t("网页版已更新，需要刷新页面才能继续。刷新会中断正在运行的任务。"), t("有新版本"), {
    confirmButtonText: t("刷新"),
    cancelButtonText: t("稍后"),
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

// Element Plus's own texts follow the language through <el-config-provider> in App.vue
createApp(App).use(router).use(ElementPlus).mount("#app")
