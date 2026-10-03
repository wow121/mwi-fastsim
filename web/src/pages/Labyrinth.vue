<script setup>
import { computed, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { clone, money, pct, store, triggerText } from "../api.js"
import JobRunner from "../components/JobRunner.vue"

const UPGRADES = [["attackSpeed", "攻击速度"], ["castSpeed", "施法速度"], ["combatDamage", "战斗伤害"], ["criticalRate", "暴击率"]]

const members = computed(() => store.team.members || [])
// the logged-in character is the one with the labyrinth settings / inventory
const memberId = ref(String((members.value.find(m => m.labyrinth) || members.value.find(m => m.ownedEquipment) || members.value[0])?.id ?? ""))
const member = computed(() => members.value.find(m => String(m.id) === memberId.value))
const upgrades = ref({})
watch(member, m => (upgrades.value = { attackSpeed: 0, castSpeed: 0, combatDamage: 0, criticalRate: 0, ...(m?.labyrinthUpgrades || {}) }), { immediate: true })
const threshold = ref(95)
const monsters = ref([])
const customCrates = ref(false)
const crates = ref([])
const buy = ref(true)
const maxSpend = ref(0)
const result = ref(null)
const open = ref([])

function params() {
  if (!member.value) return ElMessage.warning("队伍里还没有角色，先在游戏里用油猴脚本同步")
  const m = clone(member.value)
  m.labyrinthUpgrades = { ...(m.labyrinthUpgrades || {}), ...upgrades.value }
  return { member: m, monsters: monsters.value, crates: customCrates.value ? crates.value : undefined, threshold: threshold.value / 100, buy: buy.value, maxSpend: maxSpend.value * 1e6 }
}

const signed = n => (n == null ? "未设" : n > 0 ? `+${n}` : String(n))
const sec = v => (v == null ? "—" : `${v.toFixed(1)} 秒`)
const crateNames = hs => (hs || []).map(h => store.options?.labyrinthCrates?.find(c => c.hrid === h)?.name || h.split("/").pop()).join("、") || "无"
const sourceText = { room: "", fallback: "（这个怪没设配装，用的第一个战斗配装）", missing: "（没有战斗配装）", none: "（没读到迷宫设置，用的当前装备）" }
const rows = computed(() => (result.value?.results || []).map(r => ({ ...r, bestBuy: r.purchases?.[0] })))
const changed = (r, e) => {
  const c = r.current.equipment.find(x => x.slot === e.slot)
  return (c?.itemHrid || "") !== e.itemHrid || (c?.enhancementLevel || 0) !== e.enhancementLevel
}
const abilitiesChanged = r => JSON.stringify(r.best.abilities) !== JSON.stringify(r.current.abilities) || r.best.abilities.some(a => a && triggerText({ triggerMap: r.triggerMap }, a.hrid) !== triggerText({ triggerMap: r.currentTriggerMap }, a.hrid))
</script>

<template>
  <div class="page">
    <h2>迷宫配置推荐</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        和迷宫胜率计算器的算法一样：每个迷宫怪用游戏里给它设的配装（装备按“最高强化 / 精确强化”的设置取），不带食物饮料，补给箱、迷宫升级生效；
        游戏自动挑战时房间等级 = 有效等级（战斗等级 + 补给箱等级加成）+ 设置 − 1，结果按这个“设置”给出（+N / −N）。
        推荐设置 = 通关率（120 秒内打死，按整数百分比）不低于阈值的最高设置。再从背包里逐格换装备、换技能组合，看能把设置推高多少，最后列出单买一件装备的提升和花费。
        需要油猴脚本 0.4.5 以上，在游戏页面打开过一次后自动同步。
      </p>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">角色</span>
        <el-select v-model="memberId" size="small" style="width: 200px">
          <el-option v-for="m in members" :key="m.id" :label="m.name + (m.labyrinth ? '（已读迷宫设置）' : '')" :value="String(m.id)" />
        </el-select>
        <span class="muted">通关率阈值</span>
        <el-input-number v-model="threshold" :min="50" :max="99" size="small" style="width: 100px" /><span class="muted">%</span>
        <template v-if="member?.labyrinth">
          <span class="muted">战斗等级 {{ member.labyrinth.combatLevel }} · 游戏里选的补给箱：{{ crateNames(member.labyrinth.crates) }}</span>
        </template>
        <span v-else class="bad">没读到迷宫设置：更新油猴脚本到 0.4.5，打开游戏页面重新同步</span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">迷宫升级</span>
        <template v-for="[k, label] in UPGRADES" :key="k">
          <span>{{ label }}</span><el-input-number v-model="upgrades[k]" :min="0" :max="12" size="small" style="width: 90px" />
        </template>
        <span v-if="!member?.labyrinthUpgrades" class="muted">（没读到，手填）</span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">迷宫怪</span>
        <el-select v-model="monsters" multiple collapse-tags clearable placeholder="全部" size="small" style="width: 260px">
          <el-option v-for="z in store.options?.labyrinths || []" :key="z.hrid" :label="z.name" :value="z.hrid" />
        </el-select>
        <el-checkbox v-model="customCrates">换别的补给箱</el-checkbox>
        <el-select v-if="customCrates" v-model="crates" multiple collapse-tags clearable placeholder="不用" size="small" style="width: 260px">
          <el-option v-for="c in store.options?.labyrinthCrates || []" :key="c.hrid" :label="c.name" :value="c.hrid" />
        </el-select>
      </div>
      <div class="row" style="margin-bottom: 12px">
        <el-checkbox v-model="buy">也推荐可买的装备</el-checkbox>
        <template v-if="buy"><span class="muted">单件最多花</span><el-input-number v-model="maxSpend" :min="0" :step="100" size="small" style="width: 130px" /><span class="muted">M（0 = 不限）</span></template>
      </div>
      <JobRunner name="labyrinth" type="labyrinth" :params="params" label="开始推荐" @result="r => (result = r)" />
    </el-card>

    <el-card v-if="rows.length">
      <template #header>
        <div class="row">
          <b>推荐设置</b>
          <span class="muted">有效等级 {{ result.effective }}（战斗 {{ result.combatLevel }}，补给箱 {{ crateNames(result.crates) }}）· 阈值 {{ Math.round(result.threshold * 100) }}%</span>
        </div>
      </template>
      <el-table :data="rows" size="small">
        <el-table-column label="迷宫怪" prop="name" width="110" />
        <el-table-column label="配装" width="140"><template #default="{ row }">{{ row.loadoutName || "—" }}</template></el-table-column>
        <el-table-column label="现在的设置" width="150">
          <template #default="{ row }">{{ signed(row.gameSetting) }}<span v-if="row.gameSettingP != null" class="muted">（通关率 {{ pct(row.gameSettingP) }}）</span></template>
        </el-table-column>
        <el-table-column label="现在配装推荐" width="120">
          <template #default="{ row }"><b>{{ signed(row.current.setting) }}</b> <span class="muted">{{ row.current.level }} 级</span></template>
        </el-table-column>
        <el-table-column label="换装后推荐" width="150">
          <template #default="{ row }">
            <b :class="row.best.setting > row.current.setting ? 'good' : ''">{{ signed(row.best.setting) }}</b>
            <span v-if="row.best.setting > row.current.setting" class="good">（多 {{ row.best.setting - row.current.setting }} 级）</span>
          </template>
        </el-table-column>
        <el-table-column label="平均击杀" width="90"><template #default="{ row }">{{ sec(row.best.avgClear) }}</template></el-table-column>
        <el-table-column label="单买一件最多到">
          <template #default="{ row }">
            <template v-if="row.bestBuy">{{ signed(row.bestBuy.setting) }}：{{ row.bestBuy.name }} +{{ row.bestBuy.enhancementLevel }}（{{ money(row.bestBuy.cost) }}）</template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-collapse v-if="rows.length" v-model="open">
      <el-collapse-item v-for="r in rows" :key="r.monster" :name="r.monster">
        <template #title>
          <b style="margin-right: 8px">{{ r.name }}</b>
          <span class="muted">配装 {{ r.loadoutName || "—" }}{{ sourceText[r.loadoutSource] || "" }} · 推荐 {{ signed(r.current.setting) }} → {{ signed(r.best.setting) }}</span>
        </template>
        <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(360px, 1fr))">
          <div>
            <div class="muted" style="margin-bottom: 4px">装备（<span class="good">绿色</span> = 要换的，括号里是配装里现在的）</div>
            <div v-for="e in r.best.equipment.filter(e => e.itemHrid || r.current.equipment.find(x => x.slot === e.slot)?.itemHrid)" :key="e.slot" class="row">
              <span style="width: 40px" class="muted">{{ e.slotName }}</span>
              <span :class="changed(r, e) ? 'good' : ''">{{ e.name }}<template v-if="e.itemHrid"> +{{ e.enhancementLevel }}</template></span>
              <span v-if="changed(r, e)" class="muted">（{{ r.current.equipment.find(x => x.slot === e.slot)?.name || "空" }}<template v-if="r.current.equipment.find(x => x.slot === e.slot)?.itemHrid"> +{{ r.current.equipment.find(x => x.slot === e.slot).enhancementLevel }}</template>）</span>
            </div>
          </div>
          <div>
            <div class="muted" style="margin-bottom: 4px">技能与触发<span v-if="abilitiesChanged(r)" class="good">（有改动）</span></div>
            <div v-for="(a, i) in r.best.abilities" :key="i" class="row">
              <template v-if="a">
                <span>{{ a.name }} Lv.{{ a.level }}</span>
                <span class="muted">{{ triggerText({ triggerMap: r.triggerMap }, a.hrid) }}</span>
              </template>
            </div>
          </div>
        </div>
        <template v-if="r.purchases?.length">
          <div class="muted" style="margin: 12px 0 4px">单买一件（在换装后的配置上替换，各件分别比较，不叠加）</div>
          <el-table :data="r.purchases" size="small">
            <el-table-column label="格子" prop="slotName" width="70" />
            <el-table-column label="装备"><template #default="{ row }">{{ row.name }} +{{ row.enhancementLevel }}</template></el-table-column>
            <el-table-column label="花费" width="110" align="right"><template #default="{ row }">{{ money(row.cost) }}</template></el-table-column>
            <el-table-column label="怎么买" prop="how" />
            <el-table-column label="推荐设置" width="140" align="right"><template #default="{ row }">{{ signed(row.setting) }}（多 {{ row.gain }} 级）</template></el-table-column>
          </el-table>
        </template>
        <div v-else-if="buy" class="muted" style="margin-top: 8px">没有找到单买一件就能提高设置的装备</div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>
