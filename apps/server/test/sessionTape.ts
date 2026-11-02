import type { SDKSessionInfo, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import {
  Cause,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  Sink,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"

const Frame = Schema.Union([
  Schema.Struct({ out: Schema.Json }),
  Schema.Struct({ in: Schema.Json }),
  Schema.Struct({ exit: Schema.NullOr(Schema.Int) }),
])

type Frame = typeof Frame.Type

const Process = Schema.Struct({ args: Schema.Array(Schema.String), frames: Schema.Array(Frame) })

type Process = typeof Process.Type

const Tape = Schema.Struct({
  scenario: Schema.String,
  processes: Schema.Array(Process),
  calls: Schema.Array(Schema.Json),
})

type Tape = typeof Tape.Type

const tapeFile = (scenario: string) =>
  fileURLToPath(new URL(`./recordings/sessions/${scenario}.json`, import.meta.url))

/** Set GLASS_RECORD_SESSIONS=1 to run the real programs, with your logins, and save what they say. */
export const recordingSessions = process.env["GLASS_RECORD_SESSIONS"] === "1"

const uuids = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const idFields = new Set(["request_id", "uuid", "session_id", "tool_use_id", "toolUseID"])

const spellings = (path: string) => [
  path,
  path.replaceAll("\\", "/"),
  path.replace(/[^A-Za-z0-9]/g, "-"),
]

const placesOf = (places: Readonly<Record<string, string>>) =>
  Object.entries({ ...places, "<home>": homedir(), "<tmp>": tmpdir() })
    .flatMap(([name, path]) => spellings(path).map((spelling) => [name, spelling] as const))
    .toSorted(([, a], [, b]) => b.length - a.length)

type Json = Schema.Json

const isArray = (value: Json): value is Schema.JsonArray => Array.isArray(value)

const isObject = (value: Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const mapStrings = (value: Json, change: (text: string) => string): Json =>
  Predicate.isString(value)
    ? change(value)
    : isArray(value)
      ? value.map((item) => mapStrings(item, change))
      : isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([field, inner]) => [field, mapStrings(inner, change)]),
          )
        : value

const normalizer = (places: Readonly<Record<string, string>>) => {
  const known = placesOf(places)

  return (value: Json) =>
    mapStrings(value, (text) =>
      known
        .reduce((current, [name, spelling]) => current.replaceAll(spelling, name), text)
        .replace(
          /(<[a-z-]+>)((?:[\\/][\w .@-]+)*)/g,
          (_, place, rest: string) => `${place}${rest.replaceAll("\\", "/")}`,
        ),
    )
}

const denormalizer = (places: Readonly<Record<string, string>>) => {
  const known = Object.entries({ ...places, "<home>": homedir(), "<tmp>": tmpdir() })

  return (value: Json) =>
    mapStrings(value, (text) =>
      known.reduce((current, [name, path]) => current.replaceAll(name, path), text),
    )
}

const sameIds = (recorded: string, actual: string, ids: Map<string, string>) => {
  const recordedIds = recorded.match(uuids) ?? []
  const actualIds = actual.match(uuids) ?? []

  if (recordedIds.length === 0 || recorded.replace(uuids, "<id>") !== actual.replace(uuids, "<id>"))
    return false

  return recordedIds.every((id, index) => {
    const known = ids.get(id)

    if (known !== undefined) return known === actualIds[index]

    ids.set(id, actualIds[index]!)

    return true
  })
}

/** Whether `actual` is what `recorded` was, learning which ids this run uses in place of the recorded ones. */
const matches = (recorded: Json, actual: Json, ids: Map<string, string>, field = ""): boolean => {
  if (Predicate.isString(recorded) && Predicate.isString(actual)) {
    if (recorded === actual) return true

    if (!idFields.has(field)) return sameIds(recorded, actual, ids)

    const known = ids.get(recorded)

    if (known !== undefined) return known === actual

    ids.set(recorded, actual)

    return true
  }

  if (isArray(recorded) && isArray(actual))
    return (
      recorded.length === actual.length &&
      recorded.every((item, index) => matches(item, actual[index]!, ids))
    )

  if (isObject(recorded) && isObject(actual)) {
    const fields = new Set([...Object.keys(recorded), ...Object.keys(actual)])

    return [...fields].every(
      (name) =>
        name in recorded && name in actual && matches(recorded[name]!, actual[name]!, ids, name),
    )
  }

  return recorded === actual
}

const tryMatch = (recorded: Json, actual: Json, ids: Map<string, string>) => {
  const learned = new Map(ids)

  if (!matches(recorded, actual, learned)) return false

  for (const [from, to] of learned) ids.set(from, to)

  return true
}

const lines = (onLine: (line: string) => void) => {
  let pending = ""

  return (chunk: string) => {
    pending += chunk

    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end).replace(/\r$/, "")
      pending = pending.slice(end + 1)

      if (line.trim() !== "") onLine(line)
    }
  }
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const parse = (line: string): Json => Option.getOrElse(decodeLine(line), () => line)

