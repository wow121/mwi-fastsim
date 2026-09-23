<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { defaultExtra, defaultTarget, int, itemName, perDay, selectedMembers, triggerText } from "../api.js"
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
const swapItems = ref(true)
const result = ref(null)

function params() {
  if (!members.value.length) return ElMessage.warning("先在“队伍”页勾选出战成员")
  return { members: members.value, target: target.value, extra: extra.value, objective: objective.value, optimize: optimize.value, rounds: rounds.value, swapItems: swapItems.value }
}
/** Final food/drink setup of every member, slot by slot, next to the original. */
const setup = computed(() => (result.value?.members || []).map((m, i) => {
  const before = members.value.find(x => String(x.id) === String(m.id)) || members.value[i]
  const rows = []
  for (const [kind, label] of [["food", "食物"], ["drinks", "饮料"]])
    for (let k = 0; k < 3; k++) {
      const now = m[kind]?.[k] || ""
      const was = before?.[kind]?.[k] || ""
      if (!now && !was) continue
      const nowText = now ? triggerText(m, now) : ""
      const wasText = was ? triggerText(before, was) : ""
      rows.push({ slot: `${label} ${k + 1}`, now: now ? itemName(now) : "空", was: was ? itemName(was) : "空", nowText, wasText, itemChanged: now !== was, trigChanged: now === was && nowText !== wasText })
    }
  return { name: m.name, rows }
}))
const fmtObj = v => (result.value?.objective === "xp" ? `${int(v)} 经验/小时` : `${perDay(v)}/天`)
const objKey = computed(() => (result.value?.objective === "xp" ? "xpPerHour" : result.value?.objective === "profitMid" ? "profitMidpointPerHour" : "profitPerHour"))
</script>

<template>
  <div class="page">
    <h2>药水触发优化</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        对每个角色的每个食物/饮料格子：先试换成其他战斗食物/咖啡（同类互斥：酸奶、软糖、甜甜圈、蛋糕各只能带一种，同效果的咖啡只能带一种；空着的已解锁格子也会试着填上，药钱计入利润），再调触发条件（当前 / 游戏默认 / 冷却好就用 / 缺血、缺蓝、当前血量、敌人数、目标血量等阈值，粗搜后细搜）。全队所有格子轮流优化，只采用明显更好的改动，最后 24 小时 × 8 次复核不提升就保持原样。
      </p>
      <div class="row" style="margin-bottom: 8px"><TargetPicker v-model="target" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 12px">
        <span class="muted">目标</span>
        <el-radio-group v-model="objective" size="small">
          <el-radio-button value="profit">利润（下限）</el-radio-button>
          <el-radio-button value="profitMid">利润（中值）</el-radio-button>
          <el-radio-button value="xp">经验</el-radio-button>
        </el-radio-group>
        <span class="muted">轮数</span><el-input-number v-model="rounds" :min="1" :max="4" size="small" style="width: 90px" />
        <el-checkbox v-model="swapItems">也尝试换药（食物/咖啡种类）</el-checkbox>
        <span class="muted">成员</span>
        <el-checkbox-group v-model="optimize" size="small">
          <el-checkbox v-for="(m, i) in members" :key="m.id" :value="i">{{ m.name }}</el-checkbox>
        </el-checkbox-group>
      </div>
      <JobRunner name="consumables" type="consumables" :params="params" label="开始优化" @result="r => (result = r)" />
    </el-card>
    <el-card v-if="result?.members">
      <template #header>
        <div class="row">
          <b>结果</b>
          <span v-if="result.unchanged" class="good">当前配置已是最好，没有找到明显更好的方案（不需要改动）</span>
          <span v-else-if="result.improvement" :class="result.improvement.mean > 0 ? 'good' : ''">
            {{ fmtObj(result.baseline[objKey]) }} → {{ fmtObj(result.final[objKey]) }}（+{{ fmtObj(result.improvement.mean) }} ± {{ fmtObj(1.96 * result.improvement.se) }}）
          </span>
          <span style="flex: 1" />
          <ApplyResult v-if="!result.unchanged" :members="result.members" />
        </div>
      </template>
      <div class="grid">
        <div v-for="p in setup" :key="p.name">
          <b>{{ p.name }}</b>
          <el-table :data="p.rows" size="small">
            <el-table-column prop="slot" label="格子" width="66" />
            <el-table-column label="优化后">
              <template #default="{ row }">
                <div :class="{ good: row.itemChanged }" :style="{ fontWeight: row.itemChanged ? 600 : 400 }">{{ row.now }}</div>
                <div class="muted" :class="{ good: row.trigChanged || row.itemChanged }">{{ row.nowText }}</div>
              </template>
            </el-table-column>
            <el-table-column label="原来">
              <template #default="{ row }">
                <div class="muted">{{ row.was }}</div>
                <div class="muted">{{ row.wasText }}</div>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
      <el-collapse v-if="result.changes?.length || result.rejected?.length" style="margin-top: 8px">
        <el-collapse-item :title="`搜索过程（${(result.changes || []).length} 次采用${result.rejected?.length ? `，${result.rejected.length} 次复核后撤回` : ''}）`">
          <el-table :data="result.changes?.length ? result.changes : result.rejected" size="small">
            <el-table-column label="轮" prop="round" width="50" />
            <el-table-column label="角色" width="120"><template #default="{ row }">{{ members[row.member]?.name }}</template></el-table-column>
            <el-table-column label="改动" width="60" prop="what" />
            <el-table-column label="内容"><template #default="{ row }">{{ row.from ? `${row.from} → ` : "" }}{{ row.to }}</template></el-table-column>
            <el-table-column label="当时提升" align="right"><template #default="{ row }">+{{ fmtObj(row.gain.mean) }}</template></el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </el-card>
  </div>
</template>

