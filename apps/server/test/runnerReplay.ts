import { EngineModels } from "@glass/contracts"
import { Effect, Layer, Option, Predicate, Schema, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentFailure } from "../src/agentFailure"
import type { AgentTask } from "../src/agentRunners"
import { counter } from "./counter"

const Summary = Schema.Struct({ summary: Schema.String })

export interface RunnerScenario {
  readonly name: string
  readonly engine: "claude-code" | "pi"
  readonly task: (checkout: string) => AgentTask<typeof Summary.Type>
  readonly recordEnv?: Readonly<Record<string, string | undefined>>
  readonly piModelId?: string
}

const answerTask = (instructions: string, files: AgentTask<unknown>["files"] = "none") => ({
  subject: "Agent review",
  instructions,
  prompt: "PR material: none. This is a test of the answer format.",
  answer: Summary,
  files,
})

const signedOut = {
  CLAUDE_CONFIG_DIR: join(tmpdir(), "glass-signed-out-claude"),
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
}

const replyFine = 'Reply with exactly this JSON and nothing else: {"summary":"Fine."}'

const readGreeting =
  'Read the file src/greet.ts, then reply with only JSON of the form {"summary":"<the file\'s contents>"}.'

export const runnerScenarios: ReadonlyArray<RunnerScenario> = [
  { name: "claude-answer", engine: "claude-code", task: () => answerTask(replyFine) },
  {
    name: "claude-read-only",
    engine: "claude-code",
    task: (checkout) => answerTask(readGreeting, { readOnly: checkout }),
  },
  {
    name: "claude-signed-out",
    engine: "claude-code",
    task: () => answerTask(replyFine),
    recordEnv: signedOut,
  },
  {
    name: "claude-rejected-key",
    engine: "claude-code",
    task: () => answerTask(replyFine),
    recordEnv: {
      ...signedOut,
      ANTHROPIC_API_KEY: "sk-ant-glass-recording-rejected",
      CLAUDE_CODE_MAX_RETRIES: "0",
    },
  },
  { name: "pi-answer", engine: "pi", task: () => answerTask(replyFine) },
  {
    name: "pi-read-only",
    engine: "pi",
    task: (checkout) => answerTask(readGreeting, { readOnly: checkout }),
  },
  {
    name: "pi-unlisted-model",
    engine: "pi",
    task: () => answerTask(replyFine),
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

const spellings = (path: string) => [
  path,
  path.replaceAll("\\", "/"),
  path.replaceAll("\\", "\\\\"),
]

export const normalize = (text: string, places: Readonly<Record<string, string>>) =>
  Object.entries({ ...places, "<tmp>": tmpdir() })
    .flatMap(([name, path]) => spellings(path).map((spelling) => [name, spelling] as const))
    .toSorted(([, a], [, b]) => b.length - a.length)
    .reduce((current, [name, spelling]) => current.replaceAll(spelling, name), text)
    .replace(/<tmp>(?:\\\\|\\|\/)+glass-agent-[A-Za-z0-9]+/g, "<workdir>")
    .replace(
      /(<(?:workdir|checkout|home|tmp)>)((?:(?:\\\\|\\|\/)[\w.-]+)*)/g,
      (_, place, rest) => `${place}${rest.replace(/\\\\|\\/g, "/")}`,
    )

const encode = (value: string) => new TextEncoder().encode(value)

const personal = /email|org|account|uuid|name|subscription|plan/i

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const redactJson = (value: Schema.Json): Schema.Json =>
  Array.isArray(value)
    ? value.map(redactJson)
    : isJsonObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([field, inner]) => [
            field,
            personal.test(field) && Predicate.isString(inner) ? "<redacted>" : redactJson(inner),
          ]),
        )
      : value

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const redact = (output: string) =>
  Option.match(decodeJson(output), {
    onNone: () => output,
    onSome: (json) => JSON.stringify(redactJson(json)),
  })

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

// A JavaScript CLI runs as `node <script> ...args`; only its own arguments are the run's.
const argsOf = (command: ChildProcess.StandardCommand) =>
  command.command === process.execPath ? command.args.slice(1) : command.args

const standard = (command: ChildProcess.Command) =>
  ChildProcess.isStandardCommand(command)
    ? command
    : (() => {
        throw new Error("Runner recordings cover single commands only")
      })()

export const recordingSpawner = (places: Readonly<Record<string, string>>) => {
  const spawns: Array<Spawn> = []

  const layer = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner

      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const given = standard(command)
          const stdin = yield* stdinOf(given)
          const systemPrompt = systemPromptOf(given.args)

          const handle = yield* real.spawn(
            ChildProcess.make(given.command, given.args, {
              ...given.options,
              stdin: Stream.make(new TextEncoder().encode(stdin)),
            }),
          )

          let stdout = ""
          let stderr = ""
          let exitCode: number | null = null
          let streamsOpen = 2

          const save = () => {
            if (exitCode === null || streamsOpen > 0) return

            const spawn: Spawn = {
              args: argsOf(given).map((arg) => normalize(arg, places)),
              cwd: normalize(given.options.cwd ?? "", places),
              stdin: normalize(stdin, places),
              stdout: normalize(redact(stdout), places),
              stderr: normalize(stderr, places),
              exitCode,
            }

            spawns.push(systemPrompt === undefined ? spawn : { ...spawn, systemPrompt })
          }

          const ended = Effect.sync(() => {
            streamsOpen--
            save()
          })

          return ChildProcessSpawner.makeHandle({
            ...handle,
            stdout: handle.stdout.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  stdout += new TextDecoder().decode(chunk)
                }),
              ),
              Stream.onEnd(ended),
            ),
            stderr: handle.stderr.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  stderr += new TextDecoder().decode(chunk)
                }),
              ),
              Stream.onEnd(ended),
            ),
            exitCode: handle.exitCode.pipe(
              Effect.tap((code) =>
                Effect.sync(() => {
                  exitCode = code
                  save()
                }),
              ),
            ),
          })
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

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const given = standard(command)
        const args = argsOf(given).map((arg) => normalize(arg, places))
        const cwd = normalize(given.options.cwd ?? "", places)
        const stdin = normalize(yield* stdinOf(given), places)
        const systemPrompt = systemPromptOf(given.args)

        const index = unused.findIndex(
          (spawn) =>
            JSON.stringify(spawn.args) === JSON.stringify(args) &&
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

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0),
          exitCode: holding ? Effect.never : finished(ChildProcessSpawner.ExitCode(spawn.exitCode)),
          isRunning: Effect.sync(() => running),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: holding ? Stream.never : Stream.make(encode(spawn.stdout)),
          stderr: holding ? Stream.never : Stream.make(encode(spawn.stderr)),
          all: Stream.make(encode(spawn.stdout + spawn.stderr)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
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
