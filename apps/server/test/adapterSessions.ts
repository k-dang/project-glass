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
import { DateTime, Effect, Layer, Option, Stream, SubscriptionRef } from "effect"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import type { AgentAdapter, AgentSession } from "../src/agentHost/adapter"
import { claudeAdapter, type ClaudeSdk } from "../src/agentHost/claudeAdapter"
import { piAdapter } from "../src/agentHost/piAdapter"
import type { ReviewBrief, TurnSettings } from "../src/agentHost/protocol"
import { bundledPi, bundledPiProgram } from "./demoAgent"
import { type FakeModelSettings, fakeModelProvider } from "./fakeModelProvider"
import { isolatedHome, stubHome } from "./harness"
import { PI_MODEL, PI_PROVIDER, type PiSettings, writePiLogin, writePiSettings } from "./piLogin"
import { claudeLoginEnvironment, pinnedClaude, pinnedClaudeProgram } from "./pinnedClaude"
import { recordingSessions, sessionTape } from "./sessionTape"

export const run = (tool: string, command: string, reply: string) =>
  `Use the ${tool} tool to run exactly \`${command}\` and nothing else, then reply with exactly: ${reply}`

export const waiting = (turns: ReadonlyArray<Turn>) =>
  turns.at(-1)?.parts.findLast((part): part is RequestPart => isWaiting(part))

const drive = Effect.fnUntraced(function* (
  adapter: AgentAdapter,
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

  const open = (conversation: string, review: ReviewBrief | null = null) =>
    adapter.start({ folder, conversation, review, report }).pipe(
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
            yield* report(TurnStarted.make({ turnId, message, images, sentAt }))
            yield* session.startTurn(turnId, { message, images, prompt: message })

            return turnId
          }),
        steer: (message: string, images: ReadonlyArray<Image> = []) =>
          session.steer({ message, images, prompt: message }),
        answer: (requestId: string, answer: RequestAnswer) => session.answer(requestId, answer),
      })),
    )

  return { adapter, folder, events, turns: SubscriptionRef.get(turns), until, request, open }
})

export const reviewBrief: ReviewBrief = {
  instructions: "You answer a reviewer's questions about a pull request that changes greet.ts.",
  diffLines: { old: {}, new: { "greet.ts": [1, 2] } },
}

/** Writes a skill named `greet` into the `skills` folder an agent program reads. */
export const writeGreetSkill = (skills: string) =>
  Effect.sync(() => {
    mkdirSync(join(skills, "greet"), { recursive: true })
    writeFileSync(
      join(skills, "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets the user by name.\n---\n\nSay hello.\n",
    )
  })

export const writeGreeter = (folder: string) =>
  Effect.sync(() => writeFileSync(join(folder, "greet.ts"), "hi\nhello name\nbye\n"))

export const claudeSession = Effect.fnUntraced(function* (scenario: string) {
  const folder = yield* isolatedHome
  const tape = sessionTape(scenario, pinnedClaudeProgram(), { "<folder>": folder })

  if (recordingSessions)
    for (const [name, value] of Object.entries(claudeLoginEnvironment(folder)))
      vi.stubEnv(name, value)

  const sdk: ClaudeSdk = {
    query: (input) =>
      query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: tape.claude } }),
    getSessionInfo: (id, options) =>
      tape.sessionInfo(id, options?.dir, () => getSessionInfo(id, options)),
  }

  // Claude Code's own default model, which `null` picks, costs more than Haiku to record.
  return yield* drive(claudeAdapter(pinnedClaude(), sdk), tape, folder, { model: "haiku" })
})

const PROVIDER_CREDENTIAL = /^(AWS|GOOGLE|GCLOUD|AZURE|ANTHROPIC)_|_(API_KEY|TOKEN)$/

const PI_LOGIN_FILES = ["auth.json", "models.json", "models-store.json"]

const CLOUD_LOGINS = {
  AWS_SHARED_CREDENTIALS_FILE: [".aws", "credentials"],
  AWS_CONFIG_FILE: [".aws", "config"],
  GOOGLE_APPLICATION_CREDENTIALS: [".config", "gcloud", "application_default_credentials.json"],
}

/**
 * Lends the recorder's own pi login to an isolated home, or a given API key in its place. pi may
 * replace an OAuth refresh token while it runs, which voids the one in the real file, so the
 * lent `auth.json` is copied back when the session ends.
 */
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
}

export const piSession = Effect.fnUntraced(function* (
  scenario: string,
  { piSettings = { retry: { enabled: false } }, fake, apiKey }: PiSessionOptions = {},
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
