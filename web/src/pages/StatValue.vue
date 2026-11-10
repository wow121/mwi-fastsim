<script setup>
import { computed, ref } from "vue"
import { ElMessage } from "element-plus"
import { defaultExtra, defaultTarget, int, itemName, money, randomSeedBase, selectedMembers, targetLabel } from "../api.js"
import { copyText, fileStamp, saveImage, stamp } from "../export.js"
import { STAT_GROUPS } from "@app/stat-groups.mjs"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"
import { joinList, t, tk } from "../i18n.js"

const members = computed(() => selectedMembers())
const target = ref(defaultTarget())
const extra = ref(defaultExtra())
const hours = ref(24)
const seeds = ref(16)
const reseed = ref(false)
const analyze = ref(members.value.map((_, i) => i))
const KINDS = [["attack", tk("进攻")], ["defense", tk("防御")], ["loot", tk("掉落/经验")], ["level", tk("等级")]]
const groups = ref(STAT_GROUPS.filter(g => g.on).map(g => g.id))
const result = ref(null)
const out = ref(null)
const tab = ref("0")

function params() {
  if (!members.value.length) return ElMessage.warning(t("先在“队伍”页勾选出战成员"))
  if (!analyze.value.length) return ElMessage.warning(t("至少选一个要分析的成员"))
  if (!groups.value.length) return ElMessage.warning(t("至少选一项属性"))
  // healing amplify stays on for healers when the default selection is unchanged
  const def = STAT_GROUPS.filter(g => g.on).map(g => g.id)
  const same = def.length === groups.value.length && def.every(id => groups.value.includes(id))
  return {
    members: members.value, target: target.value, extra: extra.value, hours: hours.value, seeds: seeds.value,
    seedBase: reseed.value ? randomSeedBase() : undefined, analyze: analyze.value, groups: same ? undefined : groups.value,
  }
}
function onResult(r) {
  result.value = r
  if (!r?.analyze?.map(String).includes(tab.value)) tab.value = String(r?.analyze?.[0] ?? 0)
}
const name = i => result.value?.names?.[i] || t("成员{n}", { n: i + 1 })
const unitText = r => (r.levels ? t("+1 级") : r.pct ? `+${+(r.unit * 100).toFixed(1)}%` : `+${r.unit}`)
const stepText = r => (r.levels ? t("+{n} 级", { n: r.step }) : r.pct ? `+${+(r.step * 100).toFixed(1)}%` : `+${r.step}`)
const sign = v => (v >= 0 ? "+" : "") + money(v)
const signInt = v => (v == null || !Number.isFinite(v) ? "—" : (v >= 0 ? "+" : "") + int(v))
// the change of the whole step is within the 95% range of zero
const unclear = c => c.low <= 0 && c.high >= 0
const rowsOf = i => (result.value?.rows || []).filter(r => r.member === i)
const enhOf = i => result.value?.enhancements?.find(e => e.member === i)?.items || []
const STAT_ZH = {
  stabAccuracy: tk("刺击精准"), slashAccuracy: tk("斩击精准"), smashAccuracy: tk("钝击精准"), rangedAccuracy: tk("远程精准"), magicAccuracy: tk("魔法精准"),
  stabDamage: tk("刺击伤害"), slashDamage: tk("斩击伤害"), smashDamage: tk("钝击伤害"), rangedDamage: tk("远程伤害"), magicDamage: tk("魔法伤害"), defensiveDamage: tk("防御伤害"),
  stabEvasion: tk("刺击闪避"), slashEvasion: tk("斩击闪避"), smashEvasion: tk("钝击闪避"), rangedEvasion: tk("远程闪避"), magicEvasion: tk("魔法闪避"),
  physicalAmplify: tk("物理增幅"), waterAmplify: tk("水系增幅"), natureAmplify: tk("自然系增幅"), fireAmplify: tk("火系增幅"), healingAmplify: tk("治疗增幅"),
  waterResistance: tk("水系抗性"), natureResistance: tk("自然系抗性"), fireResistance: tk("火系抗性"), armor: tk("护甲"),
  armorPenetration: tk("物理穿透"), waterPenetration: tk("水系穿透"), naturePenetration: tk("自然系穿透"), firePenetration: tk("火系穿透"),
  maxHitpoints: tk("最大生命值"), maxManapoints: tk("最大法力值"), hpRegenPer10: tk("HP恢复"), mpRegenPer10: tk("MP恢复"), lifeSteal: tk("生命窃取"), manaLeech: tk("法力吸取"),
  criticalRate: tk("暴击率"), criticalDamage: tk("暴击伤害"), attackSpeed: tk("攻击速度"), castSpeed: tk("施法速度"), abilityHaste: tk("技能急速"), abilityDamage: tk("技能伤害"), autoAttackDamage: tk("普攻伤害"),
  tenacity: tk("韧性"), threat: tk("威胁"), combatDropRate: tk("战斗掉落率"), combatDropQuantity: tk("战斗掉落数量"), combatRareFind: tk("稀有发现"), combatExperience: tk("战斗经验"),
  drinkConcentration: tk("饮料浓度"), foodHaste: tk("食物急速"),
}
const statName = k => (STAT_ZH[k] ? t(STAT_ZH[k]) : k)

