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

/**
 * A Sandbox gets the agent host as one file, so the host carries pi's extensions that call Glass's
 * own code as text, each built here with its imports, and writes them out for pi.
 */
const piExtensions = new Map([
  ["virtual:pi-draw-diagram", "src/agentHost/piDrawDiagram.ts"],
  ["virtual:pi-suggest-draft", "src/agentHost/piSuggestDraft.ts"],
])

const built = new Map<string, Promise<string>>()

const buildPiExtension = (entry: string) =>
  Rolldown.build({
    input: fileURLToPath(new URL(entry, import.meta.url)),
    platform: "node",
    write: false,
    output: { format: "esm", codeSplitting: false },
  }).then(({ output }) => `export default ${JSON.stringify(output[0].code)}`)

const piExtensionSources = {
  name: "pi-extension-sources",
  resolveId: (id: string) => (piExtensions.has(id) ? `\0${id}` : null),
  load: (id: string) => {
    const entry = id.startsWith("\0") ? piExtensions.get(id.slice(1)) : undefined

    if (entry === undefined) return null

    const source = built.get(entry) ?? buildPiExtension(entry)

    built.set(entry, source)

    return source
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
  plugins: [piExtensionSources],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    silent: "passed-only",
    globalSetup: ["test/buildBundles.ts"],
  },
})
