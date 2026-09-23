<script setup>
import { computed, watch } from "vue"
import { rememberTarget, store } from "../api.js"

// v-model: { kind: "zone", zoneHrid, difficultyTier } | { kind: "labyrinth", labyrinthHrid, roomLevel }
const t = defineModel({ required: true })
const props = defineProps({ remember: { type: Boolean, default: true } })
watch(t, v => props.remember && rememberTarget(v), { deep: true })
const o = computed(() => store.options)
const zoneList = computed(() => [
  { label: "区域", options: o.value.zones },
  { label: "地下城", options: o.value.dungeons },
])
const maxTier = computed(() => [...o.value.zones, ...o.value.dungeons].find(z => z.hrid === t.value.zoneHrid)?.maxDifficulty ?? 0)
function setKind(k) {
  t.value = k === "labyrinth"
    ? { kind: "labyrinth", labyrinthHrid: o.value.labyrinths[0]?.hrid, roomLevel: 100 }
    : { kind: "zone", zoneHrid: o.value.zones[0]?.hrid, difficultyTier: 0 }
}
</script>

<template>
  <div class="row">
    <el-radio-group :model-value="t.kind" size="small" @update:model-value="setKind">
      <el-radio-button value="zone">区域/地下城</el-radio-button>
      <el-radio-button value="labyrinth">迷宫</el-radio-button>
    </el-radio-group>
    <template v-if="t.kind === 'zone'">
      <el-select v-model="t.zoneHrid" filterable style="width: 220px" size="small">
        <el-option-group v-for="g in zoneList" :key="g.label" :label="g.label">
          <el-option v-for="z in g.options" :key="z.hrid" :label="z.name" :value="z.hrid" />
        </el-option-group>
      </el-select>
      <span class="muted">难度</span>
      <el-input-number v-model="t.difficultyTier" :min="0" :max="maxTier" size="small" style="width: 90px" />
    </template>
    <template v-else>
      <el-select v-model="t.labyrinthHrid" filterable style="width: 220px" size="small">
        <el-option v-for="z in o.labyrinths" :key="z.hrid" :label="z.name" :value="z.hrid" />
      </el-select>
      <span class="muted">房间等级</span>
      <el-input-number v-model="t.roomLevel" :min="1" :max="300" size="small" style="width: 100px" />
    </template>
  </div>
</template>