function summary() {
  const r = result.value
  const lines = [t("【属性价值】{target}（{h} 小时 × {n} 次，全队利润，{time}）", { target: targetLabel(r.target || target.value), h: r.hours, n: r.seeds, time: stamp() })]
  for (const i of r.analyze) {
    lines.push(name(i) + t("："))
    for (const x of rowsOf(i)) {
      const u = x.perUnit
      lines.push("  " + t("{label} {unit}：利润 {p}/天 ±{err}，经验 {xp}/小时", { label: x.label, unit: unitText(x), p: sign(u.profitPerHour * 24), err: money(u.profitHalf * 24), xp: signInt(u.xpPerHour) }) + (unclear(x.profit) ? t("（不明显）") : ""))
    }
  }
  return lines.join("\n")
}
</script>

<template>
  <div class="page">
    <h2>{{ t("属性价值") }}</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        {{ t("每次只给一个成员加一项属性（例如精准 +10%、护甲 +20、攻击 +5 级），全队其他配置不变，用同一组随机战斗和原队伍对比，") }}
        {{ t("把多出来的全队利润和经验折算成“每 1 点属性”值多少。有了这张表，任何装备或强化都能大致换算成每天多赚多少，再对比价格就知道多久回本。") }}
        {{ t("数值是整个测试幅度上的平均，属性越高边际收益通常越小；± 是 95% 范围，标灰的项在误差范围内，看不出有用。") }}
      </p>
      <div class="row" style="margin-bottom: 8px"><span class="muted" style="width: 60px">{{ t("目标") }}</span><TargetPicker v-model="target" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 60px">{{ t("分析") }}</span>
        <el-checkbox-group v-model="analyze" size="small">
          <el-checkbox v-for="(m, i) in members" :key="m.id" :value="i">{{ m.name }}</el-checkbox>
        </el-checkbox-group>
      </div>
      <div v-for="[k, label] in KINDS" :key="k" class="row" style="margin-bottom: 6px; align-items: flex-start">
        <span class="muted" style="width: 60px; flex: none">{{ t(label) }}</span>
        <el-checkbox-group v-model="groups" size="small">
          <el-checkbox v-for="g in STAT_GROUPS.filter(g => g.kind === k)" :key="g.id" :value="g.id">{{ t(g.label) }}</el-checkbox>
        </el-checkbox-group>
      </div>
      <div class="row" style="margin: 8px 0 12px">
        <span class="muted">{{ t("每项") }}</span><el-input-number v-model="hours" :min="1" :max="240" size="small" /><span class="muted">{{ t("小时 ×") }}</span>
        <el-input-number v-model="seeds" :min="2" :max="64" size="small" /><span class="muted">{{ t("次") }}</span>
        <el-tooltip :content="t('默认每次用同一组随机战斗，重跑结果不变；勾上后换一组，用来检查结果是否稳定')" placement="top"><el-checkbox v-model="reseed" size="small">{{ t("换一组随机种子") }}</el-checkbox></el-tooltip>
        <span class="muted">{{ t("共约 {n} 组模拟", { n: analyze.length * (groups.length + 1) + 1 }) }}</span>
      </div>
      <JobRunner name="statvalue" type="statvalue" :params="params" @result="onResult" />
      <div v-if="result?.rows?.length" class="row" style="margin-top: 8px">
        <el-button size="small" @click="copyText(summary())">{{ t("复制文字") }}</el-button>
        <el-button size="small" @click="saveImage(out, `${t('属性价值')}-${fileStamp()}`)">{{ t("保存图片") }}</el-button>
      </div>
    </el-card>
    <el-card v-if="result?.rows?.length" ref="out">
      <div class="muted" style="margin-bottom: 6px">
        {{ joinList(result.names || []) }} · {{ t("每项 {h} 小时 × {n} 次", { h: result.hours, n: result.seeds }) }}{{ result.seedBase ? t("（换过随机种子）") : "" }} ·
        {{ t("原队伍全队利润 {p}/天，经验 {xp}/小时，死亡 {d}/小时", { p: money(result.base.profitPerHour * 24), xp: int(result.base.xpPerHour), d: result.base.deathsPerHour.toFixed(2) }) }}
      </div>
      <el-tabs v-model="tab">
        <el-tab-pane v-for="i in result.analyze" :key="i" :name="String(i)" :label="name(i)">
          <el-table :data="rowsOf(i)" size="small" :row-class-name="({ row }) => (unclear(row.profit) && unclear(row.xp) ? 'muted' : '')">
            <el-table-column prop="label" :label="t('属性')" min-width="130" />
            <el-table-column :label="t('每')" width="80" align="right"><template #default="{ row }">{{ unitText(row) }}</template></el-table-column>
            <el-table-column :label="t('全队利润/天')" sortable :sort-method="(a, b) => a.perUnit.profitPerHour - b.perUnit.profitPerHour" align="right" min-width="150">
              <template #default="{ row }"><span :class="{ bad: row.profit.high < 0 }">{{ sign(row.perUnit.profitPerHour * 24) }}</span> <span class="muted">±{{ money(row.perUnit.profitHalf * 24) }}</span></template>
            </el-table-column>
            <el-table-column :label="t('全队经验/小时')" sortable :sort-method="(a, b) => a.perUnit.xpPerHour - b.perUnit.xpPerHour" align="right" min-width="130">
              <template #default="{ row }">{{ signInt(row.perUnit.xpPerHour) }} <span class="muted">±{{ int(row.perUnit.xpHalf) }}</span></template>
            </el-table-column>
            <el-table-column :label="t('测试幅度')" align="right" width="90"><template #default="{ row }">{{ stepText(row) }}</template></el-table-column>
            <el-table-column :label="t('整个幅度：利润/天')" align="right" min-width="130"><template #default="{ row }">{{ sign(row.profit.mean * 24) }}</template></el-table-column>
            <el-table-column :label="t('死亡/小时')" align="right" width="90"><template #default="{ row }"><span :class="{ bad: row.deathsPerHour > 0 }">{{ row.deathsPerHour.toFixed(2) }}</span></template></el-table-column>
          </el-table>
          <template v-if="enhOf(i).length">
            <h4 style="margin: 16px 0 4px">{{ t("当前装备 +1 强化（按上表线性估算）") }}</h4>
            <el-table :data="enhOf(i)" size="small">
              <el-table-column :label="t('装备')" min-width="160"><template #default="{ row }">{{ itemName(row.itemHrid) }} +{{ row.from }} → +{{ row.to }}</template></el-table-column>
              <el-table-column :label="t('估算利润/天')" align="right"><template #default="{ row }">{{ sign(row.profitPerHour * 24) }}</template></el-table-column>
              <el-table-column :label="t('估算经验/小时')" align="right"><template #default="{ row }">{{ signInt(row.xpPerHour) }}</template></el-table-column>
              <el-table-column :label="t('未计入的属性')" min-width="140"><template #default="{ row }"><span class="muted">{{ joinList(row.missing.map(statName)) }}</span></template></el-table-column>
            </el-table>
            <div class="muted" style="margin-top: 4px">{{ t("只是估算：几项属性一起提升时效果不一定能相加；要精确比较，用“整队提升规划”。") }}</div>
          </template>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>
