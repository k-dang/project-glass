import react from "@vitejs/plugin-react"
import { defineConfig } from "vite-plus"

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
