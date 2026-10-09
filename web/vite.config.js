import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import vue from "@vitejs/plugin-vue"

// short commit shown next to the version (empty outside a git checkout)
let commit = ""
try {
  commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
} catch {}

// "./": works from any path (static hosting); @app: the shared logic in ../node/app
export default defineConfig({
  base: "./",
  plugins: [vue()],
  define: { __COMMIT__: JSON.stringify(commit) },
  resolve: { alias: { "@app": fileURLToPath(new URL("../node/app", import.meta.url)) } },
  worker: { format: "es" },
  server: { proxy: { "/api": "http://127.0.0.1:8765" }, fs: { allow: [".."] } },
  build: { chunkSizeWarningLimit: 2000 },
})
