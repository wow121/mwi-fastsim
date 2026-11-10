<script setup>
import { computed, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { call, money, store } from "../api.js"
import { joinList, t, tk } from "../i18n.js"

const SLOT = { weapon: tk("武器"), off_hand: tk("副手"), head: tk("头部"), body: tk("身体"), legs: tk("腿部"), hands: tk("手部"), feet: tk("脚部"), back: tk("背部"), neck: tk("项链"), earrings: tk("耳环"), ring: tk("戒指"), pouch: tk("袋子"), charm: tk("护符"), trinket: tk("饰品") }
const load = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d
  } catch {
    return d
  }
}
const form = ref(load("fastsim-gear-cost", { hrid: "", level: 10, tax: 4, hasHeld: false, heldHrid: "", heldLevel: 0 }))
watch(form, v => {
  try {
    localStorage.setItem("fastsim-gear-cost", JSON.stringify(v))
  } catch {}
}, { deep: true })
const groups = computed(() => Object.entries(store.options?.equipment || {}).map(([slot, list]) => ({ label: SLOT[slot] ? t(SLOT[slot]) : slot, list })))
const cap = computed(() => store.options?.enhancementCap || 20)
const result = ref(null)
const loading = ref(false)
const expanded = ref([])

async function run() {
  if (!form.value.hrid) return ElMessage.warning(t("先选一件装备"))
  loading.value = true
  try {
    const f = form.value
    result.value = await call("POST", "/api/gear-cost", {
      hrid: f.hrid, level: f.level, tax: f.tax / 100,
      held: f.hasHeld && f.heldHrid ? { hrid: f.heldHrid, level: f.heldLevel } : null,
    })
    expanded.value = result.value.best ? [result.value.best] : []
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}
function toggleHeld(v) {
  if (v && !form.value.heldHrid) form.value.heldHrid = form.value.hrid
}
const market = computed(() => result.value?.options.find(o => o.key === "market"))
const best = computed(() => result.value?.options.find(o => o.key === result.value.best))
const kindText = { market: tk("市场买"), refine: tk("买普通版精炼"), unrefine: tk("买精炼版解精炼"), mirror: tk("镜子合成") }
</script>

<template>
  <div class="page">
    <h2>{{ t("装备获取成本") }}</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        {{ t("选一件装备和强化等级，比较直接买、用贤者之镜合成（+N 主件 + 一件 +(N-1) 垫子 + 镜子 = +(N+1)，精炼版可以用普通版当垫子）、") }}
        {{ t("买普通版自己精炼、买精炼版解精炼（拿回一半精炼材料）几种做法的花费，并列出最便宜做法要买的东西。低等级的主件和垫子也按最便宜的方式获取（可能又是镜子合成）。") }}
        {{ t("手上已有同系列装备时，还会算拿它当主件、拿它当垫子（精炼版可以先解精炼）的花费；不用它的做法按把它卖掉来算净花费。价格按市场最低卖价买、最高买价扣税卖。") }}
      </p>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">{{ t("装备") }}</span>
        <el-select v-model="form.hrid" filterable :placeholder="t('选择装备')" style="width: 260px" size="small">
          <el-option-group v-for="g in groups" :key="g.label" :label="g.label">
            <el-option v-for="i in g.list" :key="i.hrid" :label="i.name" :value="i.hrid" />
          </el-option-group>
        </el-select>
        <span class="muted">{{ t("目标") }}</span><el-input-number v-model="form.level" :min="0" :max="cap" size="small" /><span class="muted">{{ t("级") }}</span>
        <span class="muted">{{ t("卖出税") }}</span><el-input-number v-model="form.tax" :min="0" :max="20" :step="0.5" size="small" /><span class="muted">%</span>
      </div>
      <div class="row" style="margin-bottom: 12px">
        <el-checkbox v-model="form.hasHeld" @change="toggleHeld">{{ t("手上已有同系列装备") }}</el-checkbox>
        <template v-if="form.hasHeld">
          <el-select v-model="form.heldHrid" filterable style="width: 260px" size="small">
            <el-option-group v-for="g in groups" :key="g.label" :label="g.label">
              <el-option v-for="i in g.list" :key="i.hrid" :label="i.name" :value="i.hrid" />
            </el-option-group>
          </el-select>
          <span class="muted">+</span><el-input-number v-model="form.heldLevel" :min="0" :max="cap" size="small" />
        </template>
      </div>
      <el-button type="primary" :loading="loading" @click="run">{{ t("计算") }}</el-button>
    </el-card>

    <el-card v-if="result">
      <template #header>
        <div class="row">
          <b>{{ result.target.name }} +{{ result.target.level }}</b>
          <span v-if="result.held" class="muted">{{ t("净花费 = 花费 − 手上装备扣税后能卖的钱（当主件 / 垫子用掉的做法不减）") }}</span>
          <span class="muted">{{ t("市场：卖 {ask} / 收 {bid} · 镜子 {mirror}", { ask: money(result.market.ask), bid: money(result.market.bid), mirror: money(result.mirrorPrice) }) }}<template v-if="result.refine">{{ t(" · 精炼材料 {cost} · 解精炼返还 {back}", { cost: money(result.refine.cost), back: money(result.refine.unrefineValue) }) }}</template><template v-if="result.held">{{ t(" · 手上的 {item} +{n} 扣税能卖 {v}", { item: result.held.name, n: result.held.n, v: money(result.held.value) }) }}</template></span>
        </div>
      </template>
      <el-alert v-if="best" type="success" :closable="false" style="margin-bottom: 10px">
        <template #title>
          {{ t("最便宜：") }}<b>{{ best.label }}</b>{{ t("，花费") }} <b>{{ money(best.cost) }}</b><template v-if="result.held">{{ t("（净花费 {v}）", { v: money(best.net) }) }}</template>
          <template v-if="market?.net != null && best.key !== 'market'">{{ t("，比直接买（{v}）省", { v: money(market.net) }) }} <b>{{ money(market.net - best.net) }}</b></template>
          <template v-else-if="best.key === 'market'">{{ t("，直接买最划算") }}</template>
        </template>
      </el-alert>
      <el-table :data="result.options" size="small" row-key="key" :expand-row-keys="expanded" @expand-change="(r, rows) => (expanded = rows.map(x => x.key))">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div v-if="row.lines" style="padding: 0 24px 8px">
              <div class="row" style="align-items: flex-start; gap: 32px">
                <div>
                  <b>{{ t("步骤") }}</b>
                  <div v-for="(l, i) in row.lines" :key="i" class="muted">{{ i + 1 }}. {{ l.text }}<span v-if="l.cost">{{ t("（{v}）", { v: (l.cost > 0 ? "" : "+") + money(Math.abs(l.cost)) }) }}</span></div>
                </div>
                <div>
                  <b>{{ t("要买的") }}</b>
                  <div v-for="s in row.shopping" :key="s.h + s.n" class="muted">{{ s.name }}{{ s.n ? ` +${s.n}` : "" }} × {{ s.count }}{{ t("（{v}）", { v: money(s.price) }) }}</div>
                  <div v-if="row.refines && result.refine" class="muted">{{ t("精炼材料 × {n} 份：", { n: row.refines }) }}{{ joinList(result.refine.inputs.map(i => `${i.name} ${Math.round(i.count * 10) / 10}`)) }}</div>
                </div>
              </div>
            </div>
            <div v-else class="muted" style="padding: 0 24px 8px">{{ row.note }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="label" :label="t('做法')" min-width="260">
          <template #default="{ row }"><span :style="row.key === result.best ? 'font-weight: 600' : ''">{{ row.label }}</span></template>
        </el-table-column>
        <el-table-column :label="t('花费')" width="120" align="right">
          <template #default="{ row }"><span :class="!result.held && row.key === result.best ? 'good' : ''">{{ row.cost == null ? "—" : money(row.cost) }}</span></template>
        </el-table-column>
        <el-table-column v-if="result.held" :label="t('净花费')" width="120" align="right">
          <template #default="{ row }"><span :class="row.key === result.best ? 'good' : ''">{{ row.net == null ? "—" : money(row.net) }}</span></template>
        </el-table-column>
        <el-table-column :label="t('镜子')" width="70" align="right"><template #default="{ row }">{{ row.mirrors || "" }}</template></el-table-column>
        <el-table-column :label="t('精炼')" width="70" align="right"><template #default="{ row }">{{ row.refines || "" }}</template></el-table-column>
        <el-table-column prop="note" :label="t('备注')" min-width="140" />
      </el-table>
    </el-card>

    <el-card v-if="result">
      <template #header><b>{{ t("各等级：市场价 vs 最低获取成本") }}</b> <span class="muted">{{ t("（成本低于卖价的等级，用镜子或精炼更划算）") }}</span></template>
      <el-table :data="result.table" size="small" max-height="520">
        <el-table-column prop="n" :label="t('等级')" width="60"><template #default="{ row }">+{{ row.n }}</template></el-table-column>
        <template v-for="[key, name] in [['base', result.target.baseName], ['refined', result.target.refinedName]]" :key="key">
          <el-table-column v-if="name" :label="name">
            <el-table-column :label="t('卖价')" width="100" align="right"><template #default="{ row }">{{ money(row[key]?.ask) }}</template></el-table-column>
            <el-table-column :label="t('收价')" width="100" align="right"><template #default="{ row }">{{ money(row[key]?.bid) }}</template></el-table-column>
            <el-table-column :label="t('最低成本')" width="110" align="right">
              <template #default="{ row }"><span :class="row[key]?.kind !== 'market' && row[key]?.cost != null ? 'good' : ''">{{ money(row[key]?.cost) }}</span></template>
            </el-table-column>
            <el-table-column :label="t('方式')" width="120"><template #default="{ row }">{{ row[key]?.cost == null ? "" : t(kindText[row[key].kind]) }}</template></el-table-column>
          </el-table-column>
        </template>
      </el-table>
    </el-card>
  </div>
</template>
