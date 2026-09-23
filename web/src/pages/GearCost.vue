<script setup>
import { computed, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { call, money, store } from "../api.js"

const SLOT = { weapon: "武器", off_hand: "副手", head: "头部", body: "身体", legs: "腿部", hands: "手部", feet: "脚部", back: "背部", neck: "项链", earrings: "耳环", ring: "戒指", pouch: "袋子", charm: "护符", trinket: "饰品" }
const load = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d
  } catch {
    return d
  }
}
const form = ref(load("fastsim-gear-cost", { hrid: "", level: 10, tax: 5, hasHeld: false, heldHrid: "", heldLevel: 0 }))
watch(form, v => {
  try {
    localStorage.setItem("fastsim-gear-cost", JSON.stringify(v))
  } catch {}
}, { deep: true })
const groups = computed(() => Object.entries(store.options?.equipment || {}).map(([slot, list]) => ({ label: SLOT[slot] || slot, list })))
const cap = computed(() => store.options?.enhancementCap || 20)
const result = ref(null)
const loading = ref(false)
const expanded = ref([])

async function run() {
  if (!form.value.hrid) return ElMessage.warning("先选一件装备")
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
const kindText = { market: "市场买", refine: "买普通版精炼", unrefine: "买精炼版解精炼", mirror: "镜子合成" }
</script>

<template>
  <div class="page">
    <h2>装备获取成本</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        选一件装备和强化等级，比较直接买、用贤者之镜合成（+N 主件 + 一件 +(N-1) 垫子 + 镜子 = +(N+1)，精炼版可以用普通版当垫子）、
        买普通版自己精炼、买精炼版解精炼（拿回一半精炼材料）几种做法的花费，并列出最便宜做法要买的东西。低等级的主件和垫子也按最便宜的方式获取（可能又是镜子合成）。
        手上已有同系列装备时，还会算拿它当主件、拿它当垫子（精炼版可以先解精炼）的花费；不用它的做法按把它卖掉来算净花费。价格按市场最低卖价买、最高买价扣税卖。
      </p>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">装备</span>
        <el-select v-model="form.hrid" filterable placeholder="选择装备" style="width: 260px" size="small">
          <el-option-group v-for="g in groups" :key="g.label" :label="g.label">
            <el-option v-for="i in g.list" :key="i.hrid" :label="i.name" :value="i.hrid" />
          </el-option-group>
        </el-select>
        <span class="muted">目标</span><el-input-number v-model="form.level" :min="0" :max="cap" size="small" /><span class="muted">级</span>
        <span class="muted">卖出税</span><el-input-number v-model="form.tax" :min="0" :max="20" :step="0.5" size="small" /><span class="muted">%</span>
      </div>
      <div class="row" style="margin-bottom: 12px">
        <el-checkbox v-model="form.hasHeld" @change="toggleHeld">手上已有同系列装备</el-checkbox>
        <template v-if="form.hasHeld">
          <el-select v-model="form.heldHrid" filterable style="width: 260px" size="small">
            <el-option-group v-for="g in groups" :key="g.label" :label="g.label">
              <el-option v-for="i in g.list" :key="i.hrid" :label="i.name" :value="i.hrid" />
            </el-option-group>
          </el-select>
          <span class="muted">+</span><el-input-number v-model="form.heldLevel" :min="0" :max="cap" size="small" />
        </template>
      </div>
      <el-button type="primary" :loading="loading" @click="run">计算</el-button>
    </el-card>

    <el-card v-if="result">
      <template #header>
        <div class="row">
          <b>{{ result.target.name }} +{{ result.target.level }}</b>
          <span v-if="result.held" class="muted">净花费 = 花费 − 手上装备扣税后能卖的钱（当主件 / 垫子用掉的做法不减）</span>
          <span class="muted">市场：卖 {{ money(result.market.ask) }} / 收 {{ money(result.market.bid) }} · 镜子 {{ money(result.mirrorPrice) }}<template v-if="result.refine"> · 精炼材料 {{ money(result.refine.cost) }} · 解精炼返还 {{ money(result.refine.unrefineValue) }}</template><template v-if="result.held"> · 手上的 {{ result.held.name }} +{{ result.held.n }} 扣税能卖 {{ money(result.held.value) }}</template></span>
        </div>
      </template>
      <el-alert v-if="best" type="success" :closable="false" style="margin-bottom: 10px">
        <template #title>
          最便宜：<b>{{ best.label }}</b>，花费 <b>{{ money(best.cost) }}</b><template v-if="result.held">（净花费 {{ money(best.net) }}）</template>
          <template v-if="market?.net != null && best.key !== 'market'">，比直接买（{{ money(market.net) }}）省 <b>{{ money(market.net - best.net) }}</b></template>
          <template v-else-if="best.key === 'market'">，直接买最划算</template>
        </template>
      </el-alert>
      <el-table :data="result.options" size="small" row-key="key" :expand-row-keys="expanded" @expand-change="(r, rows) => (expanded = rows.map(x => x.key))">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div v-if="row.lines" style="padding: 0 24px 8px">
              <div class="row" style="align-items: flex-start; gap: 32px">
                <div>
                  <b>步骤</b>
                  <div v-for="(l, i) in row.lines" :key="i" class="muted">{{ i + 1 }}. {{ l.text }}<span v-if="l.cost">（{{ l.cost > 0 ? "" : "+" }}{{ money(Math.abs(l.cost)) }}）</span></div>
                </div>
                <div>
                  <b>要买的</b>
                  <div v-for="s in row.shopping" :key="s.h + s.n" class="muted">{{ s.name }}{{ s.n ? ` +${s.n}` : "" }} × {{ s.count }}（{{ money(s.price) }}）</div>
                  <div v-if="row.refines && result.refine" class="muted">精炼材料 × {{ row.refines }} 份：{{ result.refine.inputs.map(i => `${i.name} ${Math.round(i.count * 10) / 10}`).join("、") }}</div>
                </div>
              </div>
            </div>
            <div v-else class="muted" style="padding: 0 24px 8px">{{ row.note }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="label" label="做法" min-width="260">
          <template #default="{ row }"><span :style="row.key === result.best ? 'font-weight: 600' : ''">{{ row.label }}</span></template>
        </el-table-column>
        <el-table-column label="花费" width="120" align="right">
          <template #default="{ row }"><span :class="!result.held && row.key === result.best ? 'good' : ''">{{ row.cost == null ? "—" : money(row.cost) }}</span></template>
        </el-table-column>
        <el-table-column v-if="result.held" label="净花费" width="120" align="right">
          <template #default="{ row }"><span :class="row.key === result.best ? 'good' : ''">{{ row.net == null ? "—" : money(row.net) }}</span></template>
        </el-table-column>
        <el-table-column label="镜子" width="70" align="right"><template #default="{ row }">{{ row.mirrors || "" }}</template></el-table-column>
        <el-table-column label="精炼" width="70" align="right"><template #default="{ row }">{{ row.refines || "" }}</template></el-table-column>
        <el-table-column prop="note" label="备注" min-width="140" />
      </el-table>
    </el-card>

    <el-card v-if="result">
      <template #header><b>各等级：市场价 vs 最低获取成本</b> <span class="muted">（成本低于卖价的等级，用镜子或精炼更划算）</span></template>
      <el-table :data="result.table" size="small" max-height="520">
        <el-table-column prop="n" label="等级" width="60"><template #default="{ row }">+{{ row.n }}</template></el-table-column>
        <template v-for="[key, name] in [['base', result.target.baseName], ['refined', result.target.refinedName]]" :key="key">
          <el-table-column v-if="name" :label="name">
            <el-table-column label="卖价" width="100" align="right"><template #default="{ row }">{{ money(row[key]?.ask) }}</template></el-table-column>
            <el-table-column label="收价" width="100" align="right"><template #default="{ row }">{{ money(row[key]?.bid) }}</template></el-table-column>
            <el-table-column label="最低成本" width="110" align="right">
              <template #default="{ row }"><span :class="row[key]?.kind !== 'market' && row[key]?.cost != null ? 'good' : ''">{{ money(row[key]?.cost) }}</span></template>
            </el-table-column>
            <el-table-column label="方式" width="120"><template #default="{ row }">{{ row[key]?.cost == null ? "" : kindText[row[key].kind] }}</template></el-table-column>
          </el-table-column>
        </template>
      </el-table>
    </el-card>
  </div>
</template>
