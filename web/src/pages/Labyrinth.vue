<script setup>
import { computed, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { clone, defaultExtra, money, pct, store, triggerText } from "../api.js"
import JobRunner from "../components/JobRunner.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"
import ApplyResult from "../components/ApplyResult.vue"

const UPGRADES = [["attackSpeed", "攻击速度"], ["castSpeed", "施法速度"], ["combatDamage", "战斗伤害"], ["criticalRate", "暴击率"]]

const members = computed(() => store.team.members || [])
// the logged-in character is the one whose inventory was read
const memberId = ref(String((members.value.find(m => m.ownedEquipment) || members.value[0])?.id ?? ""))
const member = computed(() => members.value.find(m => String(m.id) === memberId.value))
const upgrades = ref({})
watch(member, m => (upgrades.value = { attackSpeed: 0, castSpeed: 0, combatDamage: 0, criticalRate: 0, ...(m?.labyrinthUpgrades || {}) }), { immediate: true })
const extra = ref(defaultExtra())
const threshold = ref(95)
const monsters = ref([])
const crates = ref([])
const buy = ref(true)
const maxSpend = ref(0)
const result = ref(null)

function params() {
  if (!member.value) return ElMessage.warning("队伍里还没有角色，先在“队伍”页同步")
  const m = clone(member.value)
  m.labyrinthUpgrades = { ...(m.labyrinthUpgrades || {}), ...upgrades.value }
  return { member: m, monsters: monsters.value, crates: crates.value, extra: extra.value, threshold: threshold.value / 100, buy: buy.value, maxSpend: maxSpend.value * 1e6 }
}

const curEquip = computed(() => member.value?.equipment || {})
const changed = (row) => {
  const e = curEquip.value[row.slot]
  return (e?.itemHrid || "") !== row.itemHrid || Number(e?.enhancementLevel || 0) !== row.enhancementLevel
}
const sec = v => (v == null ? "—" : `${v.toFixed(1)} 秒`)
</script>

<template>
  <div class="page">
    <h2>迷宫配置推荐</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        给一个角色、每个迷宫怪各推荐一套装备和技能：在角色已有的装备（身上 + 背包，需要新版油猴脚本同步）里逐个格子换，再换技能组合，
        目标是通关率（120 秒内打死）不低于阈值时能打的最高房间等级。之后再列出单买一件装备能把等级再推高多少、要花多少钱。
        食物饮料保持当前设置。迷宫升级只在迷宫里生效。
      </p>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">角色</span>
        <el-select v-model="memberId" size="small" style="width: 180px">
          <el-option v-for="m in members" :key="m.id" :label="m.name + (m.ownedEquipment ? '（已读背包）' : '')" :value="String(m.id)" />
        </el-select>
        <span class="muted">通关率阈值</span>
        <el-input-number v-model="threshold" :min="50" :max="99" size="small" style="width: 100px" /><span class="muted">%</span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">迷宫升级</span>
        <template v-for="[k, label] in UPGRADES" :key="k">
          <span>{{ label }}</span><el-input-number v-model="upgrades[k]" :min="0" :max="12" size="small" style="width: 90px" />
        </template>
        <span v-if="!member?.labyrinthUpgrades" class="muted">（没读到，手填；更新油猴脚本后重新同步可自动读取）</span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">迷宫怪</span>
        <el-select v-model="monsters" multiple collapse-tags clearable placeholder="全部" size="small" style="width: 260px">
          <el-option v-for="z in store.options?.labyrinths || []" :key="z.hrid" :label="z.name" :value="z.hrid" />
        </el-select>
        <span class="muted">补给箱</span>
        <el-select v-model="crates" multiple collapse-tags clearable placeholder="不用" size="small" style="width: 260px">
          <el-option v-for="c in store.options?.labyrinthCrates || []" :key="c.hrid" :label="c.name" :value="c.hrid" />
        </el-select>
      </div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 12px">
        <el-checkbox v-model="buy">也推荐可买的装备</el-checkbox>
        <template v-if="buy"><span class="muted">单件最多花</span><el-input-number v-model="maxSpend" :min="0" :step="100" size="small" style="width: 130px" /><span class="muted">M（0 = 不限）</span></template>
      </div>
      <JobRunner name="labyrinth" type="labyrinth" :params="params" label="开始推荐" @result="r => (result = r)" />
    </el-card>

    <el-card v-for="r in result?.results || []" :key="r.monster">
      <template #header>
        <div class="row">
          <b>{{ r.name }}</b>
          <span>当前配置 {{ r.current.level }} 级</span>
          <span>→</span>
          <span class="good">推荐配置 {{ r.best.level }} 级</span>
          <span class="muted">（该等级通关率 {{ pct(r.best.p) }}，平均 {{ sec(r.best.avgClear) }} 打死）</span>
          <span style="flex: 1" />
          <ApplyResult :members="[r.config]" />
        </div>
      </template>
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(360px, 1fr))">
        <div>
          <div class="muted" style="margin-bottom: 4px">装备（<span class="good">绿色</span> = 和现在不同）</div>
          <div v-for="e in r.best.equipment.filter(e => e.itemHrid || curEquip[e.slot]?.itemHrid)" :key="e.slot" class="row">
            <span style="width: 40px" class="muted">{{ e.slotName }}</span>
            <span :class="changed(e) ? 'good' : ''">{{ e.name }}<template v-if="e.itemHrid"> +{{ e.enhancementLevel }}</template></span>
          </div>
        </div>
        <div>
          <div class="muted" style="margin-bottom: 4px">技能与触发</div>
          <div v-for="(a, i) in r.best.abilities" :key="i" class="row">
            <template v-if="a">
              <span>{{ a.name }} Lv.{{ a.level }}</span>
              <span class="muted">{{ triggerText(r.config, a.hrid) }}</span>
            </template>
          </div>
        </div>
      </div>
      <template v-if="r.purchases?.length">
        <div class="muted" style="margin: 12px 0 4px">单买一件（在推荐配置上替换，各件分别比较，不叠加）</div>
        <el-table :data="r.purchases" size="small">
          <el-table-column label="格子" prop="slotName" width="70" />
          <el-table-column label="装备"><template #default="{ row }">{{ row.name }} +{{ row.enhancementLevel }}</template></el-table-column>
          <el-table-column label="花费" width="110" align="right"><template #default="{ row }">{{ money(row.cost) }}</template></el-table-column>
          <el-table-column label="怎么买" prop="how" />
          <el-table-column label="能到" width="120" align="right"><template #default="{ row }">{{ row.level }} 级（+{{ row.gain }}）</template></el-table-column>
        </el-table>
      </template>
      <div v-else-if="buy" class="muted" style="margin-top: 8px">没有找到单买一件就能提高等级的装备</div>
    </el-card>
  </div>
</template>
