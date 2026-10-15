<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { defaultExtra, defaultTarget, int, money, pct, randomSeedBase, selectedMembers, store, targetLabel } from "../api.js"
import { copyText, fileStamp, saveImage, stamp } from "../export.js"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"

const members = computed(() => selectedMembers())
const target = ref(defaultTarget())
const extra = ref(defaultExtra())
const hours = ref(24)
const seeds = ref(16)
const reseed = ref(false)
const single = ref(true)
const result = ref(null)
const out = ref(null)
const view = ref("team")

function params() {
  if (!members.value.length) return ElMessage.warning("先在“队伍”页勾选出战成员")
  if (target.value.kind === "labyrinth") return ElMessage.warning("卷轴在迷宫里不生效，请选择区域或地下城")
  if (extra.value.seals?.length >= (store.options?.seals?.length || 7)) return ElMessage.warning("所有卷轴都已勾选为开着，没有可比较的")
  return {
    members: members.value, target: target.value, extra: extra.value, hours: hours.value, seeds: seeds.value,
    seedBase: reseed.value ? randomSeedBase() : undefined, single: single.value,
  }
}
const nSeals = computed(() => (store.options?.seals?.length || 7) - (extra.value.seals?.length || 0))
const nRuns = computed(() => nSeals.value * (1 + (single.value && members.value.length > 1 ? members.value.length : 0)) + 1)

const sealName = k => store.options?.seals?.find(s => s.key === k)?.name || k
const name = i => result.value?.names?.[i] || `成员${i + 1}`
const sign = v => (v == null || !Number.isFinite(v) ? "—" : (v >= 0 ? "+" : "") + money(v))
const signInt = v => (v == null || !Number.isFinite(v) ? "—" : (v >= 0 ? "+" : "") + int(v))
const unclear = c => c.low <= 0 && c.high >= 0
const hasSingle = computed(() => (result.value?.rows || []).some(r => r.member != null))
const rows = computed(() => (result.value?.rows || [])
  .filter(r => (view.value === "single" && hasSingle.value ? r.member != null : r.member == null))
  .map(r => ({ ...r, who: r.member == null ? "全队" : name(r.member) }))
  .sort((a, b) => b.perScroll.profit - a.perScroll.profit))
// scrolls are not on the market: price columns only when some scroll has a quote
const priced = computed(() => (result.value?.rows || []).some(r => r.costPerHour != null))
const TOKENS = 5 // a scroll decomposes into 5 labyrinth tokens

function summary() {
  const r = result.value
  const lines = [`【卷轴价值】${targetLabel(r.target)}（${(r.names || []).join("、")}，${r.hours} 小时 × ${r.seeds} 次，${stamp()}）`]
  lines.push(`原队伍：全队利润 ${money(r.base.profitPerHour * 24)}/天，经验 ${int(r.base.xpPerHour)}/小时`)
  for (const x of rows.value)
    lines.push(`· ${sealName(x.key)}（${x.who}开）：每张 ${sign(x.perScroll.profit)} ±${money(x.perScroll.profitHalf)}，经验 ${signInt(x.perScroll.xp)}；合计多赚 ${sign(x.profit.mean * 24)}/天，经验 ${signInt(x.xp.mean)}/小时${unclear(x.profit) ? "（利润变化不明显）" : ""}`)
  return lines.join("\n")
}
</script>

