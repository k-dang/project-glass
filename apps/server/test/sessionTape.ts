import type { SDKSessionInfo, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import { Cause, Deferred, Effect, Layer, Predicate, Queue, Schema, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { lineFramer } from "../src/agentHost/piRpc"
import {
  denormalizer,
  isJsonArray,
  isJsonObject,
  type Json,
  mapStrings,
  normalizer,
  parseLine,
  playedHandle,
  programArgs,
  singleCommand,
  tappedSpawn,
  utf8,
} from "./replay"

const Frame = Schema.Union([
  Schema.Struct({ out: Schema.Json }),
  Schema.Struct({ in: Schema.Json }),
  Schema.Struct({ exit: Schema.NullOr(Schema.Int) }),
])

type Frame = typeof Frame.Type

const Process = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  frames: Schema.Array(Frame),
})

type Process = typeof Process.Type

const Tape = Schema.Struct({
  scenario: Schema.String,
  processes: Schema.Array(Process),
  calls: Schema.Array(Schema.Struct({ args: Schema.Json, info: Schema.Json })),
})

type Tape = typeof Tape.Type

const tapeFile = (scenario: string) =>
  fileURLToPath(new URL(`./recordings/sessions/${scenario}.json`, import.meta.url))

export const recordingSessions = process.env["GLASS_RECORD_SESSIONS"] === "1"

const uuids = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const idFields = new Set(["request_id", "uuid", "session_id", "tool_use_id", "toolUseID"])

const learn = (ids: Map<string, string>, recorded: string, actual: string) => {
  const known = ids.get(recorded)

  if (known !== undefined) return known === actual

  for (const taken of ids.values()) if (taken === actual) return false

  ids.set(recorded, actual)

  return true
}

const bindSaid = (value: Json, ids: Map<string, string>, field = ""): void => {
  if (Predicate.isString(value)) {
    if (idFields.has(field)) learn(ids, value, value)

    for (const id of value.match(uuids) ?? []) learn(ids, id, id)
  } else if (isJsonArray(value)) for (const item of value) bindSaid(item, ids)
  else if (isJsonObject(value))
    for (const [name, inner] of Object.entries(value)) bindSaid(inner, ids, name)
}

const sameIds = (recorded: string, actual: string, ids: Map<string, string>) => {
  const recordedIds = recorded.match(uuids) ?? []
  const actualIds = actual.match(uuids) ?? []

  if (recordedIds.length === 0 || recorded.replace(uuids, "<id>") !== actual.replace(uuids, "<id>"))
    return false

  return recordedIds.every((id, index) => learn(ids, id, actualIds[index]!))
}

const matches = (recorded: Json, actual: Json, ids: Map<string, string>, field = ""): boolean => {
  if (Predicate.isString(recorded) && Predicate.isString(actual)) {
    if (recorded === actual) return true

    return idFields.has(field) ? learn(ids, recorded, actual) : sameIds(recorded, actual, ids)
  }

  if (isJsonArray(recorded) && isJsonArray(actual))
    return (
      recorded.length === actual.length &&
      recorded.every((item, index) => matches(item, actual[index]!, ids))
    )

  if (isJsonObject(recorded) && isJsonObject(actual)) {
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
  const frame = lineFramer()

  return (chunk: string) => {
    for (const line of frame(chunk)) if (line.trim() !== "") onLine(line)
  }
}

const show = (value: Json) => (Predicate.isString(value) ? value : JSON.stringify(value))

interface Program {
  readonly write: (line: string) => void
  readonly close: () => void
  readonly unsent: () => number
}

const replayProgram = (
  recorded: Process,
  ids: Map<string, string>,
  places: {
    readonly normalize: (value: Json) => Json
    readonly denormalize: (value: Json) => Json
  },
  problem: (text: string) => void,
  say: (line: string) => void,
  exit: (code: number | null) => void,
): Program => {
  const { frames } = recorded
  const { normalize, denormalize } = places
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

      if ("exit" in frame) return

      if ("in" in frame) {
        bindSaid(frame.in, ids)

        const line = mapStrings(denormalize(frame.in), (text) =>
          [...ids].reduce((current, [from, to]) => current.replaceAll(from, to), text),
        )

        say(show(line))
        cursor++
        continue
      }

      const { start, end } = outRun()

      for (let index = start; index < end; index++) if (!sent.has(index)) return

      cursor = end
    }
  }

  queueMicrotask(pump)

  return {
    write: (line) => {
      if (ended) return
      const actual = normalize(parseLine(line))
      const { start, end } = outRun()

      for (let index = start; index < end; index++) {
        const frame = frames[index]!

        if (!sent.has(index) && "out" in frame && tryMatch(frame.out, actual, ids)) {
          sent.add(index)
          pump()

          return
        }
      }

      problem(`Glass sent what the recording doesn't have next: ${show(actual)}`)
      finish(1)
    },
    close: () => {
      const last = frames.at(-1)
      finish(last !== undefined && "exit" in last ? last.exit : 0)
    },
    unsent: () =>
      frames.filter((frame, index) => index >= cursor && "out" in frame && !sent.has(index)).length,
  }
}

