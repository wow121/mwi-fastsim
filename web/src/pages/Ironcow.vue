<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { abilityName, call, defaultExtra, defaultTarget, int, itemName, money, pct, selectedMembers, store, triggerText } from "../api.js"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"
import ApplyResult from "../components/ApplyResult.vue"

// Ironcow (铁牛) mode: no market. Drops are worth the shop sell price, food / drinks / keys cost
// the time to make them by hand, and every rate is per "cycle hour" (combat + that hand work).
const KEY = "fastsim-ironcow"
const SKILLS = [["milking", "挤奶"], ["foraging", "采摘"], ["woodcutting", "伐木"], ["cheesesmithing", "奶酪锻造"], ["crafting", "制作"], ["tailoring", "缝纫"], ["cooking", "烹饪"], ["brewing", "冲泡"]]
function load() {
  let s = null
  try {
    s = JSON.parse(localStorage.getItem(KEY) || "null")
  } catch {}
  const per = (o, d) => Object.fromEntries(SKILLS.map(([k]) => [k, Number(o?.[k] ?? d)]))
  return {
    targets: Array.isArray(s?.targets) ? s.targets : [],
    objective: s?.objective || "items",
    craft: {
      levels: per(s?.craft?.levels, 1),
      speed: per(s?.craft?.speed, 0),
      efficiency: per(s?.craft?.efficiency, 0),
      artisan: !!s?.craft?.artisan,
      gourmet: !!s?.craft?.gourmet,
      gatherQty: Number(s?.craft?.gatherQty ?? 0),
    },
  }
}
const cfg = reactive(load())
watch(cfg, v => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
  } catch {}
}, { deep: true })

const targetHrids = computed({
  get: () => cfg.targets.map(t => t.hrid),
  set: list => (cfg.targets = list.map(h => cfg.targets.find(t => t.hrid === h) || { hrid: h, weight: 1 })),
})
const itemOptions = computed(() => Object.entries(store.options?.names.items || {}).map(([hrid, name]) => ({ hrid, name })))
const ironcow = () => JSON.parse(JSON.stringify({ ...cfg, objective: cfg.objective === "items" && !cfg.targets.length ? "coins" : cfg.objective }))
const skillRows = computed(() => SKILLS.map(([key, name]) => ({ key, name })))

const tab = ref("zones")
const members = computed(() => selectedMembers())
const noMembers = () => (members.value.length ? false : (ElMessage.warning("先在“队伍”页勾选出战成员"), true))

// ---- formatting by objective
const objName = { items: "目标物品", coins: "商店金币", xp: "经验" }
function fmtObj(v, obj) {
  if (v == null || !Number.isFinite(v)) return "—"
  if (obj === "items") return `${(v * 24).toFixed(2)} 个/天`
  if (obj === "xp") return `${int(v)} /小时`
  return `${money(v * 24)} /天`
}
const secs = s => (s >= 3600 ? `${(s / 3600).toFixed(2)} 小时` : s >= 60 ? `${(s / 60).toFixed(1)} 分` : `${s.toFixed(1)} 秒`)

// ---- zones
const o = computed(() => store.options)
const zones = ref(o.value.zones.map(z => z.hrid))
const dungeons = ref([])
const tiers = ref([0, 1, 2])
const hours = ref(24)
const seeds = ref(2)
const extra = ref(defaultExtra())
const zoneResult = ref(null)
function zoneParams() {
  if (noMembers()) return
  const all = [...o.value.zones, ...o.value.dungeons]
  const targets = []
  for (const h of [...zones.value, ...dungeons.value]) {
    const z = all.find(x => x.hrid === h)
    for (const t of tiers.value) if (t <= (z?.maxDifficulty ?? 0)) targets.push({ kind: "zone", zoneHrid: h, difficultyTier: t })
  }
  if (!targets.length) return ElMessage.warning("没有可模拟的目标")
  return { members: members.value, targets, hours: hours.value, seeds: seeds.value, extra: extra.value, ironcow: ironcow() }
}
const zoneRows = computed(() => (zoneResult.value?.rows || []).filter(r => r.metrics).map(r => ({ ...r, ...r.metrics })))
const zoneTargets = computed(() => [...new Set(zoneRows.value.flatMap(r => Object.keys(r.targetsPerHour || {})))])
const zoneObj = computed(() => zoneResult.value?.objective || "coins")

