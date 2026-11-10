// The page's language: a reactive copy of the shared setting in @app/lang.mjs (which the browser
// build's app logic reads directly, and the local server gets through PUT /api/lang).
// Use `t("<Chinese text>", { vars })` everywhere in the UI; templates re-render when the language changes.
import { ref } from "vue"
import { joinList as joinCore, setLang, t as tCore } from "@app/lang.mjs"
export { tk } from "@app/lang.mjs"

const KEY = "fastsim-lang"
function initial() {
  try {
    const v = localStorage.getItem(KEY)
    if (v === "zh" || v === "en") return v
  } catch {}
  return /^zh\b/i.test(navigator.language || "") ? "zh" : "en"
}

export const lang = ref(initial())
setLang(lang.value)
document.documentElement.lang = lang.value === "en" ? "en" : "zh-CN"

/** Translated text; reading `lang` makes templates and computeds track the language. */
export function t(key, vars) {
  void lang.value
  return tCore(key, vars)
}
export function joinList(a) {
  void lang.value
  return joinCore(a)
}
export const isEn = () => lang.value === "en"
/** Date / time in the UI language (not the system's). */
const locale = () => (lang.value === "en" ? "en-US" : "zh-CN")
export const dateTime = ms => new Date(ms).toLocaleString(locale())
export const timeOnly = ms => new Date(ms).toLocaleTimeString(locale())

/** Switches the local copy; the caller tells the backend and reloads names (api.js changeLang). */
export function applyLang(v) {
  lang.value = v === "en" ? "en" : "zh"
  setLang(lang.value)
  document.documentElement.lang = lang.value === "en" ? "en" : "zh-CN"
  try {
    localStorage.setItem(KEY, lang.value)
  } catch {}
}
