import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"
import type { UserConfig } from "vite-plus/pack"

// Sandboxed preloads can't load other files, including shared chunks.
const bundle = (name: string): UserConfig => ({
  entry: { index: `src/${name}/index.ts` },
  format: "cjs",
  platform: "node",
  target: "node24",
  outDir: `dist/${name}`,
  clean: false,
  sourcemap: true,
  // Sandboxed preloads must be CommonJS.
  checks: { legacyCjs: false },
  deps: { neverBundle: ["electron"], onlyBundle: false },
})

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
  server: { host: "127.0.0.1", strictPort: true },
  build: { outDir: "dist/renderer", sourcemap: true },
  pack: [bundle("main"), bundle("preload")],
  test: { include: ["src/**/*.test.{ts,tsx}"] },
})
