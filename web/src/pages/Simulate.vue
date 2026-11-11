<script setup>
import { computed, reactive, ref } from "vue"
import { ElMessage } from "element-plus"
import { COMBAT_SKILLS, attackName, call, ci, randomSeedBase, defaultExtra, defaultTarget, duration, int, itemName, money, monsterName, perDay, pct, qty, selectedMembers, store, targetLabel } from "../api.js"
import { copyText, fileStamp, saveImage, stamp } from "../export.js"
import { joinList, t } from "../i18n.js"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"

const target = ref(defaultTarget())
const extra = ref(defaultExtra())
const hours = ref(24)
const seeds = ref(8)
const reseed = ref(false)
const busy = ref(false)
const res = ref(null)
const ms = ref(0)
const who = ref(0)
const out = ref(null)
const members = computed(() => selectedMembers())
// what the shown result was run with (the selection / target may change afterwards)
const ran = ref(null)

async function run() {
  if (!members.value.length) return ElMessage.warning(t("先在“队伍”页勾选出战成员"))
  busy.value = true
  const t0 = performance.now()
  try {
    const body = { members: members.value, target: target.value, extra: extra.value, hours: hours.value, seeds: seeds.value, seedBase: reseed.value ? randomSeedBase() : undefined }
    res.value = await call("POST", "/api/simulate", body)
    ran.value = JSON.parse(JSON.stringify(body))
    if (who.value >= body.members.length) who.value = 0
    ms.value = performance.now() - t0
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}
const runMembers = computed(() => ran.value?.members || [])
const rows = computed(() => res.value?.mean.players.map((p, i) => ({ name: runMembers.value[i]?.name, ...p })) || [])
const kills = computed(() => {
  const d = res.value?.detail.result.deaths || {}
  const h = (res.value?.detail.result.simulatedTime || 1) / 3600e9
  return Object.entries(d).filter(([k]) => !k.startsWith("player")).map(([k, v]) => ({ name: store.options.names.monsters[k] || k, perHour: v / h })).sort((a, b) => b.perHour - a.perHour)
})
const detailHours = computed(() => (res.value?.detail.result.simulatedTime || 1) / 3600e9)
const damage = computed(() => {
  const r = res.value?.detail.result
  const pid = `player${who.value + 1}`
  const out = []
  for (const [tgt, byAb] of Object.entries(r?.attacks?.[pid] || {}))
    for (const [ab, byDmg] of Object.entries(byAb)) {
      let hits = 0, miss = 0, total = 0
      for (const [k, n] of Object.entries(byDmg)) {
        if (k === "miss") miss += n
        else { hits += n; total += Number(k) * n }
      }
      const e = out.find(x => x.ability === ab) || (out.push({ ability: ab, hits: 0, miss: 0, total: 0 }), out[out.length - 1])
      e.hits += hits
      e.miss += miss
      e.total += total
    }
  return out.map(e => ({ ...e, name: attackName(e.ability), dps: e.total / (detailHours.value * 3600) })).sort((a, b) => b.total - a.total)
})

// ---- death analysis (first run): the hit that killed, and the damage taken by source
const deaths = computed(() => {
  const r = res.value?.detail.result
  const pid = `player${who.value + 1}`
  const total = Number(r?.deaths?.[pid] || 0)
  const causes = []
  for (const [src, byAb] of Object.entries(r?.deathCauses?.[pid] || {}))
    for (const [ab, n] of Object.entries(byAb)) causes.push({ name: `${monsterName(src)} · ${attackName(ab)}`, n })
  causes.sort((a, b) => b.n - a.n)
  const taken = []
  for (const [src, byTgt] of Object.entries(r?.attacks || {})) {
    if (src.startsWith("player")) continue
    for (const [ab, byDmg] of Object.entries(byTgt[pid] || {})) {
      let hits = 0, miss = 0, sum = 0, max = 0
      for (const [k, n] of Object.entries(byDmg)) {
        if (k === "miss") miss += n
        else { hits += n; sum += Number(k) * n; max = Math.max(max, Number(k)) }
      }
      if (hits + miss) taken.push({ name: `${monsterName(src)} · ${attackName(ab)}`, perHour: sum / detailHours.value, max, hitRate: hits / (hits + miss), count: hits + miss })
    }
  }
  taken.sort((a, b) => b.perHour - a.perHour)
  return { total, outOfMana: Number(r?.deathsOutOfMana?.[pid] || 0), causes, taken, recorded: !!r?.deathCauses }
})
const teamDeaths = computed(() => Object.entries(res.value?.detail.result.deaths || {}).filter(([k]) => k.startsWith("player")).reduce((a, [, v]) => a + v, 0))

// ---- time to level, from the synced experience and this spot's experience per hour
const goalLevel = reactive({})
const levels = computed(() => {
  const m = runMembers.value[who.value]
  const p = res.value?.mean.players[who.value]
  const table = store.options?.levelXp || []
  if (!m || !p || !table.length) return []
  const cap = table.length - 1
  return COMBAT_SKILLS.map(([k, label]) => {
    const L = Math.min(cap, Number(m.levels?.[k] || 1))
    const e = Number(m.experience?.[k])
    const xp = Number.isFinite(e) && e >= table[L] && (L >= cap || e < table[L + 1]) ? e : table[L]
    const rate = p[`xp_${k}`] || 0
    const key = `${who.value}:${k}`
    const goal = Math.min(cap, Math.max(L + 1, goalLevel[key] ?? L + 1))
    const hoursTo = to => (to <= L ? 0 : rate > 0 ? (table[to] - xp) / rate : Infinity)
    return { key, label: t(label), level: L, progress: L >= cap ? 1 : (xp - table[L]) / (table[L + 1] - table[L]), rate, next: L >= cap ? null : hoursTo(L + 1), goal, toGoal: L >= cap ? null : hoursTo(goal), exact: Number.isFinite(e), cap }
  })
})

// ---- export
function summary() {
  const r = ran.value
  const lines = [t("【模拟】{target}（{h} 小时 × {n} 次，{time}）", { target: targetLabel(r.target), h: r.hours, n: r.seeds, time: stamp() })]
  const m = res.value.mean
  lines.push(t("全队：利润 {profit}/天（中值 {mid}/天），经验 {xp}/小时，遭遇 {enc}/小时，死亡 {deaths}/小时", { profit: perDay(m.profitPerHour), mid: perDay(m.profitMidpointPerHour), xp: int(m.xpPerHour), enc: m.encountersPerHour.toFixed(1), deaths: m.deathsPerHour.toFixed(2) + ci(m, "deathsPerHour") }))
  for (const p of rows.value)
    lines.push(t("· {name}：利润 {profit}/天，收入 {rev}/天，消耗 {exp}/天，经验 {xp}/小时，死亡 {deaths}/小时，空蓝 {oom}", { name: p.name, profit: perDay(p.profitPerHour), rev: perDay(p.revenuePerHour), exp: perDay(p.expensesPerHour), xp: int(p.xpPerHour), deaths: p.deathsPerHour.toFixed(2), oom: pct(p.outOfManaTimeRatio) }))
  return lines.join("\n")
}
</script>

<template>
  <div class="page">
    <h2>{{ t("模拟") }}</h2>
    <el-card>
      <div class="row" style="margin-bottom: 8px"><TargetPicker v-model="target" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row">
        <span class="muted">{{ t("时长（小时）") }}</span><el-input-number v-model="hours" :min="1" :max="720" size="small" />
        <span class="muted">{{ t("重复次数（不同种子，取平均）") }}</span><el-input-number v-model="seeds" :min="1" :max="64" size="small" />
        <el-tooltip :content="t('默认每次用同一组随机战斗，重跑结果不变；勾上后换一组，用来检查结果是否稳定')" placement="top"><el-checkbox v-model="reseed" size="small">{{ t("换一组随机种子") }}</el-checkbox></el-tooltip>
        <el-button type="primary" :loading="busy" @click="run">{{ t("开始模拟") }}</el-button>
        <span v-if="res" class="muted">{{ t("{n} × {h} 小时，用时 {s} 秒", { n: ran.seeds, h: ran.hours, s: (ms / 1000).toFixed(2) }) }}</span>
        <template v-if="res">
          <el-button size="small" @click="copyText(summary())">{{ t("复制文字") }}</el-button>
          <el-button size="small" @click="saveImage(out, `${t('模拟')}-${fileStamp()}`)">{{ t("保存图片") }}</el-button>
        </template>
      </div>
      <div class="muted" style="margin-top: 6px">{{ t("成员：") }}{{ joinList(members.map(m => m.name)) || t("未选择") }}</div>
    </el-card>

    <div v-if="res" ref="out">
      <el-card>
        <template #header><b>{{ t("全队") }}</b><span class="muted" style="margin-left: 8px">{{ targetLabel(ran.target) }} · {{ t("{h} 小时 × {n} 次", { h: ran.hours, n: ran.seeds }) }}{{ ran.seedBase ? t("（换过随机种子）") : "" }} · {{ t("± 是 95% 范围") }}</span></template>
        <div class="row" style="gap: 32px">
          <div><el-tooltip :content="t('掉落按买一价（直接卖给收购单）、消耗品按卖一价（直接从卖单买）算：不挂单、即买即卖时实际到手的利润')" placement="top"><span class="hint">{{ t("利润（下限）") }}</span></el-tooltip><div style="font-size: 22px">{{ perDay(res.mean.profitPerHour) }}{{ t("/天") }} <span class="muted">{{ ci(res.mean, "profitPerHour", v => money(v * 24)) }}</span></div></div>
          <div><el-tooltip :content="t('掉落和消耗品都按买一价和卖一价的中间价算：大致是挂单买卖、等成交时的利润')" placement="top"><span class="hint">{{ t("利润（中值）") }}</span></el-tooltip><div style="font-size: 22px">{{ perDay(res.mean.profitMidpointPerHour) }}{{ t("/天") }}</div></div>
          <div>{{ t("经验") }}<div style="font-size: 22px">{{ int(res.mean.xpPerHour) }}{{ t("/小时") }}</div></div>
          <div>{{ t("遭遇") }}<div style="font-size: 22px">{{ res.mean.encountersPerHour.toFixed(1) }}{{ t("/小时") }}</div></div>
          <div>{{ t("死亡") }}<div style="font-size: 22px"><span :class="{ bad: res.mean.deathsPerHour > 0 }">{{ res.mean.deathsPerHour.toFixed(2) }}{{ t("/小时") }}</span> <span class="muted">{{ ci(res.mean, "deathsPerHour") }}</span></div></div>
        </div>
      </el-card>
      <el-card>
        <template #header><b>{{ t("成员") }}</b></template>
        <el-table :data="rows" size="small">
          <el-table-column prop="name" :label="t('角色')" />
          <el-table-column :label="t('经验/小时')" align="right"><template #default="{ row }">{{ int(row.xpPerHour) }}</template></el-table-column>
          <el-table-column :label="t('收入/天')" align="right"><template #default="{ row }">{{ perDay(row.revenuePerHour) }}</template></el-table-column>
          <el-table-column :label="t('消耗/天')" align="right"><template #default="{ row }">{{ perDay(row.expensesPerHour) }}</template></el-table-column>
          <el-table-column :label="t('利润下限/天')" align="right"><template #default="{ row }">{{ perDay(row.profitPerHour) }}</template></el-table-column>
          <el-table-column :label="t('利润上限/天')" align="right"><template #default="{ row }">{{ perDay(row.profitUpperPerHour) }}</template></el-table-column>
          <el-table-column :label="t('死亡/小时')" align="right"><template #default="{ row }">{{ row.deathsPerHour.toFixed(2) }}</template></el-table-column>
          <el-table-column :label="t('空蓝时间')" align="right"><template #default="{ row }">{{ pct(row.outOfManaTimeRatio) }}</template></el-table-column>
        </el-table>
      </el-card>
      <el-card>
        <template #header>
          <div class="row"><b>{{ t("明细") }}</b><span class="muted">{{ t("（第一次模拟，{h} 小时）", { h: detailHours.toFixed(0) }) }}</span>
            <el-radio-group v-model="who" size="small"><el-radio-button v-for="(m, i) in runMembers" :key="i" :value="i">{{ m.name }}</el-radio-button></el-radio-group>
          </div>
        </template>
        <div class="grid">
          <div>
            <b>{{ t("伤害") }}</b>
            <el-table :data="damage" size="small" max-height="360">
              <el-table-column prop="name" :label="t('来源')" />
              <el-table-column label="DPS" align="right"><template #default="{ row }">{{ row.dps.toFixed(1) }}</template></el-table-column>
              <el-table-column :label="t('命中率')" align="right"><template #default="{ row }">{{ pct(row.hits / Math.max(1, row.hits + row.miss)) }}</template></el-table-column>
              <el-table-column :label="t('次数')" align="right"><template #default="{ row }">{{ int(row.hits + row.miss) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>{{ t("击杀/小时") }}</b>
            <el-table :data="kills" size="small" max-height="360">
              <el-table-column prop="name" :label="t('怪物')" />
              <el-table-column :label="t('每小时')" align="right"><template #default="{ row }">{{ row.perHour.toFixed(1) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>{{ t("收入（按买一价）") }}</b>
            <el-table :data="res.detail.players[who]?.revenueItems.slice(0, 20)" size="small" max-height="360">
              <el-table-column :label="t('物品')"><template #default="{ row }">{{ itemName(row.itemHrid) }}</template></el-table-column>
              <el-table-column :label="t('数量/天')" align="right"><template #default="{ row }">{{ qty(row.amount / detailHours * 24) }}</template></el-table-column>
              <el-table-column :label="t('价值/天')" align="right"><template #default="{ row }">{{ money(row.total / detailHours * 24) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>{{ t("消耗（按卖价）") }}</b>
            <el-table :data="res.detail.players[who]?.expenseItems" size="small" max-height="360">
              <el-table-column :label="t('物品')"><template #default="{ row }">{{ itemName(row.itemHrid) }}</template></el-table-column>
              <el-table-column :label="t('数量/天')" align="right"><template #default="{ row }">{{ qty(row.amount / detailHours * 24) }}</template></el-table-column>
              <el-table-column :label="t('花费/天')" align="right"><template #default="{ row }">{{ money(row.total / detailHours * 24) }}</template></el-table-column>
            </el-table>
          </div>
        </div>
      </el-card>
      <el-card>
        <template #header>
          <div class="row"><b>{{ t("死亡分析") }}</b><span class="muted">{{ t("（第一次模拟，{h} 小时；全队死亡 {n} 次）", { h: detailHours.toFixed(0), n: int(teamDeaths) }) }}</span>
            <el-radio-group v-model="who" size="small"><el-radio-button v-for="(m, i) in runMembers" :key="i" :value="i">{{ m.name }}</el-radio-button></el-radio-group>
          </div>
        </template>
        <div class="muted" style="margin-bottom: 8px">
          <template v-if="deaths.total">{{ t("死亡 {n} 次", { n: int(deaths.total) }) }}<template v-if="deaths.recorded">{{ t("，其中 {n} 次死时空蓝", { n: int(deaths.outOfMana) }) }}</template>{{ t("。") }}</template>
          <template v-else>{{ t("这次模拟里没有死亡") }}<template v-if="res.mean.players[who]?.deathsPerHour > 0">{{ t("（平均每小时 {n} 次，可以加长时长再看）", { n: res.mean.players[who].deathsPerHour.toFixed(2) }) }}</template>{{ t("。") }}</template>
          <template v-if="!deaths.recorded">{{ t("本地服务需要重新编译引擎后才有致命一击记录。") }}</template>
        </div>
        <div class="grid">
          <div v-if="deaths.causes.length">
            <b>{{ t("致命一击") }}</b>
            <el-table :data="deaths.causes" size="small" max-height="360">
              <el-table-column prop="name" :label="t('来源')" min-width="160" />
              <el-table-column :label="t('次数')" align="right"><template #default="{ row }">{{ int(row.n) }}</template></el-table-column>
              <el-table-column :label="t('占比')" align="right"><template #default="{ row }">{{ pct(row.n / deaths.total) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>{{ t("受到的伤害") }}</b>
            <el-table :data="deaths.taken" size="small" max-height="360">
              <el-table-column prop="name" :label="t('来源')" min-width="160" />
              <el-table-column :label="t('伤害/小时')" align="right"><template #default="{ row }">{{ int(row.perHour) }}</template></el-table-column>
              <el-table-column :label="t('最大一击')" align="right"><template #default="{ row }">{{ int(row.max) }}</template></el-table-column>
              <el-table-column :label="t('命中率')" align="right"><template #default="{ row }">{{ pct(row.hitRate) }}</template></el-table-column>
            </el-table>
          </div>
        </div>
      </el-card>
      <el-card v-if="levels.length">
        <template #header>
          <div class="row"><b>{{ t("升级时间") }}</b><span class="muted">{{ t("（按同步时的经验，一直刷这里）") }}</span>
            <el-radio-group v-model="who" size="small"><el-radio-button v-for="(m, i) in runMembers" :key="i" :value="i">{{ m.name }}</el-radio-button></el-radio-group>
          </div>
        </template>
        <el-table :data="levels" size="small">
          <el-table-column prop="label" :label="t('技能')" width="70" />
          <el-table-column :label="t('等级')" width="170"><template #default="{ row }">Lv.{{ row.level }} <span class="muted">{{ row.exact ? pct(row.progress) : t("无经验数据") }}</span></template></el-table-column>
          <el-table-column :label="t('经验/小时')" align="right"><template #default="{ row }">{{ int(row.rate) }}</template></el-table-column>
          <el-table-column :label="t('升下一级')" align="right"><template #default="{ row }">{{ row.next == null ? t("满级") : duration(row.next) }}</template></el-table-column>
          <el-table-column :label="t('目标等级')" align="center" width="150"><template #default="{ row }"><el-input-number v-if="row.level < row.cap" :model-value="row.goal" :min="row.level + 1" :max="row.cap" size="small" style="width: 110px" @update:model-value="v => (goalLevel[row.key] = v)" /></template></el-table-column>
          <el-table-column :label="t('到目标')" align="right"><template #default="{ row }">{{ row.toGoal == null ? "—" : duration(row.toGoal) }}</template></el-table-column>
        </el-table>
      </el-card>
    </div>
  </div>
</template>
