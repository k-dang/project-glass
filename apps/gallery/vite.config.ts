import react from "@vitejs/plugin-react"
import { defineConfig } from "vite-plus"

// Fixed names, so page.ts can find the bundle to inline.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    modulePreload: false,
    rolldownOptions: {
      input: "viewer/main.tsx",
      output: { entryFileNames: "viewer.js", assetFileNames: "viewer[extname]" },
    },
  },
})
