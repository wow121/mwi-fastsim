// UI language ("zh" | "en"), shared by the local server and the browser build.
//
// The Chinese text is the key: write `t("开始优化")` or, with values, `t("已导入 {n} 人", { n })`.
// The same Chinese word that needs different English in different places gets a context suffix:
// `t("刷新#market")` shows "刷新" in Chinese and looks up "刷新#market" in English.
// A key stored in a table and translated where it is shown is marked `tk("队伍")` (returns the key).
// In Chinese mode the key itself is shown (placeholders filled); in English mode the key is looked up
// in the English dictionaries under ./locales/en/ (one file per area, merged here). A key missing from
// them falls back to the Chinese text, so an untranslated string shows up as Chinese, never blank.
// `node node/check-i18n.mjs` lists t() keys without a translation and Chinese literals not wrapped in t().
//
// The language is one global setting (single-user tool): the page sets it on load and when the user
// switches (server mode: PUT /api/lang). Job results keep the language they were computed in.
import en from "./locales/en/index.mjs"

let lang = "zh"
const listeners = new Set()

export const LANGS = ["zh", "en"]
export const getLang = () => lang
export function setLang(l) {
  const v = l === "en" ? "en" : "zh"
  if (v === lang) return lang
  lang = v
  for (const f of listeners) f(lang)
  return lang
}
export function onLangChange(f) {
  listeners.add(f)
  return () => listeners.delete(f)
}

const CTX = /#[\w-]+$/
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m)) : s)

/** Translated text of the Chinese `key`, with `{name}` placeholders filled from `vars`. */
export function t(key, vars) {
  if (lang === "en") {
    const s = en[key]
    if (s !== undefined) return fill(s, vars)
  }
  return fill(key.replace(CTX, ""), vars)
}

/** Marks a Chinese key to be translated later with t() (e.g. in a table of labels); returns it as is. */
export const tk = key => key

/** Joins a list the way the language does ("、" in Chinese, ", " in English). */
export const joinList = a => a.join(lang === "en" ? ", " : "、")
/** Separator between clauses ("；" / "; "), and the colon ("：" / ": "). */
export const SEP = () => (lang === "en" ? "; " : "；")
export const COLON = () => (lang === "en" ? ": " : "：")

export const enDict = en