export const sessionTape = (scenario: string, places: Readonly<Record<string, string>>) => {
  const normalizeText = normalizer(places)
  const normalize = (value: Json) => mapStrings(value, normalizeText)
  const denormalize = denormalizer(places)
  const problems: Array<string> = []
  const failing = new Set<(failure: Effect.Effect<never, Error>) => void>()
  const ids = new Map<string, string>()

  const recorded: Tape = recordingSessions
    ? { scenario, processes: [], calls: [] }
    : Schema.decodeUnknownSync(Schema.fromJsonString(Tape))(
        readFileSync(tapeFile(scenario), "utf8"),
      )

  const processes: Array<Process> = []
  const calls: Array<{ args: Json; info: Json }> = []
  const programs: Array<Program> = []
  let nextProcess = 0
  let nextCall = 0

  const failure = () => Effect.fail(new Error(problems.join("\n")))

  const problem = (text: string) => {
    problems.push(text)

    for (const fail of failing) fail(failure())
  }

  const mismatch = Effect.callback<never, Error>((resume) => {
    if (problems.length > 0) return resume(failure())

    failing.add(resume)

    return Effect.sync(() => failing.delete(resume))
  })

  const nextRecorded = (args: ReadonlyArray<string>, cwd: string | undefined) => {
    const process = recorded.processes[nextProcess++]
    const started = show({ args: args.map(normalizeText), cwd: normalizeText(cwd ?? "") })

    if (process === undefined || show({ args: [...process.args], cwd: process.cwd }) !== started) {
      problem(`Glass started a program the recording doesn't have: ${started}`)

      return undefined
    }

    return process
  }

  const replay = (
    process: Process | undefined,
    say: (line: string) => void,
    exit: (code: number | null) => void,
  ): Program => {
    if (process === undefined) {
      queueMicrotask(() => exit(1))

      return { write: () => {}, close: () => {}, unsent: () => 0 }
    }

    const program = replayProgram(process, ids, { normalize, denormalize }, problem, say, exit)
    programs.push(program)

    return program
  }

  const recordProcess = (args: ReadonlyArray<string>, cwd: string | undefined) => {
    const frames: Array<Frame> = []
    processes.push({ args: args.map(normalizeText), cwd: normalizeText(cwd ?? ""), frames })

    return {
      out: lines((line) => frames.push({ out: normalize(parseLine(line)) })),
      in: lines((line) => frames.push({ in: normalize(parseLine(line)) })),
      exit: (code: number | null) => frames.push({ exit: code }),
    }
  }

  const claude = (options: SpawnOptions): SpawnedProcess => {
    if (recordingSessions) {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      })

      const tape = recordProcess(options.args, options.cwd)
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const sentText = utf8()
      const saidText = utf8()
      stdin.on("data", (chunk: Buffer) => tape.out(sentText(chunk)))
      stdin.pipe(child.stdin)
      child.stdout.on("data", (chunk: Buffer) => tape.in(saidText(chunk)))
      child.stdout.pipe(stdout)
      child.on("close", (code) => tape.exit(code))

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

    const program = replay(
      nextRecorded(options.args, options.cwd),
      (line) => stdout.write(`${line}\n`),
      exit,
    )

    const sentText = utf8()
    const write = lines(program.write)
    stdin.on("data", (chunk: Buffer) => write(sentText(chunk)))
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

  const spawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner

      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const given = yield* singleCommand(command)
          const args = programArgs(given)

          if (recordingSessions) {
            const tape = recordProcess(args, given.options.cwd)

            return yield* tappedSpawn(real, given, {
              stdin: tape.out,
              stdout: tape.in,
              exit: tape.exit,
            })
          }

          const output = yield* Queue.unbounded<Uint8Array, Cause.Done>()
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>()
          const encoder = new TextEncoder()

          const exit = (code: number | null) => {
            Effect.runSync(Queue.end(output))
            Effect.runSync(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(code ?? 1)))
          }

          const program = replay(
            nextRecorded(args, given.options.cwd),
            (line) => Effect.runSync(Queue.offer(output, encoder.encode(`${line}\n`))),
            exit,
          )

          yield* Effect.addFinalizer(() => Effect.sync(program.close))
          const sentText = utf8()
          const write = lines(program.write)

          return playedHandle({
            exitCode: Deferred.await(exited),
            isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
            kill: () => Effect.sync(program.close),
            stdin: Sink.forEach((chunk: Uint8Array) => Effect.sync(() => write(sentText(chunk)))),
            stdout: Stream.fromQueue(output),
          })
        }),
      )
    }),
  )

  const sessionInfo = (
    conversation: string,
    dir: string | undefined,
    live: () => Promise<SDKSessionInfo | undefined>,
  ): Promise<SDKSessionInfo | undefined> => {
    const args = normalize({ conversation, dir: dir ?? "" })

    if (recordingSessions)
      return live().then((info) => {
        calls.push({ args, info: normalize(parseLine(JSON.stringify(info ?? null))) })

        return info
      })

    const call = recorded.calls[nextCall++]

    if (call === undefined || show(call.args) !== show(args)) {
      problem(`Glass looked up a conversation the recording doesn't have: ${show(args)}`)

      return Promise.resolve(undefined)
    }

    const { info } = call

    if (info === null) return Promise.resolve(undefined)

    // SAFETY: the recording holds what getSessionInfo returned for this call when it was recorded.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- See SAFETY above.
    const saved = denormalize(info) as SDKSessionInfo

    return Promise.resolve(saved)
  }

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

    if (nextCall < recorded.calls.length)
      problems.push(`Glass never made ${recorded.calls.length - nextCall} recorded lookups`)

    const unsent = programs.reduce((total, program) => total + program.unsent(), 0)

    if (unsent > 0) problems.push(`Glass never sent ${unsent} recorded lines`)

    if (problems.length > 0) throw new Error(problems.join("\n"))
  })

  return { claude, spawner, sessionInfo, mismatch, finish }
}
