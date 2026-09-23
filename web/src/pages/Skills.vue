<script setup>
import { computed, onMounted, reactive, ref } from "vue"
import { ElMessage } from "element-plus"
import { abilityName, call, defaultExtra, defaultTarget, int, perDay, selectedMembers, store, triggerText } from "../api.js"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"
import ApplyResult from "../components/ApplyResult.vue"

const members = computed(() => selectedMembers())
const target = ref(defaultTarget())
const extra = ref(defaultExtra())
const objective = ref("profit")
const optimize = ref(members.value.map((_, i) => i))
const rounds = ref(2)
const allPresets = ref(false)
const pools = ref([])
onMounted(async () => {
  pools.value = await call("POST", "/api/skill-pools", { members: members.value })
})
const precision = ref("standard")
const excluded = reactive({}) // member index -> Set of excluded hrids
const result = ref(null)

const PRESETS = {
  fast: [{ hours: 1, seeds: 2, keep: 0.1, min: 8 }, { hours: 4, seeds: 4, keep: 4 }, { hours: 8, seeds: 6, keep: 2 }],
  standard: [{ hours: 2, seeds: 2, keep: 0.1, min: 12 }, { hours: 6, seeds: 4, keep: 6 }, { hours: 12, seeds: 8, keep: 3 }],
  precise: [{ hours: 4, seeds: 4, keep: 0.15, min: 16 }, { hours: 12, seeds: 8, keep: 8 }, { hours: 24, seeds: 16, keep: 4 }],
}

function isOn(i, h) {
  return !excluded[i]?.has(h)
}
function setOn(i, h, v) {
  excluded[i] ||= new Set()
  v ? excluded[i].delete(h) : excluded[i].add(h)
}
function params() {
  if (!members.value.length) return ElMessage.warning("先在“队伍”页勾选出战成员")
  return {
    members: members.value, target: target.value, extra: extra.value, objective: objective.value,
    optimize: optimize.value, rounds: rounds.value, allPresets: allPresets.value, stages: PRESETS[precision.value],
    exclude: Object.fromEntries(Object.entries(excluded).map(([k, s]) => [k, [...s]])),
  }
}
const fmtObj = v => (result.value?.objective === "xp" ? `${int(v)} 经验/小时` : `${perDay(v)}/天`)
const objKey = computed(() => (result.value?.objective === "xp" ? "xpPerHour" : result.value?.objective === "profitMid" ? "profitMidpointPerHour" : "profitPerHour"))
</script>

<template>
  <div class="page">
    <h2>技能与触发优化（整队）</h2>
    <el-card>
      <div class="row" style="margin-bottom: 8px"><TargetPicker v-model="target" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">目标</span>
        <el-radio-group v-model="objective" size="small">
          <el-radio-button value="profit">利润（下限）</el-radio-button>
          <el-radio-button value="profitMid">利润（中值）</el-radio-button>
          <el-radio-button value="xp">经验</el-radio-button>
        </el-radio-group>
        <span class="muted">精度</span>
        <el-radio-group v-model="precision" size="small">
          <el-radio-button value="fast">快速</el-radio-button>
          <el-radio-button value="standard">标准</el-radio-button>
          <el-radio-button value="precise">精确</el-radio-button>
        </el-radio-group>
        <span class="muted">轮数</span><el-input-number v-model="rounds" :min="1" :max="4" size="small" style="width: 90px" />
        <el-checkbox v-model="allPresets">也试非默认的触发预设（更慢）</el-checkbox>
      </div>
      <div v-for="(m, i) in members" :key="m.id" style="margin-bottom: 10px">
        <el-checkbox :model-value="optimize.includes(i)" @change="v => (optimize = v ? [...optimize, i] : optimize.filter(x => x !== i))">
          <b>{{ m.name }}</b>
          <span class="muted" v-if="pools[i]"> · {{ pools[i].className }} · {{ pools[i].slots }} 个技能格 · 特殊技能不变</span>
        </el-checkbox>
        <div class="row" style="margin-left: 24px" v-if="pools[i]">
          <el-tooltip v-for="a in pools[i].pool" :key="a.hrid" :content="a.learned ? `触发预设：${a.presets.map(p => (p.checked ? '✓' : '') + p.label).join('；')}` : '还没学'" placement="top">
            <el-check-tag :checked="a.learned && isOn(i, a.hrid)" :disabled="!a.learned" @change="v => a.learned && setOn(i, a.hrid, v)" size="small">
              {{ a.name }} {{ a.learned ? a.level : "（未学）" }}
            </el-check-tag>
          </el-tooltip>
          <span v-if="!pools[i].pool.length" class="bad">没识别出职业（看武器）</span>
        </div>
      </div>
      <div style="margin-top: 12px">
        <JobRunner name="skills" type="skills" :params="params" label="开始优化" @result="r => (result = r)" />
      </div>
    </el-card>

    <el-card v-if="result?.members">
      <template #header>
        <div class="row">
          <b>结果</b>
          <span v-if="result.unchanged" class="good">当前配置已是最好，没有找到明显更好的方案（不需要改动）</span>
          <span v-else-if="result.improvement" :class="result.improvement.mean > 0 ? 'good' : ''">
            {{ fmtObj(result.baseline[objKey]) }} → {{ fmtObj(result.final[objKey]) }}（+{{ fmtObj(result.improvement.mean) }} ± {{ fmtObj(1.96 * result.improvement.se) }}，24 小时 × 8 次配对复核）
          </span>
          <span style="flex: 1" />
          <ApplyResult v-if="!result.unchanged" :members="result.members" />
        </div>
      </template>
      <div class="grid">
        <div v-for="(m, i) in result.members" :key="m.id">
          <b>{{ m.name }}</b>
          <el-table :data="m.abilities" size="small">
            <el-table-column label="槽位" width="70"><template #default="{ $index }">{{ $index === 0 ? "特殊" : $index }}</template></el-table-column>
            <el-table-column label="优化后"><template #default="{ row }">{{ row.abilityHrid ? `${abilityName(row.abilityHrid)} Lv.${row.level}` : "—" }}</template></el-table-column>
            <el-table-column label="原来"><template #default="{ $index }">{{ members[i]?.abilities[$index]?.abilityHrid ? abilityName(members[i].abilities[$index].abilityHrid) : "—" }}</template></el-table-column>
            <el-table-column label="触发"><template #default="{ row }">{{ row.abilityHrid ? triggerText(m, row.abilityHrid) : "" }}</template></el-table-column>
          </el-table>
        </div>
      </div>
    </el-card>

    <el-card v-if="result?.history?.length">
      <template #header><b>搜索过程</b> <span class="muted">每轮每名成员的前 5 名</span></template>
      <div v-for="(h, k) in result.history" :key="k" style="margin-bottom: 8px">
        <div class="muted">第 {{ h.round }} 轮 · {{ members[h.member]?.name }}</div>
        <el-table :data="h.top" size="small">
          <el-table-column label="技能组"><template #default="{ row }">{{ row.abilities.join(" / ") }}</template></el-table-column>
          <el-table-column label="目标值" width="150" align="right"><template #default="{ row }">{{ fmtObj(row.value) }}</template></el-table-column>
          <el-table-column label="对比当前" width="200" align="right"><template #default="{ row }">{{ row.vs ? `${row.vs.mean >= 0 ? "+" : ""}${fmtObj(row.vs.mean)}` : "" }}</template></el-table-column>
          <el-table-column label="死亡/小时" width="100" align="right"><template #default="{ row }">{{ row.deaths.toFixed(2) }}</template></el-table-column>
        </el-table>
      </div>
    </el-card>
  </div>
</template>
