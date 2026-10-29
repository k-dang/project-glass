import { TOKEN_PARAM } from "@glass/contracts"
import { Data, Deferred, Duration, Effect, Schedule } from "effect"
import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"

const LOG_ROTATE_BYTES = 5 * 1024 * 1024

const RESTART_DELAYS = [Duration.millis(500), Duration.seconds(1), Duration.seconds(2)]

const HEALTHY_RUN = Duration.minutes(1)

export class BackendError extends Data.TaggedError("BackendError")<{
  readonly message: string
}> {}

export const openBackendLog = Effect.fn("openBackendLog")(function* (path: string) {
  const opened = yield* Deferred.make<void, BackendError>()
  const failed = yield* Deferred.make<never, BackendError>()

  const onOpen = () => {
    Deferred.doneUnsafe(opened, Effect.void)
  }

  const onError = (cause: Error) => {
    const failure = Effect.fail(
      new BackendError({ message: `Backend log failed: ${cause.message}` }),
    )

    Deferred.doneUnsafe(opened, failure)
    Deferred.doneUnsafe(failed, failure)
  }

  const stream = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true })

        if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) >= LOG_ROTATE_BYTES) {
          renameSync(path, path.replace(/\.log$/, ".previous.log"))
        }

        return createWriteStream(path, { flags: "a" }).once("open", onOpen).on("error", onError)
      },
      catch: (cause) =>
        new BackendError({ message: `Couldn't open backend log: ${String(cause)}` }),
    }),
    (log) =>
      Effect.callback<void>((resume) => {
        const closed = () => {
          log.off("open", onOpen)
          log.off("error", onError)
          resume(Effect.void)
        }

        if (log.closed) return closed()

        log.once("close", closed)
        log.end()
      }),
  )

  yield* Deferred.await(opened)

  return { stream, failed: Deferred.await(failed) }
})

export const waitForBackend = Effect.fn("waitForBackend")((port: number, token: string) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`http://127.0.0.1:${port}/health?${TOKEN_PARAM}=${token}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      }),
    catch: () => new BackendError({ message: "Backend is not answering" }),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => new BackendError({ message: `Backend answered HTTP ${response.status}` }),
    ),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.fail(new BackendError({ message: "Backend did not start in time" })),
    }),
    Effect.asVoid,
  ),
)

export const keepRunning = Effect.fn("keepRunning")(function* (
  run: Effect.Effect<never, BackendError>,
  onRestart: (error: BackendError, delay: Duration.Duration) => Effect.Effect<void>,
) {
  let failures = 0

  while (true) {
    const [ranFor, error] = yield* Effect.timed(Effect.flip(run))
    failures = Duration.isGreaterThanOrEqualTo(ranFor, HEALTHY_RUN) ? 1 : failures + 1
    const delay = RESTART_DELAYS[failures - 1]

    if (delay === undefined) return yield* error

    yield* onRestart(error, delay)
    yield* Effect.sleep(delay)
  }
})
