<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { ci, defaultExtra, int, itemName, money, perDay, pct, qty, randomSeedBase, selectedMembers, store } from "../api.js"
import { copyText, fileStamp, saveImage, stamp } from "../export.js"
import JobRunner from "../components/JobRunner.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"
import { joinList, t } from "../i18n.js"

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
  if (!members.length) return ElMessage.warning(t("先在“队伍”页勾选出战成员"))
  const all = [...o.value.zones, ...o.value.dungeons]
  const targets = []
  const tooBig = []
  for (const h of [...zones.value, ...dungeons.value]) {
    const z = all.find(x => x.hrid === h)
    if (z?.maxPartySize && members.length > z.maxPartySize) { tooBig.push(z.name); continue }
    for (const t of tiers.value) if (t <= (z?.maxDifficulty ?? 0)) targets.push({ kind: "zone", zoneHrid: h, difficultyTier: t })
  }
  if (tooBig.length) ElMessage.warning(t("队伍 {n} 人，跳过人数上限更小的：{list}", { n: members.length, list: joinList(tooBig) }))
  if (!targets.length) return ElMessage.warning(t("没有可模拟的目标"))
  return { members, targets, hours: hours.value, seeds: seeds.value, seedBase: reseed.value ? randomSeedBase() : undefined, extra: extra.value, objective: objective.value }
}
const rows = computed(() => (result.value?.rows || []).filter(r => r.metrics).map(r => ({ ...r, ...r.metrics, key: `${r.target.zoneHrid}#${r.target.difficultyTier}` })))
const memberName = i => result.value?.names?.[i] || t("成员{n}", { n: i + 1 })
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
  const lines = [t("【刷图推荐】{names}（每个目标 {h} 小时 × {n} 次，按{by}排序，{at}）", { names: joinList(r.names || []), h: r.hours, n: r.seeds, by: r.objective === "xp" ? t("经验") : t("利润"), at: stamp() })]
  sorted.slice(0, 15).forEach((x, i) => {
    const top = revenueRows(x)[0]
    lines.push(t("{i}. {name} T{tier}：利润 {p}/天（中值 {mid}/天），经验 {xp}/小时，死亡 {d}/小时", { i: i + 1, name: x.name, tier: x.target.difficultyTier, p: perDay(x.profitPerHour), mid: perDay(x.profitMidpointPerHour), xp: int(x.xpPerHour), d: x.deathsPerHour.toFixed(2) + ci(x, "deathsPerHour") })
      + (top ? t("，主要收入 {item} {share}", { item: itemName(top.itemHrid), share: pct(top.share) }) : ""))
  })
  return lines.join("\n")
}
</script>