// ---- skills / food
const target = ref(defaultTarget())
const optimize = ref(members.value.map((_, i) => i))
const rounds = ref(2)
const swapItems = ref(true)
const craftableOnly = ref(true)
const skillResult = ref(null)
const foodResult = ref(null)
const skillParams = () => (noMembers() ? undefined : { members: members.value, target: target.value, extra: extra.value, optimize: optimize.value, rounds: rounds.value, ironcow: ironcow() })
const foodParams = () => (noMembers() ? undefined : { members: members.value, target: target.value, extra: extra.value, optimize: optimize.value, rounds: rounds.value, swapItems: swapItems.value, craftableOnly: craftableOnly.value, ironcow: ironcow() })
const valueKey = obj => (obj === "items" ? "itemsPerHour" : obj === "xp" ? "xpPerHour" : "coinsPerHour")
const foodSetup = computed(() => (foodResult.value?.members || []).map((m, i) => {
  const before = members.value.find(x => String(x.id) === String(m.id)) || members.value[i]
  const rows = []
  for (const [kind, label] of [["food", "食物"], ["drinks", "饮料"]])
    for (let k = 0; k < 3; k++) {
      const now = m[kind]?.[k] || ""
      const was = before?.[kind]?.[k] || ""
      if (!now && !was) continue
      rows.push({ slot: `${label} ${k + 1}`, now: now ? itemName(now) : "空", was: was ? itemName(was) : "空", nowText: now ? triggerText(m, now) : "", changed: now !== was })
    }
  return { name: m.name, rows }
}))

// ---- craft table
const craft = ref(null)
const craftKind = ref("all")
async function loadCraft() {
  craft.value = await call("POST", "/api/ironcow/craft", { ironcow: ironcow() })
}
onMounted(loadCraft)
let craftTimer = null
watch(() => cfg.craft, () => {
  clearTimeout(craftTimer)
  craftTimer = setTimeout(loadCraft, 300)
}, { deep: true })
const craftRows = computed(() => (craft.value?.rows || []).filter(r => craftKind.value === "all" || r.kind === craftKind.value))
const treeRows = (t, path = "") => (t.children || []).map((c, i) => ({ ...c, id: `${path}${i}`, children: treeRows(c, `${path}${i}.`) }))
</script>

