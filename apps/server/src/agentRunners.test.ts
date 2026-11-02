import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, Layer } from "effect"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import { isolatedHome } from "../test/harness"
import {
  type Recording,
  readRecording,
  replaySpawner,
  type RunnerScenario,
  runnerScenarios,
} from "../test/runnerReplay"
import { AgentRunners } from "./agentRunners"
import { ServerConfig } from "./ServerConfig"

const fixture = Effect.fnUntraced(function* (
  scenario: RunnerScenario,
  options: { hold?: boolean; recording?: Recording } = {},
) {
  const home = yield* isolatedHome
  const temporary = join(home, "tmp")
  const checkout = join(home, "checkout")
  mkdirSync(temporary)
  mkdirSync(join(checkout, "src"), { recursive: true })
  writeFileSync(join(checkout, "src", "greet.ts"), "hello")

  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, temporary)

  const recording = options.recording ?? readRecording(scenario.name)
  const replay = replaySpawner(recording, { "<checkout>": checkout }, options)

  const run = Effect.gen(function* () {
    const runner = yield* (yield* AgentRunners).select({
      engine: scenario.engine,
      models: recording.models,
    })

    return yield* runner.run(scenario.task(checkout))
  }).pipe(
    Effect.scoped,
    Effect.provide(
      AgentRunners.layer.pipe(
        Layer.provide(replay.layer),
        Layer.provide(ServerConfig.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              GLASS_PORT: "0",
              GLASS_TOKEN: "unused",
              GLASS_HOME: home,
              GLASS_CLAUDE_COMMAND: join(home, "claude"),
              GLASS_PI_COMMAND: join(home, "pi"),
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
        Layer.orDie,
      ),
    ),
  )

  return {
    recording,
    replay,
    run,
    leftovers: () => readdirSync(temporary).filter((name) => name.startsWith("glass-agent-")),
  }
})

for (const scenario of runnerScenarios)
  it.live(`replays ${scenario.name} to the outcome the real CLI gave`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario)

      const outcome = yield* f.run.pipe(
        Effect.match({
          onSuccess: (answer) => ({ answer }),
          onFailure: (failure) => {
            for (const spawn of f.recording.spawns)
              if (spawn.stdout.trim().length > 20) assert.notInclude(failure.message, spawn.stdout)

            return { failure: failure.reason }
          },
        }),
      )

      assert.deepStrictEqual(outcome, f.recording.outcome)
      assert.deepStrictEqual(f.replay.unexpected, [])
      assert.strictEqual(f.replay.unused(), 0)
      assert.isEmpty(f.leftovers())
    }),
  )

for (const name of ["claude-answer", "pi-answer"])
  it.live(`stopping ${name} part-way stops the CLI and removes its directory`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        runnerScenarios.find((scenario) => scenario.name === name)!,
        { hold: true },
      )

      const running = yield* Effect.forkChild(f.run)
      yield* f.replay.served(f.recording.spawns.length)
      yield* Fiber.interrupt(running)

      yield* f.replay.stopped(1)
      assert.isEmpty(f.leftovers())
    }),
  )

const piText = '{"type":"text","text":"{\\"summary\\":\\"Fine.\\"}"}'

for (const [name, base, from, to] of [
  ["a truncated pi answer", "pi-answer", '"stopReason":"stop"', '"stopReason":"length"'],
  ["a pi text block without text", "pi-answer", piText, `${piText},{"type":"text"}`],
  [
    "a pi answer that isn't JSON",
    "pi-answer",
    piText,
    '{"type":"text","text":"not JSON secret-should-not-leak"}',
  ],
  [
    "a Claude Code answer that isn't JSON",
    "claude-answer",
    '"result":"{\\"summary\\":\\"Fine.\\"}"',
    '"result":"not JSON secret-should-not-leak"',
  ],
] as const)
  it.live(`fails as unusable output for ${name}`, () =>
    Effect.gen(function* () {
      const scenario = runnerScenarios.find((candidate) => candidate.name === base)!
      const recorded = readRecording(base)
      const answering = recorded.spawns.at(-1)!
      assert.include(answering.stdout, from)

      const f = yield* fixture(scenario, {
        recording: {
          ...recorded,
          spawns: [
            ...recorded.spawns.slice(0, -1),
            { ...answering, stdout: answering.stdout.replaceAll(from, to) },
          ],
        },
      })

      const failure = yield* Effect.flip(f.run)
      assert.strictEqual(failure.reason, "unusable-output")
      assert.notInclude(failure.message, "secret-should-not-leak")
    }),
  )

it.live("reports a runner whose executable is missing as not installed", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    const failures = yield* Effect.forEach(["claude-code", "pi"] as const, (engine) =>
      Effect.gen(function* () {
        const runner = yield* (yield* AgentRunners).select({
          engine,
          models: {
            "claude-code": "claude-haiku",
            pi: { provider: "glass-test", modelId: "gpt-test" },
          },
        })

        return runner
      }).pipe(
        Effect.scoped,
        Effect.flip,
        Effect.provide(
          AgentRunners.layer.pipe(
            Layer.provide(ServerConfig.layer),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnvRecord({
                  GLASS_PORT: "0",
                  GLASS_TOKEN: "unused",
                  GLASS_HOME: home,
                  GLASS_CLAUDE_COMMAND: "glass-missing-claude",
                  GLASS_PI_COMMAND: "glass-missing-pi",
                }),
              ),
            ),
            Layer.provide(NodeServices.layer),
            Layer.orDie,
          ),
        ),
      ),
    )

    assert.deepStrictEqual(
      failures.map((failure) => failure.reason),
      ["not-installed", "not-installed"],
    )
  }),
)
