<script setup>
import { computed, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { abilityName, clone, COMBAT_SKILLS, defaultExtra, defaultTarget, int, itemName, money, saveTeam, store, targetLabel } from "../api.js"
import { copyText, fileStamp, saveImage, stamp } from "../export.js"
import JobRunner from "../components/JobRunner.vue"
import TargetPicker from "../components/TargetPicker.vue"
import ExtraBuffs from "../components/ExtraBuffs.vue"
import { joinList, t, tk } from "../i18n.js"

// roles of the composition ranking (keys of BUILDS in node/app/opt-comp.mjs)
const ROLES = [["water", tk("水法")], ["fire", tk("火法")], ["nature", tk("自然法")], ["healer", tk("自然奶")], ["sword", tk("剑")], ["mace", tk("锤")], ["spear", tk("枪")], ["bow", tk("弓")], ["crossbow", tk("弩")], ["shield", tk("盾")]]
const roleName = k => t(ROLES.find(r => r[0] === k)?.[1] || k)

const load = (k, d) => {
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(k)) || {}) }
  } catch {
    return d
  }
}
const cfg = ref(load("fastsim-comp", {
  size: 3, budget: 3000, builds: ROLES.map(r => r[0]), required: [], abilityLevel: 60, house: 8, achievements: true, even: false, levels: Object.fromEntries(COMBAT_SKILLS.map(([s]) => [s, 130])), top: 5, objective: "profit", tax: 4,
}))
if (!cfg.value.levels || "template" in cfg.value) {
  cfg.value.levels = Object.fromEntries(COMBAT_SKILLS.map(([s]) => [s, 130]))
  cfg.value.abilityLevel = 60
}
delete cfg.value.template
delete cfg.value.level
if (typeof cfg.value.house !== "number") cfg.value.house = 8
if (typeof cfg.value.achievements !== "boolean") cfg.value.achievements = true
watch(cfg, v => { try { localStorage.setItem("fastsim-comp", JSON.stringify(v)) } catch {} }, { deep: true })
const target = ref(defaultTarget())
const extra = ref(defaultExtra())
const result = ref(null)
const out = ref(null)

const zone = computed(() => [...(store.options?.zones || []), ...(store.options?.dungeons || [])].find(z => z.hrid === target.value.zoneHrid))
const maxSize = computed(() => Math.min(5, zone.value?.maxPartySize || 5))
watch(maxSize, v => { if (cfg.value.size > v) cfg.value.size = v })
// how many compositions: multisets of `size` from the roles, with the required ones
const count = computed(() => {
  const k = cfg.value.builds.length
  const n = cfg.value.size - Math.min(cfg.value.size, cfg.value.required.length)
  let c = 1
  for (let i = 1; i <= n; i++) c = (c * (k + i - 1)) / i
  return Math.round(c)
})

function params() {
  if (target.value.kind === "labyrinth") return ElMessage.warning(t("迷宫是单人挑战，请选择区域或地下城"))
  if (!cfg.value.builds.length) return ElMessage.warning(t("至少选一种职业"))
  if (cfg.value.required.some(r => !cfg.value.builds.includes(r))) return ElMessage.warning(t("必须包含的职业也要在可选职业里"))
  if (cfg.value.required.length > cfg.value.size) return ElMessage.warning(t("必须包含的职业比人数还多"))
  return {
    target: target.value, extra: extra.value, objective: cfg.value.objective, size: cfg.value.size, budget: cfg.value.budget * 1e6,
    builds: cfg.value.builds, required: cfg.value.required, abilityLevel: cfg.value.abilityLevel, top: cfg.value.top, tax: cfg.value.tax / 100,
    levels: cfg.value.levels, house: cfg.value.house, achievements: cfg.value.achievements, even: cfg.value.even,
  }
}

