import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk"
import {
  type AgentEvent,
  applyAgentEvent,
  type Image,
  isWaiting,
  type RequestAnswer,
  type RequestPart,
  type Turn,
  TurnStarted,
} from "@glass/contracts"
import { NodeServices } from "@effect/platform-node"
import {
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import type { AgentAdapter, AgentSession } from "../src/agentHost/adapter"
import { claudeAdapter, type ClaudeSdk } from "../src/agentHost/claudeAdapter"
import { piAdapter } from "../src/agentHost/piAdapter"
import { AgentRunners } from "../src/agentRunners"
import { GlassMcpTools } from "../src/mcp/server"
import {
  type ConversationRole,
  GlobalRole,
  type ReviewBrief,
  type SkillSource,
  type TurnSettings,
  WorkRole,
} from "../src/agentHost/protocol"
import { bundledPi, bundledPiProgram } from "./demoAgent"
import { type FakeModelSettings, fakeModelProvider } from "./fakeModelProvider"
import { startFakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"
import { isolatedHome, startBackend, stubHome } from "./harness"
import { PI_MODEL, PI_PROVIDER, type PiSettings, writePiLogin, writePiSettings } from "./piLogin"
import { claudeLoginEnvironment, pinnedClaude, pinnedClaudeProgram } from "./pinnedClaude"
import { writeSentSkills } from "../src/agentHost/sentSkills"
import { recordingSessions, sessionTape } from "./sessionTape"

export const run = (tool: string, command: string, reply: string) =>
  `Use the ${tool} tool to run exactly \`${command}\` and nothing else, then reply with exactly: ${reply}`

export const runningTool = (name: string) => (turns: ReadonlyArray<Turn>) =>
  turns
    .at(-1)
    ?.parts.some(
      (part) =>
        Predicate.isTagged(part, "ToolCall") && part.name === name && part.status === "running",
    ) ?? false

export const lastTextOf = (turn: Turn | undefined) => {
  const text = turn?.parts.findLast((part) => Predicate.isTagged(part, "Text"))

  return Predicate.isTagged(text, "Text") ? text.text : ""
}

export const waiting = (turns: ReadonlyArray<Turn>) =>
  turns.at(-1)?.parts.findLast((part): part is RequestPart => isWaiting(part))

type Work = typeof WorkRole.Type

const drive = Effect.fnUntraced(function* <Role extends ConversationRole>(
  adapter: AgentAdapter<Role | Work>,
  tape: ReturnType<typeof sessionTape>,
  folder: string,
  defaults: Partial<TurnSettings> = {},
) {
  yield* Effect.addFinalizer(() => tape.finish)
  const turns = yield* SubscriptionRef.make<ReadonlyArray<Turn>>([])
  const events: Array<AgentEvent> = []
  let nextTurn = 0

  const report = (event: AgentEvent) =>
    Effect.sync(() => events.push(event)).pipe(
      Effect.andThen(SubscriptionRef.update(turns, (current) => applyAgentEvent(current, event))),
    )

  const until = (holds: (current: ReadonlyArray<Turn>) => boolean) =>
    SubscriptionRef.changes(turns).pipe(
      Stream.filter(holds),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.raceFirst(tape.mismatch),
    )

  const request = until((current) => waiting(current) !== undefined).pipe(
    Effect.map((current) => waiting(current)!),
  )

  const open = (conversation: string, role: Role | Work = WorkRole.make({})) =>
    adapter.start({ folder, conversation, role, skills: [], report }).pipe(
      Effect.map((session: AgentSession) => ({
        session,
        configure: (settings: Partial<TurnSettings>) =>
          session.configure({
            model: null,
            effort: null,
            permissionMode: null,
            ...defaults,
            ...settings,
          }),
        send: (message: string, images: ReadonlyArray<Image> = []) =>
          Effect.gen(function* () {
            const turnId = `turn-${++nextTurn}`
            const sentAt = yield* DateTime.now
            yield* report(
              TurnStarted.make({ turnId, message, images, context: null, feedback: [], sentAt }),
            )
            yield* session.startTurn(turnId, { message, images, context: null, prompt: message })

            return turnId
          }),
        steer: (message: string, images: ReadonlyArray<Image> = []) =>
          session.steer({ message, images, context: null, prompt: message }),
        answer: (requestId: string, answer: RequestAnswer) => session.answer(requestId, answer),
      })),
    )

  return { adapter, folder, events, turns: SubscriptionRef.get(turns), until, request, open }
})

export const reviewBrief: ReviewBrief = {
  instructions: "You answer a reviewer's questions about a pull request that changes greet.ts.",
  diffLines: { old: {}, new: { "greet.ts": [1, 2] } },
}

export const writeGreetSkill = (skills: string) =>
  Effect.sync(() => {
    mkdirSync(join(skills, "greet"), { recursive: true })
    writeFileSync(
      join(skills, "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets the user by name.\n---\n\nSay hello.\n",
    )
  })

export const writeGreetPack = (folder: string) =>
  writeSentSkills(folder, [greetPack]).pipe(Effect.provide(NodeServices.layer))

const greetPack: SkillSource = {
  name: "team",
  skills: [
    {
      name: "greet",
      files: [
        {
          path: "SKILL.md",
          executable: false,
          contents: new TextEncoder().encode(
            "---\nname: greet\ndescription: Greets the team by name.\n---\n\nSay hello to the team.\n",
          ),
        },
      ],
    },
  ],
}

export const writeGreeter = (folder: string) =>
  Effect.sync(() => writeFileSync(join(folder, "greet.ts"), "hi\nhello name\nbye\n"))

const WaitForRelease = Tool.make("wait_for_release", {
  description: "Waits until Glass releases it. Call it only when the user asks you to.",
  success: Schema.String,
})

const ReleaseTools = Toolkit.make(WaitForRelease)

/**
 * A backend serving Glass's tools, with one To-do and one PR, beside a tool that waits until the
 * test stops the Turn calling it. Its endpoint and credential reach recordings only by placeholder.
 */
export const glassToolsBackend = Effect.fnUntraced(function* (sessionId: string) {
  const github = yield* startFakeGitHub()

  github.seedPullRequest({
    owner: "acme",
    repo: "api",
    number: 42,
    title: "Greet by name",
    base: { sha: "b0", files: { "greet.ts": "hi\n" } },
    head: { sha: "h1", files: { "greet.ts": "hello name\n" } },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-hi\n+hello name",
      },
    ],
  })

  const waitStarted = yield* Deferred.make<void>()
  const waitInterrupted = yield* Deferred.make<void>()

  const tools = Layer.merge(
    GlassMcpTools,
    McpServer.toolkit(ReleaseTools).pipe(
      Layer.provide(
        ReleaseTools.toLayer({
          wait_for_release: () =>
            Deferred.succeed(waitStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(waitInterrupted, undefined)),
            ),
        }),
      ),
    ),
  )

  // The backend's home would hide the user's own logins from a session that records.
  const homes = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"].map(
    (name) => [name, process.env[name]] as const,
  )

  const { client, mcpCredentials } = yield* startBackend(
    { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
    yield* isolatedHome,
    AgentRunners.layer,
    tools,
  )

  for (const [name, value] of homes) vi.stubEnv(name, value)

  yield* client.AddToDo({ title: "Reply to Sam" })

  const url = yield* mcpCredentials.endpoint
  const bearer = yield* mcpCredentials.issue({ conversationId: "global-conversation", sessionId })

  return {
    role: GlobalRole.make({ tools: { url, bearer } }),
    places: { "<glass-tools-url>": url, "<glass-tools-bearer>": Redacted.value(bearer) },
    waitStarted: Deferred.await(waitStarted),
    waitInterrupted: Deferred.await(waitInterrupted),
  }
})