<template>
  <div class="page">
    <h2>铁牛模式</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        铁牛没有市场：掉落按<b>商店卖价</b>算金币，食物、饮料、地下城钥匙不花钱，而是算<b>手搓时间</b>（从采集原料开始，按你的生活技能等级和茶）。
        打怪和手搓不能同时进行，所以下面的每小时都是按「战斗时间 + 补回这段战斗消耗所需的手搓时间」算的（队伍取手搓最慢的一人）。
      </p>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 70px">目标物品</span>
        <el-select v-model="targetHrids" multiple :multiple-limit="5" filterable placeholder="选 1–5 个想刷的物品（宝箱会按内容物展开）" style="width: 480px" size="small">
          <el-option v-for="it in itemOptions" :key="it.hrid" :label="it.name" :value="it.hrid" />
        </el-select>
      </div>
      <div v-if="cfg.targets.length > 1" class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 70px">权重</span>
        <span v-for="t in cfg.targets" :key="t.hrid" class="row" style="gap: 4px">
          <span>{{ itemName(t.hrid) }}</span>
          <el-input-number v-model="t.weight" :min="0" :step="0.5" size="small" style="width: 100px" />
        </span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 70px">优化目标</span>
        <el-radio-group v-model="cfg.objective" size="small">
          <el-radio-button value="items" :disabled="!cfg.targets.length">目标物品数量</el-radio-button>
          <el-radio-button value="coins">商店卖价金币</el-radio-button>
          <el-radio-button value="xp">经验</el-radio-button>
        </el-radio-group>
        <span v-if="cfg.objective === 'items' && !cfg.targets.length" class="muted">（还没选目标物品，按金币算）</span>
      </div>
      <el-collapse>
        <el-collapse-item title="生活技能与茶（决定手搓速度）">
          <el-table :data="skillRows" size="small" style="max-width: 560px">
            <el-table-column prop="name" label="技能" width="100" />
            <el-table-column label="等级"><template #default="{ row }"><el-input-number v-model="cfg.craft.levels[row.key]" :min="1" :max="200" size="small" style="width: 110px" /></template></el-table-column>
            <el-table-column label="速度 %"><template #default="{ row }"><el-input-number v-model="cfg.craft.speed[row.key]" :min="0" :max="500" size="small" style="width: 110px" /></template></el-table-column>
            <el-table-column label="额外效率 %"><template #default="{ row }"><el-input-number v-model="cfg.craft.efficiency[row.key]" :min="0" :max="500" size="small" style="width: 110px" /></template></el-table-column>
          </el-table>
          <div class="row" style="margin-top: 8px">
            <el-checkbox v-model="cfg.craft.artisan">工匠茶（原料 −10%）</el-checkbox>
            <el-checkbox v-model="cfg.craft.gourmet">美食茶（烹饪/冲泡产出 +12%）</el-checkbox>
            <span class="muted">采集数量 +</span><el-input-number v-model="cfg.craft.gatherQty" :min="0" :max="100" size="small" style="width: 100px" /><span class="muted">%</span>
          </div>
          <p class="muted">等级高于配方要求时每级 +1% 效率（自动算）；速度来自工具，额外效率来自茶、房屋等，自己填。泡茶本身的时间暂不计入。</p>
        </el-collapse-item>
      </el-collapse>
      <div class="row" style="margin-top: 8px"><ExtraBuffs v-model="extra" /></div>
    </el-card>

    <el-tabs v-model="tab">
      <el-tab-pane label="刷图推荐" name="zones">
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
          <div class="row" style="margin-bottom: 12px">
            <span class="muted">每个目标</span><el-input-number v-model="hours" :min="1" :max="240" size="small" /><span class="muted">小时 ×</span>
            <el-input-number v-model="seeds" :min="1" :max="16" size="small" /><span class="muted">次</span>
          </div>
          <JobRunner name="ironcow-zones" type="ironcow-zones" :params="zoneParams" @result="r => (zoneResult = r)" />
        </el-card>
        <el-card v-if="zoneRows.length">
          <template #header><span class="muted">按{{ objName[zoneObj] }}排序；产出都是「每天」= 24 个综合小时（战斗 + 手搓）</span></template>
          <el-table :data="zoneRows" size="small">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="grid" style="padding: 0 12px">
                  <div v-for="(p, i) in row.players" :key="i">
                    <b>{{ members[i]?.name || `队员${i + 1}` }}</b>
                    <span class="muted"> · 手搓 {{ p.craftPerCombatHour.toFixed(2) }} 小时 / 战斗小时</span>
                    <el-table :data="Object.entries(p.usedPerCombatHour).map(([h, n]) => ({ h, n, s: p.craftSecondsPerUnit[h] || 0 }))" size="small">
                      <el-table-column label="消耗"><template #default="{ row: u }">{{ itemName(u.h) }}</template></el-table-column>
                      <el-table-column label="每战斗小时" align="right"><template #default="{ row: u }">{{ u.n.toFixed(1) }}</template></el-table-column>
                      <el-table-column label="每个手搓" align="right"><template #default="{ row: u }">{{ secs(u.s) }}</template></el-table-column>
                      <el-table-column label="手搓/战斗小时" align="right"><template #default="{ row: u }">{{ secs(u.n * u.s) }}</template></el-table-column>
                    </el-table>
                    <div v-if="p.missing.length" class="bad" style="font-size: 12px">没计入时间（无法手搓，需要另外刷）：{{ p.missing.map(itemName).join("、") }}</div>
                    <div v-if="p.locked.length" class="bad" style="font-size: 12px">等级不够：{{ p.locked.join("、") }}</div>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="目标" min-width="150"><template #default="{ row }">{{ row.name }} · T{{ row.target.difficultyTier }}</template></el-table-column>
            <el-table-column v-if="cfg.targets.length" prop="itemsPerHour" label="目标物品/天" sortable align="right"><template #default="{ row }">{{ (row.itemsPerHour * 24).toFixed(2) }}</template></el-table-column>
            <el-table-column v-for="h in zoneTargets" :key="h" :label="`${itemName(h)}/天`" align="right"><template #default="{ row }">{{ ((row.targetsPerHour[h] || 0) * 24).toFixed(3) }}</template></el-table-column>
            <el-table-column prop="coinsPerHour" label="商店金币/天" sortable align="right"><template #default="{ row }">{{ money(row.coinsPerHour * 24) }}</template></el-table-column>
            <el-table-column prop="xpPerHour" label="经验/小时" sortable align="right"><template #default="{ row }">{{ int(row.xpPerHour) }}</template></el-table-column>
            <el-table-column prop="combatShare" label="战斗时间占比" sortable align="right"><template #default="{ row }">{{ pct(row.combatShare) }}</template></el-table-column>
            <el-table-column prop="deathsPerHour" label="死亡/战斗小时" sortable align="right"><template #default="{ row }"><span :class="{ bad: row.deathsPerHour > 0 }">{{ row.deathsPerHour.toFixed(2) }}</span></template></el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="技能优化" name="skills">
        <el-card>
          <p class="muted" style="margin-top: 0">按上面的优化目标（含手搓时间）搜索整队技能组和触发条件，候选规则和普通模式的技能优化相同（用各人已学会的技能）。</p>
          <div class="row" style="margin-bottom: 8px"><TargetPicker v-model="target" /></div>
          <div class="row" style="margin-bottom: 12px">
            <span class="muted">轮数</span><el-input-number v-model="rounds" :min="1" :max="4" size="small" style="width: 90px" />
            <span class="muted">成员</span>
            <el-checkbox-group v-model="optimize" size="small">
              <el-checkbox v-for="(m, i) in members" :key="m.id" :value="i">{{ m.name }}</el-checkbox>
            </el-checkbox-group>
          </div>
          <JobRunner name="ironcow-skills" type="ironcow-skills" :params="skillParams" label="开始优化" @result="r => (skillResult = r)" />
        </el-card>
        <el-card v-if="skillResult?.members">
          <template #header>
            <div class="row">
              <b>结果</b>
              <span v-if="skillResult.unchanged" class="good">当前配置已是最好</span>
              <span v-else class="good">
                {{ fmtObj(skillResult.baseline[valueKey(skillResult.ironcowObjective)], skillResult.ironcowObjective) }} →
                {{ fmtObj(skillResult.final[valueKey(skillResult.ironcowObjective)], skillResult.ironcowObjective) }}
              </span>
              <span style="flex: 1" />
              <ApplyResult v-if="!skillResult.unchanged" :members="skillResult.members" />
            </div>
          </template>
          <div class="grid">
            <div v-for="(m, i) in skillResult.members" :key="m.id">
              <b>{{ m.name }}</b>
              <el-table :data="m.abilities" size="small">
                <el-table-column label="槽位" width="70"><template #default="{ $index }">{{ $index === 0 ? "特殊" : $index }}</template></el-table-column>
                <el-table-column label="优化后"><template #default="{ row }">{{ row.abilityHrid ? `${abilityName(row.abilityHrid)} Lv.${row.level}` : "—" }}</template></el-table-column>
                <el-table-column label="原来"><template #default="{ $index }">{{ members[i]?.abilities[$index]?.abilityHrid ? abilityName(members[i].abilities[$index].abilityHrid) : "—" }}</template></el-table-column>
                <el-table-column label="触发"><template #default="{ row }">{{ row.abilityHrid ? triggerText(m, row.abilityHrid) : "" }}</template></el-table-column>
              </el-table>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="食物饮料优化" name="food">
        <el-card>
          <p class="muted" style="margin-top: 0">
            换食物/饮料种类并调触发条件，目标里已经扣掉手搓时间：吃得越多、越难做，战斗时间占比越低。
          </p>
          <div class="row" style="margin-bottom: 8px"><TargetPicker v-model="target" /></div>
          <div class="row" style="margin-bottom: 12px">
            <span class="muted">轮数</span><el-input-number v-model="rounds" :min="1" :max="4" size="small" style="width: 90px" />
            <el-checkbox v-model="swapItems">也尝试换种类</el-checkbox>
            <el-checkbox v-model="craftableOnly">只用现在能手搓的（原料都能采集、等级够）</el-checkbox>
            <span class="muted">成员</span>
            <el-checkbox-group v-model="optimize" size="small">
              <el-checkbox v-for="(m, i) in members" :key="m.id" :value="i">{{ m.name }}</el-checkbox>
            </el-checkbox-group>
          </div>
          <JobRunner name="ironcow-consumables" type="ironcow-consumables" :params="foodParams" label="开始优化" @result="r => (foodResult = r)" />
        </el-card>
        <el-card v-if="foodResult?.members">
          <template #header>
            <div class="row">
              <b>结果</b>
              <span v-if="foodResult.unchanged" class="good">当前配置已是最好</span>
              <span v-else class="good">
                {{ fmtObj(foodResult.baseline[valueKey(foodResult.ironcowObjective)], foodResult.ironcowObjective) }} →
                {{ fmtObj(foodResult.final[valueKey(foodResult.ironcowObjective)], foodResult.ironcowObjective) }}
                · 战斗时间占比 {{ pct(foodResult.baseline.combatShare) }} → {{ pct(foodResult.final.combatShare) }}
              </span>
              <span style="flex: 1" />
              <ApplyResult v-if="!foodResult.unchanged" :members="foodResult.members" />
            </div>
          </template>
          <div class="grid">
            <div v-for="p in foodSetup" :key="p.name">
              <b>{{ p.name }}</b>
              <el-table :data="p.rows" size="small">
                <el-table-column prop="slot" label="格子" width="66" />
                <el-table-column label="优化后">
                  <template #default="{ row }">
                    <div :class="{ good: row.changed }">{{ row.now }}</div>
                    <div class="muted">{{ row.nowText }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="原来"><template #default="{ row }"><span class="muted">{{ row.was }}</span></template></el-table-column>
              </el-table>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="手搓工时" name="craft">
        <el-card>
          <div class="row" style="margin-bottom: 8px">
            <el-radio-group v-model="craftKind" size="small">
              <el-radio-button value="all">全部</el-radio-button>
              <el-radio-button value="food">食物</el-radio-button>
              <el-radio-button value="drink">饮料</el-radio-button>
            </el-radio-group>
            <span class="muted">从采集原料开始，做一个要多少时间（按上面的生活技能设置）。展开看配方树。</span>
          </div>
          <el-table :data="craftRows" size="small" row-key="hrid" :default-sort="{ prop: 'seconds', order: 'ascending' }">
            <el-table-column type="expand">
              <template #default="{ row }">
                <el-table :data="treeRows(row.tree)" row-key="id" size="small" default-expand-all style="margin: 0 12px">
                  <el-table-column label="原料"><template #default="{ row: t }">{{ t.name }}<span v-if="t.missing" class="bad">（无法手搓）</span></template></el-table-column>
                  <el-table-column label="数量" align="right"><template #default="{ row: t }">{{ t.count.toFixed(2) }}</template></el-table-column>
                  <el-table-column label="做法"><template #default="{ row: t }">{{ t.action }}</template></el-table-column>
                  <el-table-column label="合计时间" align="right"><template #default="{ row: t }">{{ secs(t.seconds) }}</template></el-table-column>
                </el-table>
              </template>
            </el-table-column>
            <el-table-column prop="name" label="物品" />
            <el-table-column prop="seconds" label="每个手搓" sortable align="right"><template #default="{ row }">{{ secs(row.seconds) }}</template></el-table-column>
            <el-table-column label="每小时能做" align="right"><template #default="{ row }">{{ row.seconds > 0 ? (3600 / row.seconds).toFixed(1) : "—" }}</template></el-table-column>
            <el-table-column label="备注" min-width="220">
              <template #default="{ row }">
                <span v-if="row.missing.length" class="bad">无法手搓：{{ row.missing.join("、") }} </span>
                <span v-if="row.locked.length" class="bad">等级不够：{{ row.locked.join("、") }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
