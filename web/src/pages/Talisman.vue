<script setup>
import { computed, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { money, store } from "../api.js"
import JobRunner from "../components/JobRunner.vue"
import { joinList, t, tk } from "../i18n.js"

const o = computed(() => store.options)
const mods = computed(() => o.value?.talismanModifiers || [])
const info = computed(() => Object.fromEntries(mods.value.map(x => [x.hrid, x])))
const modName = h => info.value[h]?.name || h
const GROUPS = [["offense", tk("进攻词条")], ["defense", tk("防御词条")], ["utility", tk("辅助词条")], ["special", tk("特殊词条")]]
const groups = computed(() => GROUPS.map(([key, label]) => ({ key, label: t(label), list: mods.value.filter(x => x.group === key) })).filter(g => g.list.length))

// inputs, remembered in this browser
const KEY = "fastsim-talisman-v1"
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}")
  } catch {
    return {}
  }
})()
const start = ref(saved.start || { lines: [], lockHrid: "" })
const target = ref(saved.target || [])
const prices = ref(saved.prices || {})
const weights = ref(saved.weights || [32, 16, 8, 4, 2, 1])
const runs = ref(saved.runs || 400)
watch([start, target, prices, weights, runs], () => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ start: start.value, target: target.value, prices: prices.value, weights: weights.value, runs: runs.value }))
  } catch {}
}, { deep: true })

const items = computed(() => o.value?.talismanItems || [])
const priceOf = it => prices.value[it.hrid] ?? (it.ask || it.sell)
const priceNote = it => (prices.value[it.hrid] != null ? t("手填") : it.ask ? t("市场卖一价") : t("商店卖价（占位）"))
function setPrice(h, v) {
  prices.value = { ...prices.value, [h]: Math.max(0, Number(v) || 0) }
}
function resetPrices() {
  prices.value = {}
}

