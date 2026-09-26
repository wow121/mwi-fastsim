<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { abilityName, call, clone, itemName, loadState, saveTeam, store } from "../api.js"
import TriggerEditor from "../components/TriggerEditor.vue"

const SLOTS = [["weapon", "武器"], ["off_hand", "副手"], ["head", "头"], ["body", "身体"], ["legs", "腿"], ["hands", "手"], ["feet", "脚"], ["back", "背"], ["neck", "项链"], ["earrings", "耳环"], ["ring", "戒指"], ["pouch", "袋子"], ["charm", "护符"]]
const SKILLS = [["stamina", "耐力"], ["intelligence", "智力"], ["attack", "攻击"], ["melee", "近战"], ["defense", "防御"], ["ranged", "远程"], ["magic", "魔法"]]
const o = computed(() => store.options)
const dirty = ref(false)
const editing = ref(store.team.members[0]?.id ?? null)
const member = computed(() => store.team.members.find(m => m.id === editing.value))
const loadoutName = ref("")

function toggle(id, on) {
  const sel = store.team.selected.filter(x => x !== String(id))
  if (on) {
    if (sel.length >= 5) return ElMessage.warning("最多 5 人")
    sel.push(String(id))
  }
  store.team.selected = sel
  dirty.value = true
}
function ensureSlot(m, slot) {
  m.equipment[slot] ||= { itemHrid: "", enhancementLevel: 0 }
  return m.equipment[slot]
}
function trig(m, hrid) {
  return computed({
    get: () => (m.triggerMap && Object.prototype.hasOwnProperty.call(m.triggerMap, hrid) ? m.triggerMap[hrid] : null),
    set: v => {
      m.triggerMap ||= {}
      if (v == null) delete m.triggerMap[hrid]
      else m.triggerMap[hrid] = v
      dirty.value = true
    },
  })
}
const triggerTargets = computed(() => {
  const m = member.value
  if (!m) return []
  const list = [...(m.abilities || []).map(a => a.abilityHrid), ...(m.food || []), ...(m.drinks || [])].filter(Boolean)
  return [...new Set(list)].map(h => ({ hrid: h, name: itemName(h) !== h ? itemName(h) : abilityName(h), model: trig(m, h) }))
})
// Teammates' profiles only show equipped abilities, so every ability stays selectable:
// learned ones first (with their level), the rest at a level the user types in.
const learnedMap = computed(() => {
  const m = member.value
  const map = { ...(m?.abilityLevelMap || {}) }
  for (const a of m?.abilities || []) if (a.abilityHrid) map[a.abilityHrid] ||= a.level
  return map
})
const learned = computed(() => o.value.abilities.filter(a => learnedMap.value[a.hrid]).map(a => ({ ...a, level: learnedMap.value[a.hrid] })))
const abilityOptions = computed(() => [...learned.value, ...o.value.abilities.filter(a => !learnedMap.value[a.hrid]).map(a => ({ ...a, level: 0 }))])
function setAbility(i, hrid) {
  const m = member.value
  const lv = m.abilityLevelMap?.[hrid] || m.abilities[i].level || 1
  m.abilities[i] = { abilityHrid: hrid || "", level: hrid ? lv : 1 }
  if (hrid) m.abilityLevelMap = { ...(m.abilityLevelMap || {}), [hrid]: lv }
  dirty.value = true
}
function setAbilityLevel(a) {
  const m = member.value
  if (a.abilityHrid) m.abilityLevelMap = { ...(m.abilityLevelMap || {}), [a.abilityHrid]: a.level }
  dirty.value = true
}
async function save() {
  await saveTeam()
  dirty.value = false
  ElMessage.success("已保存")
}
async function reload() {
  await loadState()
  dirty.value = false
}
async function saveLoadout() {
  if (!loadoutName.value.trim()) return ElMessage.warning("请输入方案名称")
  const list = store.loadouts.filter(l => l.name !== loadoutName.value.trim())
  list.unshift({ name: loadoutName.value.trim(), savedAt: Date.now(), members: clone(store.team.members), selected: [...store.team.selected] })
  await call("PUT", "/api/loadouts", list)
  store.loadouts = list
  ElMessage.success("方案已保存")
}
async function useLoadout(l) {
  store.team.members = clone(l.members)
  store.team.selected = [...l.selected]
  dirty.value = true
}
async function deleteLoadout(l) {
  store.loadouts = store.loadouts.filter(x => x !== l)
  await call("PUT", "/api/loadouts", store.loadouts)
}
</script>