export const claudeSession = Effect.fnUntraced(function* (
  scenario: string,
  places: Readonly<Record<string, string>> = {},
) {
  const folder = yield* isolatedHome
  const tape = sessionTape(scenario, pinnedClaudeProgram(), { "<folder>": folder, ...places })

  if (recordingSessions)
    for (const [name, value] of Object.entries(claudeLoginEnvironment(folder)))
      vi.stubEnv(name, value)

  const sdk: ClaudeSdk = {
    query: (input) =>
      query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: tape.claude } }),
    getSessionInfo: (id, options) =>
      tape.sessionInfo(id, options?.dir, () => getSessionInfo(id, options)),
  }

  return yield* drive(claudeAdapter(pinnedClaude(), sdk), tape, folder, { model: "haiku" })
})

const PROVIDER_CREDENTIAL = /^(AWS|GOOGLE|GCLOUD|AZURE|ANTHROPIC)_|_(API_KEY|TOKEN)$/

const PI_LOGIN_FILES = ["auth.json", "models.json", "models-store.json"]

const CLOUD_LOGINS = {
  AWS_SHARED_CREDENTIALS_FILE: [".aws", "credentials"],
  AWS_CONFIG_FILE: [".aws", "config"],
  GOOGLE_APPLICATION_CREDENTIALS: [".config", "gcloud", "application_default_credentials.json"],
}

