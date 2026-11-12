<script setup>
import { onMounted, onUnmounted, ref } from "vue"
import { call } from "../api.js"
import { dateTime, t, tk } from "../i18n.js"
import JobProgress from "../components/JobProgress.vue"

const jobs = ref([])
let timer = null
async function refresh() {
  jobs.value = await call("GET", "/api/jobs")
  timer = setTimeout(refresh, 2000)
}
onMounted(refresh)
onUnmounted(() => clearTimeout(timer))
const statusText = { running: tk("运行中"), done: tk("完成"), error: tk("出错"), cancelled: tk("已取消"), interrupted: tk("中断") }
const page = {
  skills: "/skills", consumables: "/consumables", upgrades: "/upgrades", goal: "/goal", zones: "/zones", queue: "/queue", labyrinth: "/labyrinth",
  statvalue: "/stat-value", scrolls: "/scrolls", talisman: "/talisman", "ironcow-zones": "/ironcow", "ironcow-skills": "/ironcow", "ironcow-consumables": "/ironcow",
}
async function cancel(j) {
  await call("POST", `/api/jobs/${j.id}/cancel`)
}
async function remove(j) {
  await call("DELETE", `/api/jobs/${j.id}`)
  jobs.value = jobs.value.filter(x => x.id !== j.id)
}
function open(j) {
  localStorage.setItem(`fastsim-job-${j.type}`, j.id)
}
</script>

<template>
  <div class="page">
    <h2>{{ t("任务") }}</h2>
    <el-table :data="jobs" size="small" :empty-text="t('还没有任务')">
      <!-- titles are t() keys (job types) or text the page already translated -->
      <el-table-column :label="t('任务')" min-width="160"><template #default="{ row }">{{ t(row.title) }}</template></el-table-column>
      <el-table-column :label="t('状态')" width="90"><template #default="{ row }">{{ statusText[row.status] ? t(statusText[row.status]) : row.status }}</template></el-table-column>
      <el-table-column :label="t('进度')" min-width="260">
        <template #default="{ row }">
          {{ row.progress?.stage }}<template v-if="row.status === 'running' && row.progress?.total"> · {{ row.progress.done }}/{{ row.progress.total }}</template>
          <JobProgress v-if="row.status === 'running'" :progress="row.progress" compact />
        </template>
      </el-table-column>
      <el-table-column :label="t('开始#time')" width="170"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column>
      <el-table-column :label="t('用时')" width="90" align="right"><template #default="{ row }">{{ row.finishedAt ? t("{s} 秒", { s: ((row.finishedAt - row.createdAt) / 1000).toFixed(0) }) : "" }}</template></el-table-column>
      <el-table-column width="200">
        <template #default="{ row }">
          <router-link v-if="page[row.type]" :to="page[row.type]" @click="open(row)"><el-button size="small" text type="primary">{{ t("查看") }}</el-button></router-link>
          <el-button v-if="row.status === 'running'" size="small" text @click="cancel(row)">{{ t("取消") }}</el-button>
          <el-button v-else size="small" text type="danger" @click="remove(row)">{{ t("删除") }}</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
