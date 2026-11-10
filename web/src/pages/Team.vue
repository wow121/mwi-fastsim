<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { abilityName, call, clone, itemName, loadState, saveTeam, store } from "../api.js"
import { dateTime, joinList, t, tk } from "../i18n.js"
import TriggerEditor from "../components/TriggerEditor.vue"

const SLOTS = [["weapon", tk("武器")], ["off_hand", tk("副手")], ["head", tk("头")], ["body", tk("身体")], ["legs", tk("腿")], ["hands", tk("手")], ["feet", tk("脚")], ["back", tk("背")], ["neck", tk("项链")], ["earrings", tk("耳环")], ["ring", tk("戒指")], ["pouch", tk("袋子")], ["charm", tk("护符")], ["trinket", tk("饰品")]]
const SKILLS = [["stamina", tk("耐力")], ["intelligence", tk("智力")], ["attack", tk("攻击")], ["melee", tk("近战")], ["defense", tk("防御")], ["ranged", tk("远程")], ["magic", tk("魔法")]]
const o = computed(() => store.options)
const dirty = ref(false)
const editing = ref(store.team.members[0]?.id ?? null)
const member = computed(() => store.team.members.find(m => m.id === editing.value))
const loadoutName = ref("")

function toggle(id, on) {
  const sel = store.team.selected.filter(x => x !== String(id))
  if (on) {
    if (sel.length >= 5) return ElMessage.warning(t("最多 5 人"))
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
// house rooms / guild buffs: missing keys read as 0, writes create the map
function setHouse(h, v) {
  member.value.houseRooms = { ...(member.value.houseRooms || {}), [h]: Math.max(0, Math.floor(Number(v) || 0)) }
  dirty.value = true
}
function setGuild(h, v) {
  member.value.guildBuffs = { ...(member.value.guildBuffs || {}), [h]: Math.max(0, Math.floor(Number(v) || 0)) }
  dirty.value = true
}
const shrineOf = h => {
  const v = member.value?.guildBuffCaps?.[h]
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v)
}
const houseGroups = computed(() => [[t("战斗房屋"), o.value.houseRooms.filter(h => h.combat)], [t("其他房屋（只加全局经验和稀有发现）"), o.value.houseRooms.filter(h => !h.combat)]])
async function save() {
  await saveTeam()
  dirty.value = false
  ElMessage.success(t("已保存"))
}
async function reload() {
  await loadState()
  dirty.value = false
}
async function saveLoadout() {
  if (!loadoutName.value.trim()) return ElMessage.warning(t("请输入方案名称"))
  const list = store.loadouts.filter(l => l.name !== loadoutName.value.trim())
  list.unshift({ name: loadoutName.value.trim(), savedAt: Date.now(), members: clone(store.team.members), selected: [...store.team.selected] })
  await call("PUT", "/api/loadouts", list)
  store.loadouts = list
  ElMessage.success(t("方案已保存"))
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
    <h2>{{ t("队伍") }}</h2>
    <el-alert v-if="!store.team.members.length || store.team.sample" type="info" :closable="false" style="margin-bottom: 12px">
      <template #title>
        {{ store.team.sample ? t("当前是测试队伍。") : t("还没有队伍数据。") }}{{ t("装好") }} <el-link type="primary" href="https://github.com/wow121/mwi-fastsim/raw/main/userscript/mwi-fastsim.user.js" target="_blank">{{ t("mwi-fastsim 油猴脚本") }}</el-link>{{ t("后刷新游戏页面（队长或任一队员的号都行），") }}{{ store.mode === "browser" ? t("左下角显示“已读取”后再刷新本页，会自动导入。") : t("左下角显示“已同步”后再刷新本页。") }}
      </template>
    </el-alert>

    <el-alert v-if="store.team.source === 'game' && store.team.missing?.length" type="warning" :closable="false" style="margin-bottom: 12px">
      <template #title>{{ t("缺少队友数据：{list}。在游戏里点开他们的资料页，脚本会自动补上。", { list: joinList(store.team.missing) }) }}</template>
    </el-alert>

    <el-alert v-if="store.team.dtoCheck" :type="store.team.dtoCheck.ok === true ? 'success' : store.team.dtoCheck.ok === false ? 'warning' : 'info'" :closable="false" style="margin-bottom: 12px">
      <template #title>{{ t("数据核对：") }}{{ store.team.dtoCheck.summary }}</template>
      <div v-for="d in store.team.dtoCheck.diffs || []" :key="d" class="muted">{{ d }}</div>
    </el-alert>

    <el-card>
      <template #header>
        <div class="row">
          <b>{{ t("出战成员") }}</b><span class="muted">{{ t("勾选参与模拟和优化的角色（最多 5 人）") }}</span>
          <span style="flex: 1" />
          <el-button size="small" @click="reload">{{ t("重新读取") }}</el-button>
          <el-button size="small" type="primary" :disabled="!dirty" @click="save">{{ t("保存修改") }}</el-button>
        </div>
      </template>
      <div class="row">
        <el-check-tag v-for="m in store.team.members" :key="m.id" :checked="store.team.selected.includes(String(m.id))" @change="v => toggle(m.id, v)">
          {{ m.name || t("角色{id}", { id: m.id }) }}
        </el-check-tag>
      </div>
    </el-card>

    <el-card>
      <template #header>
        <div class="row">
          <b>{{ t("编辑角色") }}</b>
          <el-radio-group v-model="editing" size="small">
            <el-radio-button v-for="m in store.team.members" :key="m.id" :value="m.id">{{ m.name || t("角色{id}", { id: m.id }) }}</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <el-tabs v-if="member" @tab-change="() => {}">
        <el-tab-pane :label="t('装备')">
          <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(330px, 1fr))">
            <div v-for="[slot, label] in SLOTS" :key="slot" class="row">
              <span style="width: 40px" class="muted">{{ t(label) }}</span>
              <el-select v-model="ensureSlot(member, slot).itemHrid" filterable clearable size="small" style="width: 200px" @change="dirty = true">
                <el-option v-for="it in o.equipment[slot] || []" :key="it.hrid" :label="it.name" :value="it.hrid" />
              </el-select>
              <el-input-number v-model="ensureSlot(member, slot).enhancementLevel" :min="0" :max="o.enhancementCap" size="small" style="width: 80px" @change="dirty = true" />
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane :label="t('技能')">
          <div v-for="(a, i) in member.abilities" :key="i" class="row" style="margin-bottom: 6px">
            <span style="width: 70px" class="muted">{{ i === 0 ? t("特殊技能") : t("技能 {i}", { i }) }}</span>
            <el-select :model-value="a.abilityHrid" filterable clearable size="small" style="width: 220px" @update:model-value="v => setAbility(i, v)">
              <el-option v-for="x in abilityOptions.filter(x => (i === 0) === x.isSpecial)" :key="x.hrid" :label="x.level ? `${x.name} Lv.${x.level}` : t('{name}（未读到）', { name: x.name })" :value="x.hrid" />
            </el-select>
            <el-input-number v-model="a.level" :min="1" :max="200" size="small" style="width: 90px" @change="setAbilityLevel(a)" />
            <span v-if="(member.levels?.intelligence ?? 1) < (o.slotRequirements[i + 1] ?? 0)" class="bad">{{ t("智力不足，未解锁") }}</span>
          </div>
          <div class="muted">{{ t("已学技能 {n} 个（来自插件数据）。队友只能读到正在装备的技能，其他技能标“未读到”，选上后填等级即可。", { n: learned.length }) }}</div>
        </el-tab-pane>
        <el-tab-pane :label="t('食物/饮料')">
          <div v-for="(kind, k) in [['food', t('食物'), o.food], ['drinks', t('饮料'), o.drinks]]" :key="k">
            <div v-for="i in 3" :key="i" class="row" style="margin-bottom: 6px">
              <span style="width: 60px" class="muted">{{ kind[1] }} {{ i }}</span>
              <el-select v-model="member[kind[0]][i - 1]" filterable clearable size="small" style="width: 240px" @change="dirty = true">
                <el-option v-for="x in kind[2]" :key="x.hrid" :label="x.name" :value="x.hrid" />
              </el-select>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane :label="t('触发条件')">
          <div v-for="tt in triggerTargets" :key="tt.hrid" style="margin-bottom: 12px">
            <b>{{ tt.name }}</b>
            <TriggerEditor v-model="tt.model.value" />
          </div>
        </el-tab-pane>
        <el-tab-pane :label="t('等级#tab')">
          <div class="row">
            <div v-for="[k, label] in SKILLS" :key="k" class="row">
              <span class="muted">{{ t(label) }}</span>
              <el-input-number v-model="member.levels[k]" :min="1" :max="200" size="small" style="width: 90px" @change="dirty = true" />
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane :label="t('房屋/神龛')">
          <div v-for="[title, rooms] in houseGroups" :key="title" style="margin-bottom: 12px">
            <div class="muted" style="margin-bottom: 6px">{{ title }}</div>
            <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(210px, 1fr))">
              <div v-for="h in rooms" :key="h.hrid" class="row">
                <span style="width: 90px; white-space: nowrap">{{ h.name }}</span>
                <el-input-number :model-value="Number(member.houseRooms?.[h.hrid] || 0)" :min="0" :max="h.maxLevel" size="small" style="width: 90px" @change="v => setHouse(h.hrid, v)" />
              </div>
            </div>
          </div>
          <div class="muted" style="margin-bottom: 6px">{{ t("公会神龛加成（个人等级）") }}</div>
          <div v-for="g in o.guildBuffs" :key="g.hrid" class="row" style="margin-bottom: 6px">
            <span style="width: 290px; white-space: nowrap">{{ g.shrine }} · {{ g.name }}</span>
            <el-input-number :model-value="Number(member.guildBuffs?.[g.hrid] || 0)" :min="0" :max="g.maxLevel" size="small" style="width: 90px" @change="v => setGuild(g.hrid, v)" />
            <span v-if="shrineOf(g.hrid) != null" class="muted">{{ t("公会神龛 {n} 级", { n: shrineOf(g.hrid) }) }}</span>
            <span v-if="shrineOf(g.hrid) != null && Number(member.guildBuffs?.[g.hrid] || 0) > shrineOf(g.hrid)" class="bad">{{ t("高于公会神龛等级，游戏里只按 {n} 级生效", { n: shrineOf(g.hrid) }) }}</span>
          </div>
          <el-alert v-if="!member.guildBuffCaps" type="info" :closable="false" show-icon style="margin-top: 6px">
            <template #title>{{ t("队友的神龛加成取自队友的个人资料页；资料页看不到公会神龛等级，这里不做限制，按个人等级模拟。如果公会神龛比个人等级低，请手动改小。") }}</template>
          </el-alert>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-card>
      <template #header><b>{{ t("配装方案") }}</b> <span class="muted">{{ t("保存/切换整队配置") }}</span></template>
      <div class="row" style="margin-bottom: 8px">
        <el-input v-model="loadoutName" :placeholder="t('方案名称')" size="small" style="width: 200px" />
        <el-button size="small" @click="saveLoadout">{{ t("保存当前为方案") }}</el-button>
      </div>
      <el-table :data="store.loadouts" size="small" :empty-text="t('暂无方案')">
        <el-table-column prop="name" :label="t('名称')" />
        <el-table-column :label="t('成员')"><template #default="{ row }">{{ joinList(row.selected.map(id => row.members.find(m => String(m.id) === id)?.name)) }}</template></el-table-column>
        <el-table-column :label="t('保存时间')" width="180"><template #default="{ row }">{{ dateTime(row.savedAt) }}</template></el-table-column>
        <el-table-column width="150">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="useLoadout(row)">{{ t("载入") }}</el-button>
            <el-button size="small" text type="danger" @click="deleteLoadout(row)">{{ t("删除") }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
