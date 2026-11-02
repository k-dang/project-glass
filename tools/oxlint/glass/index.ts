import { definePlugin } from "vite-plus/lint/plugins"
import { architecture } from "./architecture.ts"
import { testWaits } from "./test-waits.ts"

export default definePlugin({
  meta: { name: "glass" },
  rules: { architecture, "test-waits": testWaits },
})
