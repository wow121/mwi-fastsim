<script setup>
import { watch } from "vue"
import { rememberExtra } from "../api.js"

const e = defineModel({ required: true }) // { mooPass, comExp, comDrop }
watch(e, v => rememberExtra(v), { deep: true })
</script>

<template>
  <div class="row">
    <el-checkbox v-model="e.mooPass" size="small">Moo Pass</el-checkbox>
    <span class="muted">社区经验</span>
    <el-input-number v-model="e.comExp" :min="0" :max="20" size="small" style="width: 90px" />
    <span class="muted">社区掉落</span>
    <el-input-number v-model="e.comDrop" :min="0" :max="20" size="small" style="width: 90px" />
  </div>
</template>
