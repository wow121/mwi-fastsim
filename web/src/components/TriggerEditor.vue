<script setup>
import { computed } from "vue"
import { store } from "../api.js"

// v-model: array of conditions | null (null = game default)
const model = defineModel()
const o = computed(() => store.options.trigger)
const useDefault = computed({
  get: () => model.value == null,
  set: v => (model.value = v ? null : []),
})
function condsFor(dep) {
  const d = o.value.dependencies.find(x => x.hrid === dep)
  return o.value.conditions.filter(c => (d?.single ? c.single : c.multi))
}
function cmpsFor(cond) {
  const c = o.value.conditions.find(x => x.hrid === cond)
  return o.value.comparators.filter(x => !c || c.comparators.includes(x.hrid))
}
const allowValue = cmp => o.value.comparators.find(x => x.hrid === cmp)?.allowValue
function add() {
  const dep = o.value.dependencies[0].hrid
  const cond = condsFor(dep)[0]?.hrid
  model.value = [...(model.value || []), { dependencyHrid: dep, conditionHrid: cond, comparatorHrid: cmpsFor(cond)[0]?.hrid, value: 0 }]
}
</script>

<template>
  <div>
    <el-checkbox v-model="useDefault" size="small">使用游戏默认条件</el-checkbox>
    <template v-if="!useDefault">
      <div v-if="!model.length" class="muted">无条件：冷却好就立即使用</div>
      <div v-for="(c, i) in model" :key="i" class="row" style="margin: 4px 0">
        <el-select v-model="c.dependencyHrid" size="small" style="width: 130px">
          <el-option v-for="d in o.dependencies" :key="d.hrid" :label="d.name" :value="d.hrid" />
        </el-select>
        <el-select v-model="c.conditionHrid" size="small" style="width: 170px" filterable>
          <el-option v-for="d in condsFor(c.dependencyHrid)" :key="d.hrid" :label="d.name" :value="d.hrid" />
        </el-select>
        <el-select v-model="c.comparatorHrid" size="small" style="width: 110px">
          <el-option v-for="d in cmpsFor(c.conditionHrid)" :key="d.hrid" :label="d.name" :value="d.hrid" />
        </el-select>
        <el-input-number v-if="allowValue(c.comparatorHrid)" v-model="c.value" size="small" style="width: 110px" :controls="false" />
        <el-button size="small" text type="danger" @click="model.splice(i, 1)">删除</el-button>
      </div>
      <el-button v-if="model.length < 4" size="small" @click="add">添加条件</el-button>
    </template>
  </div>
</template>