// pi may replace an OAuth refresh token while it runs, which voids the one in the real file.
const lendPiLogin = Effect.fnUntraced(function* (home: string, apiKey: string | undefined) {
  const real = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent")
  const lent = join(home, ".pi", "agent")

  for (const file of PI_LOGIN_FILES)
    if (existsSync(join(real, file))) copyFileSync(join(real, file), join(lent, file))

  for (const [name, path] of Object.entries(CLOUD_LOGINS))
    if (!process.env[name] && existsSync(join(homedir(), ...path)))
      vi.stubEnv(name, join(homedir(), ...path))

  if (apiKey !== undefined) {
    writePiLogin(home, PI_PROVIDER, apiKey)

    return
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      const before = join(real, "auth.json")
      const after = join(lent, "auth.json")

      if (
        existsSync(after) &&
        (!existsSync(before) || readFileSync(before, "utf8") !== readFileSync(after, "utf8"))
      )
        copyFileSync(after, before)
    }),
  )
})

interface PiSessionOptions {
  readonly piSettings?: PiSettings
  readonly fake?: FakeModelSettings
  readonly apiKey?: string
  readonly places?: Readonly<Record<string, string>>
}

export const piSession = Effect.fnUntraced(function* (
  scenario: string,
  { piSettings = { retry: { enabled: false } }, fake, apiKey, places = {} }: PiSessionOptions = {},
) {
  const home = yield* isolatedHome
  const folder = join(home, "work")
  mkdirSync(folder)

  if (fake !== undefined) {
    yield* fakeModelProvider(home, fake, piSettings)

    for (const name of Object.keys(process.env))
      if (PROVIDER_CREDENTIAL.test(name)) vi.stubEnv(name, "")
  } else {
    writePiSettings(home, PI_PROVIDER, PI_MODEL, piSettings)

    if (recordingSessions) yield* lendPiLogin(home, apiKey)
  }

  // pi reads the user's `~/.agents/skills`, which would put the machine in the recording.
  stubHome(home)
  vi.stubEnv("PI_OFFLINE", "1")

  const tape = sessionTape(scenario, bundledPiProgram(), {
    "<folder>": folder,
    "<pi-home>": home,
    "<pi-model>": PI_MODEL,
    "<pi-provider>": PI_PROVIDER,
    ...places,
  })

  const adapter = yield* piAdapter(bundledPi).pipe(
    Effect.provide(tape.spawner.pipe(Layer.provide(NodeServices.layer))),
    Effect.provide(NodeServices.layer),
  )

  const extension = (name: string, source: string) =>
    Effect.sync(() => {
      const extensions = join(home, ".pi", "agent", "extensions")
      mkdirSync(extensions, { recursive: true })
      writeFileSync(join(extensions, name), source)
    })

  return { ...(yield* drive(adapter, tape, folder)), home, extension }
})
