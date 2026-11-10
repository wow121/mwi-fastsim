<script setup>
import { computed, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { defaultExtra, defaultTarget, money, selectedMembers } from "../api.js"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"
import { joinList, t } from "../i18n.js"

const load = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d
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
const current = ref(defaultTarget())
const goal = ref(load("fastsim-goal-target", { ...defaultTarget() }))
watch(goal, v => save("fastsim-goal-target", v), { deep: true })
const extra = ref(defaultExtra())
// cash / other income / tax are shared with the upgrade planner page
const plan = ref(load("fastsim-upgrade-plan", {}))
for (const [k, d] of [["cash", {}], ["other", {}], ["tax", 4], ["buyPrice", "ask"], ["sellPrice", "bid"]]) if (plan.value[k] == null) plan.value[k] = d
watch(plan, v => save("fastsim-upgrade-plan", { ...load("fastsim-upgrade-plan", {}), cash: v.cash, other: v.other, tax: v.tax, buyPrice: v.buyPrice, sellPrice: v.sellPrice }), { deep: true })
const opts = ref(load("fastsim-goal-opts", { maxDeaths: 0.01, maxLevelUp: 8, replacements: true, levels: true, consumables: true, guild: false, charms: true }))
watch(opts, v => save("fastsim-goal-opts", v), { deep: true })
const optimize = ref(members.value.map((_, i) => i))
const result = ref(null)

function params() {
  if (!members.value.length) return ElMessage.warning(t("先在“队伍”页勾选出战成员"))
  const p = plan.value
  return {
    members: members.value, goal: goal.value, current: current.value, extra: extra.value, optimize: optimize.value,
    budgets: members.value.map(m => (p.cash[m.name] || 0) * 1e6), otherIncomes: members.value.map(m => (p.other[m.name] || 0) * 1e6),
    tax: p.tax / 100, buyPrice: p.buyPrice, sellPrice: p.sellPrice, maxDeaths: opts.value.maxDeaths, maxLevelUp: opts.value.maxLevelUp, replacements: opts.value.replacements, levels: opts.value.levels !== false, consumables: opts.value.consumables !== false, guild: !!opts.value.guild, charms: opts.value.charms !== false,
  }
}
const fmtDays = d => (d == null || !Number.isFinite(d) ? "—" : d < 0.05 ? "0" : d.toFixed(1))
const days = d => (d == null ? t("收入 ≤ 0，攒不够") : d === 0 ? t("现在就够") : t("还要攒 {d} 天", { d: d.toFixed(1) }))
const deaths = d => t("{v}/小时", { v: d.toFixed(d < 0.1 ? 3 : 2) })
const fmtD = d => t("{d} 天", { d: fmtDays(d) })
</script>

<template>
  <div class="page">
    <h2>{{ t("目标区域提升") }}</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        {{ t("选一个现在打不动的目标（比如某个区域的高难度），找出能在目标上不死、并且比现在刷的地方日利高的综合提升里，") }}<b>{{ t("最快能做完的那一套") }}</b>{{ t("：装备（强化 / 精炼 / 镜子 / 按职业换装）、技能书、房子、战斗等级、药品一起考虑；刷经验时戴哪种护符（决定经验主要分给哪个技能）也会一起挑。") }}
        {{ t("攒钱和刷经验是同时进行的：第 T 天时每个人能花「自己的现金 + T 天自己的收入」，等级是按当前经验和现在每天涨的经验刷 T 天后的等级。") }}
        {{ t("对一个天数 T，在各人的预算内从头挑最划算的装备组合（先减少死亡，再提高利润），看能不能达标；先粗试 0 / 7 / 30 / 90 / 180 天，再在不达标和达标之间二分找最短的 T。") }}
        {{ t("找到后去掉用不上的装备、把等级压到刚好够，按真正需要的东西算出最终天数。") }}
        {{ t("开始和达标后各在目标上做一次药品优化（换消耗品 / 咖啡、调触发）。") }}
      </p>
      <div class="row" style="margin-bottom: 8px"><b style="width: 90px">{{ t("目标") }}</b><TargetPicker v-model="goal" :remember="false" /></div>
      <div class="row" style="margin-bottom: 8px"><b style="width: 90px">{{ t("现在刷的") }}</b><TargetPicker v-model="current" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div v-for="m in members" :key="m.id" class="row" style="margin-bottom: 8px">
        <b style="width: 90px">{{ m.name }}</b>
        <span class="muted">{{ t("现金") }}</span><el-input-number v-model="plan.cash[m.name]" :min="0" :step="100" size="small" /><span class="muted">M</span>
        <span class="muted">{{ t("其他收入") }}</span><el-input-number v-model="plan.other[m.name]" :step="1" size="small" /><span class="muted">{{ t("M/天") }}</span>
      </div>
      <div class="row" style="margin-bottom: 12px">
        <span class="muted">{{ t("允许死亡") }}</span><el-input-number v-model="opts.maxDeaths" :min="0" :max="5" :step="0.01" :precision="2" size="small" /><span class="muted">{{ t("次/小时（0.01 ≈ 100 小时死一次；0 = 24 小时 × 12 次复核里一次都不死）") }}</span>
        <span class="muted">{{ t("强化最多比现在高") }}</span><el-input-number v-model="opts.maxLevelUp" :min="1" :max="12" size="small" /><span class="muted">{{ t("级#enh") }}</span>
        <span class="muted">{{ t("卖出税") }}</span><el-input-number v-model="plan.tax" :min="0" :max="20" :step="0.5" size="small" /><span class="muted">%</span>
        <span class="muted">{{ t("买入按") }}</span>
        <el-radio-group v-model="plan.buyPrice" size="small">
          <el-radio-button value="ask">{{ t("卖一价（直接买）") }}</el-radio-button>
          <el-radio-button value="bid">{{ t("买一价（挂买单）") }}</el-radio-button>
        </el-radio-group>
        <span class="muted">{{ t("卖出按") }}</span>
        <el-radio-group v-model="plan.sellPrice" size="small">
          <el-radio-button value="bid">{{ t("买一价（直接卖）") }}</el-radio-button>
          <el-radio-button value="ask">{{ t("卖一价（挂卖单）") }}</el-radio-button>
        </el-radio-group>
        <el-checkbox v-model="opts.replacements">{{ t("包含换装") }}</el-checkbox>
        <el-checkbox v-model="opts.levels">{{ t("包含等级提升") }}</el-checkbox>
        <el-checkbox v-model="opts.consumables">{{ t("药品优化") }}</el-checkbox>
        <el-checkbox v-model="opts.charms">{{ t("考虑换护符刷经验") }}</el-checkbox>
        <el-checkbox v-model="opts.guild">{{ t("允许提升公会加成（不超过公会神殿等级，花公会代币，不花金币）") }}</el-checkbox>
        <span class="muted">{{ t("成员") }}</span>
        <el-checkbox-group v-model="optimize" size="small">
          <el-checkbox v-for="(m, i) in members" :key="m.id" :value="i">{{ m.name }}</el-checkbox>
        </el-checkbox-group>
      </div>
      <JobRunner name="goal" type="goal" :params="params" :label="t('开始计算')" @result="r => (result = r)" />
    </el-card>

    <el-card v-if="result?.final">
      <template #header>
        <div class="row">
          <el-tag :type="result.reached ? 'success' : 'danger'">{{ result.reached ? t("能达标") : t("没能达标") }}</el-tag>
          <span>{{ t("现在 {now}/天 · 直接去目标 {start}/天、死亡 {d}", { now: money(result.now.profit), start: money(result.start.profit), d: deaths(result.start.deaths) }) }} · {{ t("提升后") }} <b>{{ t("{v}/天", { v: money(result.final.profit) }) }}</b>{{ t("、死亡") }} <b>{{ deaths(result.final.deaths) }}</b></span>
        </div>
      </template>
      <el-alert v-if="!result.reached" type="warning" :closable="false" style="margin-bottom: 8px"
        :title="t('180 天内达不到（价格会变、也不会一直只打一个地方，所以最多只看 180 天）。下面是按 180 天的钱和等级能做到的最接近的方案；可以放宽“强化最多比现在高”、允许少量死亡，或先在目标上跑技能优化再试。')" />
      <p v-if="result.reached && result.readyDays != null">{{ t("最快大约") }} <b>{{ fmtD(result.readyDays) }}</b>{{ t("后能去刷（按每个人自己的现金、收入和涨经验速度，攒钱和刷经验同时进行，取最慢的那个人）。") }}</p>
      <h4 style="margin: 4px 0">{{ t("要买 / 要做的（{n} 项）", { n: result.changes.length }) }}</h4>
      <el-table :data="result.changes" size="small">
        <el-table-column prop="memberName" :label="t('角色')" width="90" />
        <el-table-column prop="slotName" :label="t('位置')" width="80" />
        <el-table-column :label="t('变化')" min-width="230"><template #default="{ row }">{{ row.from }} → <b>{{ row.to }}</b></template></el-table-column>
        <el-table-column prop="how" :label="t('做法')" min-width="220" />
        <el-table-column :label="t('花费')" width="110" align="right"><template #default="{ row }">{{ row.kind === "gear" || row.kind === "charm" ? money(row.cost) : "—" }}</template></el-table-column>
      </el-table>
      <template v-if="result.consumableChanges?.length">
        <h4 style="margin: 12px 0 4px">{{ t("药品调整（{n} 项）", { n: result.consumableChanges.length }) }}</h4>
        <el-table :data="result.consumableChanges" size="small">
          <el-table-column prop="when" :label="t('时机')" width="80" />
          <el-table-column prop="memberName" :label="t('角色')" width="90" />
          <el-table-column :label="t('位置')" width="100"><template #default="{ row }">{{ row.kind === "food" ? t("食物") : t("饮料") }} {{ row.slot + 1 }}</template></el-table-column>
          <el-table-column prop="what" :label="t('类型')" width="70" />
          <el-table-column :label="t('变化')" min-width="260"><template #default="{ row }">{{ row.from ? `${row.from} → ` : "" }}<b>{{ row.to }}</b></template></el-table-column>
        </el-table>
      </template>
      <h4 style="margin: 12px 0 4px">{{ t("每人花费") }}</h4>
      <el-table :data="result.perMember" size="small">
        <el-table-column prop="name" :label="t('角色')" width="90" />
        <el-table-column :label="t('花费')" width="110" align="right"><template #default="{ row }">{{ money(row.cost) }}</template></el-table-column>
        <el-table-column :label="t('现金')" width="110" align="right"><template #default="{ row }">{{ money(row.cash) }}</template></el-table-column>
        <el-table-column :label="t('现在收入')" width="110" align="right"><template #default="{ row }">{{ t("{v}/天", { v: money(row.income) }) }}</template></el-table-column>
        <el-table-column :label="t('攒钱')" min-width="130"><template #default="{ row }">{{ days(row.saveDays) }}</template></el-table-column>
        <el-table-column :label="t('刷经验')" width="90" align="right"><template #default="{ row }">{{ fmtD(row.levelDays) }}</template></el-table-column>
        <el-table-column :label="t('刷经验时的护符')" min-width="150"><template #default="{ row }">{{ row.charm || "" }}</template></el-table-column>
        <el-table-column :label="t('目标上日利')" width="110" align="right"><template #default="{ row, $index }">{{ money(result.final.players[$index].profit) }}</template></el-table-column>
        <el-table-column :label="t('目标上死亡')" width="110" align="right"><template #default="{ row, $index }">{{ deaths(result.final.players[$index].deaths) }}</template></el-table-column>
      </el-table>
      <p class="muted">{{ t("到了目标之后，建议再在目标上跑一次“技能与触发优化”，打法可能和现在不一样。") }}<template v-if="result.removed.length">{{ t("复核时去掉了不需要的提升：{list}。", { list: joinList(result.removed) }) }}</template></p>
      <el-collapse>
        <el-collapse-item v-if="result.levelOptions?.length" :title="t('升级要多久（按现在刷的地方，{n} 项）', { n: result.levelOptions.length })">
          <el-table :data="result.levelOptions" size="small">
            <el-table-column prop="memberName" :label="t('角色')" width="90" />
            <el-table-column prop="skill" :label="t('技能#skill')" width="70" />
            <el-table-column :label="t('等级')" width="70"><template #default="{ row }">Lv.{{ row.level }}</template></el-table-column>
            <el-table-column :label="t('经验/天')" width="100" align="right"><template #default="{ row }">{{ money(row.perDay) }}</template></el-table-column>
            <el-table-column :label="t('+1 级')" width="90" align="right"><template #default="{ row }">{{ fmtD(row.days1) }}</template></el-table-column>
            <el-table-column :label="t('+5 级')" width="90" align="right"><template #default="{ row }">{{ fmtD(row.days5) }}</template></el-table-column>
            <el-table-column :label="t('最快的护符')" min-width="140"><template #default="{ row }">{{ row.bestCharm || "" }}</template></el-table-column>
            <el-table-column :label="t('戴它 +1 级')" width="100" align="right"><template #default="{ row }">{{ row.bestCharm ? fmtD(row.best1) : "" }}</template></el-table-column>
            <el-table-column :label="t('戴它 +5 级')" width="100" align="right"><template #default="{ row }">{{ row.bestCharm ? fmtD(row.best5) : "" }}</template></el-table-column>
          </el-table>
        </el-collapse-item>
        <el-collapse-item :title="t('搜索过程（{n} 步）', { n: result.steps.length })">
          <el-table :data="result.steps" size="small">
            <el-table-column :label="t('按几天算')" width="90"><template #default="{ row }">{{ fmtD(row.T) }}</template></el-table-column>
            <el-table-column :label="t('目的')" width="80"><template #default="{ row }">{{ row.phase === "deaths" ? t("减少死亡") : t("提高利润") }}</template></el-table-column>
            <el-table-column :label="t('变化')" min-width="260"><template #default="{ row }">{{ row.memberName }} {{ row.what }}<span class="muted">{{ t("（{how}）", { how: row.how }) }}</span></template></el-table-column>
            <el-table-column :label="t('折合天数')" width="90" align="right"><template #default="{ row }">{{ fmtDays(row.days) }}</template></el-table-column>
            <el-table-column :label="t('之后死亡')" width="110" align="right"><template #default="{ row }">{{ deaths(row.deaths) }}</template></el-table-column>
            <el-table-column :label="t('之后日利')" width="110" align="right"><template #default="{ row }">{{ money(row.profit) }}</template></el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </el-card>
  </div>
</template>