const show = (value: Json) => (Predicate.isString(value) ? value : JSON.stringify(value))

interface Program {
  readonly write: (line: string) => void
  readonly close: () => void
}

/**
 * A recorded program's side of a conversation: it says its recorded lines, waiting at each run of
 * lines Glass sent until Glass sends them again, in any order within the run.
 */
const replayProgram = (
  recorded: Process,
  ids: Map<string, string>,
  places: Readonly<Record<string, string>>,
  problems: Array<string>,
  say: (line: string) => void,
  exit: (code: number | null) => void,
): Program => {
  const { frames } = recorded
  const normalize = normalizer(places)
  const denormalize = denormalizer(places)
  const sent = new Set<number>()
  let cursor = 0
  let ended = false

  const outRun = () => {
    let end = cursor

    while (end < frames.length && "out" in frames[end]!) end++

    return { start: cursor, end }
  }

  const finish = (code: number | null) => {
    if (ended) return
    ended = true
    exit(code)
  }

  const pump = () => {
    while (cursor < frames.length) {
      if (ended) return
      const frame = frames[cursor]!

      if ("in" in frame) {
        const line = mapStrings(denormalize(frame.in), (text) =>
          [...ids].reduce((current, [from, to]) => current.replaceAll(from, to), text),
        )

        say(show(line))
        cursor++
        continue
      }

      if ("exit" in frame) {
        if (cursor === frames.length - 1) return
        cursor++
        finish(frame.exit)

        return
      }

      const { start, end } = outRun()

      for (let index = start; index < end; index++) if (!sent.has(index)) return

      cursor = end
    }
  }

  queueMicrotask(pump)

  return {
    write: (line) => {
      const actual = normalize(parse(line))
      const { start, end } = outRun()

      for (let index = start; index < end; index++) {
        const frame = frames[index]!

        if (!sent.has(index) && "out" in frame && tryMatch(frame.out, actual, ids)) {
          sent.add(index)
          pump()

          return
        }
      }

      problems.push(`Glass sent what the recording doesn't have next: ${show(actual)}`)
      console.error(problems.at(-1))
    },
    close: () => {
      const last = frames.at(-1)
      finish(last !== undefined && "exit" in last ? last.exit : 0)
    },
  }
}

