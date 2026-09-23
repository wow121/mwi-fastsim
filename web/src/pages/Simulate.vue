<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { call, defaultExtra, defaultTarget, int, itemName, money, perDay, pct, selectedMembers, store } from "../api.js"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"

const target = ref(defaultTarget())
const extra = ref(defaultExtra())
const hours = ref(24)
const seeds = ref(4)
const busy = ref(false)
const res = ref(null)
const ms = ref(0)
const who = ref(0)
const members = computed(() => selectedMembers())

async function run() {
  if (!members.value.length) return ElMessage.warning("先在“队伍”页勾选出战成员")
  busy.value = true
  const t0 = performance.now()
  try {
    res.value = await call("POST", "/api/simulate", { members: members.value, target: target.value, extra: extra.value, hours: hours.value, seeds: seeds.value })
    ms.value = performance.now() - t0
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}
const rows = computed(() => res.value?.mean.players.map((p, i) => ({ name: members.value[i]?.name, ...p })) || [])
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
  return out.map(e => ({ ...e, name: store.options.names.abilities[e.ability] || { autoAttack: "普攻", damageOverTime: "持续伤害", parry: "招架", retaliation: "反击", physicalThorns: "物理荆棘", elementalThorns: "元素荆棘" }[e.ability] || e.ability, dps: e.total / (detailHours.value * 3600) })).sort((a, b) => b.total - a.total)
})
</script>

<template>
  <div class="page">
    <h2>模拟</h2>
    <el-card>
      <div class="row" style="margin-bottom: 8px"><TargetPicker v-model="target" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row">
        <span class="muted">时长（小时）</span><el-input-number v-model="hours" :min="1" :max="720" size="small" />
        <span class="muted">重复次数（不同种子，取平均）</span><el-input-number v-model="seeds" :min="1" :max="64" size="small" />
        <el-button type="primary" :loading="busy" @click="run">开始模拟</el-button>
        <span v-if="res" class="muted">{{ seeds }} × {{ hours }} 小时，用时 {{ (ms / 1000).toFixed(2) }} 秒</span>
      </div>
      <div class="muted" style="margin-top: 6px">成员：{{ members.map(m => m.name).join("、") || "未选择" }}</div>
    </el-card>

    <template v-if="res">
      <el-card>
        <template #header><b>全队</b></template>
        <div class="row" style="gap: 32px">
          <div>利润（下限）<div style="font-size: 22px">{{ perDay(res.mean.profitPerHour) }}/天</div></div>
          <div>利润（中值）<div style="font-size: 22px">{{ perDay(res.mean.profitMidpointPerHour) }}/天</div></div>
          <div>经验<div style="font-size: 22px">{{ int(res.mean.xpPerHour) }}/小时</div></div>
          <div>遭遇<div style="font-size: 22px">{{ res.mean.encountersPerHour.toFixed(1) }}/小时</div></div>
          <div>死亡<div style="font-size: 22px" :class="{ bad: res.mean.deathsPerHour > 0 }">{{ res.mean.deathsPerHour.toFixed(2) }}/小时</div></div>
        </div>
      </el-card>
      <el-card>
        <template #header><b>成员</b></template>
        <el-table :data="rows" size="small">
          <el-table-column prop="name" label="角色" />
          <el-table-column label="经验/小时" align="right"><template #default="{ row }">{{ int(row.xpPerHour) }}</template></el-table-column>
          <el-table-column label="收入/天" align="right"><template #default="{ row }">{{ perDay(row.revenuePerHour) }}</template></el-table-column>
          <el-table-column label="消耗/天" align="right"><template #default="{ row }">{{ perDay(row.expensesPerHour) }}</template></el-table-column>
          <el-table-column label="利润下限/天" align="right"><template #default="{ row }">{{ perDay(row.profitPerHour) }}</template></el-table-column>
          <el-table-column label="利润上限/天" align="right"><template #default="{ row }">{{ perDay(row.profitUpperPerHour) }}</template></el-table-column>
          <el-table-column label="死亡/小时" align="right"><template #default="{ row }">{{ row.deathsPerHour.toFixed(2) }}</template></el-table-column>
          <el-table-column label="空蓝时间" align="right"><template #default="{ row }">{{ pct(row.outOfManaTimeRatio) }}</template></el-table-column>
        </el-table>
      </el-card>
      <el-card>
        <template #header>
          <div class="row"><b>明细</b><span class="muted">（第一次模拟，{{ detailHours.toFixed(0) }} 小时）</span>
            <el-radio-group v-model="who" size="small"><el-radio-button v-for="(m, i) in members" :key="i" :value="i">{{ m.name }}</el-radio-button></el-radio-group>
          </div>
        </template>
        <div class="grid">
          <div>
            <b>伤害</b>
            <el-table :data="damage" size="small" max-height="360">
              <el-table-column prop="name" label="来源" />
              <el-table-column label="DPS" align="right"><template #default="{ row }">{{ row.dps.toFixed(1) }}</template></el-table-column>
              <el-table-column label="命中率" align="right"><template #default="{ row }">{{ pct(row.hits / Math.max(1, row.hits + row.miss)) }}</template></el-table-column>
              <el-table-column label="次数" align="right"><template #default="{ row }">{{ int(row.hits + row.miss) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>击杀/小时</b>
            <el-table :data="kills" size="small" max-height="360">
              <el-table-column prop="name" label="怪物" />
              <el-table-column label="每小时" align="right"><template #default="{ row }">{{ row.perHour.toFixed(1) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>收入（按买一价）</b>
            <el-table :data="res.detail.players[who]?.revenueItems.slice(0, 20)" size="small" max-height="360">
              <el-table-column label="物品"><template #default="{ row }">{{ itemName(row.itemHrid) }}</template></el-table-column>
              <el-table-column label="数量/天" align="right"><template #default="{ row }">{{ (row.amount / detailHours * 24).toFixed(1) }}</template></el-table-column>
              <el-table-column label="价值/天" align="right"><template #default="{ row }">{{ money(row.total / detailHours * 24) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>消耗（按卖价）</b>
            <el-table :data="res.detail.players[who]?.expenseItems" size="small" max-height="360">
              <el-table-column label="物品"><template #default="{ row }">{{ itemName(row.itemHrid) }}</template></el-table-column>
              <el-table-column label="数量/天" align="right"><template #default="{ row }">{{ (row.amount / detailHours * 24).toFixed(1) }}</template></el-table-column>
              <el-table-column label="花费/天" align="right"><template #default="{ row }">{{ money(row.total / detailHours * 24) }}</template></el-table-column>
            </el-table>
          </div>
        </div>
      </el-card>
    </template>
  </div>
</template>
