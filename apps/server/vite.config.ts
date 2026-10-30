import { createRequire } from "node:module"
import { dirname } from "node:path"
import { defineConfig } from "vite-plus"

// pnpm resolves @effect/vitest to a different vitest copy than vp test.
const vitest = dirname(
  createRequire(import.meta.resolve("vite-plus")).resolve("vitest/package.json"),
)

const node = {
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  deps: { onlyBundle: false },
} as const

export default defineConfig({
  pack: [
    {
      ...node,
      entry: { bin: "src/bin.ts", piWorker: "src/piWorker.ts", agentHost: "src/agentHost.ts" },
      outDir: "dist",
    },
    // `pnpm dev:fake`'s backend, kept out of `dist` so it never ships.
    {
      ...node,
      entry: { fakeBackend: "test/fakeBackend.ts", agentHost: "src/agentHost.ts" },
      outDir: "dist-fake",
    },
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    globalSetup: ["test/buildBundles.ts"],
    alias: { vitest },
    server: { deps: { inline: ["@effect/vitest"] } },
  },
})
