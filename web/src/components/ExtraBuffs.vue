<script setup>
import { watch } from "vue"
import { rememberExtra, store } from "../api.js"

const e = defineModel({ required: true }) // { mooPass, comExp, comDrop, seals: [scroll key] }
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
  <div class="row" style="margin-top: 4px">
    <span class="muted" title="全队每人都开着所选卷轴；迷宫里不生效">卷轴</span>
    <el-checkbox-group v-model="e.seals" size="small">
      <el-checkbox v-for="s in store.options?.seals || []" :key="s.key" :value="s.key">{{ s.name }}</el-checkbox>
    </el-checkbox-group>
  </div>
</template>
