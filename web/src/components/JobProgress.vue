<script setup>
import { computed } from "vue"
import { t, tk } from "../i18n.js"

// Overall progress bar and time left of a running job (see node/app/job-progress.mjs).
const props = defineProps({ progress: Object, compact: Boolean })
const BASIS = { same: tk("按上次同参数的任务"), estimate: tk("按预估工作量"), stage: tk("按当前阶段") }
const pct = computed(() => (props.progress?.overall == null ? null : Math.floor(props.progress.overall * 100)))
const left = computed(() => {
  const ms = props.progress?.eta
  if (ms == null) return t("剩余时间估算中")
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return t("剩余约 {time}", { time: h ? t("{h} 小时 {m} 分", { h, m }) : m ? t("{m} 分 {s} 秒", { m, s: s % 60 }) : t("{s} 秒", { s }) })
})
</script>

<template>
  <div v-if="progress" :class="compact ? 'jp-compact' : 'jp'">
    <el-progress v-if="pct != null" :percentage="pct" :stroke-width="compact ? 6 : 10" />
    <div class="muted">
      {{ left }}<template v-if="progress.eta != null && BASIS[progress.basis]">{{ t("（{x}）", { x: t(BASIS[progress.basis]) }) }}</template>
      <template v-if="!compact && progress.simHours"> · {{ t("已模拟 {n} 小时", { n: Math.round(progress.simHours).toLocaleString() }) }}</template>
    </div>
  </div>
</template>

<style scoped>
.jp { margin-top: 8px; }
.jp-compact :deep(.el-progress__text) { font-size: 12px !important; }
</style>
