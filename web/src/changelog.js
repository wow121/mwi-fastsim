// Version and release notes, read from the repository's CHANGELOG.md at build time.
import raw from "../../CHANGELOG.md?raw"

/** [{ version, date, items: [text] }], newest first. */
export const releases = raw.split(/^## /m).slice(1).map(block => {
  const [head, ...lines] = block.split("\n")
  const [, version = head.trim(), date = ""] = /^(v[\w.-]+)\s*[—-]\s*(.*)$/.exec(head.trim()) || []
  return { version, date: date.trim(), items: lines.filter(l => l.startsWith("- ")).map(l => l.slice(2).trim()) }
})

export const version = releases[0]?.version || "dev"
// short commit of the build (vite.config.js), "" when git was not available
export const commit = typeof __COMMIT__ === "string" ? __COMMIT__ : ""
