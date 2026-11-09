import { NodeServices } from "@effect/platform-node"
import { EngineModels } from "@glass/contracts"
import { Effect, Layer, Option, Predicate, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentFailure } from "../src/agentFailure"
import { AgentRunners } from "../src/agentRunners"
import type { AgentTools } from "../src/agentTools"
import { AgentCommands } from "../src/SettingsStore"
import { counter } from "./counter"
import {
  decodeJson,
  type Json,
  mapStrings,
  normalizer,
  playedHandle,
  programArgs,
  singleCommand,
  tappedSpawn,
} from "./replay"

const Summary = Schema.Struct({ summary: Schema.String })

export interface RunnerScenario {
  readonly name: string
  readonly engine: "claude-code" | "pi"
  readonly instructions: string
  readonly tools?: AgentTools
  readonly recordEnv?: Readonly<Record<string, string | undefined>>
  readonly piModelId?: string
}

export const scenarioTask = (
  { instructions, tools = "read-only" }: RunnerScenario,
  checkout: string,
) => ({
  subject: "Agent review",
  instructions,
  prompt: "PR material: none. This is a test of the answer format.",
  answer: Summary,
  tools,
  checkout,
})

const signedOut = {
  CLAUDE_CONFIG_DIR: join(tmpdir(), "glass-signed-out-claude"),
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
}

const replyFine = 'Reply with exactly this JSON and nothing else: {"summary":"Fine."}'

export const seedCheckout = (checkout: string) => {
  mkdirSync(join(checkout, "src"), { recursive: true })
  writeFileSync(join(checkout, "src", "greet.ts"), "hello")
}

const runGreeting =
  'Run the shell command `cat src/greet.ts`, then reply with only JSON of the form {"summary":"<what it printed>"}.'

const readGreeting =
  'Read the file src/greet.ts, then reply with only JSON of the form {"summary":"<the file\'s contents>"}.'

export const runnerScenarios: ReadonlyArray<RunnerScenario> = [
  {
    name: "claude-answer",
    engine: "claude-code",
    instructions: replyFine,
  },
  {
    name: "claude-read-only",
    engine: "claude-code",
    instructions: readGreeting,
  },
  {
    name: "claude-signed-out",
    engine: "claude-code",
    instructions: replyFine,
    recordEnv: signedOut,
  },
  {
    name: "claude-rejected-key",
    engine: "claude-code",
    instructions: replyFine,
    recordEnv: {
      ...signedOut,
      ANTHROPIC_API_KEY: "sk-ant-glass-recording-rejected",
      CLAUDE_CODE_MAX_RETRIES: "0",
    },
  },
  {
    name: "claude-shell",
    engine: "claude-code",
    instructions: runGreeting,
    tools: "shell",
  },
  { name: "pi-answer", engine: "pi", instructions: replyFine },
  {
    name: "pi-read-only",
    engine: "pi",
    instructions: readGreeting,
  },
  {
    name: "pi-shell",
    engine: "pi",
    instructions: runGreeting,
    tools: "shell",
  },
  {
    name: "pi-unlisted-model",
    engine: "pi",
    instructions: replyFine,
    piModelId: "glass-no-such-model",
  },
]

const Spawn = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  stdin: Schema.String,
  systemPrompt: Schema.optional(Schema.String),
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Int,
})

type Spawn = typeof Spawn.Type

export const Recording = Schema.Struct({
  scenario: Schema.String,
  program: Schema.String,
  models: EngineModels,
  outcome: Schema.Union([
    Schema.Struct({ answer: Summary }),
    Schema.Struct({ failure: AgentFailure.fields.reason }),
  ]),
  spawns: Schema.Array(Spawn),
})

export type Recording = typeof Recording.Type

export const recordingFile = (scenario: string) =>
  new URL(`./recordings/runners/${scenario}.json`, import.meta.url)

export const readRecording = (scenario: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Recording))(
    readFileSync(recordingFile(scenario), "utf8"),
  )

export const runnersLayer = (
  commands: AgentCommands["Service"],
  spawner: Layer.Layer<
    ChildProcessSpawner.ChildProcessSpawner,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.service(ChildProcessSpawner.ChildProcessSpawner),
  ),
) =>
  AgentRunners.layer.pipe(
    Layer.provide(spawner),
    Layer.provide(Layer.succeed(AgentCommands, commands)),
    Layer.provide(NodeServices.layer),
    Layer.orDie,
  )

