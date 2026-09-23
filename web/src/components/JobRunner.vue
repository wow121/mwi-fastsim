<script setup>
import { onMounted, onUnmounted, ref } from "vue"
import { call } from "../api.js"

// Starts a server job, polls it, exposes the latest result. Remembers the last job per `name`
// so the page shows it again after navigation.
const props = defineProps({ name: String, type: String, params: Function, label: { type: String, default: "开始" } })
const emit = defineEmits(["result"])
const job = ref(null)
let timer = null

async function poll(id) {
  clearTimeout(timer)
  try {
    job.value = await call("GET", `/api/jobs/${id}`)
    if (job.value.result) emit("result", job.value.result, job.value)
    if (job.value.status === "running") timer = setTimeout(() => poll(id), 800)
  } catch {
    job.value = null
  }
}
async function start() {
  const params = await props.params()
  if (!params) return
  const { id } = await call("POST", "/api/jobs", { type: props.type, params })
  localStorage.setItem(`fastsim-job-${props.name}`, id)
  poll(id)
}
async function cancel() {
  if (job.value) await call("POST", `/api/jobs/${job.value.id}/cancel`)
}
onMounted(() => {
  const id = localStorage.getItem(`fastsim-job-${props.name}`)
  if (id) poll(id)
})
onUnmounted(() => clearTimeout(timer))
const statusText = { running: "运行中", done: "完成", error: "出错", cancelled: "已取消", interrupted: "中断（服务重启）" }
</script>

<template>
  <div>
    <div class="row">
      <el-button type="primary" :disabled="job?.status === 'running'" @click="start">{{ label }}</el-button>
      <el-button v-if="job?.status === 'running'" @click="cancel">取消</el-button>
      <span v-if="job" class="muted">
        {{ statusText[job.status] || job.status }} · {{ job.progress?.stage }}
        <template v-if="job.progress?.total"> · {{ job.progress.done }}/{{ job.progress.total }}</template>
        <template v-if="job.finishedAt"> · 用时 {{ ((job.finishedAt - job.createdAt) / 1000).toFixed(1) }} 秒</template>
      </span>
    </div>
    <el-progress v-if="job?.status === 'running' && job.progress?.total" :percentage="Math.round((100 * job.progress.done) / job.progress.total)" style="margin-top: 8px" />
    <el-alert v-if="job?.status === 'error'" type="error" :title="job.error?.split('\n')[0]" :closable="false" style="margin-top: 8px" />
    <el-collapse v-if="job?.log?.length" style="margin-top: 8px">
      <el-collapse-item :title="`日志（${job.log.length}）`">
        <div v-for="(l, i) in job.log" :key="i" class="muted" style="white-space: pre-wrap">{{ l.msg }}</div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>
