import { defineConfig } from "vite"
import { fileURLToPath } from "node:url"
import vue from "@vitejs/plugin-vue"

// "./": works from any path (static hosting); @app: the shared logic in ../node/app
export default defineConfig({
  base: "./",
  plugins: [vue()],
  resolve: { alias: { "@app": fileURLToPath(new URL("../node/app", import.meta.url)) } },
  worker: { format: "es" },
  server: { proxy: { "/api": "http://127.0.0.1:8765" }, fs: { allow: [".."] } },
  build: { chunkSizeWarningLimit: 2000 },
})
