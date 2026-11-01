import { NodeRuntime, NodeSocket } from "@effect/platform-node"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "../src/server"
import { ServerConfig } from "../src/ServerConfig"
import { bundledPi, seedDemoAgent, startDemoClaude, startDemoPi } from "./demoAgent"
import { DEMO_REPOSITORY, seedDemoPullRequests } from "./demoPullRequests"
import { startFakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"
import { fakeAgentRunners } from "./fakeAgentRunners"
import { installFakeSandboxProvider } from "./fakeSandboxProvider"

/** Follows the demo repository on first launch; later launches keep the user's choices. */
const followDemoRepository = Effect.gen(function* () {
  const { dataDirectory } = yield* ServerConfig
  const settings = join(dataDirectory, "settings.json")

  if (existsSync(settings)) return

  mkdirSync(dirname(settings), { recursive: true })
  writeFileSync(settings, JSON.stringify({ followedRepositories: [DEMO_REPOSITORY] }))
})

/**
 * The backend `pnpm dev:fake` runs: signed in to the tests' fake GitHub, seeded with demo PRs
 * whose commits it also serves over git, and writing Tours without a model. The fake GitHub
 * starts fresh with each backend.
 */
const main = Effect.gen(function* () {
  const github = yield* startFakeGitHub({ git: true })
  seedDemoPullRequests(github)

  const claudeDirectory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "glass-fake-claude-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )

  const claudeCommand = yield* startDemoClaude(claudeDirectory)

  const configured = ConfigProvider.layer(
    ConfigProvider.fromEnvRecord({
      ...process.env,
      GH_TOKEN: VIEWER.token,
      GLASS_GITHUB_API_URL: github.url,
      GLASS_GIT_REMOTE: github.gitUrl,
      GLASS_PI_COMMAND: bundledPi,
      GLASS_CLAUDE_COMMAND: claudeCommand,
    }),
  )

  const config = yield* ServerConfig.pipe(
    Effect.provide(ServerConfig.layer),
    Effect.provide(configured),
  )

  const demo = join(config.dataDirectory, "demo")
  yield* startDemoPi(join(demo, "pi"))

  github.seedBranches(DEMO_REPOSITORY, { defaultBranch: "main", branches: ["main", "develop"] })

  installFakeSandboxProvider(
    dirname(config.dataDirectory),
    {
      root: join(demo, "sandboxes"),
      cloneFrom: join(demo, "repositories", `${DEMO_REPOSITORY.repo}-origin.git`),
      piCommand: bundledPi,
      claudeCommand,
    },
    fileURLToPath(new URL("../test/fakeSandboxProvider.ts", import.meta.url)),
  )

  yield* Layer.build(
    serve(fakeAgentRunners).pipe(
      Layer.provide(Layer.effectDiscard(followDemoRepository)),
      Layer.provide(ServerConfig.layer),
      Layer.provide(configured),
    ),
  )

  yield* seedDemoAgent(config.port, Redacted.value(config.token), join(demo, "repositories")).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Couldn't start the demo Agent", cause)),
  )

  return yield* Effect.never
})

main.pipe(Effect.provide(NodeSocket.layerWebSocketConstructor), Effect.scoped, NodeRuntime.runMain)
