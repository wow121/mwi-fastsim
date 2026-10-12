// Sharing results: copy a plain-text summary, or save a part of the page as a PNG.
import { ElMessage, ElMessageBox } from "element-plus"
import { h } from "vue"

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // http pages without clipboard access: fall back to a hidden textarea
    const ta = Object.assign(document.createElement("textarea"), { value: text })
    ta.style.cssText = "position:fixed;left:-9999px"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    ta.remove()
    // no clipboard at all: show the text to copy by hand
    if (!ok) return ElMessageBox({ title: "复制下面的文字", message: h("textarea", { value: text, readonly: true, rows: 12, style: "width: 100%; font-size: 12px" }), customStyle: { maxWidth: "720px", width: "90%" } }).catch(() => {})
  }
  ElMessage.success("已复制")
}

/** `el`: an element or a component (its root element is used). */
export async function saveImage(el, name) {
  el = el?.$el || el
  if (!el) return
  const { toPng } = await import("html-to-image")
  try {
    const url = await toPng(el, { pixelRatio: 2, backgroundColor: getComputedStyle(document.body).backgroundColor || "#fff" })
    Object.assign(document.createElement("a"), { href: url, download: `${name}.png` }).click()
  } catch (e) {
    ElMessage.error(`保存图片失败：${e.message || e}`)
  }
}

const pad = n => String(n).padStart(2, "0")
/** Local time, "2026-10-12 06:49". */
export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** For file names, "20261012-0649". */
export const fileStamp = () => stamp().replace(/-/g, "").replace(" ", "-").replace(":", "")
