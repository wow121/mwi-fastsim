<script setup>
import { computed, onMounted, reactive, ref } from "vue"
import { ElMessage } from "element-plus"
import { abilityName, call, defaultExtra, defaultTarget, int, perDay, selectedMembers, store, triggerText } from "../api.js"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"
import ApplyResult from "../components/ApplyResult.vue"
import { triggerKey } from "@app/skill-pools.mjs"
import { isEn, joinList, t } from "../i18n.js"

const members = computed(() => selectedMembers())
const target = ref(defaultTarget())
const extra = ref(defaultExtra())
const objective = ref("profit")
const optimize = ref(members.value.map((_, i) => i))
const rounds = ref(2)
const allPresets = ref(false)
const crossElement = ref(false)
const consumables = ref(false)
const pools = ref([])
onMounted(async () => {
  pools.value = await call("POST", "/api/skill-pools", { members: members.value })
})
const precision = ref("standard")
const excluded = reactive({}) // member index -> Set of excluded hrids
const added = reactive({}) // member index -> { hrid: level } for abilities not read from the game
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
function isAdded(i, h) {
  return added[i]?.[h] != null
}
function setAdded(i, h, v) {
  added[i] ||= {}
  if (v) added[i][h] = Math.max(1, ...Object.values(pools.value[i]?.pool || []).map(a => a.level || 0))
  else delete added[i][h]
}
function params() {
  if (!members.value.length) return ElMessage.warning(t("先在“队伍”页勾选出战成员"))
  return {
    members: members.value, target: target.value, extra: extra.value, objective: objective.value,
    optimize: optimize.value, rounds: rounds.value, allPresets: allPresets.value, crossElement: crossElement.value, consumables: consumables.value, stages: PRESETS[precision.value],
    exclude: Object.fromEntries(Object.entries(excluded).map(([k, s]) => [k, [...s]])),
    add: Object.fromEntries(Object.entries(added).map(([k, o]) => [k, { ...o }])),
  }
}
// result vs the configuration it started from (slot by slot): highlight what the optimizer changed
// equivalent wordings ("targeted enemy HP >= 1" vs "all enemies HP >= 1", condition order) are not a change
const trigKey = (mem, h) => (mem?.triggerMap && Object.prototype.hasOwnProperty.call(mem.triggerMap, h) ? triggerKey(mem.triggerMap[h]) : "default")
function abilityChanged(i, k) {
  const a = result.value.members[i]?.abilities[k], b = members.value[i]?.abilities[k]
  return (a?.abilityHrid || "") !== (b?.abilityHrid || "") || (!!a?.abilityHrid && a.level !== b?.level)
}
function triggerChanged(i, k) {
  const h = result.value.members[i]?.abilities[k]?.abilityHrid
  return !!h && trigKey(result.value.members[i], h) !== trigKey(members.value[i], h)
}
const changeCount = i => (result.value.members[i]?.abilities || []).filter((_, k) => abilityChanged(i, k) || triggerChanged(i, k)).length
const fmtObj = v => (result.value?.objective === "xp" ? t("{v} 经验/小时", { v: int(v) }) : t("{v}/天", { v: perDay(v) }))
const SEMI = () => (isEn() ? "; " : "；") // i18n-ok
const COMMA = () => (isEn() ? ", " : "，") // i18n-ok
const objKey = computed(() => (result.value?.objective === "xp" ? "xpPerHour" : result.value?.objective === "profitMid" ? "profitMidpointPerHour" : "profitPerHour"))
</script>