/** Records or replays what Agent programs said to Glass, for one scenario. */
export const sessionTape = (scenario: string, places: Readonly<Record<string, string>>) => {
  const normalize = normalizer(places)
  const problems: Array<string> = []
  const ids = new Map<string, string>()

  const recorded: Tape = recordingSessions
    ? { scenario, processes: [], calls: [] }
    : Schema.decodeUnknownSync(Schema.fromJsonString(Tape))(
        readFileSync(tapeFile(scenario), "utf8"),
      )

  const processes: Array<{ args: Array<string>; frames: Array<Frame> }> = []
  const calls: Array<Json> = []
  let nextProcess = 0
  let nextCall = 0

  const nextRecorded = (args: ReadonlyArray<string>) => {
    const process = recorded.processes[nextProcess++]

    if (process === undefined || !tryMatch(process.args, normalize(args), ids)) {
      problems.push(`Glass started a program the recording doesn't have: ${args.join(" ")}`)
      console.error(problems.at(-1))

      return undefined
    }

    return process
  }

  const recordProcess = (args: ReadonlyArray<string>) => {
    const frames: Array<Frame> = []

    const normalized = args.flatMap((arg) => {
      const text = normalize(arg)

      return Predicate.isString(text) ? [text] : []
    })

    processes.push({ args: normalized, frames })

    return {
      out: lines((line) => frames.push({ out: normalize(parse(line)) })),
      in: lines((line) => frames.push({ in: normalize(parse(line)) })),
      exit: (code: number | null) => frames.push({ exit: code }),
    }
  }

  /** For the Claude Agent SDK's `spawnClaudeCodeProcess`. */
  const claude = (options: SpawnOptions): SpawnedProcess => {
    if (recordingSessions) {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      })

      const tape = recordProcess(options.args)
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      stdin.on("data", (chunk: Buffer) => tape.out(chunk.toString("utf8")))
      stdin.pipe(child.stdin)
      child.stdout.on("data", (chunk: Buffer) => tape.in(chunk.toString("utf8")))
      child.stdout.pipe(stdout)
      child.on("exit", (code) => tape.exit(code))

      return Object.assign(child, { stdin, stdout })
    }

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const events = new EventEmitter()
    let exitCode: number | null = null
    let killed = false

    const exit = (code: number | null) => {
      exitCode = code
      stdout.end()
      events.emit("exit", code, null)
    }

    const process = nextRecorded(options.args)

    const program =
      process === undefined
        ? { write: () => {}, close: () => exit(1) }
        : replayProgram(process, ids, places, problems, (line) => stdout.write(`${line}\n`), exit)

    stdin.on("data", lines(program.write))
    stdin.on("end", program.close)

    return Object.assign(events, {
      stdin,
      stdout,
      get killed() {
        return killed
      },
      get exitCode() {
        return exitCode
      },
      kill: () => {
        killed = true
        program.close()

        return true
      },
    })
  }

  /** A ChildProcessSpawner for programs Glass starts itself, such as pi. */
  const spawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner

      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command))
            return yield* Effect.die("Session tapes cover single commands only")

          const args =
            command.command === globalThis.process.execPath ? command.args.slice(1) : command.args

          if (recordingSessions) {
            const tape = recordProcess(args)
            const handle = yield* real.spawn(command)
            const decoder = new TextDecoder()

            return ChildProcessSpawner.makeHandle({
              ...handle,
              stdin: Sink.mapInput(handle.stdin, (chunk: Uint8Array) => {
                tape.out(decoder.decode(chunk))

                return chunk
              }),
              stdout: handle.stdout.pipe(
                Stream.tap((chunk) => Effect.sync(() => tape.in(new TextDecoder().decode(chunk)))),
              ),
              exitCode: handle.exitCode.pipe(
                Effect.tap((code) => Effect.sync(() => tape.exit(code))),
              ),
            })
          }

          const output = yield* Queue.unbounded<Uint8Array, Cause.Done>()
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>()
          const encoder = new TextEncoder()

          const exit = (code: number | null) => {
            Effect.runSync(Queue.end(output))
            Effect.runSync(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(code ?? 1)))
          }

          const process = nextRecorded(args)

          const program =
            process === undefined
              ? { write: () => {}, close: () => exit(1) }
              : replayProgram(
                  process,
                  ids,
                  places,
                  problems,
                  (line) => Effect.runSync(Queue.offer(output, encoder.encode(`${line}\n`))),
                  exit,
                )

          yield* Effect.addFinalizer(() => Effect.sync(program.close))
          const decoder = new TextDecoder()
          const write = lines(program.write)

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: Deferred.await(exited),
            isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
            kill: () => Effect.sync(program.close),
            stdin: Sink.forEach((chunk: Uint8Array) =>
              Effect.sync(() => write(decoder.decode(chunk, { stream: true }))),
            ),
            stdout: Stream.fromQueue(output),
            stderr: Stream.empty,
            all: Stream.fromQueue(output),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        }),
      )
    }),
  )

  /** Records what the SDK found of a saved conversation on disk, or replays it. */
  const sessionInfo = (
    live: () => Promise<SDKSessionInfo | undefined>,
  ): Promise<SDKSessionInfo | undefined> => {
    if (recordingSessions)
      return live().then((info) => {
        calls.push(normalize(parse(JSON.stringify(info ?? null))))

        return info
      })

    const info = recorded.calls[nextCall++] ?? null

    if (info === null) return Promise.resolve(undefined)

    // SAFETY: the recording holds what getSessionInfo returned for this call when it was recorded.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- See SAFETY above.
    const saved = denormalizer(places)(info) as SDKSessionInfo

    return Promise.resolve(saved)
  }

  /** Saves the recording, or fails if the replay went anywhere the recording didn't. */
  const finish = Effect.sync(() => {
    if (recordingSessions) {
      const file = tapeFile(scenario)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ scenario, processes, calls }, null, 2)}\n`)

      return
    }

    if (nextProcess < recorded.processes.length)
      problems.push(
        `Glass never started ${recorded.processes.length - nextProcess} recorded programs`,
      )

    if (problems.length > 0) throw new Error(problems.join("\n"))
  })

  return { claude, spawner, sessionInfo, finish }
}
