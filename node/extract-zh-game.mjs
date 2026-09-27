// Extracts the game's own Chinese name tables (the zh resource of the game client: itemNames,
// monsterNames, actionNames, ...) from a script that embeds them, and writes app/zh-game.mjs.
//   node extract-zh-game.mjs <script.js> [more.js ...]
// The tables are found by their names ("monsterNames: {" ...), so any bundle or userscript that
// carries the game's zh resource works (e.g. the MWI profit panel userscript). Later files only
// fill names the earlier ones lack; the labyrinth monsters come from the MWI labyrinth
// userscript's LABYRINTH_MONSTER_NAME_ZH_MAP.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const CATEGORIES = [
  "gameModeNames", "skillNames", "abilityNames", "itemNames", "itemCategoryNames", "equipmentTypeNames", "combatStyleNames",
  "damageTypeNames", "monsterNames", "combatTriggerDependencyNames", "combatTriggerConditionNames", "combatTriggerComparatorNames",
  "actionNames", "actionTypeNames", "actionCategoryNames", "buffTypeNames", "houseRoomNames", "communityBuffTypeNames",
]
// other names of the same tables in other scripts
const ALIASES = { LABYRINTH_MONSTER_NAME_ZH_MAP: "monsterNames" }

const files = process.argv.slice(2)
if (!files.length) {
  console.error("usage: node extract-zh-game.mjs <script.js> [more.js ...]")
  process.exit(1)
}

/** Body of `name: { ... }` / `name = { ... }` (string-aware brace matching), or null. */
function block(s, name) {
  const at = s.search(new RegExp(`[\\s,{]${name}\\s*[:=]\\s*\\{`))
  if (at < 0) return null
  let i = s.indexOf("{", at) + 1
  const begin = i
  let depth = 1
  while (depth) {
    const c = s[i]
    if (c === '"' || c === "'") {
      i++
      while (s[i] !== c) i += s[i] === "\\" ? 2 : 1
    } else if (c === "{") depth++
    else if (c === "}") depth--
    i++
  }
  return s.slice(begin, i - 1)
}

function entries(body) {
  const t = {}
  for (const m of body.matchAll(/(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))\s*:\s*"((?:[^"\\]|\\.)*)"/g)) t[m[1] != null ? JSON.parse(`"${m[1]}"`) : m[2]] = JSON.parse(`"${m[3]}"`)
  return t
}

const out = Object.fromEntries(CATEGORIES.map(c => [c, {}]))
for (const f of files) {
  const s = fs.readFileSync(f, "utf8")
  for (const [name, c] of [...CATEGORIES.map(c => [c, c]), ...Object.entries(ALIASES)]) {
    const body = block(s, name)
    if (body == null) continue
    const t = entries(body)
    let added = 0
    for (const [k, v] of Object.entries(t)) if (!(k in out[c])) { out[c][k] = v; added++ }
    console.log(`${path.basename(f)} ${name}: ${added} added`)
  }
}
for (const c of CATEGORIES) if (!Object.keys(out[c]).length) throw new Error(`${c} not found in any file`)
const here = path.dirname(fileURLToPath(import.meta.url))
fs.writeFileSync(path.join(here, "app", "zh-game.mjs"), `// The game's own Chinese names by hrid, extracted by node/extract-zh-game.mjs.\nexport default ${JSON.stringify(out)}\n`)