<template>
  <div class="page">
    <h2>{{ t("刷图推荐") }}</h2>
    <el-card>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 60px">{{ t("区域") }}</span>
        <el-select v-model="zones" multiple collapse-tags collapse-tags-tooltip filterable style="width: 420px" size="small">
          <el-option v-for="z in o.zones" :key="z.hrid" :label="z.name" :value="z.hrid" />
        </el-select>
        <el-button size="small" @click="zones = o.zones.map(z => z.hrid)">{{ t("全选") }}</el-button>
        <el-button size="small" @click="zones = []">{{ t("清空") }}</el-button>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 60px">{{ t("地下城") }}</span>
        <el-select v-model="dungeons" multiple collapse-tags filterable style="width: 420px" size="small">
          <el-option v-for="z in o.dungeons" :key="z.hrid" :label="z.name" :value="z.hrid" />
        </el-select>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 60px">{{ t("难度") }}</span>
        <el-checkbox-group v-model="tiers" size="small">
          <el-checkbox-button v-for="tier in [0, 1, 2, 3, 4, 5]" :key="tier" :value="tier">T{{ tier }}</el-checkbox-button>
        </el-checkbox-group>
      </div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 12px">
        <span class="muted">{{ t("每个目标") }}</span><el-input-number v-model="hours" :min="1" :max="240" size="small" /><span class="muted">{{ t("小时 ×") }}</span>
        <el-input-number v-model="seeds" :min="1" :max="64" size="small" /><span class="muted">{{ t("次") }}</span>
        <el-tooltip :content="t('默认每次用同一组随机战斗，重跑结果不变；勾上后换一组，用来检查结果是否稳定')" placement="top"><el-checkbox v-model="reseed" size="small">{{ t("换一组随机种子") }}</el-checkbox></el-tooltip>
        <span class="muted">{{ t("排序") }}</span>
        <el-radio-group v-model="objective" size="small"><el-radio-button value="profit">{{ t("利润") }}</el-radio-button><el-radio-button value="xp">{{ t("经验") }}</el-radio-button></el-radio-group>
      </div>
      <JobRunner name="zones" type="zones" :params="params" @result="r => (result = r)" />
      <div v-if="rows.length" class="row" style="margin-top: 8px">
        <el-button size="small" @click="copyText(summary())">{{ t("复制文字（前 15 名）") }}</el-button>
        <el-button size="small" @click="saveImage(out, `${t('刷图推荐')}-${fileStamp()}`)">{{ t("保存图片") }}</el-button>
      </div>
    </el-card>
    <el-card v-if="rows.length" ref="out">
      <div class="muted" style="margin-bottom: 6px">{{ joinList(result.names || []) }} · {{ t("每个目标 {h} 小时 × {n} 次", { h: result.hours, n: result.seeds }) }}{{ result.seedBase ? t("（换过随机种子）") : "" }} · {{ t("± 是 95% 范围，死亡数波动很大，次数越多越准 · 点左侧箭头展开每个成员和主要收入") }}</div>
      <el-table :data="rows" size="small" row-key="key" :default-sort="{ prop: objective === 'xp' ? 'xpPerHour' : 'profitPerHour', order: 'descending' }">
        <el-table-column type="expand">
          <template #default="{ row }">
            <el-table :data="playerRows(row)" size="small" style="margin: 0 0 4px 48px; width: calc(100% - 48px)">
              <el-table-column prop="name" :label="t('角色')" min-width="110" />
              <el-table-column :label="t('经验/小时')" align="right"><template #default="{ row: p }">{{ int(p.xpPerHour) }}</template></el-table-column>
              <el-table-column :label="t('收入/天')" align="right"><template #default="{ row: p }">{{ perDay(p.revenuePerHour) }}</template></el-table-column>
              <el-table-column :label="t('消耗/天')" align="right"><template #default="{ row: p }">{{ perDay(p.expensesPerHour) }}</template></el-table-column>
              <el-table-column :label="t('利润下限/天')" align="right"><template #default="{ row: p }">{{ perDay(p.profitPerHour) }}</template></el-table-column>
              <el-table-column :label="t('利润中值/天')" align="right"><template #default="{ row: p }">{{ perDay(p.profitMidpointPerHour) }}</template></el-table-column>
              <el-table-column :label="t('死亡/小时')" align="right"><template #default="{ row: p }"><span :class="{ bad: p.deathsPerHour > 0 }">{{ p.deathsPerHour.toFixed(2) }}</span></template></el-table-column>
              <el-table-column :label="t('空蓝')" align="right"><template #default="{ row: p }">{{ pct(p.outOfManaTimeRatio) }}</template></el-table-column>
            </el-table>
            <div v-if="row.items" class="grid" style="margin: 8px 0 4px 48px">
              <div>
                <b>{{ t("主要收入（全队，买一价）") }}</b>
                <el-table :data="revenueRows(row)" size="small">
                  <el-table-column :label="t('物品')" min-width="140"><template #default="{ row: x }">{{ itemName(x.itemHrid) }}</template></el-table-column>
                  <el-table-column :label="t('数量/天')" align="right"><template #default="{ row: x }">{{ qty(x.amountPerHour * 24) }}</template></el-table-column>
                  <el-table-column :label="t('价值/天')" align="right"><template #default="{ row: x }">{{ perDay(x.valuePerHour) }}</template></el-table-column>
                  <el-table-column :label="t('占比')" align="right"><template #default="{ row: x }"><span :class="{ bad: x.share >= 0.5 }">{{ pct(x.share) }}</span></template></el-table-column>
                </el-table>
              </div>
              <div v-if="expenseRows(row).length">
                <b>{{ t("主要消耗（全队，卖一价）") }}</b>
                <el-table :data="expenseRows(row)" size="small">
                  <el-table-column :label="t('物品')" min-width="140"><template #default="{ row: x }">{{ itemName(x.itemHrid) }}</template></el-table-column>
                  <el-table-column :label="t('数量/天')" align="right"><template #default="{ row: x }">{{ qty(x.amountPerHour * 24) }}</template></el-table-column>
                  <el-table-column :label="t('花费/天')" align="right"><template #default="{ row: x }">{{ perDay(x.valuePerHour) }}</template></el-table-column>
                </el-table>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('目标')" min-width="160"><template #default="{ row }">{{ row.name }} · T{{ row.target.difficultyTier }}</template></el-table-column>
        <el-table-column prop="profitPerHour" :label="t('利润下限/天')" sortable align="right"><template #default="{ row }">{{ perDay(row.profitPerHour) }} <span class="muted">{{ ci(row, "profitPerHour", v => money(v * 24)) }}</span></template></el-table-column>
        <el-table-column prop="profitMidpointPerHour" :label="t('利润中值/天')" sortable align="right"><template #default="{ row }">{{ perDay(row.profitMidpointPerHour) }}</template></el-table-column>
        <el-table-column prop="xpPerHour" :label="t('经验/小时')" sortable align="right"><template #default="{ row }">{{ int(row.xpPerHour) }}</template></el-table-column>
        <el-table-column prop="deathsPerHour" :label="t('死亡/小时')" sortable align="right"><template #default="{ row }"><span :class="{ bad: row.deathsPerHour > 0 }">{{ row.deathsPerHour.toFixed(2) }}</span> <span class="muted">{{ ci(row, "deathsPerHour") }}</span></template></el-table-column>
        <el-table-column prop="encountersPerHour" :label="t('遭遇/小时')" sortable align="right"><template #default="{ row }">{{ row.encountersPerHour.toFixed(1) }}</template></el-table-column>
        <el-table-column :label="t('空蓝')" align="right"><template #default="{ row }">{{ pct(row.outOfManaTimeRatio) }}</template></el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
