import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import type { EngineModels } from "@glass/contracts"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { realpathSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fakeAgent } from "../test/fakeAgent"
import { piCliAnswer, piCliModels } from "../test/fakeAgentFiles"
import { isolatedHome } from "../test/harness"
import { AgentRunners } from "./agentRunners"
import { ServerConfig } from "./ServerConfig"

const models: EngineModels = {
  "claude-code": "claude-sonnet-5-5",
  pi: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
}

const runnersLayer = (home: string, command: string) =>
  AgentRunners.layer.pipe(
    Layer.provide(ServerConfig.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          GLASS_PORT: "0",
          GLASS_TOKEN: "unused",
          GLASS_HOME: home,
          GLASS_CLAUDE_COMMAND: command,
          GLASS_PI_COMMAND: command,
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.orDie,
  )

const readOnlyTask = (directory: string) => ({
  subject: "Agent review",
  instructions: "Review the code.",
  prompt: "PR material",
  answer: Schema.Struct({ summary: Schema.String }),
  files: { readOnly: directory },
})

it.live("the pi CLI reads a read-only directory with only its read-only tools", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const checkout = join(home, "checkout")
    yield* Effect.promise(() => mkdir(join(checkout, "src"), { recursive: true }))
    yield* Effect.promise(() => writeFile(join(checkout, "src", "greet.ts"), "hello"))

    const agent = yield* fakeAgent({
      ready: true,
      output: piCliAnswer('{"summary":"Fine."}'),
      modelsOutput: piCliModels,
    })

    const answered = yield* Effect.gen(function* () {
      const selected = yield* (yield* AgentRunners).select({ engine: "pi", models })

      return yield* selected.run(readOnlyTask(checkout))
    }).pipe(Effect.scoped, Effect.provide(runnersLayer(home, agent.command)))

    assert.deepStrictEqual(answered, { summary: "Fine." })
    const prompted = (yield* agent.calls).find((call) => call.stage === "prompted")!
    assert.strictEqual(prompted.cwd, realpathSync(checkout))
    assert.deepStrictEqual(prompted.files, ["src/greet.ts"])
    assert.include(prompted.args.join(" "), "--tools read,grep,find,ls")
    assert.notInclude(prompted.args, "--no-tools")
    assert.strictEqual(prompted.systemPrompt, "Review the code.")
  }),
)

const claudeAnswer = JSON.stringify({ result: '{"summary":"Fine."}' })

it.live("Claude Code reads a read-only directory with only its restricted read tools", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const checkout = join(home, "checkout")
    yield* Effect.promise(() => mkdir(join(checkout, "src"), { recursive: true }))
    yield* Effect.promise(() => writeFile(join(checkout, "src", "greet.ts"), "hello"))

    const agent = yield* fakeAgent({ ready: true, output: claudeAnswer })

    const answered = yield* Effect.gen(function* () {
      const selected = yield* (yield* AgentRunners).select({ engine: "claude-code", models })

      return yield* selected.run(readOnlyTask(checkout))
    }).pipe(Effect.scoped, Effect.provide(runnersLayer(home, agent.command)))

    assert.deepStrictEqual(answered, { summary: "Fine." })
    const prompted = (yield* agent.calls).find((call) => call.stage === "prompted")!
    assert.strictEqual(prompted.cwd, realpathSync(checkout))
    assert.include(prompted.args.join(" "), "--restricted --tools Read,Grep,Glob")
    assert.notInclude(prompted.args, "--json-schema")
    assert.include(prompted.input, '"summary"')
  }),
)

it.live("Claude Code runs a task without file access with no tools", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const agent = yield* fakeAgent({ ready: true, output: claudeAnswer })

    yield* Effect.gen(function* () {
      const selected = yield* (yield* AgentRunners).select({ engine: "claude-code", models })

      return yield* selected.run({ ...readOnlyTask(home), files: "none" })
    }).pipe(Effect.scoped, Effect.provide(runnersLayer(home, agent.command)))

    const prompted = (yield* agent.calls).find((call) => call.stage === "prompted")!
    assert.notStrictEqual(prompted.cwd, realpathSync(home))
    assert.include(prompted.args.join(" "), "--tools  --strict-mcp-config")
    assert.notInclude(prompted.args, "--restricted")
  }),
)

it.live("a Claude Code that can't restrict its tools runs only tasks without file access", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    const agent = yield* fakeAgent({
      ready: true,
      output: claudeAnswer,
      helpOutput: "--tools --strict-mcp-config --no-session-persistence --disable-slash-commands",
    })

    const [readOnly, none] = yield* Effect.gen(function* () {
      const selected = yield* (yield* AgentRunners).select({ engine: "claude-code", models })

      return yield* Effect.all([
        selected.run(readOnlyTask(home)).pipe(Effect.flip),
        selected.run({ ...readOnlyTask(home), files: "none" }),
      ])
    }).pipe(Effect.scoped, Effect.provide(runnersLayer(home, agent.command)))

    assert.strictEqual(readOnly.reason, "not-ready")
    assert.include(readOnly.message, "can't be limited to reading the PR's code")
    assert.deepStrictEqual(none, { summary: "Fine." })
  }),
)
