<script setup>
import { computed, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { defaultExtra, defaultTarget, int, money, selectedMembers } from "../api.js"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"

const load = (k, d) => {
  try {
    const v = JSON.parse(localStorage.getItem(k))
    return v ?? d
  } catch {
    return d
  }
}
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {}
}

const members = computed(() => selectedMembers())
const target = ref(defaultTarget())
const extra = ref(defaultExtra())
const hours = ref(12)
const seeds = ref(8)
const replacements = ref(true)
const optimize = ref(members.value.map((_, i) => i))
const plan = ref(load("fastsim-upgrade-plan", { cash: {}, other: {}, horizons: [30, 60], tax: 5, maxLevelUp: 6, keepEnd: false, houses: true, guild: true, refinedUnrefine: false }))
if (!plan.value.cash) plan.value.cash = {}
if (!plan.value.other) plan.value.other = {}
if (plan.value.houses == null) plan.value.houses = true
if (plan.value.guild == null) plan.value.guild = true
delete plan.value.budget
delete plan.value.otherIncome
watch(plan, v => save("fastsim-upgrade-plan", v), { deep: true })
const result = ref(null)
const kinds = ref([])
const tab = ref("")

function params() {
  if (!members.value.length) return ElMessage.warning("先在“队伍”页勾选出战成员")
  if (!plan.value.horizons.length) return ElMessage.warning("至少选一个规划天数")
  const p = plan.value
  return {
    members: members.value, target: target.value, extra: extra.value, hours: hours.value, seeds: seeds.value, replacements: replacements.value, optimize: optimize.value,
    houses: p.houses !== false, guild: p.guild !== false, refinedResale: p.refinedUnrefine ? "unrefine" : "market", budgets: members.value.map(m => (p.cash[m.name] || 0) * 1e6), otherIncomes: members.value.map(m => (p.other[m.name] || 0) * 1e6), horizons: p.horizons, tax: p.tax / 100, maxLevelUp: p.maxLevelUp, keepEnd: p.keepEnd,
  }
}
function onResult(r) {
  result.value = r
  if (!r?.plans?.some(p => String(p.days) === tab.value)) tab.value = String(r?.plans?.at(-1)?.days ?? "")
}
const slotNames = computed(() => [...new Set((result.value?.rows || []).map(r => r.slotName))])
const rows = computed(() => (result.value?.rows || []).filter(r => !kinds.value.length || kinds.value.includes(r.slotName)))
const sign = v => (v >= 0 ? "+" : "") + money(v)
const day = d => (d < 0.05 ? "现在" : `第 ${d.toFixed(1)} 天`)
</script>

