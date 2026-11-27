import {
  RPC_PATH,
  THREAD_FILES_PATH,
  type PlaceTag,
  TOKEN_PARAM,
  VISUALIZATIONS_PATH,
} from "@glass/contracts"
import {
  BACKEND_READY,
  type BackendEndpoint,
  type BackendFailure,
  STOP_BACKEND,
} from "@glass/contracts/desktop"
import { Cause, Duration, Effect, Fiber, Option } from "effect"
import { app, utilityProcess } from "electron"
import { randomBytes, randomUUID } from "node:crypto"
import { BackendError, keepRunning, openBackendLog } from "./backendIo"
import { lastBoundPortOrFree } from "./backendPort"
import { prependLoginShellPath } from "./loginShellPath"

const READY_DEADLINE = Duration.seconds(20)

const STOP_DEADLINE = Duration.seconds(10)

const GLASS_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(["", ".", ".."])

const backendUrl = (endpoint: BackendEndpoint, route: string, segments: ReadonlyArray<string>) => {
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) return null

  const url = new URL(
    `${route}/${segments.map(encodeURIComponent).join("/")}`,
    endpoint.url.replace(/^ws/, "http"),
  )

  url.searchParams.set(TOKEN_PARAM, endpoint.token)

  return url.href
}

export const threadFileUrl = (
  endpoint: BackendEndpoint,
  place: PlaceTag,
  file: { readonly threadId: string; readonly path: ReadonlyArray<string> },
) =>
  GLASS_ID.test(file.threadId)
    ? backendUrl(endpoint, THREAD_FILES_PATH, [place, file.threadId, ...file.path])
    : null

export const visualizationUrl = (endpoint: BackendEndpoint, id: string) =>
  GLASS_ID.test(id) ? backendUrl(endpoint, VISUALIZATIONS_PATH, [id]) : null

export interface BackendProcess {
  readonly ready: Promise<void>
  readonly exited: Promise<number>
  readonly running: () => boolean
  readonly stop: () => void
  readonly kill: () => void
}

type ForkBackend = (env: Readonly<Record<string, string>>) => BackendProcess

type Note = (level: "INFO" | "ERROR", message: string) => Effect.Effect<void>

const stopBackend = (backend: BackendProcess) =>
  Effect.sync(backend.stop).pipe(
    Effect.andThen(Effect.promise(() => backend.exited)),
    Effect.timeoutOrElse({
      duration: STOP_DEADLINE,
      orElse: () =>
        Effect.sync(backend.kill).pipe(Effect.andThen(Effect.promise(() => backend.exited))),
    }),
  )

export const launchBackend = Effect.fn("launchBackend")(function* (options: {
  readonly fork: ForkBackend
  readonly rendererOrigin: string
  readonly dataDirectory: string
  readonly onReady: (endpoint: BackendEndpoint) => void
  readonly onDown: () => void
  readonly note: Note
}) {
  const port = yield* Effect.tryPromise({
    try: () => lastBoundPortOrFree(options.dataDirectory),
    catch: (cause) =>
      new BackendError({
        message: cause instanceof Error ? cause.message : "No free port",
      }),
  })

  const token = randomBytes(32).toString("base64url")

  const backend = yield* Effect.acquireRelease(
    Effect.sync(() =>
      options.fork({
        GLASS_PORT: String(port),
        GLASS_TOKEN: token,
        GLASS_ALLOWED_ORIGINS: options.rendererOrigin,
        GLASS_DATA_DIRECTORY: options.dataDirectory,
      }),
    ),
    (started) =>
      started.running()
        ? stopBackend(started).pipe(
            Effect.flatMap((code) => options.note("INFO", `Backend stopped with code ${code}`)),
          )
        : Effect.void,
  )

  const exited = Effect.promise(() => backend.exited).pipe(
    Effect.flatMap((code) =>
      Effect.fail(new BackendError({ message: `Backend exited with code ${code}` })),
    ),
  )

  yield* Effect.raceFirst(
    Effect.promise(() => backend.ready),
    exited,
  ).pipe(
    Effect.timeoutOrElse({
      duration: READY_DEADLINE,
      orElse: () => Effect.fail(new BackendError({ message: "Backend did not start in time" })),
    }),
  )

  options.onReady({ url: `ws://127.0.0.1:${port}${RPC_PATH}`, token })

  return yield* exited.pipe(Effect.ensuring(Effect.sync(options.onDown)))
}, Effect.scoped)

