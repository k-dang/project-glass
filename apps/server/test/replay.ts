import { Effect, Option, Predicate, Schema, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"

export type Json = Schema.Json

export const isJsonArray = (value: Json): value is Schema.JsonArray => Array.isArray(value)

export const isJsonObject = (value: Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

export const mapStrings = (
  value: Json,
  change: (text: string, field: string) => string,
  field = "",
): Json =>
  Predicate.isString(value)
    ? change(value, field)
    : isJsonArray(value)
      ? value.map((item) => mapStrings(item, change, field))
      : isJsonObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, inner]) => [name, mapStrings(inner, change, name)]),
          )
        : value

export const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

export const parseLine = (line: string): Json => Option.getOrElse(decodeJson(line), () => line)

const withMachinePlaces = (places: Readonly<Record<string, string>>) =>
  Object.entries({ ...places, "<home>": homedir(), "<tmp>": tmpdir() })

/** The folder as pi names its sessions folder after it: `/` and `:` dashed, leading one dropped. */
const piSessionsName = (path: string) => path.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")

const spellings = (path: string) => {
  const dashed = path.replace(/[^A-Za-z0-9]/g, "-")

  return [
    path,
    path.replaceAll("\\", "/"),
    path.replaceAll("\\", "\\\\"),
    ...(dashed.split("-").filter(Boolean).length > 1 ? [dashed] : []),
    ...[piSessionsName(path)].filter((name) => name.includes("-")),
  ]
}

export const normalizer = (places: Readonly<Record<string, string>>) => {
  const known = withMachinePlaces(places)
    .flatMap(([name, path]) => spellings(path).map((spelling) => [name, spelling] as const))
    .toSorted(([, a], [, b]) => b.length - a.length)

  return (text: string) =>
    known
      .reduce((current, [name, spelling]) => current.replaceAll(spelling, name), text)
      .replace(/<tmp>(?:\\\\|\\|\/)+glass-agent-[A-Za-z0-9]+/g, "<workdir>")
      .replace(
        /(<[a-z-]+>)([\w.@-]*(?:(?:\\\\|\\|\/)[\w.@-]+)*)/g,
        (_, place: string, rest: string) => `${place}${rest.replace(/\\\\|\\/g, "/")}`,
      )
}

export const denormalizer = (places: Readonly<Record<string, string>>) => {
  const known = withMachinePlaces(places)

  return (value: Json) =>
    mapStrings(value, (text) =>
      known.reduce((current, [name, path]) => current.replaceAll(name, path), text),
    )
}

const Package = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, version: Schema.String }),
)

export const installedProgram = (packageJson: string) => {
  const { name, version } = Schema.decodeUnknownSync(Package)(readFileSync(packageJson, "utf8"))

  return `${name} ${version}`
}

export const singleCommand = (command: ChildProcess.Command) =>
  ChildProcess.isStandardCommand(command)
    ? Effect.succeed(command)
    : Effect.die(new Error("Recordings cover single commands only"))

export const programArgs = (command: ChildProcess.StandardCommand) =>
  command.command === process.execPath ? command.args.slice(1) : command.args

export const utf8 = () => {
  const decoder = new TextDecoder()

  return (chunk: Uint8Array) => decoder.decode(chunk, { stream: true })
}

export const tappedSpawn = Effect.fnUntraced(function* (
  real: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.StandardCommand,
  tap: {
    readonly stdin?: (text: string) => void
    readonly stdout: (text: string) => void
    readonly stderr?: (text: string) => void
    readonly exit: (code: number) => void
  },
) {
  const handle = yield* real.spawn(command)
  let code: number | undefined
  let open = tap.stderr === undefined ? 1 : 2
  let told = false

  const settle = () => {
    if (code === undefined || open > 0 || told) return
    told = true
    tap.exit(code)
  }

  const exited = (value: number) =>
    Effect.sync(() => {
      code ??= value
      settle()
    })

  const ended = Effect.sync(() => {
    open--
    settle()
  })

  const through = <E>(stream: Stream.Stream<Uint8Array, E>, say: (text: string) => void) => {
    const decode = utf8()

    return stream.pipe(
      Stream.tap((chunk) => Effect.sync(() => say(decode(chunk)))),
      Stream.onEnd(ended),
    )
  }

  yield* handle.exitCode.pipe(Effect.flatMap(exited), Effect.ignore, Effect.forkScoped)

  const stdinText = utf8()
  const { stdin, stderr } = tap

  return ChildProcessSpawner.makeHandle({
    ...handle,
    stdin:
      stdin === undefined
        ? handle.stdin
        : Sink.mapInput(handle.stdin, (chunk: Uint8Array) => {
            stdin(stdinText(chunk))

            return chunk
          }),
    stdout: through(handle.stdout, tap.stdout),
    stderr: stderr === undefined ? handle.stderr : through(handle.stderr, stderr),
    exitCode: handle.exitCode.pipe(Effect.tap(exited)),
  })
})

export const playedHandle = (played: {
  readonly stdout: Stream.Stream<Uint8Array>
  readonly stderr?: Stream.Stream<Uint8Array>
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>
  readonly isRunning: Effect.Effect<boolean>
  readonly kill?: () => Effect.Effect<void>
  readonly stdin?: Sink.Sink<void, Uint8Array>
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0),
    stdout: played.stdout,
    stderr: played.stderr ?? Stream.empty,
    all: Stream.die(new Error("Replays keep stdout and stderr apart")),
    exitCode: played.exitCode,
    isRunning: played.isRunning,
    kill: played.kill ?? (() => Effect.void),
    stdin: played.stdin ?? Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
