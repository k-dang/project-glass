import { NodeSocket } from "@effect/platform-node"
import { ConfigProvider, Context, Duration, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ASK_TIMEOUT_SECONDS, OutsideQuestions } from "../src/OutsideQuestions"
import { GlassMcpTools } from "../src/mcp/server"
import { serve } from "../src/server"
import { ServerConfig } from "../src/ServerConfig"
import { runMain, wideEventsToStdout } from "../src/wideEvents"
import { writeAgentCommands } from "./agentCommands"
import { bundledPi, seedDemoAgent, startDemoClaude, startDemoPi } from "./demoAgent"
import { DEMO_GATEWAY_REPOSITORY, DEMO_REPOSITORY, seedDemoPullRequests } from "./demoPullRequests"
import { startFakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"
import { fakeAgentRunners } from "./fakeAgentRunners"
import { FAKE_PI_MODEL } from "./fakeModelProvider"
import { installFakeSandboxProvider } from "./fakeSandboxProvider"

const seedDemoSettings = (dataDirectory: string) => {
  const settings = join(dataDirectory, "settings.json")

  if (existsSync(settings)) return

  mkdirSync(dirname(settings), { recursive: true })
  writeFileSync(
    settings,
    JSON.stringify({
      followedRepositories: [DEMO_REPOSITORY, DEMO_GATEWAY_REPOSITORY],
      agentReviewModels: { pi: FAKE_PI_MODEL },
    }),
  )
}

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
    }),
  )

  const config = yield* ServerConfig.pipe(
    Effect.provide(ServerConfig.layer),
    Effect.provide(configured),
  )

  const demo = join(config.dataDirectory, "demo")
  yield* startDemoPi(join(demo, "pi"))

  github.seedBranches(DEMO_REPOSITORY, { defaultBranch: "main", branches: ["main", "develop"] })

  github.pushRepository({ owner: DEMO_REPOSITORY.owner, repo: "skills" }, "main", {
    "team/architect/SKILL.md":
      "---\nname: architect\ndescription: Shape a design before writing code.\n---\n\nSketch the modules first.\n",
    "team/reviewer/SKILL.md":
      "---\nname: reviewer\ndescription: Review a change for bugs and gaps.\n---\n\nRead the diff twice.\n",
  })

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

  seedDemoSettings(config.dataDirectory)
  writeAgentCommands(config.dataDirectory, { claudeCommand, piCommand: bundledPi })

  const running = yield* Layer.build(
    serve(fakeAgentRunners, GlassMcpTools).pipe(
      Layer.provide(ServerConfig.layer),
      Layer.provide(configured),
    ),
  )

  yield* Context.get(running, OutsideQuestions)
    .ask({
      question: "Ship the retry change?",
      choices: ["Ship it", "Hold it"],
      session: "demo-session",
      askedBy: "Claude Code",
      timeout: Duration.seconds(ASK_TIMEOUT_SECONDS),
    })
    .pipe(Effect.forkScoped)

  yield* seedDemoAgent(config.port, Redacted.value(config.token), join(demo, "repositories")).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Couldn't start the demo Agent", cause)),
  )

  return yield* Effect.never
})

main.pipe(
  Effect.provide(NodeSocket.layerWebSocketConstructor),
  Effect.scoped,
  runMain(wideEventsToStdout("backend").pipe(Layer.provide(FetchHttpClient.layer))),
)