// ranking objective of the result: profit per day, encounters per hour (EPH) or experience per hour
const obj = computed(() => result.value?.objective || "profit")
const isXp = computed(() => obj.value === "xp")
const KEY = { profit: "profitPerHour", eph: "encountersPerHour", xp: "xpPerHour" }
const fmt = (v, o) => (v == null || !Number.isFinite(v) ? "—" : o === "xp" ? int(v) : o === "eph" ? v.toFixed(1) : money(v * 24))
const val = (v, o = obj.value) => fmt(v, o)
const UNIT = { profit: tk("利润/天"), eph: "EPH", xp: tk("经验/小时") }
const valUnit = computed(() => t(UNIT[obj.value]))
const comp = keys => keys.map(roleName).join(" + ")
const rows = computed(() => result.value?.rows || [])

async function addToTeam(row) {
  await ElMessageBox.confirm(t("把这个配队的 {n} 个角色作为新角色加到队伍里（不勾选出战），可以在“队伍”页查看、模拟或继续优化技能和药品。", { n: row.configs.length }), t("加到队伍"), { type: "info" })
  const stampId = Date.now()
  row.configs.forEach((c, i) => {
    const m = clone(c)
    m.id = `comp-${stampId}-${i + 1}`
    m.name = `${t("配队")}${i + 1}·${roleName(c.build)}`
    delete m.build
    store.team.members.push(m)
  })
  await saveTeam()
  ElMessage.success(t("已加到队伍"))
}

function summary() {
  const r = result.value
  const lines = [t("【配队排行】{target}，{n} 人，全队预算 {b}（{time}）", { target: targetLabel(r.target), n: r.size, b: money(r.budget), time: stamp() })]
  rows.value.forEach((x, i) => {
    lines.push(t("{i}. {comp}：{unit} {v}，人均 {pv}，死亡 {d}/小时，装备 {c}", { i: i + 1, comp: comp(x.builds), unit: valUnit.value, v: val(x.value), pv: obj.value === "eph" ? "—" : val(x.value / r.size), d: x.mean.deathsPerHour.toFixed(2), c: money(x.cost) }))
    for (const m of x.members) lines.push("   " + t("{role}：{gear}", { role: roleName(m.build), gear: joinList(m.gear.map(g => `${itemName(g.h)} +${g.n}`)) }))
  })
  return lines.join("\n")
}
</script>

