import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"
import { Rolldown } from "vite-plus/pack"

const node = {
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  deps: { onlyBundle: false },
} as const

const PI_DRAW_DIAGRAM = "virtual:pi-draw-diagram"

/**
 * A Sandbox gets the agent host as one file, so the host carries pi's Diagram extension as text,
 * built here with Pele and the rest of its imports, and writes it out for pi.
 */
const piDrawDiagram = {
  name: "pi-draw-diagram",
  resolveId: (id: string) => (id === PI_DRAW_DIAGRAM ? `\0${PI_DRAW_DIAGRAM}` : null),
  load: async (id: string) => {
    if (id !== `\0${PI_DRAW_DIAGRAM}`) return null

    const { output } = await Rolldown.build({
      input: fileURLToPath(new URL("src/agentHost/piDrawDiagram.ts", import.meta.url)),
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
  plugins: [piDrawDiagram],
})

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
  plugins: [piDrawDiagram],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    silent: "passed-only",
    globalSetup: ["test/buildBundles.ts"],
  },
})