// start talisman: typed in, or one of the team's (slotted or owned) talismans
const sources = computed(() => {
  const out = []
  const seen = new Set()
  for (const m of store.team.members || []) {
    for (const x of [...(m.talismans || []), ...(m.talismanLibrary || [])]) {
      if (!x?.modifiers?.length) continue
      const k = `${m.id}:${x.id ?? JSON.stringify(x.modifiers)}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ label: `${m.name} · ${x.modifiers.map(l => `${modName(l.hrid)} G${l.grade}`).join(" / ")}`, x })
    }
  }
  return out
})
function pick(i) {
  const x = sources.value[i]?.x
  if (x) start.value = { lines: x.modifiers.map(l => ({ hrid: l.hrid, grade: l.grade })), lockHrid: "" }
}
const MAX = computed(() => o.value?.talismanMaxModifiers || 4)
function setLine(list, j, field, v, dflt) {
  const a = list.map(x => ({ ...x }))
  if (field === "hrid" && !v) a.splice(j, 1)
  else if (j >= a.length) a.push({ ...dflt, [field]: v })
  else a[j][field] = v
  return a.filter(x => x.hrid)
}
const startRows = computed(() => Math.min(MAX.value, start.value.lines.length + 1))
const targetRows = computed(() => Math.min(MAX.value, target.value.length + 1))
const setStart = (j, f, v) => {
  start.value = { ...start.value, lines: setLine(start.value.lines, j, f, v, { hrid: "", grade: 1 }) }
  if (!start.value.lines.some(l => l.hrid === start.value.lockHrid)) start.value.lockHrid = ""
}
const setTarget = (j, f, v) => (target.value = setLine(target.value, j, f, v, { hrid: "", min: 1 }))

function params() {
  if (!mods.value.length) return ElMessage.warning(t("游戏数据里没有符石（打开左侧栏的「测试服数据」）"))
  if (!target.value.length) return ElMessage.warning(t("请填写目标词条"))
  return {
    start: start.value,
    target: target.value,
    prices: Object.fromEntries(items.value.map(it => [it.hrid, Number(priceOf(it)) || 0])),
    gradeWeights: weights.value.map(Number),
    runs: runs.value,
  }
}
const result = ref(null)
const fmtCost = v => (Number.isFinite(v) ? money(v) : t("超出上限"))
const isTarget = h => (result.value?.target || target.value).some(q => q.hrid === h)
const itemName = h => items.value.find(i => i.hrid === h)?.name || h
// the example run with consecutive dropped rerolls of the same orb folded into one row
const exampleRows = computed(() => {
  const out = []
  for (const x of result.value?.example?.log || []) {
    const last = out[out.length - 1]
    if (!x.taken && last && !last.taken && last.op === x.op) last.n++
    else out.push({ ...x, n: 1 })
  }
  return out
})
const ORB_ITEM = { reshape: "/items/reshaping_orb", reforge: "/items/reforging_orb", mutate: "/items/mutation_orb", focus: "/items/focus_orb", attune: "/items/attunement_orb", exchange: "/items/exchange_orb", bind: "/items/binding_orb" }
const gradeOdds = computed(() => {
  const w = weights.value.map(Number)
  const s = w.reduce((a, b) => a + b, 0) || 1
  return w.map(x => `${((x / s) * 100).toFixed(1)}%`).join(" / ")
})
</script>

<template>
  <div class="page">
    <h2>{{ t("符石洗练") }}</h2>
    <el-alert v-if="!mods.length" type="info" :closable="false" style="margin-bottom: 12px" :title="t('游戏数据里没有符石（打开左侧栏的「测试服数据」）')" />
    <p class="muted">{{ t("从现有符石洗到目标词条，比较各种洗法（用哪种宝珠凑类型、提品级，什么时候锁定，洗出的结果要不要）的期望花费，给出最便宜的做法和一次典型的洗练过程。") }}</p>

    <el-card>
      <template #header><b>{{ t("现在的符石") }}</b> <span class="muted">{{ t("留空 = 从新做一个符石开始") }}</span></template>
      <div v-if="sources.length" class="row" style="margin-bottom: 8px">
        <el-select :model-value="null" :placeholder="t('从队伍的符石里选')" size="small" style="width: 520px" @update:model-value="pick">
          <el-option v-for="(s, i) in sources" :key="i" :label="s.label" :value="i" />
        </el-select>
        <el-button size="small" text @click="start = { lines: [], lockHrid: '' }">{{ t("清空") }}</el-button>
      </div>
      <div v-for="j in startRows" :key="j" class="row" style="margin-bottom: 4px">
        <el-select :model-value="start.lines[j - 1]?.hrid || ''" filterable clearable size="small" style="width: 200px" :placeholder="t('词条')" @update:model-value="v => setStart(j - 1, 'hrid', v)">
          <el-option-group v-for="g in groups" :key="g.key" :label="g.label">
            <el-option v-for="x in g.list" :key="x.hrid" :label="x.name" :value="x.hrid" />
          </el-option-group>
        </el-select>
        <span class="muted">{{ t("品级") }}</span>
        <el-input-number :model-value="start.lines[j - 1]?.grade || 1" :min="1" :max="6" size="small" style="width: 90px" :disabled="!start.lines[j - 1]" @change="v => setStart(j - 1, 'grade', v)" />
        <el-checkbox v-if="start.lines[j - 1]" :model-value="start.lockHrid === start.lines[j - 1].hrid" @change="v => (start.lockHrid = v ? start.lines[j - 1].hrid : '')">{{ t("已锁定") }}</el-checkbox>
      </div>
    </el-card>

    <el-card>
      <template #header><b>{{ t("目标") }}</b> <span class="muted">{{ t("要有的词条和最低品级，顺序不限；其余词条随意") }}</span></template>
      <div v-for="j in targetRows" :key="j" class="row" style="margin-bottom: 4px">
        <el-select :model-value="target[j - 1]?.hrid || ''" filterable clearable size="small" style="width: 200px" :placeholder="t('词条')" @update:model-value="v => setTarget(j - 1, 'hrid', v)">
          <el-option-group v-for="g in groups" :key="g.key" :label="g.label">
            <el-option v-for="x in g.list" :key="x.hrid" :label="x.name" :value="x.hrid" :disabled="target.some((q, k) => k !== j - 1 && q.hrid === x.hrid)" />
          </el-option-group>
        </el-select>
        <span class="muted">{{ t("至少") }}</span>
        <el-input-number :model-value="target[j - 1]?.min || 1" :min="1" :max="6" size="small" style="width: 90px" :disabled="!target[j - 1]" @change="v => setTarget(j - 1, 'min', v)" />
      </div>
    </el-card>

    <el-card>
      <template #header>
        <div class="row"><b>{{ t("价格") }}</b><span class="muted">{{ t("正式服还没有这些物品的市场价，先按商店卖价占位，请按你的估价改") }}</span><span style="flex: 1" /><el-button size="small" text @click="resetPrices">{{ t("恢复默认") }}</el-button></div>
      </template>
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(440px, 1fr))">
        <div v-for="it in items" :key="it.hrid" class="row" style="flex-wrap: nowrap">
          <span style="width: 110px">{{ it.name }}</span>
          <el-input-number :model-value="priceOf(it)" :min="0" :step="10000" size="small" style="width: 150px" :controls="false" @change="v => setPrice(it.hrid, v)" />
          <span class="muted">{{ money(priceOf(it)) }} · {{ priceNote(it) }}</span>
        </div>
      </div>
      <el-collapse style="margin-top: 8px">
        <el-collapse-item :title="t('洗出品级的概率（游戏数据里没有，可改）')">
          <div class="row">
            <span v-for="(w, i) in weights" :key="i" class="row">
              <span class="muted">G{{ i + 1 }}</span>
              <el-input-number v-model="weights[i]" :min="0" size="small" style="width: 80px" :controls="false" />
            </span>
          </div>
          <div class="muted" style="margin-top: 6px">{{ t("相对权重，按上限截断后归一（重塑只到 G4）。现在：{odds}。默认每级减半，和测试服洗出的 432 条（重塑、重铸混在一起）大致吻合。", { odds: gradeOdds }) }}</div>
        </el-collapse-item>
      </el-collapse>
      <div class="row" style="margin-top: 8px">
        <span class="muted">{{ t("每种洗法模拟") }}</span>
        <el-input-number v-model="runs" :min="50" :max="20000" :step="100" size="small" style="width: 120px" />
        <span class="muted">{{ t("次（最好的几种再多跑 4 倍）") }}</span>
      </div>
    </el-card>

    <el-card>
      <JobRunner name="talisman" type="talisman" :params="params" @result="r => (result = r)" />
    </el-card>

    <template v-if="result">
      <el-card>
        <template #header><b>{{ t("最便宜的做法") }}</b></template>
        <ol v-if="result.best.plan" style="margin: 0 0 8px; padding-left: 22px; line-height: 1.9">
          <li v-for="(x, i) in result.best.plan" :key="i">{{ x }}</li>
        </ol>
        <div v-else style="margin-bottom: 8px">{{ result.best.text }}</div>
        <div class="row" style="margin-bottom: 8px">
          <span>{{ t("期望花费") }} <b>{{ fmtCost(result.best.mean) }}</b></span>
          <span class="muted">{{ t("中位数 {m} · 90% 在 {p} 以内 · 平均 {n} 步", { m: fmtCost(result.best.median), p: fmtCost(result.best.p90), n: result.best.steps.toFixed(0) }) }}</span>
          <span v-if="result.best.success < 1" class="bad">{{ t("{p}% 的模拟在花费上限 {c} 内没洗出来", { p: ((1 - result.best.success) * 100).toFixed(1), c: fmtCost(result.maxCost) }) }}</span>
        </div>
        <div class="muted">{{ t("平均用量：") }}{{ joinList(Object.entries(result.best.counts).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${itemName(h)} ×${n.toFixed(1)}`)) }}</div>
      </el-card>
      <el-card>
        <template #header><b>{{ t("各种做法比较") }}</b></template>
        <el-table :data="result.top" size="small">
          <el-table-column :label="t('做法')" min-width="420"><template #default="{ row }">{{ row.text }}</template></el-table-column>
          <el-table-column :label="t('期望')" width="100"><template #default="{ row }">{{ fmtCost(row.mean) }}</template></el-table-column>
          <el-table-column :label="t('中位数')" width="100"><template #default="{ row }">{{ fmtCost(row.median) }}</template></el-table-column>
          <el-table-column label="90%" width="100"><template #default="{ row }">{{ fmtCost(row.p90) }}</template></el-table-column>
          <el-table-column :label="t('成功率')" width="80"><template #default="{ row }">{{ (row.success * 100).toFixed(1) }}%</template></el-table-column>
        </el-table>
      </el-card>
      <el-card v-if="result.example">
        <template #header><b>{{ t("一次典型的洗练过程") }}</b> <span class="muted">{{ t("花费 {c}，用了 {n} 次宝珠（接近中位数的一次）。绿色是目标词条。", { c: fmtCost(result.example.cost), n: result.example.steps }) }}</span></template>
        <div v-for="(x, i) in exampleRows" :key="i" class="row" style="margin-bottom: 4px; align-items: baseline">
          <span class="muted" style="width: 28px">{{ i + 1 }}</span>
          <span style="width: 230px">
            <template v-if="x.op === 'add'">{{ t("加一条词条") }}</template>
            <template v-else-if="x.op === 'bind'">{{ t("用{orb}锁住 {line}", { orb: itemName(ORB_ITEM.bind), line: `${modName(x.lines[x.lock].hrid)} G${x.lines[x.lock].grade}` }) }}</template>
            <template v-else-if="x.taken">{{ t("用{orb}，洗出：", { orb: itemName(ORB_ITEM[x.op]) }) }}</template>
            <template v-else>{{ t("用{orb} {n} 次，结果都没要", { orb: itemName(ORB_ITEM[x.op]), n: x.n }) }}</template>
          </span>
          <span v-if="x.taken">
            <span v-for="(l, k) in x.lines" :key="k" :style="{ marginRight: '12px', fontWeight: isTarget(l.hrid) ? 600 : 400, color: isTarget(l.hrid) ? 'var(--el-color-success)' : undefined }">{{ modName(l.hrid) }} G{{ l.grade }}</span>
            <span v-if="x.op !== 'add' && x.op !== 'bind'" class="muted">{{ t("→ 采用") }}</span>
          </span>
        </div>
        <div v-if="result.example.truncated" class="muted">{{ t("……只显示前 400 步") }}</div>
      </el-card>
    </template>
  </div>
</template>
