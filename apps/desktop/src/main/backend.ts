import {
  RPC_PATH,
  THREAD_FILES_PATH,
  type PlaceTag,
  TOKEN_PARAM,
  VISUALIZATIONS_PATH,
} from "@glass/contracts"
import type { BackendEndpoint, BackendFailure } from "@glass/contracts/desktop"
import { Cause, Deferred, Duration, Effect, Fiber, Option } from "effect"
import { app, type UtilityProcess, utilityProcess } from "electron"
import { randomBytes, randomUUID } from "node:crypto"
import { BackendError, keepRunning, openBackendLog, waitForBackend } from "./backendIo"
import { lastBoundPortOrFree } from "./backendPort"
import { prependLoginShellPath } from "./loginShellPath"

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

// WARNING: UtilityProcess.kill() SIGKILLs 2 s after its SIGTERM (Chromium EnsureProcessTerminated), cutting off the Agent host's shutdown.
const stopBackend = (backend: UtilityProcess, exitCode: Promise<number>) =>
  Effect.sync(() => {
    if (backend.pid !== undefined) process.kill(backend.pid, "SIGINT")
  }).pipe(
    Effect.andThen(Effect.promise(() => exitCode)),
    Effect.timeoutOrElse({
      duration: STOP_DEADLINE,
      orElse: () =>
        Effect.sync(() => backend.kill()).pipe(Effect.andThen(Effect.promise(() => exitCode))),
    }),
    Effect.asVoid,
  )

const startBackend = Effect.fn("startBackend")(function* (options: {
  readonly entry: string
  readonly rendererOrigin: string
  readonly logFile: string
  readonly dataDirectory: string
}) {
  const port = yield* Effect.tryPromise({
    try: () => lastBoundPortOrFree(options.dataDirectory),
    catch: (cause) =>
      new BackendError({
        message: cause instanceof Error ? cause.message : "No free port",
      }),
  })

  const token = randomBytes(32).toString("base64url")
  const log = yield* openBackendLog(options.logFile)
  const ready = yield* Deferred.make<void>()

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

  const note = (level: "INFO" | "ERROR", message: string) =>
    Effect.sync(() =>
      writeOutput(
        Buffer.from(
          `${JSON.stringify({ at: new Date().toISOString(), ...launch, level, message })}\n`,
        ),
      ),
    )

  const run = Effect.gen(function* () {
    yield* note("INFO", "Starting backend")

    const { exitCode } = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const backend = utilityProcess.fork(options.entry, [], {
          serviceName: "Glass backend",
          stdio: "pipe",
          env: {
            ...process.env,
            GLASS_PORT: String(port),
            GLASS_TOKEN: token,
            GLASS_ALLOWED_ORIGINS: options.rendererOrigin,
            GLASS_DATA_DIRECTORY: options.dataDirectory,
          },
        })

        backend.stdout?.on("data", writeOutput)
        backend.stderr?.on("data", relayStderr)

        return {
          backend,
          exitCode: new Promise<number>((resolve) => backend.once("exit", resolve)),
        }
      }),
      (started) => stopBackend(started.backend, started.exitCode),
    )

    const exited = Effect.promise(() => exitCode).pipe(
      Effect.flatMap((code) =>
        Effect.fail(new BackendError({ message: `Backend exited with code ${code}` })),
      ),
    )

    yield* Effect.raceFirst(waitForBackend(port, token), exited)
    yield* Deferred.succeed(ready, undefined)

    return yield* exited
  }).pipe(Effect.scoped)

  const supervisor = yield* keepRunning(run, (error, delay) =>
    note("ERROR", `${error.message}; restarting in ${Duration.format(delay)}`),
  ).pipe(
    Effect.tapError((error) => note("ERROR", `${error.message}; giving up`)),
    Effect.raceFirst(log.failed),
    Effect.forkScoped,
  )

  const failed = Fiber.join(supervisor)

  yield* Effect.raceFirst(Deferred.await(ready), failed)

  return {
    endpoint: { url: `ws://127.0.0.1:${port}${RPC_PATH}`, token } satisfies BackendEndpoint,
    failed,
  }
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
  readonly onFailure: (kind: BackendFailure["kind"], message: string) => void
}) => {
  const program = Effect.gen(function* () {
    if (app.isPackaged && process.platform !== "win32") {
      yield* prependLoginShellPath(process.env, [
        process.env["SHELL"],
        process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
      ])
    }

    const backend = yield* startBackend(options)

    onReady(backend.endpoint)
    onFailure("crash", (yield* Effect.flip(backend.failed)).message)
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        if (Cause.hasInterruptsOnly(cause)) return

        Option.match(Cause.findErrorOption(cause), {
          onSome: (error) => onFailure("start", error.message),
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