<template>
  <div class="page">
    <h2>队伍</h2>
    <el-alert v-if="!store.team.members.length || store.team.sample" type="info" :closable="false" style="margin-bottom: 12px">
      <template #title>
        {{ store.team.sample ? "当前是测试队伍。" : "还没有队伍数据。" }}装好 <el-link type="primary" href="https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim.user.js" target="_blank">mwi-fastsim 油猴脚本</el-link>后刷新游戏页面（队长或任一队员的号都行），{{ store.mode === "browser" ? "左下角显示“已读取”后再刷新本页，会自动导入。" : "左下角显示“已同步”后再刷新本页。" }}
      </template>
    </el-alert>

    <el-alert v-if="store.team.source === 'game' && store.team.missing?.length" type="warning" :closable="false" style="margin-bottom: 12px">
      <template #title>缺少队友数据：{{ store.team.missing.join("、") }}。在游戏里点开他们的资料页，脚本会自动补上。</template>
    </el-alert>

    <el-alert v-if="store.team.dtoCheck" :type="store.team.dtoCheck.ok === true ? 'success' : store.team.dtoCheck.ok === false ? 'warning' : 'info'" :closable="false" style="margin-bottom: 12px">
      <template #title>数据核对：{{ store.team.dtoCheck.summary }}</template>
      <div v-for="d in store.team.dtoCheck.diffs || []" :key="d" class="muted">{{ d }}</div>
    </el-alert>

    <el-card>
      <template #header>
        <div class="row">
          <b>出战成员</b><span class="muted">勾选参与模拟和优化的角色（最多 5 人）</span>
          <span style="flex: 1" />
          <el-button size="small" @click="reload">重新读取</el-button>
          <el-button size="small" type="primary" :disabled="!dirty" @click="save">保存修改</el-button>
        </div>
      </template>
      <div class="row">
        <el-check-tag v-for="m in store.team.members" :key="m.id" :checked="store.team.selected.includes(String(m.id))" @change="v => toggle(m.id, v)">
          {{ m.name || `角色${m.id}` }}
        </el-check-tag>
      </div>
    </el-card>

    <el-card>
      <template #header>
        <div class="row">
          <b>编辑角色</b>
          <el-radio-group v-model="editing" size="small">
            <el-radio-button v-for="m in store.team.members" :key="m.id" :value="m.id">{{ m.name || `角色${m.id}` }}</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <el-tabs v-if="member" @tab-change="() => {}">
        <el-tab-pane label="装备">
          <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(330px, 1fr))">
            <div v-for="[slot, label] in SLOTS" :key="slot" class="row">
              <span style="width: 40px" class="muted">{{ label }}</span>
              <el-select v-model="ensureSlot(member, slot).itemHrid" filterable clearable size="small" style="width: 200px" @change="dirty = true">
                <el-option v-for="it in o.equipment[slot] || []" :key="it.hrid" :label="it.name" :value="it.hrid" />
              </el-select>
              <el-input-number v-model="ensureSlot(member, slot).enhancementLevel" :min="0" :max="o.enhancementCap" size="small" style="width: 80px" @change="dirty = true" />
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="技能">
          <div v-for="(a, i) in member.abilities" :key="i" class="row" style="margin-bottom: 6px">
            <span style="width: 70px" class="muted">{{ i === 0 ? "特殊技能" : `技能 ${i}` }}</span>
            <el-select :model-value="a.abilityHrid" filterable clearable size="small" style="width: 220px" @update:model-value="v => setAbility(i, v)">
              <el-option v-for="x in abilityOptions.filter(x => (i === 0) === x.isSpecial)" :key="x.hrid" :label="x.level ? `${x.name} Lv.${x.level}` : `${x.name}（未读到）`" :value="x.hrid" />
            </el-select>
            <el-input-number v-model="a.level" :min="1" :max="200" size="small" style="width: 90px" @change="setAbilityLevel(a)" />
            <span v-if="(member.levels?.intelligence ?? 1) < (o.slotRequirements[i + 1] ?? 0)" class="bad">智力不足，未解锁</span>
          </div>
          <div class="muted">已学技能 {{ learned.length }} 个（来自插件数据）。队友只能读到正在装备的技能，其他技能标“未读到”，选上后填等级即可。</div>
        </el-tab-pane>
        <el-tab-pane label="食物/饮料">
          <div v-for="(kind, k) in [['food', '食物', o.food], ['drinks', '饮料', o.drinks]]" :key="k">
            <div v-for="i in 3" :key="i" class="row" style="margin-bottom: 6px">
              <span style="width: 60px" class="muted">{{ kind[1] }} {{ i }}</span>
              <el-select v-model="member[kind[0]][i - 1]" filterable clearable size="small" style="width: 240px" @change="dirty = true">
                <el-option v-for="x in kind[2]" :key="x.hrid" :label="x.name" :value="x.hrid" />
              </el-select>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="触发条件">
          <div v-for="t in triggerTargets" :key="t.hrid" style="margin-bottom: 12px">
            <b>{{ t.name }}</b>
            <TriggerEditor v-model="t.model.value" />
          </div>
        </el-tab-pane>
        <el-tab-pane label="等级">
          <div class="row">
            <div v-for="[k, label] in SKILLS" :key="k" class="row">
              <span class="muted">{{ label }}</span>
              <el-input-number v-model="member.levels[k]" :min="1" :max="200" size="small" style="width: 90px" @change="dirty = true" />
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-card>
      <template #header><b>配装方案</b> <span class="muted">保存/切换整队配置</span></template>
      <div class="row" style="margin-bottom: 8px">
        <el-input v-model="loadoutName" placeholder="方案名称" size="small" style="width: 200px" />
        <el-button size="small" @click="saveLoadout">保存当前为方案</el-button>
      </div>
      <el-table :data="store.loadouts" size="small" empty-text="暂无方案">
        <el-table-column prop="name" label="名称" />
        <el-table-column label="成员"><template #default="{ row }">{{ row.selected.map(id => row.members.find(m => String(m.id) === id)?.name).join("、") }}</template></el-table-column>
        <el-table-column label="保存时间" width="180"><template #default="{ row }">{{ new Date(row.savedAt).toLocaleString() }}</template></el-table-column>
        <el-table-column width="150">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="useLoadout(row)">载入</el-button>
            <el-button size="small" text type="danger" @click="deleteLoadout(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