const forkUtilityProcess = (
  entry: string,
  env: Readonly<Record<string, string>>,
  output: { readonly stdout: (chunk: Buffer) => void; readonly stderr: (chunk: Buffer) => void },
): BackendProcess => {
  const child = utilityProcess.fork(entry, [], {
    serviceName: "Glass backend",
    stdio: "pipe",
    env: { ...process.env, ...env },
  })

  child.stdout?.on("data", output.stdout)
  child.stderr?.on("data", output.stderr)

  return {
    ready: new Promise((resolve) =>
      child.on("message", (message) => {
        if (message === BACKEND_READY) resolve()
      }),
    ),
    exited: new Promise((resolve) => child.once("exit", resolve)),
    running: () => child.pid !== undefined,
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A UtilityProcess takes no target origin.
    stop: () => child.postMessage(STOP_BACKEND),
    kill: () => child.kill(),
  }
}

const superviseBackend = Effect.fn("superviseBackend")(function* ({
  entry,
  logFile,
  ...options
}: {
  readonly entry: string
  readonly rendererOrigin: string
  readonly logFile: string
  readonly dataDirectory: string
  readonly onReady: (endpoint: BackendEndpoint) => void
  readonly onDown: () => void
}) {
  const log = yield* openBackendLog(logFile)

  const writeOutput = (chunk: Buffer) => {
    log.stream.write(chunk)
  }

  const relayStderr = (chunk: Buffer) => {
    writeOutput(chunk)
    process.stderr.write(chunk)
  }

  const launch = {
    source: "desktop",
    launch_id: randomUUID(),
    platform: `${process.platform}-${process.arch}`,
  }

  const note: Note = (level, message) =>
    Effect.sync(() =>
      writeOutput(
        Buffer.from(
          `${JSON.stringify({ at: new Date().toISOString(), ...launch, level, message })}\n`,
        ),
      ),
    )

  const run = note("INFO", "Starting backend").pipe(
    Effect.andThen(
      launchBackend({
        ...options,
        fork: (env) => forkUtilityProcess(entry, env, { stdout: writeOutput, stderr: relayStderr }),
        note,
      }),
    ),
  )

  return yield* keepRunning(run, (error, delay) =>
    note("ERROR", `${error.message}; restarting in ${Duration.format(delay)}`),
  ).pipe(
    Effect.tapError((error) => note("ERROR", `${error.message}; giving up`)),
    Effect.raceFirst(log.failed),
  )
})

export const runBackend = ({
  onReady,
  onFailure,
  ...options
}: {
  readonly entry: string
  readonly rendererOrigin: string
  readonly logFile: string
  readonly dataDirectory: string
  readonly onReady: (endpoint: BackendEndpoint) => void
  readonly onDown: () => void
  readonly onFailure: (kind: BackendFailure["kind"], message: string) => void
}) => {
  let started = false

  const program = Effect.gen(function* () {
    if (app.isPackaged && process.platform !== "win32") {
      yield* prependLoginShellPath(process.env, [
        process.env["SHELL"],
        process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
      ])
    }

    return yield* superviseBackend({
      ...options,
      onReady: (endpoint) => {
        started = true
        onReady(endpoint)
      },
    })
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        if (Cause.hasInterruptsOnly(cause)) return

        Option.match(Cause.findErrorOption(cause), {
          onSome: (error) => onFailure(started ? "crash" : "start", error.message),
          onNone: () => {
            console.error(Cause.pretty(cause))
            onFailure("start", "Unexpected error while starting the backend")
          },
        })
      }),
    ),
  )

  const fiber = Effect.runFork(program)

  app.on("will-quit", (event) => {
    if (fiber.pollUnsafe() !== undefined) return
    event.preventDefault()
    void Effect.runPromise(Fiber.interrupt(fiber)).finally(() => app.quit())
  })
}
