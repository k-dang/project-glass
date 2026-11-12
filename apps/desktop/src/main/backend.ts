import { RPC_PATH } from "@glass/contracts"
import type { BackendEndpoint } from "@glass/contracts/desktop"
import { Deferred, Duration, Effect, Fiber } from "effect"
import { type UtilityProcess, utilityProcess } from "electron"
import { randomBytes, randomUUID } from "node:crypto"
import { BackendError, keepRunning, openBackendLog, waitForBackend } from "./backendIo"
import { choosePort } from "./backendPort"

const STOP_DEADLINE = Duration.seconds(10)

// `kill()` SIGKILLs a backend still running two seconds after its SIGTERM (Chromium's
// EnsureProcessTerminated), cutting off its shutdown of the Agent host.
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

export const startBackend = Effect.fn("startBackend")(function* (options: {
  readonly entry: string
  readonly rendererOrigin: string
  readonly logFile: string
  readonly dataDirectory: string
}) {
  const port = yield* Effect.tryPromise({
    try: () => choosePort(options.dataDirectory),
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

  // Stderr is filed and echoed, so warnings, errors and crash text show up in the terminal.
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
