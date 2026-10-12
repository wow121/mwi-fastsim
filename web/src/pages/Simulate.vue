<script setup>
import { computed, reactive, ref } from "vue"
import { ElMessage } from "element-plus"
import { COMBAT_SKILLS, attackName, call, defaultExtra, defaultTarget, duration, int, itemName, money, monsterName, perDay, pct, qty, selectedMembers, store, targetLabel } from "../api.js"
import { copyText, fileStamp, saveImage, stamp } from "../export.js"
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
const out = ref(null)
const members = computed(() => selectedMembers())
// what the shown result was run with (the selection / target may change afterwards)
const ran = ref(null)

async function run() {
  if (!members.value.length) return ElMessage.warning("先在“队伍”页勾选出战成员")
  busy.value = true
  const t0 = performance.now()
  try {
    const body = { members: members.value, target: target.value, extra: extra.value, hours: hours.value, seeds: seeds.value }
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
    const t = to => (to <= L ? 0 : rate > 0 ? (table[to] - xp) / rate : Infinity)
    return { key, label, level: L, progress: L >= cap ? 1 : (xp - table[L]) / (table[L + 1] - table[L]), rate, next: L >= cap ? null : t(L + 1), goal, toGoal: L >= cap ? null : t(goal), exact: Number.isFinite(e), cap }
  })
})

