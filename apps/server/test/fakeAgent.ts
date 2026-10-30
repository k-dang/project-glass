import { assert } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { eventually } from "./eventually"
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
      eventually(
        calls.pipe(
          Effect.map((logged) =>
            assert.isAtLeast(logged.filter((call) => call.stage === stage).length, count),
          ),
        ),
      ),
  }
})
