import { assert, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import { isolatedHome } from "../test/harness"
import {
  type Recording,
  readRecording,
  replaySpawner,
  type RunnerScenario,
  runnerScenarios,
  runnersLayer,
  scenarioTask,
  seedCheckout,
} from "../test/runnerReplay"
import { AgentRunners } from "./agentRunners"

const scenarioNamed = (name: string) => runnerScenarios.find((scenario) => scenario.name === name)!

const fixture = Effect.fnUntraced(function* (
  scenario: RunnerScenario,
  options: { hold?: boolean; recording?: Recording } = {},
) {
  const home = yield* isolatedHome
  const temporary = join(home, "tmp")
  const checkout = join(home, "checkout")
  mkdirSync(temporary)
  seedCheckout(checkout)

  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, temporary)

  const recording = options.recording ?? readRecording(scenario.name)
  const replay = replaySpawner(recording, { "<checkout>": checkout }, options)

  const run = Effect.gen(function* () {
    const runner = yield* (yield* AgentRunners).select({
      engine: scenario.engine,
      models: recording.models,
    })

    return yield* runner.run(scenarioTask(scenario, checkout))
  }).pipe(
    Effect.scoped,
    Effect.provide(
      runnersLayer(
        { claudeCommand: join(home, "claude"), piCommand: join(home, "pi") },
        replay.layer,
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
      const f = yield* fixture(scenarioNamed(name), { hold: true })

      const running = yield* Effect.forkChild(f.run)
      yield* f.replay.served(f.recording.spawns.length)
      yield* Fiber.interrupt(running)

      yield* f.replay.stopped(1)
      assert.isEmpty(f.leftovers())
    }),
  )

for (const name of ["claude-answer", "pi-answer"])
  it.effect(`times out ${name}'s readiness check, stops the CLI, and removes its directory`, () =>
    Effect.gen(function* () {
      const recording = readRecording(name)

      const readiness = {
        ...recording,
        spawns: recording.spawns.filter((spawn) => !spawn.args.includes("-p")),
      }

      const f = yield* fixture(scenarioNamed(name), { hold: true, recording: readiness })
      const running = yield* Effect.forkChild(f.run)
      yield* f.replay.served(readiness.spawns.length)
      yield* TestClock.adjust("30 seconds")

      const failure = yield* Fiber.join(running).pipe(Effect.flip)
      assert.strictEqual(failure.reason, "not-ready")
      assert.include(failure.message, "took too long")
      yield* f.replay.stopped(1)
      assert.isEmpty(f.leftovers())

      const retry = yield* fixture(scenarioNamed(name))
      assert.deepStrictEqual(yield* retry.run, { summary: "Fine." })
    }),
  )

const edited = (
  base: string,
  printed: (spawn: Recording["spawns"][number]) => boolean,
  from: string,
  to: string,
): Recording => {
  const recorded = readRecording(base)
  const target = recorded.spawns.find(printed)!
  assert.include(target.stdout, from)

  return {
    ...recorded,
    spawns: recorded.spawns.map((spawn) =>
      spawn === target ? { ...spawn, stdout: spawn.stdout.replaceAll(from, to) } : spawn,
    ),
  }
}

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
      const f = yield* fixture(scenarioNamed(base), {
        recording: edited(base, (spawn) => spawn.args.includes("-p"), from, to),
      })

      const failure = yield* Effect.flip(f.run)
      assert.strictEqual(failure.reason, "unusable-output")
      assert.notInclude(failure.message, "secret-should-not-leak")
    }),
  )

it.live("refuses a Claude Code that can't restrict its tools", () =>
  Effect.gen(function* () {
    const f = yield* fixture(scenarioNamed("claude-read-only"), {
      recording: edited(
        "claude-read-only",
        (spawn) => spawn.args[0] === "--help",
        "--restricted",
        "--unrelated",
      ),
    })

    const failure = yield* Effect.flip(f.run)
    assert.strictEqual(failure.reason, "not-ready")
  }),
)

it.live("reports a runner whose executable is missing as not installed", () =>
  Effect.gen(function* () {
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
          runnersLayer({ claudeCommand: "glass-missing-claude", piCommand: "glass-missing-pi" }),
        ),
      ),
    )

    assert.deepStrictEqual(
      failures.map((failure) => failure.reason),
      ["not-installed", "not-installed"],
    )
  }),
)
