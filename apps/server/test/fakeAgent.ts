import { assert } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { vi } from "vite-plus/test"
import { type FakeAgentSettings, installFakeAgent } from "./fakeAgentFiles"
import { isolatedHome } from "./harness"

const AgentLogLine = Schema.Struct({
  stage: Schema.Literals(["auth", "help", "models", "generate", "prompted"]),
  pid: Schema.Int,
  cwd: Schema.String,
  args: Schema.Array(Schema.String),
  input: Schema.optional(Schema.String),
  systemPrompt: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(Schema.String)),
})

const decodeCall = Schema.decodeUnknownSync(Schema.fromJsonString(AgentLogLine))

const readCalls = (log: string) =>
  log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeCall(line))

export const fakeAgent = Effect.fnUntraced(function* (initial: FakeAgentSettings) {
  const directory = yield* isolatedHome
  const agent = yield* Effect.promise(() => installFakeAgent(directory, "agent.cjs", initial))
  const log = Effect.promise(agent.log)
  const calls = log.pipe(Effect.map(readCalls))

  return {
    command: agent.command,
    configure: (settings: FakeAgentSettings) => Effect.promise(() => agent.configure(settings)),
    log,
    calls,
    untilCalls: (stage: typeof AgentLogLine.Type.stage, count = 1) =>
      Effect.promise(() =>
        vi.waitFor(
          async () => {
            const logged = await Effect.runPromise(calls)
            assert.isAtLeast(logged.filter((call) => call.stage === stage).length, count)
          },
          { timeout: 5000 },
        ),
      ),
  }
})