<template>
  <div class="page">
    <h2>{{ t("技能与触发优化（整队）") }}</h2>
    <el-card>
      <div class="row" style="margin-bottom: 8px"><TargetPicker v-model="target" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">{{ t("目标#objective") }}</span>
        <el-radio-group v-model="objective" size="small">
          <el-radio-button value="profit">{{ t("利润（下限）") }}</el-radio-button>
          <el-radio-button value="profitMid">{{ t("利润（中值）") }}</el-radio-button>
          <el-radio-button value="xp">{{ t("经验") }}</el-radio-button>
        </el-radio-group>
        <span class="muted">{{ t("精度") }}</span>
        <el-radio-group v-model="precision" size="small">
          <el-radio-button value="fast">{{ t("快速") }}</el-radio-button>
          <el-radio-button value="standard">{{ t("标准") }}</el-radio-button>
          <el-radio-button value="precise">{{ t("精确") }}</el-radio-button>
        </el-radio-group>
        <span class="muted">{{ t("轮数") }}</span><el-input-number v-model="rounds" :min="1" :max="4" size="small" style="width: 90px" />
        <el-checkbox v-model="allPresets">{{ t("也试非默认的触发预设（更慢）") }}</el-checkbox>
        <el-checkbox v-model="crossElement">{{ t("法师也试其他系学过的技能（更慢）") }}</el-checkbox>
        <el-checkbox v-model="consumables">{{ t("完成后接着优化药水触发") }}</el-checkbox>
      </div>
      <div v-for="(m, i) in members" :key="m.id" style="margin-bottom: 10px">
        <el-checkbox :model-value="optimize.includes(i)" @change="v => (optimize = v ? [...optimize, i] : optimize.filter(x => x !== i))">
          <b>{{ m.name }}</b>
          <span class="muted" v-if="pools[i]"> · {{ pools[i].className }} · {{ t("{n} 个技能格 · 特殊技能不变", { n: pools[i].slots }) }}</span>
        </el-checkbox>
        <div class="row" style="margin-left: 24px" v-if="pools[i]">
          <template v-for="a in pools[i].pool" :key="a.hrid">
            <el-tooltip :content="a.learned ? t('触发预设：{list}', { list: a.presets.map(p => (p.checked ? '✓' : '') + p.label).join(SEMI()) }) : t('没读到这个技能（队友只能读到正在装备的技能）。勾选后按填写的等级参与优化')" placement="top">
              <el-check-tag :checked="a.learned ? isOn(i, a.hrid) : isAdded(i, a.hrid)" @change="v => (a.learned ? setOn(i, a.hrid, v) : setAdded(i, a.hrid, v))" size="small">
                {{ a.name }} {{ a.learned ? a.level : isAdded(i, a.hrid) ? "" : t("（未读到）") }}
              </el-check-tag>
            </el-tooltip>
            <el-input-number v-if="!a.learned && isAdded(i, a.hrid)" v-model="added[i][a.hrid]" :min="1" :max="200" size="small" controls-position="right" style="width: 80px" />
          </template>
          <span v-if="!pools[i].pool.length" class="bad">{{ t("没识别出职业（看武器）") }}</span>
        </div>
      </div>
      <div style="margin-top: 12px">
        <JobRunner name="skills" type="skills" :params="params" :label="t('开始优化')" @result="r => (result = r)" />
      </div>
    </el-card>

    <el-card v-if="result?.members">
      <template #header>
        <div class="row">
          <b>{{ t("结果") }}</b>
          <span v-if="result.unchanged" class="good">{{ t("当前配置已是最好，没有找到明显更好的方案（不需要改动）") }}</span>
          <span v-else-if="result.improvement" :class="result.improvement.mean > 0 ? 'good' : ''">
            {{ fmtObj(result.baseline[objKey]) }} → {{ fmtObj(result.final[objKey]) }}{{ t("（{gain} ± {se}，全队 24 小时 × 32 次配对复核）", { gain: (result.improvement.mean >= 0 ? "+" : "") + fmtObj(result.improvement.mean), se: fmtObj(1.96 * result.improvement.se) }) }}
          </span>
          <span style="flex: 1" />
          <ApplyResult v-if="!result.unchanged" :members="result.members" />
        </div>
      </template>
      <div v-if="result.consumableChanges?.length" style="margin-bottom: 8px">
        <b>{{ t("药水触发") }}</b>
        <div v-for="(c, k) in result.consumableChanges" :key="k" class="changed">
          {{ c.team ? joinList(c.members.map(j => members[j]?.name)) : members[c.member]?.name }} · {{ c.what }}{{ t("：") }}{{ c.from ? `${c.from} → ` : "" }}{{ c.to }}
        </div>
      </div>
      <div class="grid">
        <div v-for="(m, i) in result.members" :key="m.id">
          <b>{{ m.name }}</b>
          <span v-if="!result.unchanged" :class="changeCount(i) ? 'changed' : 'muted'"> · {{ changeCount(i) ? t("改了 {n} 处", { n: changeCount(i) }) : t("不变") }}</span>
          <el-table :data="m.abilities" size="small" :row-class-name="({ rowIndex }) => (!result.unchanged && (abilityChanged(i, rowIndex) || triggerChanged(i, rowIndex)) ? 'changed-row' : '')">
            <el-table-column :label="t('槽位')" width="70"><template #default="{ $index }">{{ $index === 0 ? t("特殊") : $index }}</template></el-table-column>
            <el-table-column :label="t('优化后')"><template #default="{ row, $index }"><span :class="!result.unchanged && abilityChanged(i, $index) ? 'changed' : ''">{{ row.abilityHrid ? `${abilityName(row.abilityHrid)} Lv.${row.level}` : "—" }}</span></template></el-table-column>
            <el-table-column :label="t('原来')"><template #default="{ $index }">{{ members[i]?.abilities[$index]?.abilityHrid ? abilityName(members[i].abilities[$index].abilityHrid) : "—" }}</template></el-table-column>
            <el-table-column :label="t('触发')">
              <template #default="{ row, $index }">
                <template v-if="row.abilityHrid">
                  <span :class="!result.unchanged && triggerChanged(i, $index) ? 'changed' : ''">{{ triggerText(m, row.abilityHrid) }}</span>
                  <div v-if="!result.unchanged && triggerChanged(i, $index) && !abilityChanged(i, $index)" class="muted" style="text-decoration: line-through">{{ triggerText(members[i], row.abilityHrid) }}</div>
                </template>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </el-card>

    <el-card v-if="result?.history?.length">
      <template #header><b>{{ t("搜索过程") }}</b> <span class="muted">{{ t("每轮每名成员的前 5 名；带「复核」的是最有希望的方案（最好的预设组合，和在当前触发上逐步增删条件、微调阈值的结果），换一组随机战斗、用 2 倍时长复核过（先跑 4 倍次数，分不出好坏的再逐步加到最多 16 倍），复核结果明显更好（± 范围整个大于 0）才采用") }}</span></template>
      <div v-for="(h, k) in result.history" :key="k" style="margin-bottom: 8px">
        <div class="muted">{{ h.title || t("第 {round} 轮 · {who}", { round: h.round, who: members[h.member]?.name }) }}</div>
        <el-table :data="h.top" size="small">
          <el-table-column :label="t('技能组')"><template #default="{ row }">{{ row.abilities.join(h.team ? SEMI() : " / ") }}<span v-if="row.tuned" class="muted">{{ t("（当前触发改进：{list}）", { list: row.tuned.join(COMMA()) }) }}</span></template></el-table-column>
          <el-table-column :label="t('目标值')" width="150" align="right"><template #default="{ row }">{{ fmtObj(row.value) }}</template></el-table-column>
          <el-table-column :label="t('对比当前')" width="260" align="right">
            <template #default="{ row }">
              <template v-if="row.vs"><span :class="row.confirmed && row.vs.clearlyBetter ? 'good' : ''">{{ row.vs.mean >= 0 ? "+" : "" }}{{ fmtObj(row.vs.mean) }}</span><span class="muted"> ± {{ fmtObj(1.96 * row.vs.se) }}</span></template>
              <span v-if="row.confirmed" class="muted"> · {{ t("复核 {h}h×{n}", { h: row.confirmed.hours, n: row.confirmed.seeds }) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('死亡/小时')" width="100" align="right"><template #default="{ row }">{{ row.deaths.toFixed(2) }}</template></el-table-column>
        </el-table>
      </div>
    </el-card>
  </div>
</template>