const personal = /email|org|account|uuid|name|subscription|plan/i

const redactJson = (value: Json) =>
  mapStrings(value, (text, field) => (personal.test(field) ? "<redacted>" : text))

const redact = (output: string) => {
  const whole = decodeJson(output)

  return Option.isSome(whole)
    ? JSON.stringify(redactJson(whole.value))
    : output
        .split("\n")
        .map((line) =>
          Option.match(decodeJson(line), {
            onNone: () => line,
            onSome: (json) => JSON.stringify(redactJson(json)),
          }),
        )
        .join("\n")
}

const encode = (value: string) => new TextEncoder().encode(value)

const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString)

const stdinOf = (command: ChildProcess.StandardCommand) => {
  const stdin = command.options.stdin

  const stream = Stream.isStream(stdin)
    ? stdin
    : Predicate.hasProperty(stdin, "stream") && Stream.isStream(stdin.stream)
      ? stdin.stream
      : null

  return stream === null ? Effect.succeed("") : text(stream).pipe(Effect.orDie)
}

const systemPromptOf = (args: ReadonlyArray<string>) => {
  const index = args.indexOf("--system-prompt")

  return index === -1 ? undefined : readFileSync(args[index + 1]!, "utf8")
}

export const recordingSpawner = (places: Readonly<Record<string, string>>) => {
  const spawns: Array<Spawn> = []
  const normalize = normalizer(places)

  const layer = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner

      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const given = yield* singleCommand(command)
          const stdin = yield* stdinOf(given)
          const systemPrompt = systemPromptOf(given.args)
          let stdout = ""
          let stderr = ""

          return yield* tappedSpawn(
            real,
            ChildProcess.make(given.command, given.args, {
              ...given.options,
              stdin: Stream.make(encode(stdin)),
            }),
            {
              stdout: (chunk) => {
                stdout += chunk
              },
              stderr: (chunk) => {
                stderr += chunk
              },
              exit: (exitCode) => {
                const spawn: Spawn = {
                  args: programArgs(given).map(normalize),
                  cwd: normalize(given.options.cwd ?? ""),
                  stdin: normalize(stdin),
                  stdout: normalize(redact(stdout)),
                  stderr: normalize(stderr),
                  exitCode,
                }

                spawns.push(systemPrompt === undefined ? spawn : { ...spawn, systemPrompt })
              },
            },
          )
        }),
      )
    }),
  )

  return { layer, spawns }
}

export const replaySpawner = (
  recording: Recording,
  places: Readonly<Record<string, string>>,
  { hold = false } = {},
) => {
  const unused = [...recording.spawns]
  const unexpected: Array<string> = []
  const stopped = counter()
  const served = counter()
  const normalize = normalizer(places)

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const given = yield* singleCommand(command)
        const args = programArgs(given).map(normalize)
        const argsText = JSON.stringify(args)
        const cwd = normalize(given.options.cwd ?? "")
        const stdin = normalize(yield* stdinOf(given))
        const systemPrompt = systemPromptOf(given.args)

        const index = unused.findIndex(
          (spawn) =>
            JSON.stringify(spawn.args) === argsText &&
            spawn.cwd === cwd &&
            spawn.stdin === stdin &&
            spawn.systemPrompt === systemPrompt,
        )

        if (index === -1) {
          unexpected.push(JSON.stringify({ args, cwd, stdin, systemPrompt }))

          return yield* Effect.die(new Error(`Not in the recording: ${args.join(" ")}`))
        }

        const spawn = unused.splice(index, 1)[0]!
        const holding = hold && unused.length === 0
        let running = true

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (running) stopped.add()
            running = false
          }),
        )
        served.add()

        const finished = <A>(value: A) =>
          Effect.sync(() => {
            running = false

            return value
          })

        return playedHandle({
          exitCode: holding ? Effect.never : finished(ChildProcessSpawner.ExitCode(spawn.exitCode)),
          isRunning: Effect.sync(() => running),
          stdout: holding ? Stream.never : Stream.make(encode(spawn.stdout)),
          stderr: holding ? Stream.never : Stream.make(encode(spawn.stderr)),
        })
      }),
    ),
  )

  return {
    layer,
    unused: () => unused.length,
    unexpected,
    stopped: stopped.reached,
    served: served.reached,
  }
}
