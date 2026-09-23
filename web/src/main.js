import { createApp } from "vue"
import { createRouter, createWebHashHistory } from "vue-router"
import ElementPlus from "element-plus"
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
  { path: "/queue", component: () => import("./pages/Queue.vue"), meta: { title: "批量队列" } },
  { path: "/jobs/:id?", component: () => import("./pages/Jobs.vue"), meta: { title: "任务" } },
]

const router = createRouter({ history: createWebHashHistory(), routes })
createApp(App).use(router).use(ElementPlus, { locale: zhCn }).mount("#app")
