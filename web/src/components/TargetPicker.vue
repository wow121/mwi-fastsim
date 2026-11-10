<script setup>
import { computed, watch } from "vue"
import { rememberTarget, selectedMembers, store } from "../api.js"
import { t } from "../i18n.js"

// v-model: { kind: "zone", zoneHrid, difficultyTier } | { kind: "labyrinth", labyrinthHrid, roomLevel }
const target = defineModel({ required: true })
const props = defineProps({ remember: { type: Boolean, default: true } })
watch(target, v => props.remember && rememberTarget(v), { deep: true })
const o = computed(() => store.options)
const zoneList = computed(() => [
  { label: t("区域"), options: o.value.zones },
  { label: t("地下城"), options: o.value.dungeons },
])
const zone = computed(() => [...o.value.zones, ...o.value.dungeons].find(z => z.hrid === target.value.zoneHrid))
const maxTier = computed(() => zone.value?.maxDifficulty ?? 0)
// the game lets at most maxPartySize players in (3 in group zones, 5 in dungeons)
const tooBig = computed(() => (zone.value?.maxPartySize && selectedMembers().length > zone.value.maxPartySize ? zone.value.maxPartySize : 0))
function setKind(k) {
  target.value = k === "labyrinth"
    ? { kind: "labyrinth", labyrinthHrid: o.value.labyrinths[0]?.hrid, roomLevel: 100 }
    : { kind: "zone", zoneHrid: o.value.zones[0]?.hrid, difficultyTier: 0 }
}
</script>

<template>
  <div class="row">
    <el-radio-group :model-value="target.kind" size="small" @update:model-value="setKind">
      <el-radio-button value="zone">{{ t("区域/地下城") }}</el-radio-button>
      <el-radio-button value="labyrinth">{{ t("迷宫") }}</el-radio-button>
    </el-radio-group>
    <template v-if="target.kind === 'zone'">
      <el-select v-model="target.zoneHrid" filterable style="width: 220px" size="small">
        <el-option-group v-for="g in zoneList" :key="g.label" :label="g.label">
          <el-option v-for="z in g.options" :key="z.hrid" :label="z.name" :value="z.hrid" />
        </el-option-group>
      </el-select>
      <span class="muted">{{ t("难度") }}</span>
      <el-input-number v-model="target.difficultyTier" :min="0" :max="maxTier" size="small" style="width: 90px" />
      <span v-if="tooBig" style="color: var(--el-color-danger)">{{ t("最多 {max} 人，出战成员有 {n} 人", { max: tooBig, n: selectedMembers().length }) }}</span>
    </template>
    <template v-else>
      <el-select v-model="target.labyrinthHrid" filterable style="width: 220px" size="small">
        <el-option v-for="z in o.labyrinths" :key="z.hrid" :label="z.name" :value="z.hrid" />
      </el-select>
      <span class="muted">{{ t("房间等级") }}</span>
      <el-input-number v-model="target.roomLevel" :min="1" :max="300" size="small" style="width: 100px" />
    </template>
  </div>
</template>
