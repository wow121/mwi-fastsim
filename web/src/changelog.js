// Version and release notes, read from the repository's CHANGELOG.md at build time.
import raw from "../../CHANGELOG.md?raw"

/** [{ version, date, intro: [text], items: [{ text, sub: [text] }] }], newest first. Paragraphs before the
 *  first item are the intro; indented "  - " lines are sub-items of the item above them. */
export const releases = raw.split(/^## /m).slice(1).map(block => {
  const [head, ...lines] = block.split("\n")
  const [, version = head.trim(), date = ""] = /^(v[\w.-]+)\s*[—-]\s*(.*)$/.exec(head.trim()) || []
  const intro = []
  const items = []
  for (const l of lines) {
    if (l.startsWith("- ")) items.push({ text: l.slice(2).trim(), sub: [] })
    else if (/^\s+- /.test(l) && items.length) items.at(-1).sub.push(l.replace(/^\s+- /, "").trim())
    else if (l.trim() && !items.length) intro.push(l.trim())
  }
  return { version, date: date.trim(), intro, items }
})

export const version = releases[0]?.version || "dev"
// short commit of the build (vite.config.js), "" when git was not available
export const commit = typeof __COMMIT__ === "string" ? __COMMIT__ : ""
