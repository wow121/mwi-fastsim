// Summarizes headless-browser page dumps: visible text and console errors per page.
import fs from "node:fs"
import path from "node:path"
const dir = process.argv[2]
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".html"))) {
  const r = f.replace(".html", "")
  const html = fs.readFileSync(path.join(dir, f), "utf8")
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
  const main = text.slice(text.indexOf("任务") + 2)
  console.log(`== ${r}: ${text.length} chars :: ${main.slice(0, 200)}`)
  const err = fs.existsSync(path.join(dir, `${r}.err`)) ? fs.readFileSync(path.join(dir, `${r}.err`), "utf8") : ""
  for (const l of err.split("\n").filter(l => /CONSOLE|Uncaught/.test(l)).slice(0, 4)) console.log("   ERR", l.slice(0, 300))
}
