<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { defaultExtra, int, perDay, pct, selectedMembers, store } from "../api.js"
import JobRunner from "../components/JobRunner.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"

const o = computed(() => store.options)
const zones = ref(o.value.zones.map(z => z.hrid))
const dungeons = ref([])
const tiers = ref([0, 1, 2])
const hours = ref(24)
const seeds = ref(2)
const extra = ref(defaultExtra())
const objective = ref("profit")
const result = ref(null)

function params() {
  const members = selectedMembers()
  if (!members.length) return ElMessage.warning("先在“队伍”页勾选出战成员")
  const all = [...o.value.zones, ...o.value.dungeons]
  const targets = []
  for (const h of [...zones.value, ...dungeons.value]) {
    const z = all.find(x => x.hrid === h)
    for (const t of tiers.value) if (t <= (z?.maxDifficulty ?? 0)) targets.push({ kind: "zone", zoneHrid: h, difficultyTier: t })
  }
  if (!targets.length) return ElMessage.warning("没有可模拟的目标")
  return { members, targets, hours: hours.value, seeds: seeds.value, extra: extra.value, objective: objective.value }
}
const rows = computed(() => (result.value?.rows || []).filter(r => r.metrics).map(r => ({ ...r, ...r.metrics, key: `${r.target.zoneHrid}#${r.target.difficultyTier}` })))
const memberName = i => result.value?.names?.[i] || `成员${i + 1}`
const playerRows = row => (row.players || []).map((p, i) => ({ name: memberName(i), ...p }))
</script>

<template>
  <div class="page">
    <h2>刷图推荐</h2>
    <el-card>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 60px">区域</span>
        <el-select v-model="zones" multiple collapse-tags collapse-tags-tooltip filterable style="width: 420px" size="small">
          <el-option v-for="z in o.zones" :key="z.hrid" :label="z.name" :value="z.hrid" />
        </el-select>
        <el-button size="small" @click="zones = o.zones.map(z => z.hrid)">全选</el-button>
        <el-button size="small" @click="zones = []">清空</el-button>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 60px">地下城</span>
        <el-select v-model="dungeons" multiple collapse-tags filterable style="width: 420px" size="small">
          <el-option v-for="z in o.dungeons" :key="z.hrid" :label="z.name" :value="z.hrid" />
        </el-select>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 60px">难度</span>
        <el-checkbox-group v-model="tiers" size="small">
          <el-checkbox-button v-for="t in [0, 1, 2, 3, 4, 5]" :key="t" :value="t">T{{ t }}</el-checkbox-button>
        </el-checkbox-group>
      </div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 12px">
        <span class="muted">每个目标</span><el-input-number v-model="hours" :min="1" :max="240" size="small" /><span class="muted">小时 ×</span>
        <el-input-number v-model="seeds" :min="1" :max="16" size="small" /><span class="muted">次</span>
        <span class="muted">排序</span>
        <el-radio-group v-model="objective" size="small"><el-radio-button value="profit">利润</el-radio-button><el-radio-button value="xp">经验</el-radio-button></el-radio-group>
      </div>
      <JobRunner name="zones" type="zones" :params="params" @result="r => (result = r)" />
    </el-card>
    <el-card v-if="rows.length">
      <el-table :data="rows" size="small" row-key="key" :default-sort="{ prop: objective === 'xp' ? 'xpPerHour' : 'profitPerHour', order: 'descending' }">
        <el-table-column type="expand">
          <template #default="{ row }">
            <el-table :data="playerRows(row)" size="small" style="margin: 0 0 4px 48px; width: calc(100% - 48px)">
              <el-table-column prop="name" label="角色" min-width="110" />
              <el-table-column label="经验/小时" align="right"><template #default="{ row: p }">{{ int(p.xpPerHour) }}</template></el-table-column>
              <el-table-column label="收入/天" align="right"><template #default="{ row: p }">{{ perDay(p.revenuePerHour) }}</template></el-table-column>
              <el-table-column label="消耗/天" align="right"><template #default="{ row: p }">{{ perDay(p.expensesPerHour) }}</template></el-table-column>
              <el-table-column label="利润下限/天" align="right"><template #default="{ row: p }">{{ perDay(p.profitPerHour) }}</template></el-table-column>
              <el-table-column label="利润中值/天" align="right"><template #default="{ row: p }">{{ perDay(p.profitMidpointPerHour) }}</template></el-table-column>
              <el-table-column label="死亡/小时" align="right"><template #default="{ row: p }"><span :class="{ bad: p.deathsPerHour > 0 }">{{ p.deathsPerHour.toFixed(2) }}</span></template></el-table-column>
              <el-table-column label="空蓝" align="right"><template #default="{ row: p }">{{ pct(p.outOfManaTimeRatio) }}</template></el-table-column>
            </el-table>
          </template>
        </el-table-column>
        <el-table-column label="目标" min-width="160"><template #default="{ row }">{{ row.name }} · T{{ row.target.difficultyTier }}</template></el-table-column>
        <el-table-column prop="profitPerHour" label="利润下限/天" sortable align="right"><template #default="{ row }">{{ perDay(row.profitPerHour) }}</template></el-table-column>
        <el-table-column prop="profitMidpointPerHour" label="利润中值/天" sortable align="right"><template #default="{ row }">{{ perDay(row.profitMidpointPerHour) }}</template></el-table-column>
        <el-table-column prop="xpPerHour" label="经验/小时" sortable align="right"><template #default="{ row }">{{ int(row.xpPerHour) }}</template></el-table-column>
        <el-table-column prop="deathsPerHour" label="死亡/小时" sortable align="right"><template #default="{ row }"><span :class="{ bad: row.deathsPerHour > 0 }">{{ row.deathsPerHour.toFixed(2) }}</span></template></el-table-column>
        <el-table-column prop="encountersPerHour" label="遭遇/小时" sortable align="right"><template #default="{ row }">{{ row.encountersPerHour.toFixed(1) }}</template></el-table-column>
        <el-table-column label="空蓝" align="right"><template #default="{ row }">{{ pct(row.outOfManaTimeRatio) }}</template></el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