// ---- export
function summary() {
  const r = ran.value
  const lines = [`【模拟】${targetLabel(r.target)}（${r.hours} 小时 × ${r.seeds} 次，${stamp()}）`]
  const m = res.value.mean
  lines.push(`全队：利润 ${perDay(m.profitPerHour)}/天（中值 ${perDay(m.profitMidpointPerHour)}/天），经验 ${int(m.xpPerHour)}/小时，遭遇 ${m.encountersPerHour.toFixed(1)}/小时，死亡 ${m.deathsPerHour.toFixed(2)}/小时`)
  for (const p of rows.value)
    lines.push(`· ${p.name}：利润 ${perDay(p.profitPerHour)}/天，收入 ${perDay(p.revenuePerHour)}/天，消耗 ${perDay(p.expensesPerHour)}/天，经验 ${int(p.xpPerHour)}/小时，死亡 ${p.deathsPerHour.toFixed(2)}/小时，空蓝 ${pct(p.outOfManaTimeRatio)}`)
  return lines.join("\n")
}
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
        <span v-if="res" class="muted">{{ ran.seeds }} × {{ ran.hours }} 小时，用时 {{ (ms / 1000).toFixed(2) }} 秒</span>
        <template v-if="res">
          <el-button size="small" @click="copyText(summary())">复制文字</el-button>
          <el-button size="small" @click="saveImage(out, `模拟-${fileStamp()}`)">保存图片</el-button>
        </template>
      </div>
      <div class="muted" style="margin-top: 6px">成员：{{ members.map(m => m.name).join("、") || "未选择" }}</div>
    </el-card>

    <div v-if="res" ref="out">
      <el-card>
        <template #header><b>全队</b><span class="muted" style="margin-left: 8px">{{ targetLabel(ran.target) }} · {{ ran.hours }} 小时 × {{ ran.seeds }} 次</span></template>
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
            <el-radio-group v-model="who" size="small"><el-radio-button v-for="(m, i) in runMembers" :key="i" :value="i">{{ m.name }}</el-radio-button></el-radio-group>
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
              <el-table-column label="数量/天" align="right"><template #default="{ row }">{{ qty(row.amount / detailHours * 24) }}</template></el-table-column>
              <el-table-column label="价值/天" align="right"><template #default="{ row }">{{ money(row.total / detailHours * 24) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>消耗（按卖价）</b>
            <el-table :data="res.detail.players[who]?.expenseItems" size="small" max-height="360">
              <el-table-column label="物品"><template #default="{ row }">{{ itemName(row.itemHrid) }}</template></el-table-column>
              <el-table-column label="数量/天" align="right"><template #default="{ row }">{{ qty(row.amount / detailHours * 24) }}</template></el-table-column>
              <el-table-column label="花费/天" align="right"><template #default="{ row }">{{ money(row.total / detailHours * 24) }}</template></el-table-column>
            </el-table>
          </div>
        </div>
      </el-card>
      <el-card>
        <template #header>
          <div class="row"><b>死亡分析</b><span class="muted">（第一次模拟，{{ detailHours.toFixed(0) }} 小时；全队死亡 {{ int(teamDeaths) }} 次）</span>
            <el-radio-group v-model="who" size="small"><el-radio-button v-for="(m, i) in runMembers" :key="i" :value="i">{{ m.name }}</el-radio-button></el-radio-group>
          </div>
        </template>
        <div class="muted" style="margin-bottom: 8px">
          <template v-if="deaths.total">死亡 {{ int(deaths.total) }} 次<template v-if="deaths.recorded">，其中 {{ int(deaths.outOfMana) }} 次死时空蓝</template>。</template>
          <template v-else>这次模拟里没有死亡<template v-if="res.mean.players[who]?.deathsPerHour > 0">（平均每小时 {{ res.mean.players[who].deathsPerHour.toFixed(2) }} 次，可以加长时长再看）</template>。</template>
          <template v-if="!deaths.recorded">本地服务需要重新编译引擎后才有致命一击记录。</template>
        </div>
        <div class="grid">
          <div v-if="deaths.causes.length">
            <b>致命一击</b>
            <el-table :data="deaths.causes" size="small" max-height="360">
              <el-table-column prop="name" label="来源" min-width="160" />
              <el-table-column label="次数" align="right"><template #default="{ row }">{{ int(row.n) }}</template></el-table-column>
              <el-table-column label="占比" align="right"><template #default="{ row }">{{ pct(row.n / deaths.total) }}</template></el-table-column>
            </el-table>
          </div>
          <div>
            <b>受到的伤害</b>
            <el-table :data="deaths.taken" size="small" max-height="360">
              <el-table-column prop="name" label="来源" min-width="160" />
              <el-table-column label="伤害/小时" align="right"><template #default="{ row }">{{ int(row.perHour) }}</template></el-table-column>
              <el-table-column label="最大一击" align="right"><template #default="{ row }">{{ int(row.max) }}</template></el-table-column>
              <el-table-column label="命中率" align="right"><template #default="{ row }">{{ pct(row.hitRate) }}</template></el-table-column>
            </el-table>
          </div>
        </div>
      </el-card>
      <el-card v-if="levels.length">
        <template #header>
          <div class="row"><b>升级时间</b><span class="muted">（按同步时的经验，一直刷这里）</span>
            <el-radio-group v-model="who" size="small"><el-radio-button v-for="(m, i) in runMembers" :key="i" :value="i">{{ m.name }}</el-radio-button></el-radio-group>
          </div>
        </template>
        <el-table :data="levels" size="small">
          <el-table-column prop="label" label="技能" width="70" />
          <el-table-column label="等级" width="170"><template #default="{ row }">Lv.{{ row.level }} <span class="muted">{{ row.exact ? pct(row.progress) : "无经验数据" }}</span></template></el-table-column>
          <el-table-column label="经验/小时" align="right"><template #default="{ row }">{{ int(row.rate) }}</template></el-table-column>
          <el-table-column label="升下一级" align="right"><template #default="{ row }">{{ row.next == null ? "满级" : duration(row.next) }}</template></el-table-column>
          <el-table-column label="目标等级" align="center" width="150"><template #default="{ row }"><el-input-number v-if="row.level < row.cap" :model-value="row.goal" :min="row.level + 1" :max="row.cap" size="small" style="width: 110px" @update:model-value="v => (goalLevel[row.key] = v)" /></template></el-table-column>
          <el-table-column label="到目标" align="right"><template #default="{ row }">{{ row.toGoal == null ? "—" : duration(row.toGoal) }}</template></el-table-column>
        </el-table>
      </el-card>
    </div>
  </div>
</template>
