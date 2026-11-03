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
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import type { AgentAdapter, AgentSession } from "../src/agentHost/adapter"
import { claudeAdapter, type ClaudeSdk } from "../src/agentHost/claudeAdapter"
import { piAdapter } from "../src/agentHost/piAdapter"
import type { ReviewBrief, TurnSettings } from "../src/agentHost/protocol"
import { bundledPi, bundledPiProgram } from "./demoAgent"
import { type FakeModelSettings, fakeModelProvider } from "./fakeModelProvider"
import { isolatedHome } from "./harness"
import {
  gatewayKey,
  PI_MODEL,
  PI_PROVIDER,
  type PiSettings,
  writePiLogin,
  writePiSettings,
} from "./piLogin"
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

/** An Agent review's Agent, on a checkout whose diff holds lines 1 and 2 of `greet.ts`. */
export const reviewBrief: ReviewBrief = {
  instructions: "You answer a reviewer's questions about a pull request that changes greet.ts.",
  diffLines: { "new:greet.ts": [1, 2] },
}

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

  if (fake !== undefined) yield* fakeModelProvider(home, fake, piSettings)
  else {
    writePiSettings(home, PI_PROVIDER, PI_MODEL, piSettings)

    if (recordingSessions) writePiLogin(home, PI_PROVIDER, apiKey ?? gatewayKey())
  }

  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"))
  vi.stubEnv("PI_OFFLINE", "1")
  const tape = sessionTape(scenario, bundledPiProgram(), { "<folder>": folder, "<pi-home>": home })

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

  return { ...(yield* drive(adapter, tape, folder)), extension }
})