<template>
  <div class="page">
    <h2>整队提升规划</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        先把全队每个位置能到达的状态（当前装备及其精炼版的更高强化等级、按职业的高档换装、技能 +5/+10 级、房子 +1～+3 级）逐个模拟，得到每项每天多赚多少；
        队伍越强，单项提升占总利润的比例越小，和模拟误差差不多大，所以初筛之后，可能在规划期内回本的提升（最多 40 项）会换一组随机种子、用 2 倍时长 × 4 倍次数再模拟一遍，购买计划只用复核过的数字；
        再按你的现金和每天收入排出购买顺序：钱够了就买，目标是规划期末的总资产（现金 + 身上装备按买一价扣税能卖的钱）最高。
        中途买的过渡装备以后卖掉要付差价和卖出税，所以只有它在这段时间多赚的钱超过这些损耗时才会被安排。
        买入按市场最低卖价，卖出按最高买价并扣卖出税；过渡装备以后卖掉时的差价和税都算在损耗里。
        房子按升级材料的市场价加金币算，升上去卖不回来。公会加成每人最多升到自己公会神殿的等级，花公会代币和公会币、不花金币，只在单项表里列出供参考，不进购买计划。
        获得装备的成本取最便宜的路线：直接买、贤者之镜合成（+N 加一件 +(N-1) 垫子加镜子 = +(N+1)，手上的装备可以当主件或垫子）、买普通版自己精炼。
      </p>
      <div class="row" style="margin-bottom: 8px"><TargetPicker v-model="target" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div v-for="m in members" :key="m.id" class="row" style="margin-bottom: 8px">
        <b style="width: 90px">{{ m.name }}</b>
        <span class="muted">现金</span><el-input-number v-model="plan.cash[m.name]" :min="0" :step="100" size="small" /><span class="muted">M</span>
        <span class="muted">其他收入</span><el-input-number v-model="plan.other[m.name]" :step="1" size="small" /><span class="muted">M/天（战斗利润之外）</span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">卖出税</span><el-input-number v-model="plan.tax" :min="0" :max="20" :step="0.5" size="small" /><span class="muted">%</span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">规划天数</span>
        <el-checkbox-group v-model="plan.horizons" size="small">
          <el-checkbox-button v-for="d in [7, 14, 30, 60, 90, 180]" :key="d" :value="d">{{ d }} 天</el-checkbox-button>
        </el-checkbox-group>
        <span class="muted">强化最多比现在高</span><el-input-number v-model="plan.maxLevelUp" :min="1" :max="10" size="small" /><span class="muted">级</span>
        <el-checkbox v-model="plan.keepEnd">期末装备不扣卖出税（打算一直留着）</el-checkbox>
        <el-checkbox v-model="plan.refinedUnrefine">精炼版按解精炼估回收价（保守）</el-checkbox>
      </div>
      <div class="row" style="margin-bottom: 12px">
        <span class="muted">每项</span><el-input-number v-model="hours" :min="1" :max="72" size="small" /><span class="muted">小时 ×</span>
        <el-input-number v-model="seeds" :min="2" :max="32" size="small" /><span class="muted">次配对</span>
        <el-checkbox v-model="replacements">包含换装</el-checkbox>
        <el-checkbox v-model="plan.houses">包含房子</el-checkbox>
        <el-checkbox v-model="plan.guild">列出公会加成</el-checkbox>
        <span class="muted">成员</span>
        <el-checkbox-group v-model="optimize" size="small">
          <el-checkbox v-for="(m, i) in members" :key="m.id" :value="i">{{ m.name }}</el-checkbox>
        </el-checkbox-group>
      </div>
      <JobRunner name="upgrades" type="upgrades" :params="params" label="开始规划" @result="onResult" />
    </el-card>

    <el-card v-if="result?.plans">
      <template #header>
        <div class="row">
          <b>购买计划</b>
          <span class="muted">当前全队 {{ money(result.profitPerDay) }}/天 · 现金各自 {{ (result.budgets || []).map((b, k) => `${result.names[k]} ${money(b)}`).join("、") }} · 卖出税 {{ (result.tax * 100).toFixed(1) }}% · 镜子 {{ money(result.mirror) }} · 价格按现在的市场价不变 · 期末装备{{ result.keepEnd ? "按买一价" : "按买一价扣税" }}估值</span>
        </div>
      </template>
      <el-tabs v-model="tab">
        <el-tab-pane v-for="p in result.plans" :key="p.days" :name="String(p.days)" :label="`${p.days} 天`">
          <el-alert v-if="!p.steps.length" type="info" :closable="false" :title="`${p.days} 天内没有值得做的提升：任何购买的损耗都超过这段时间多赚的钱`" />
          <template v-else>
            <p>
              {{ p.days }} 天后总资产比什么都不买多 <b class="good">{{ money(p.gain) }}</b>，
              全部做完后全队每天多赚约 <b>{{ money(p.finalIncome - result.income) }}</b>
              <span v-if="p.check" class="muted">（终态整队实测 {{ sign(p.check.actual) }}/天 ± {{ money(1.96 * p.check.sig.se * 24) }}，逐项相加估计 {{ sign(p.check.estimated) }}/天）</span>
            </p>
            <p class="muted">每个角色只用自己的现金和自己的收入买自己的装备。
              <template v-for="x in p.perMember || []" :key="x.name">{{ x.name }}：收入 {{ money(x.startIncome) }} → {{ money(x.income) }}/天，期末现金 {{ money(x.cash) }}；</template>
            </p>
            <el-table :data="p.steps" size="small">
              <el-table-column label="时间" width="100"><template #default="{ row }">{{ day(row.day) }}</template></el-table-column>
              <el-table-column prop="memberName" label="角色" width="90" />
              <el-table-column prop="slotName" label="位置" width="80" />
              <el-table-column label="变化" min-width="220"><template #default="{ row }">{{ row.from }} → <b>{{ row.to }}</b></template></el-table-column>
              <el-table-column prop="how" label="做法" min-width="200" />
              <el-table-column label="花费" width="100" align="right"><template #default="{ row }">{{ money(row.cost) }}</template></el-table-column>
              <el-table-column label="损耗" width="100" align="right"><template #default="{ row }">{{ money(row.loss) }}</template></el-table-column>
              <el-table-column label="全队利润/天" width="110" align="right"><template #default="{ row }"><span :class="row.dProfitPerDay > 0 ? 'good' : 'bad'">{{ sign(row.dProfitPerDay) }}</span></template></el-table-column>
              <el-table-column label="该角色余额" width="100" align="right"><template #default="{ row }">{{ money(row.cashAfter) }}</template></el-table-column>
            </el-table>
            <p class="muted">花费 = 实际掏出的现金（已扣掉卖旧装备回收的钱）；损耗 = 花费 − 新装备能卖回的钱 + 旧装备能卖回的钱，即这一步真正亏掉的差价、税和精炼/镜子材料。</p>
          </template>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-card v-if="result?.rows">
      <template #header>
        <div class="row">
          <b>单项（{{ rows.length }}）</b>
          <el-checkbox-group v-model="kinds" size="small">
            <el-checkbox-button v-for="k in slotNames" :key="k" :value="k">{{ k }}</el-checkbox-button>
          </el-checkbox-group>
          <span class="muted">从当前状态一步到位；N 天净收益 = 利润/天 × N − 损耗<template v-if="result.refineSeeds">；「复核」= 用 {{ result.refineHours }} 小时 × {{ result.refineSeeds }} 次重新模拟过（{{ result.refinedCount }} 项），「初筛」的数字误差较大，不进购买计划</template></span>
        </div>
      </template>
      <el-table :data="rows" size="small">
        <el-table-column prop="memberName" label="角色" width="90" sortable />
        <el-table-column label="提升" min-width="230"><template #default="{ row }">{{ row.from }} → {{ row.label }}</template></el-table-column>
        <el-table-column prop="how" label="做法" min-width="170" />
        <el-table-column prop="cost" label="花费" width="110" align="right" sortable>
          <template #default="{ row }">{{ row.guild ? `${row.guildTokens.toLocaleString()} 公会代币` : money(row.cost) }}</template>
        </el-table-column>
        <el-table-column prop="loss" label="损耗" width="100" align="right" sortable><template #default="{ row }">{{ row.guild ? "—" : money(row.loss) }}</template></el-table-column>
        <el-table-column prop="dProfitPerDay" label="全队利润/天" width="115" align="right" sortable>
          <template #default="{ row }"><span :class="row.dProfitPerDay > 0 ? 'good' : 'bad'">{{ sign(row.dProfitPerDay) }}</span></template>
        </el-table-column>
        <el-table-column v-for="d in result.horizons" :key="d" :label="`${d} 天净收益`" width="115" align="right" sortable :sort-method="(a, b) => a.net[d] - b.net[d]">
          <template #default="{ row }"><span :class="row.net[d] > 0 ? 'good' : 'bad'">{{ sign(row.net[d]) }}</span></template>
        </el-table-column>
        <el-table-column prop="dOwnPerDay" label="自己/天" width="100" align="right" sortable><template #default="{ row }">{{ row.dOwnPerDay == null ? "" : sign(row.dOwnPerDay) }}</template></el-table-column>
        <el-table-column prop="dXpPerHour" label="经验/小时" width="100" align="right" sortable><template #default="{ row }">{{ row.dXpPerHour >= 0 ? "+" : "" }}{{ int(row.dXpPerHour) }}</template></el-table-column>
        <el-table-column label="精度" width="60" align="center"><template #default="{ row }"><span :class="row.refined ? '' : 'muted'">{{ row.guild ? "" : row.refined ? "复核" : "初筛" }}</span></template></el-table-column>
        <el-table-column label="显著" width="60" align="center"><template #default="{ row }">{{ row.significance?.clearlyBetter ? "✓" : "" }}</template></el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
