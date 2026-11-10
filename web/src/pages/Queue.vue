<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { defaultExtra, defaultTarget, int, perDay, selectedMembers, store, targetLabel } from "../api.js"
import { t } from "../i18n.js"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"

const configs = ref(["__current__"])
const targets = ref([defaultTarget()])
const draft = ref(defaultTarget())
const extra = ref(defaultExtra())
const hours = ref(24)
const seeds = ref(2)
const result = ref(null)

const choices = computed(() => [{ name: "__current__", label: t("当前队伍") }, ...store.loadouts.map(l => ({ name: l.name, label: l.name }))])
function membersOf(name) {
  if (name === "__current__") return selectedMembers()
  const l = store.loadouts.find(x => x.name === name)
  return l ? l.selected.map(id => l.members.find(m => String(m.id) === id)).filter(Boolean) : []
}
function params() {
  const items = []
  for (const c of configs.value)
    for (const tg of targets.value) {
      const members = membersOf(c)
      if (members.length) items.push({ label: `${choices.value.find(x => x.name === c)?.label} @ ${targetLabel(tg)}`, members, target: tg, hours: hours.value, seeds: seeds.value, extra: extra.value })
    }
  if (!items.length) return ElMessage.warning(t("队列为空"))
  return { items }
}
</script>

<template>
  <div class="page">
    <h2>{{ t("批量队列") }}</h2>
    <el-card>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted">{{ t("配置") }}</span>
        <el-select v-model="configs" multiple style="width: 420px" size="small">
          <el-option v-for="c in choices" :key="c.name" :label="c.label" :value="c.name" />
        </el-select>
        <span class="muted">{{ t("（在“队伍”页保存配装方案后可选）") }}</span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <TargetPicker v-model="draft" />
        <el-button size="small" @click="targets.push({ ...draft })">{{ t("添加目标") }}</el-button>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <el-tag v-for="(tg, i) in targets" :key="i" closable @close="targets.splice(i, 1)">{{ targetLabel(tg) }}</el-tag>
      </div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 12px">
        <span class="muted">{{ t("每项") }}</span><el-input-number v-model="hours" :min="1" :max="240" size="small" /><span class="muted">{{ t("小时 ×") }}</span>
        <el-input-number v-model="seeds" :min="1" :max="32" size="small" /><span class="muted">{{ t("次") }}</span>
      </div>
      <JobRunner name="queue" type="queue" :params="params" :label="t('运行队列')" @result="r => (result = r)" />
    </el-card>
    <el-card v-if="result?.rows">
      <el-table :data="result.rows.map(r => ({ label: r.label, ...r.metrics }))" size="small">
        <el-table-column prop="label" :label="t('配置 @ 目标')" min-width="260" />
        <el-table-column prop="profitPerHour" :label="t('利润下限/天')" sortable align="right"><template #default="{ row }">{{ perDay(row.profitPerHour) }}</template></el-table-column>
        <el-table-column prop="profitMidpointPerHour" :label="t('利润中值/天')" sortable align="right"><template #default="{ row }">{{ perDay(row.profitMidpointPerHour) }}</template></el-table-column>
        <el-table-column prop="xpPerHour" :label="t('经验/小时')" sortable align="right"><template #default="{ row }">{{ int(row.xpPerHour) }}</template></el-table-column>
        <el-table-column prop="deathsPerHour" :label="t('死亡/小时')" sortable align="right"><template #default="{ row }">{{ row.deathsPerHour.toFixed(2) }}</template></el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
