import { RPC_PATH } from "@glass/contracts"
import type { BackendEndpoint } from "@glass/contracts/desktop"
import { Deferred, Duration, Effect, Fiber, Schema } from "effect"
import { type UtilityProcess, utilityProcess } from "electron"
import { randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { BackendError, keepRunning, openBackendLog, waitForBackend } from "./backendIo"

const STOP_DEADLINE = Duration.seconds(10)

const decodeTcpAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))

const freePort = Effect.callback<number, BackendError>((resume) => {
  const server = createServer()
  server.once("error", (cause) =>
    resume(Effect.fail(new BackendError({ message: `No free port: ${cause.message}` }))),
  )
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()

    server.close(() =>
      resume(
        decodeTcpAddress(address).pipe(
          Effect.map(({ port }) => port),
          Effect.mapError(
            (cause) => new BackendError({ message: `No listening port: ${cause.message}` }),
          ),
        ),
      ),
    )
  })
})

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
}) {
  const port = yield* freePort
  const token = randomBytes(32).toString("base64url")
  const log = yield* openBackendLog(options.logFile)
  const ready = yield* Deferred.make<void>()

  const writeOutput = (chunk: Buffer) => {
    log.stream.write(chunk)
    process.stdout.write(chunk)
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
          },
        })

        for (const output of [backend.stdout, backend.stderr]) output?.on("data", writeOutput)

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
