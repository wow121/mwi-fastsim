<script setup>
import { ElMessage, ElMessageBox } from "element-plus"
import { clone, saveTeam, store } from "../api.js"
import { t } from "../i18n.js"

// Writes optimized member configs back into the team (matched by id).
const props = defineProps({ members: Array })
async function apply() {
  await ElMessageBox.confirm(t("用优化结果覆盖队伍中这些角色的配置？（可以先在“队伍”页保存一个配装方案备份）"), t("应用到队伍"), { type: "warning" })
  for (const m of props.members) {
    const i = store.team.members.findIndex(x => String(x.id) === String(m.id))
    if (i >= 0) store.team.members[i] = clone(m)
  }
  await saveTeam()
  ElMessage.success(t("已应用并保存"))
}
</script>

<template>
  <el-button type="success" size="small" @click="apply">{{ t("应用到队伍") }}</el-button>
</template>
