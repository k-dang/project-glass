import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"
import { Rolldown } from "vite-plus/pack"

// WARNING: playwright-core reads its own files, such as browsers.json, relative to its package, which breaks once bundled.
const unbundled: Array<string> = ["playwright-core"]

const node = {
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  deps: { onlyBundle: false, neverBundle: unbundled },
} as const

const piExtensions = new Map([
  ["virtual:pi-draw-diagram", "src/agentHost/piDrawDiagram.ts"],
  ["virtual:pi-review-tools", "src/agentHost/piReviewTools.ts"],
])

const piExtensionSources = {
  name: "pi-extension-sources",
  resolveId: (id: string) => (piExtensions.has(id) ? `\0${id}` : null),
  load: async (id: string) => {
    const entry = id.startsWith("\0") ? piExtensions.get(id.slice(1)) : undefined

    if (entry === undefined) return null

    const { output } = await Rolldown.build({
      input: fileURLToPath(new URL(entry, import.meta.url)),
      platform: "node",
      write: false,
      output: { format: "esm", codeSplitting: false },
    })

    return `export default ${JSON.stringify(output[0].code)}`
  },
}

const agentHost = (
  outDir: string,
  entry: Record<string, string> = { agentHost: "src/agentHost.ts" },
) => ({
  ...node,
  entry,
  outDir,
  outputOptions: { codeSplitting: false } as const,
  plugins: [piExtensionSources],
})

const backend = process.env["GLASS_PACK_BACKEND"]

export default defineConfig({
  pack: [
    ...(backend === "fake"
      ? []
      : [
          {
            ...node,
            entry: { bin: "src/bin.ts", sqlReadWorker: "src/sqlReadWorker.ts" },
            outDir: "dist",
          },
          agentHost("dist"),
        ]),
    ...(backend === "real"
      ? []
      : [
          {
            ...node,
            entry: {
              fakeBackend: "test/fakeBackend.ts",
              fakeSandboxProvider: "test/fakeSandboxProvider.ts",
              sqlReadWorker: "src/sqlReadWorker.ts",
            },
            outDir: "dist-fake",
            // WARNING: @octokit/graphql-schema reads ../schema.json relative to its own module, which breaks once bundled.
            deps: { ...node.deps, neverBundle: [...unbundled, "@octokit/graphql-schema"] },
          },
          agentHost("dist-fake"),
        ]),
    ...(process.env["GLASS_PACK_TEST_HOST"] === "1"
      ? [agentHost("dist-test", { scriptedAgentHost: "test/scriptedAgentHost.ts" })]
      : []),
  ],
  plugins: [piExtensionSources],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    sequence: { shuffle: true },
    silent: "passed-only",
    globalSetup: ["test/buildBundles.ts", "test/isolateHome.ts"],
  },
})
