<script setup>
import { onMounted, onUnmounted, ref } from "vue"
import { call } from "../api.js"

const jobs = ref([])
let timer = null
async function refresh() {
  jobs.value = await call("GET", "/api/jobs")
  timer = setTimeout(refresh, 2000)
}
onMounted(refresh)
onUnmounted(() => clearTimeout(timer))
const statusText = { running: "运行中", done: "完成", error: "出错", cancelled: "已取消", interrupted: "中断" }
const page = { skills: "/skills", consumables: "/consumables", upgrades: "/upgrades", zones: "/zones", queue: "/queue" }
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
    <h2>任务</h2>
    <el-table :data="jobs" size="small" empty-text="还没有任务">
      <el-table-column prop="title" label="任务" min-width="160" />
      <el-table-column label="状态" width="90"><template #default="{ row }">{{ statusText[row.status] || row.status }}</template></el-table-column>
      <el-table-column label="进度" min-width="220">
        <template #default="{ row }">{{ row.progress?.stage }}<template v-if="row.status === 'running' && row.progress?.total"> · {{ row.progress.done }}/{{ row.progress.total }}</template></template>
      </el-table-column>
      <el-table-column label="开始" width="170"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
      <el-table-column label="用时" width="90" align="right"><template #default="{ row }">{{ row.finishedAt ? `${((row.finishedAt - row.createdAt) / 1000).toFixed(0)} 秒` : "" }}</template></el-table-column>
      <el-table-column width="200">
        <template #default="{ row }">
          <router-link :to="page[row.type]" @click="open(row)"><el-button size="small" text type="primary">查看</el-button></router-link>
          <el-button v-if="row.status === 'running'" size="small" text @click="cancel(row)">取消</el-button>
          <el-button v-else size="small" text type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
