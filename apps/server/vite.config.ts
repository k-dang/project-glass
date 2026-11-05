import { defineConfig } from "vite-plus"

const node = {
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  deps: { onlyBundle: false },
} as const

const agentHost = (
  outDir: string,
  entry: Record<string, string> = { agentHost: "src/agentHost.ts" },
) =>
  ({
    ...node,
    entry,
    outDir,
    outputOptions: { codeSplitting: false },
  }) as const

export default defineConfig({
  pack: [
    {
      ...node,
      entry: { bin: "src/bin.ts", sqlReadWorker: "src/sqlReadWorker.ts" },
      outDir: "dist",
    },
    agentHost("dist"),
    {
      ...node,
      entry: { fakeBackend: "test/fakeBackend.ts", sqlReadWorker: "src/sqlReadWorker.ts" },
      outDir: "dist-fake",
      // It reads ../schema.json relative to its own module, which breaks once bundled.
      deps: { ...node.deps, neverBundle: ["@octokit/graphql-schema"] },
    },
    agentHost("dist-fake"),
    ...(process.env["GLASS_PACK_TEST_HOST"] === "1"
      ? [agentHost("dist-test", { scriptedAgentHost: "test/scriptedAgentHost.ts" })]
      : []),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    silent: "passed-only",
    globalSetup: ["test/buildBundles.ts"],
  },
})