<template>
  <div class="page">
    <h2>{{ t("配队排行") }}</h2>
    <el-card>
      <p class="muted" style="margin-top: 0">
        {{ t("从零组一支队伍：给定地图、人数和全队的装备预算，比较各种职业搭配（水法、火法、自然法、自然奶、剑、锤、枪、弓、弩、盾），每种搭配用预算买它最划算的装备（预算可以平均分给每人，也可以让优化决定怎么分），按收益排行。") }}
        {{ t("每个角色都用下面的战斗等级和技能等级（所有房子都是下面的房子等级，可选全部成就，不算公会加成），技能和药品用这个职业的常见配置。装备只按价格（市场、镜子、精炼里最便宜的拿法）和属性价值挑，不看你手上已有的。") }}
        {{ t("先用模拟测出每种属性在这张图上对全队值多少，再在预算内挑总价值最高的装备组合；所有配队先粗筛，最好的几个再单独测、反复调整装备，最后长时间模拟确认。") }}
      </p>
      <div class="row" style="margin-bottom: 8px"><span class="muted" style="width: 70px">{{ t("目标") }}</span><TargetPicker v-model="target" :remember="false" /></div>
      <div class="row" style="margin-bottom: 8px"><ExtraBuffs v-model="extra" /></div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 70px">{{ t("人数") }}</span><el-input-number v-model="cfg.size" :min="1" :max="maxSize" size="small" style="width: 90px" />
        <span class="muted">{{ t("全队预算") }}</span><el-input-number v-model="cfg.budget" :min="0" :step="500" size="small" style="width: 140px" /><span class="muted">M</span>
        <el-tooltip :content="t('勾上后每人最多花全队预算 ÷ 人数；不勾时预算在队员之间怎么分也一起优化')" placement="top"><el-checkbox v-model="cfg.even" size="small">{{ t("平均分配") }}</el-checkbox></el-tooltip>
        <el-tooltip :content="t('按什么排名，也按它挑装备。EPH = 每小时打完的战斗次数（地下城是每小时通关次数）')" placement="top"><span class="muted">{{ t("排序") }}</span></el-tooltip>
        <el-radio-group v-model="cfg.objective" size="small">
          <el-radio-button value="profit">{{ t("日利润优先") }}</el-radio-button>
          <el-radio-button value="eph">{{ t("EPH 优先") }}</el-radio-button>
          <el-radio-button value="xp">{{ t("经验优先") }}</el-radio-button>
        </el-radio-group>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 70px">{{ t("可选职业") }}</span>
        <el-checkbox-group v-model="cfg.builds" size="small">
          <el-checkbox-button v-for="[k, n] in ROLES" :key="k" :value="k">{{ t(n) }}</el-checkbox-button>
        </el-checkbox-group>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 70px">{{ t("必须包含") }}</span>
        <el-select v-model="cfg.required" multiple size="small" style="width: 320px" :placeholder="t('不限')">
          <el-option v-for="[k, n] in ROLES" :key="k" :label="t(n)" :value="k" />
        </el-select>
        <span class="muted">{{ t("同一职业选两次可以要求两个") }}</span>
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 70px">{{ t("战斗等级") }}</span>
        <template v-for="[s, n] in COMBAT_SKILLS" :key="s">
          <span class="muted">{{ t(n) }}</span><el-input-number v-model="cfg.levels[s]" :min="1" :max="200" size="small" :controls="false" style="width: 60px" />
        </template>
        <span class="muted">{{ t("技能等级") }}</span><el-input-number v-model="cfg.abilityLevel" :min="1" :max="200" size="small" style="width: 100px" />
      </div>
      <div class="row" style="margin-bottom: 8px">
        <span class="muted" style="width: 70px">{{ t("房子等级") }}</span><el-input-number v-model="cfg.house" :min="0" :max="8" size="small" style="width: 90px" />
        <el-checkbox v-model="cfg.achievements" size="small">{{ t("全部成就") }}</el-checkbox>
      </div>
      <div class="row" style="margin: 8px 0 12px">
        <span class="muted">{{ t("精调前几名") }}</span><el-input-number v-model="cfg.top" :min="1" :max="12" size="small" style="width: 90px" />
        <span class="muted">{{ t("市场税") }}</span><el-input-number v-model="cfg.tax" :min="0" :max="20" :step="0.5" size="small" style="width: 100px" /><span class="muted">%</span>
        <span class="muted">{{ t("共 {n} 种配队", { n: count }) }}</span>
      </div>
      <JobRunner name="comp" type="comp" :params="params" @result="r => (result = r)" />
      <div v-if="rows.length" class="row" style="margin-top: 8px">
        <el-button size="small" @click="copyText(summary())">{{ t("复制文字") }}</el-button>
        <el-button size="small" @click="saveImage(out, `${t('配队排行')}-${fileStamp()}`)">{{ t("保存图片") }}</el-button>
      </div>
    </el-card>

    <el-card v-if="result && (rows.length || result.screen?.length)" ref="out">
      <div class="muted" style="margin-bottom: 6px">
        {{ targetLabel(result.target) }} · {{ t("{n} 人", { n: result.size }) }} · {{ t("全队预算 {b}", { b: money(result.budget) }) }}{{ result.even ? t("（平均分配）") : "" }} ·
        {{ t("战斗等级 {l}，技能 {a} 级，房子 {h} 级", { l: COMBAT_SKILLS.map(([s]) => result.levels[s]).join("/"), a: result.abilityLevel, h: result.house }) }}{{ result.achievements ? t("，全部成就") : "" }} ·
        {{ t("最后每个配队 {h} 小时 × {n} 次", { h: result.final.hours, n: result.final.seeds }) }}
      </div>
      <el-alert v-if="rows.length && rows[0].mean.deathsPerHour > 1" type="warning" show-icon :closable="false" style="margin-bottom: 8px"
        :title="t('最好的配队也一直在死：这张图对这个等级和预算太难，换低一点的难度或提高等级、预算再试')" />
      <el-table v-if="rows.length" :data="rows" size="small" :row-key="r => r.builds.join('+')">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding: 4px 16px">
              <div v-for="(m, i) in row.members" :key="i" style="margin-bottom: 10px">
                <div>
                  <b>{{ i + 1 }}. {{ roleName(m.build) }}</b>
                  <span class="muted"> · {{ t("装备 {c}", { c: money(m.cost) }) }} · {{ isXp ? t("经验/小时") : t("利润/天") }} {{ val(isXp ? m.metrics.xpPerHour : m.metrics.profitPerHour, isXp ? "xp" : "profit") }} · {{ t("死亡 {d}/小时", { d: (m.metrics.deathsPerHour || 0).toFixed(2) }) }}</span>
                </div>
                <div class="muted">{{ t("技能：") }}{{ joinList(m.abilities.map(abilityName)) }} · {{ t("饮料：") }}{{ joinList(m.drinks.map(itemName)) }}</div>
                <el-table :data="m.gear" size="small" style="max-width: 820px">
                  <el-table-column prop="slotName" :label="t('部位')" width="70" />
                  <el-table-column :label="t('装备')" min-width="180"><template #default="{ row: g }">{{ itemName(g.h) }} +{{ g.n }}</template></el-table-column>
                  <el-table-column :label="t('花费')" align="right" width="100"><template #default="{ row: g }">{{ money(g.cost) }}</template></el-table-column>
                  <el-table-column prop="how" :label="t('怎么拿')" min-width="200" />
                </el-table>
              </div>
              <el-button size="small" @click="addToTeam(row)">{{ t("加到队伍") }}</el-button>
            </div>
          </template>
        </el-table-column>
        <el-table-column type="index" width="40" />
        <el-table-column :label="t('配队')" min-width="220"><template #default="{ row }">{{ comp(row.builds) }}</template></el-table-column>
        <el-table-column :label="valUnit" align="right" min-width="120">
          <template #default="{ row }"><b>{{ val(row.value) }}</b> <span class="muted">{{ row.mean.ci?.[KEY[obj]] ? "±" + val(row.mean.ci[KEY[obj]]) : "" }}</span></template>
        </el-table-column>
        <el-table-column v-if="obj !== 'eph'" :label="t('人均')" align="right" width="100"><template #default="{ row }">{{ val(row.value / result.size) }}</template></el-table-column>
        <template v-for="o in ['profit', 'eph', 'xp'].filter(o => o !== obj)" :key="o">
          <el-table-column :label="t(UNIT[o])" align="right" width="100"><template #default="{ row }">{{ fmt(row.mean[KEY[o]], o) }}</template></el-table-column>
        </template>
        <el-table-column :label="t('死亡/小时')" align="right" width="90"><template #default="{ row }"><span :class="{ bad: row.mean.deathsPerHour > 0.05 }">{{ row.mean.deathsPerHour.toFixed(2) }}</span></template></el-table-column>
        <el-table-column :label="t('装备花费')" align="right" width="100"><template #default="{ row }">{{ money(row.cost) }}</template></el-table-column>
      </el-table>
      <el-collapse v-if="result.screen?.length" style="margin-top: 12px">
        <el-collapse-item :title="t('粗筛排行（前 {n} 个，{c} 种配队里；{h} 小时 × {s} 次，只作参考）', { n: result.screen.length, c: result.count, h: result.screenRun.hours, s: result.screenRun.seeds })">
          <el-table :data="result.screen" size="small">
            <el-table-column type="index" width="40" />
            <el-table-column :label="t('配队')" min-width="220"><template #default="{ row }">{{ comp(row.builds) }}</template></el-table-column>
            <el-table-column :label="valUnit" align="right" width="120"><template #default="{ row }">{{ val(row.value) }}</template></el-table-column>
            <el-table-column :label="t('死亡/小时')" align="right" width="90"><template #default="{ row }">{{ row.deaths.toFixed(2) }}</template></el-table-column>
            <el-table-column :label="t('装备花费')" align="right" width="100"><template #default="{ row }">{{ money(row.cost) }}</template></el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </el-card>
  </div>
</template>