<template>
  <div class="page">
    <h2>卷轴价值</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        在选定的地图上，每种迷宫卷轴（还没勾选成“开着”的）分别给全队开上，和不开对比，用同一组随机战斗算多赚多少利润和经验。
        一张卷轴 30 分钟，开的人每人每小时用 2 张，多赚的利润和经验除以用掉的张数，就是在这张图上用一张卷轴值多少。
        卷轴不能在市场交易，可以和分解（一张得 5 个迷宫代币）比较，看是用掉划算还是分解划算。
        勾上“单人开”时，再分别只给一个成员开，看给谁开最值。± 是 95% 范围，标灰的项变化在误差范围内。
      </p>
      <div class="row" style="margin-bottom: 8px"><span class="muted" style="width: 60px">目标</span><TargetPicker v-model="target" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin: 8px 0 12px">
        <span class="muted">每项</span><el-input-number v-model="hours" :min="1" :max="240" size="small" /><span class="muted">小时 ×</span>
        <el-input-number v-model="seeds" :min="2" :max="64" size="small" /><span class="muted">次</span>
        <el-checkbox v-model="single" size="small" :disabled="members.length < 2">也算单人开</el-checkbox>
        <el-tooltip content="默认每次用同一组随机战斗，重跑结果不变；勾上后换一组，用来检查结果是否稳定" placement="top"><el-checkbox v-model="reseed" size="small">换一组随机种子</el-checkbox></el-tooltip>
        <span class="muted">共约 {{ nRuns }} 组模拟</span>
      </div>
      <JobRunner name="scrolls" type="scrolls" :params="params" @result="r => (result = r)" />
      <div v-if="result?.rows?.length" class="row" style="margin-top: 8px">
        <el-button size="small" @click="copyText(summary())">复制文字</el-button>
        <el-button size="small" @click="saveImage(out, `卷轴价值-${fileStamp()}`)">保存图片</el-button>
      </div>
    </el-card>
    <el-card v-if="result?.rows?.length" ref="out">
      <div class="muted" style="margin-bottom: 6px">
        {{ targetLabel(result.target) }} · {{ (result.names || []).join("、") }} · 每项 {{ result.hours }} 小时 × {{ result.seeds }} 次{{ result.seedBase ? "（换过随机种子）" : "" }} ·
        原队伍全队利润 {{ money(result.base.profitPerHour * 24) }}/天，经验 {{ int(result.base.xpPerHour) }}/小时
        <template v-if="result.on?.length"> · 已开着：{{ result.on.map(sealName).join("、") }}</template>
      </div>
      <el-radio-group v-if="hasSingle" v-model="view" size="small" style="margin-bottom: 8px">
        <el-radio-button value="team">全队开</el-radio-button>
        <el-radio-button value="single">单人开</el-radio-button>
      </el-radio-group>
      <el-table :data="rows" size="small" :row-class-name="({ row }) => (unclear(row.profit) && unclear(row.xp) ? 'muted' : '')">
        <el-table-column label="卷轴" min-width="130"><template #default="{ row }">{{ sealName(row.key) }}</template></el-table-column>
        <el-table-column v-if="view === 'single' && hasSingle" prop="who" label="谁开" min-width="90" />
        <el-table-column label="每张价值" sortable :sort-method="(a, b) => a.perScroll.profit - b.perScroll.profit" align="right" min-width="130">
          <template #default="{ row }"><b :class="{ bad: row.profit.high < 0 }">{{ sign(row.perScroll.profit) }}</b> <span class="muted">±{{ money(row.perScroll.profitHalf) }}</span></template>
        </el-table-column>
        <el-table-column label="折合每代币" align="right" width="100"><template #default="{ row }">{{ sign(row.perScroll.profit / TOKENS) }}</template></el-table-column>
        <el-table-column label="每张经验" sortable :sort-method="(a, b) => a.perScroll.xp - b.perScroll.xp" align="right" width="100"><template #default="{ row }">{{ signInt(row.perScroll.xp) }}</template></el-table-column>
        <el-table-column label="合计多赚/天" sortable :sort-method="(a, b) => a.profit.mean - b.profit.mean" align="right" min-width="140">
          <template #default="{ row }"><span :class="{ bad: row.profit.high < 0 }">{{ sign(row.profit.mean * 24) }}</span> <span class="muted">±{{ money((row.profit.high - row.profit.mean) * 24) }}</span></template>
        </el-table-column>
        <el-table-column label="用量/天" align="right" width="80"><template #default="{ row }">{{ row.users * result.perHour * 24 }} 张</template></el-table-column>
        <el-table-column v-if="priced" label="市场价" align="right" width="90"><template #default="{ row }">{{ row.costPerHour == null ? "无报价" : money(row.price.ask) }}</template></el-table-column>
        <el-table-column v-if="priced" label="按市场价净赚/天" sortable :sort-method="(a, b) => (a.netPerHour ?? -Infinity) - (b.netPerHour ?? -Infinity)" align="right" min-width="110">
          <template #default="{ row }"><b :class="{ bad: row.netPerHour != null && row.netPerHour < 0 }">{{ sign(row.netPerHour == null ? null : row.netPerHour * 24) }}</b></template>
        </el-table-column>
        <el-table-column label="合计经验/小时" sortable :sort-method="(a, b) => a.xp.mean - b.xp.mean" align="right" min-width="130">
          <template #default="{ row }">{{ signInt(row.xp.mean) }} <span class="muted">{{ result.base.xpPerHour > 0 ? pct(row.xp.mean / result.base.xpPerHour) : "" }}</span></template>
        </el-table-column>
        <el-table-column label="死亡/小时" align="right" width="90"><template #default="{ row }"><span :class="{ bad: row.deathsPerHour > 0 }">{{ row.deathsPerHour.toFixed(2) }}</span></template></el-table-column>
      </el-table>
      <div class="muted" style="margin-top: 4px">死亡/小时是开了这个卷轴后的；原队伍 {{ result.base.deathsPerHour.toFixed(2) }}/小时。经验卷轴不加利润，看“每张经验”。</div>
    </el-card>
  </div>
</template>
