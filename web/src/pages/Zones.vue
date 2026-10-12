<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { ci, defaultExtra, int, itemName, money, perDay, pct, qty, randomSeedBase, selectedMembers, store } from "../api.js"
import { copyText, fileStamp, saveImage, stamp } from "../export.js"
import JobRunner from "../components/JobRunner.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"

const o = computed(() => store.options)
const zones = ref(o.value.zones.map(z => z.hrid))
const dungeons = ref([])
const tiers = ref([0, 1, 2])
const hours = ref(24)
const seeds = ref(8)
const reseed = ref(false)
const extra = ref(defaultExtra())
const objective = ref("profit")
const result = ref(null)
const out = ref(null)

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
  return { members, targets, hours: hours.value, seeds: seeds.value, seedBase: reseed.value ? randomSeedBase() : undefined, extra: extra.value, objective: objective.value }
}
const rows = computed(() => (result.value?.rows || []).filter(r => r.metrics).map(r => ({ ...r, ...r.metrics, key: `${r.target.zoneHrid}#${r.target.difficultyTier}` })))
const memberName = i => result.value?.names?.[i] || `成员${i + 1}`
const playerRows = row => (row.players || []).map((p, i) => ({ name: memberName(i), ...p }))
// share of the team's revenue, so a zone that lives off one item stands out
const revenueRows = row => {
  const list = row.items?.revenue || []
  const total = list.reduce((a, x) => a + x.valuePerHour, 0)
  return list.slice(0, 8).map(x => ({ ...x, share: total > 0 ? x.valuePerHour / total : 0 }))
}
const expenseRows = row => (row.items?.expenses || []).slice(0, 8)

function summary() {
  const r = result.value
  const sorted = [...rows.value].sort((a, b) => (b[r.objective === "xp" ? "xpPerHour" : "profitPerHour"] ?? 0) - (a[r.objective === "xp" ? "xpPerHour" : "profitPerHour"] ?? 0))
  const lines = [`【刷图推荐】${(r.names || []).join("、")}（每个目标 ${r.hours} 小时 × ${r.seeds} 次，按${r.objective === "xp" ? "经验" : "利润"}排序，${stamp()}）`]
  sorted.slice(0, 15).forEach((x, i) => {
    const top = revenueRows(x)[0]
    lines.push(`${i + 1}. ${x.name} T${x.target.difficultyTier}：利润 ${perDay(x.profitPerHour)}/天（中值 ${perDay(x.profitMidpointPerHour)}/天），经验 ${int(x.xpPerHour)}/小时，死亡 ${x.deathsPerHour.toFixed(2)}${ci(x, "deathsPerHour")}/小时${top ? `，主要收入 ${itemName(top.itemHrid)} ${pct(top.share)}` : ""}`)
  })
  return lines.join("\n")
}
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
        <el-input-number v-model="seeds" :min="1" :max="64" size="small" /><span class="muted">次</span>
        <el-tooltip content="默认每次用同一组随机战斗，重跑结果不变；勾上后换一组，用来检查结果是否稳定" placement="top"><el-checkbox v-model="reseed" size="small">换一组随机种子</el-checkbox></el-tooltip>
        <span class="muted">排序</span>
        <el-radio-group v-model="objective" size="small"><el-radio-button value="profit">利润</el-radio-button><el-radio-button value="xp">经验</el-radio-button></el-radio-group>
      </div>
      <JobRunner name="zones" type="zones" :params="params" @result="r => (result = r)" />
      <div v-if="rows.length" class="row" style="margin-top: 8px">
        <el-button size="small" @click="copyText(summary())">复制文字（前 15 名）</el-button>
        <el-button size="small" @click="saveImage(out, `刷图推荐-${fileStamp()}`)">保存图片</el-button>
      </div>
    </el-card>
    <el-card v-if="rows.length" ref="out">
      <div class="muted" style="margin-bottom: 6px">{{ (result.names || []).join("、") }} · 每个目标 {{ result.hours }} 小时 × {{ result.seeds }} 次{{ result.seedBase ? "（换过随机种子）" : "" }} · ± 是 95% 范围，死亡数波动很大，次数越多越准 · 点左侧箭头展开每个成员和主要收入</div>
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
            <div v-if="row.items" class="grid" style="margin: 8px 0 4px 48px">
              <div>
                <b>主要收入（全队，买一价）</b>
                <el-table :data="revenueRows(row)" size="small">
                  <el-table-column label="物品" min-width="140"><template #default="{ row: x }">{{ itemName(x.itemHrid) }}</template></el-table-column>
                  <el-table-column label="数量/天" align="right"><template #default="{ row: x }">{{ qty(x.amountPerHour * 24) }}</template></el-table-column>
                  <el-table-column label="价值/天" align="right"><template #default="{ row: x }">{{ perDay(x.valuePerHour) }}</template></el-table-column>
                  <el-table-column label="占比" align="right"><template #default="{ row: x }"><span :class="{ bad: x.share >= 0.5 }">{{ pct(x.share) }}</span></template></el-table-column>
                </el-table>
              </div>
              <div v-if="expenseRows(row).length">
                <b>主要消耗（全队，卖一价）</b>
                <el-table :data="expenseRows(row)" size="small">
                  <el-table-column label="物品" min-width="140"><template #default="{ row: x }">{{ itemName(x.itemHrid) }}</template></el-table-column>
                  <el-table-column label="数量/天" align="right"><template #default="{ row: x }">{{ qty(x.amountPerHour * 24) }}</template></el-table-column>
                  <el-table-column label="花费/天" align="right"><template #default="{ row: x }">{{ perDay(x.valuePerHour) }}</template></el-table-column>
                </el-table>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="目标" min-width="160"><template #default="{ row }">{{ row.name }} · T{{ row.target.difficultyTier }}</template></el-table-column>
        <el-table-column prop="profitPerHour" label="利润下限/天" sortable align="right"><template #default="{ row }">{{ perDay(row.profitPerHour) }} <span class="muted">{{ ci(row, "profitPerHour", v => money(v * 24)) }}</span></template></el-table-column>
        <el-table-column prop="profitMidpointPerHour" label="利润中值/天" sortable align="right"><template #default="{ row }">{{ perDay(row.profitMidpointPerHour) }}</template></el-table-column>
        <el-table-column prop="xpPerHour" label="经验/小时" sortable align="right"><template #default="{ row }">{{ int(row.xpPerHour) }}</template></el-table-column>
        <el-table-column prop="deathsPerHour" label="死亡/小时" sortable align="right"><template #default="{ row }"><span :class="{ bad: row.deathsPerHour > 0 }">{{ row.deathsPerHour.toFixed(2) }}</span> <span class="muted">{{ ci(row, "deathsPerHour") }}</span></template></el-table-column>
        <el-table-column prop="encountersPerHour" label="遭遇/小时" sortable align="right"><template #default="{ row }">{{ row.encountersPerHour.toFixed(1) }}</template></el-table-column>
        <el-table-column label="空蓝" align="right"><template #default="{ row }">{{ pct(row.outOfManaTimeRatio) }}</template></el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
