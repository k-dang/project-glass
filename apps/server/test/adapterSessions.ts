import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk"
import {
  type AgentEvent,
  applyAgentEvent,
  type Image,
  type RequestAnswer,
  type Turn,
  TurnStarted,
} from "@glass/contracts"
import { NodeServices } from "@effect/platform-node"
import { DateTime, Effect, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import type { AgentAdapter, AgentSession } from "../src/agentHost/adapter"
import { claudeAdapter, type ClaudeSdk } from "../src/agentHost/claudeAdapter"
import { piAdapter } from "../src/agentHost/piAdapter"
import type { TurnSettings } from "../src/agentHost/protocol"
import { bundledPi } from "./demoAgent"
import {
  type FakeAnthropicReply,
  type FakeAnthropicRequest,
  startFakeAnthropic,
} from "./fakeAnthropic"
import { type FakeModelSettings, fakeModelProvider, type PiSettings } from "./fakeModelProvider"
import { isolatedHome } from "./harness"
import { fakeAnthropicEnvironment, pinnedClaude, pinnedClaudePackage } from "./pinnedClaude"
import { recordingSessions, sessionTape } from "./sessionTape"

const installed = (name: string, packageJson: string | URL) =>
  `${name} ${
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
      readFileSync(packageJson, "utf8"),
    ).version
  }`

const drive = Effect.fnUntraced(function* (
  adapter: AgentAdapter,
  tape: ReturnType<typeof sessionTape>,
  folder: string,
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

  const open = (conversation: string) =>
    adapter.start({ folder, conversation, report }).pipe(
      Effect.map((session: AgentSession) => ({
        session,
        configure: (settings: Partial<TurnSettings>) =>
          session.configure({ model: null, effort: null, permissionMode: null, ...settings }),
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

  return { adapter, events, turns: SubscriptionRef.get(turns), until, open }
})

export const claudeSession = Effect.fnUntraced(function* (
  scenario: string,
  reply?: (request: FakeAnthropicRequest) => FakeAnthropicReply,
) {
  const folder = yield* isolatedHome

  const tape = sessionTape(
    scenario,
    installed("@anthropic-ai/claude-agent-sdk", pinnedClaudePackage()),
    {
      "<folder>": folder,
    },
  )

  let api: Pick<Effect.Success<typeof startFakeAnthropic>, "hold" | "release" | "received"> = {
    hold: Effect.void,
    release: Effect.void,
    received: () => Effect.void,
  }

  if (recordingSessions) {
    const anthropic = yield* startFakeAnthropic
    api = anthropic

    if (reply !== undefined) yield* anthropic.respond(reply)

    for (const [name, value] of Object.entries(fakeAnthropicEnvironment(folder, anthropic.url)))
      vi.stubEnv(name, value)
  }

  const sdk: ClaudeSdk = {
    query: (input) =>
      query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: tape.claude } }),
    getSessionInfo: (id, options) =>
      tape.sessionInfo(id, options?.dir, () => getSessionInfo(id, options)),
  }

  return { ...(yield* drive(claudeAdapter(pinnedClaude(), sdk), tape, folder)), api }
})

export const piSession = Effect.fnUntraced(function* (
  scenario: string,
  settings: FakeModelSettings = {},
  piSettings: PiSettings = { retry: { enabled: false } },
) {
  const home = yield* isolatedHome
  const folder = join(home, "work")
  mkdirSync(folder)

  const provider = yield* fakeModelProvider(home, settings, piSettings)

  const model: Pick<typeof provider, "received" | "cancelled" | "release"> = recordingSessions
    ? provider
    : { received: () => Effect.void, cancelled: () => Effect.void, release: () => Effect.void }

  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"))
  vi.stubEnv("PI_OFFLINE", "1")

  const tape = sessionTape(
    scenario,
    installed(
      "@earendil-works/pi-coding-agent",
      new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
    ),
    {
      "<folder>": folder,
      "<pi-home>": home,
    },
  )

  const adapter = yield* piAdapter(bundledPi).pipe(
    Effect.provide(tape.spawner.pipe(Layer.provide(NodeServices.layer))),
  )

  const extension = (name: string, source: string) =>
    Effect.sync(() => {
      const extensions = join(home, ".pi", "agent", "extensions")
      mkdirSync(extensions, { recursive: true })
      writeFileSync(join(extensions, name), source)
    })

  return { ...(yield* drive(adapter, tape, folder)), model, extension }
})
