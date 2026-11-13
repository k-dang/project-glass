import { Deferred, Effect, Schema, Sink, Stream, Predicate } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { startOpenCode } from "../src/agentHost/openCodeRuntime"
import { denormalizer, mapStrings, normalizer, parseLine, installedProgram } from "./replay"
import { blankPersonal, recordingSessions, tryMatch } from "./sessionTape"
import { counter } from "./counter"

const Frame = Schema.Union([
  Schema.Struct({
    request: Schema.Int,
    method: Schema.String,
    path: Schema.String,
    body: Schema.Json,
    directory: Schema.String,
    authenticated: Schema.Boolean,
  }),
  Schema.Struct({
    response: Schema.Int,
    status: Schema.Int,
    body: Schema.Json,
    stream: Schema.Boolean,
    cursor: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ event: Schema.Json, stream: Schema.Int }),
  Schema.Struct({ end: Schema.Int }),
  Schema.Struct({ launch: Schema.Json }),
  Schema.Struct({ failure: Schema.Int }),
  Schema.Struct({ crash: Schema.Literal(true) }),
])

const Header = Schema.fromJsonString(Schema.Struct({ program: Schema.String }))

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame))

type Frame = typeof Frame.Type

const program = `opencode 1.19.5; ${installedProgram(fileURLToPath(new URL("../node_modules/@opencode-ai/sdk/package.json", import.meta.url)))}`

const readTape = (path: string) => {
  const [header, ...frames] = readFileSync(path, "utf8").trimEnd().split(/\r?\n/)

  return {
    ...Schema.decodeUnknownSync(Header)(header),
    frames: frames.map((frame) => decodeFrame(frame)),
  }
}

export const openCodeSessionTape = (scenario: string, places: Readonly<Record<string, string>>) => {
  const path = fileURLToPath(
    new URL(`./recordings/sessions/opencode-${scenario}.ndjson`, import.meta.url),
  )

  const normalizeText = normalizer(places)
  const normalize = (value: Schema.Json) => blankPersonal(mapStrings(value, normalizeText))
  const denormalize = denormalizer(places)

  const recorded = recordingSessions ? { program, frames: [] } : readTape(path)

  if (recorded.program !== program)
    throw new Error("OpenCode's recording is stale. Run record:sessions opencode.")
  const frames: Array<Frame> = []
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  const clients: Array<OpencodeClient> = []
  const credentials = new Set<string>()
  const processes: Array<ChildProcessSpawner.ChildProcessHandle> = []
  const started = counter()
  let dropAbort = false
  let rejectSubscriptions = false
  let crashing = false
  const ids = new Map<string, string>()

  const incoming = (value: Schema.Json) =>
    mapStrings(denormalize(value), (text) =>
      [...ids].reduce((current, [from, to]) => current.replaceAll(from, to), text),
    )

  let nextRequest = 0
  let position = 0
  let problem: Error | undefined
  let fail: ((error: Error) => void) | undefined

  const mismatch = Effect.callback<never, Error>((resume) => {
    fail = (error) => resume(Effect.fail(error))

    if (problem !== undefined) fail?.(problem)
  })

  const pending: Array<{
    frame: Extract<Frame, { request: number }>
    resolve: (response: Response) => void
    reject: (error: Error) => void
  }> = []

  const launches: Array<{ launch: Schema.Json }> = []

  const responses = new Map<number, (response: Response) => void>()
  const failures = new Map<number, (error: Error) => void>()
  const streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()

  const complain = (message: string) => {
    problem = new Error(message)
    fail?.(problem)
  }

  const pump = () => {
    while (position < recorded.frames.length) {
      const frame = recorded.frames[position]!

      if ("crash" in frame) {
        if (!crashing) return
        crashing = false
      } else if ("launch" in frame) {
        const actual = launches.shift()

        if (actual === undefined) return

        if (!tryMatch(frame, actual, ids)) {
          complain("OpenCode launch changed. Run record:sessions opencode.")

          return
        }
      } else if ("request" in frame) {
        const index = pending.findIndex((item) =>
          tryMatch(
            mapStrings(
              {
                method: frame.method,
                path: frame.path,
                body: frame.body,
                directory: frame.directory,
                authenticated: frame.authenticated,
              },
              (text) =>
                [...ids].reduce((current, [from, to]) => current.replaceAll(from, to), text),
            ),
            {
              method: item.frame.method,
              path: item.frame.path,
              body: item.frame.body,
              directory: item.frame.directory,
              authenticated: item.frame.authenticated,
            },
            ids,
          ),
        )

        if (index === -1) return
        const request = pending.splice(index, 1)[0]!
        responses.set(frame.request, request.resolve)
        failures.set(frame.request, request.reject)
      } else if ("failure" in frame) {
        failures.get(frame.failure)?.(new Error("OpenCode test connection failed"))
      } else if ("response" in frame) {
        const resolve = responses.get(frame.response)

        if (resolve === undefined) {
          complain("OpenCode response has no request")

          return
        }

        const body = frame.stream
          ? new ReadableStream<Uint8Array>({
              start: (controller) => {
                streams.set(frame.response, controller)
              },
            })
          : frame.status === 204
            ? null
            : JSON.stringify(incoming(frame.body))

        const headers = new Headers({
          "content-type": frame.stream ? "text/event-stream" : "application/json",
        })

        if (frame.cursor !== null) headers.set("x-next-cursor", frame.cursor)
        resolve(
          new Response(body, {
            status: frame.status,
            headers,
          }),
        )
      } else if ("end" in frame) {
        streams.get(frame.end)?.close()
        streams.delete(frame.end)
      } else {
        streams
          .get(frame.stream)
          ?.enqueue(encoder.encode(`data: ${JSON.stringify(incoming(frame.event))}\n\n`))
      }

      position++
    }
  }

  const transport: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const id = ++nextRequest

    const frame = {
      request: id,
      method: request.method,
      path: normalizeText(decodeURIComponent(url.pathname + url.search)),
      body: normalize(parseLine(await request.clone().text())),
      directory: normalizeText(
        decodeURIComponent(request.headers.get("x-opencode-directory") ?? ""),
      ),
      authenticated: credentials.has(request.headers.get("authorization") ?? ""),
    }

    if (!recordingSessions)
      return new Promise<Response>((resolve, reject) => {
        pending.push({ frame, resolve, reject })
        request.signal.addEventListener(
          "abort",
          () => {
            streams.get(id)?.error(new Error("OpenCode replay request was aborted"))
            streams.delete(id)
            reject(new Error("OpenCode replay request was aborted"))
          },
          { once: true },
        )
        setImmediate(pump)
      })
    frames.push(frame)

    if (
      (rejectSubscriptions && url.pathname === "/event") ||
      (dropAbort && url.pathname.endsWith("/abort"))
    ) {
      frames.push({ failure: id })
      throw new Error("OpenCode test connection failed")
    }

    const response = await globalThis.fetch(request).catch((error) => {
      frames.push({ failure: id })
      throw error
    })

    const stream = response.headers.get("content-type")?.includes("text/event-stream") === true

    if (!stream) {
      frames.push({
        response: id,
        status: response.status,
        body: normalize(parseLine(await response.clone().text())),
        stream: false,
        cursor: response.headers.get("x-next-cursor"),
      })

      return response
    }

    frames.push({ response: id, status: response.status, body: null, stream: true, cursor: null })
    let text = ""
    const decoder = new TextDecoder()
    const reader = response.body!.getReader()
    readers.add(reader)

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))

        if (chunk.done) {
          frames.push({ end: id })
          readers.delete(reader)
          controller.close()

          return
        }

        text += decoder.decode(chunk.value, { stream: true })
        let end = text.indexOf("\n\n")

        while (end !== -1) {
          const data = text
            .slice(0, end)
            .split("\n")
            .find((line) => line.startsWith("data: "))

          if (data !== undefined)
            frames.push({ event: normalize(parseLine(data.slice(6))), stream: id })
          text = text.slice(end + 2)
          end = text.indexOf("\n\n")
        }

        controller.enqueue(chunk.value)
      },
      cancel: () => reader.cancel(),
    })

    return new Response(body, { status: response.status, headers: response.headers })
  }

  const start: typeof startOpenCode = (command, folder, skills) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const recordedSpawner = ChildProcessSpawner.make((launch) =>
        Effect.gen(function* () {
          if (!Predicate.isTagged(launch, "StandardCommand"))
            return yield* Effect.die(new Error("OpenCode launch must be a single command"))
          const environment = launch.options.env ?? {}
          const password = environment["OPENCODE_SERVER_PASSWORD"]
          credentials.add(
            `Basic ${Buffer.from(`${environment["OPENCODE_SERVER_USERNAME"]}:${password}`).toString("base64")}`,
          )
          const port = launch.args.find((arg) => arg.startsWith("--port="))?.slice(7)

          const descriptor = {
            launch: normalize({
              executable: launch.command === command ? "<opencode>" : launch.command,
              args: launch.args.map((arg) => (arg.startsWith("--port=") ? "--port=<port>" : arg)),
              cwd: launch.options.cwd ?? "",
              config: JSON.parse(environment["OPENCODE_CONFIG_CONTENT"] ?? "null"),
              username: environment["OPENCODE_SERVER_USERNAME"] ?? null,
              password: (password?.length ?? 0) >= 32,
            }),
          }

          if (recordingSessions) {
            frames.push(descriptor)

            return yield* spawner.spawn(launch)
          }

          launches.push(descriptor)
          pump()
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>()

          const stdout = Stream.make(
            new TextEncoder().encode(`server listening on http://127.0.0.1:${port}\n`),
          )

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Deferred.await(exited),
            isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
            kill: () =>
              Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
            stdout,
            stderr: Stream.empty,
            all: stdout,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        }).pipe(Effect.tap((handle) => Effect.sync(() => processes.push(handle)))),
      )

      return yield* startOpenCode(command, folder, skills, transport).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordedSpawner),
        Effect.tap(({ version }) =>
          version === "1.19.5" ? Effect.void : Effect.die(new Error("Record with OpenCode 1.19.5")),
        ),
      )
    })

  return {
    start: (...args: Parameters<typeof startOpenCode>) =>
      start(...args).pipe(
        Effect.tap(({ client }) =>
          Effect.sync(() => {
            clients.push(client)
            started.add()
          }),
        ),
      ),
    clients,
    crash: Effect.gen(function* () {
      if (recordingSessions) frames.push({ crash: true })
      yield* processes.at(-1)!.kill()

      if (!recordingSessions) {
        crashing = true
        pump()
      }
    }),
    started: started.reached,
    dropAbortRequest: Effect.sync(() => {
      dropAbort = true
    }),
    failSubscriptions: Effect.sync(() => {
      rejectSubscriptions = true
    }),
    disconnect: Effect.promise(async () => {
      for (const reader of readers) await reader.cancel()
    }),
    mismatch,
    finish: Effect.sync(() => {
      if (recordingSessions) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(
          path,
          [JSON.stringify({ program }), ...frames.map((frame) => JSON.stringify(frame))].join(
            "\n",
          ) + "\n",
        )
      } else {
        // HTTP completion and SSE idle can coalesce the final reconciliation read.
        // Only complete, never-issued read blocks may remain; mutations and events
        // must be consumed, and every request Glass actually issued must match.
        const reads = new Set<number>()

        const optionalReads =
          recorded.frames.slice(position).every((frame) => {
            if (
              "request" in frame &&
              frame.method === "GET" &&
              /^\/(?:session\/[^/?]+\/message|session\/status|permission|question)(?:\?|$)/.test(
                frame.path,
              )
            ) {
              reads.add(frame.request)

              return true
            }

            if ("response" in frame) return reads.delete(frame.response)

            return "end" in frame
          }) && reads.size === 0

        if (
          problem !== undefined ||
          (!optionalReads && position !== recorded.frames.length) ||
          pending.length > 0
        )
          throw (
            problem ??
            new Error(
              `OpenCode recording stopped at ${position}/${recorded.frames.length}; pending: ${pending.map(({ frame }) => `${frame.method} ${frame.path}`).join(", ")}`,
            )
          )
      }
    }),
  }
}
