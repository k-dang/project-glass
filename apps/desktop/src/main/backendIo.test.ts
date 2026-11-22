import { Duration, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { BackendError, keepRunning, openBackendLog, waitForBackend } from "./backendIo"

const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "glass-backend-io-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

describe("backend log", () => {
  it.live("appends to a small log and flushes output before closing", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const path = join(directory, "backend.log")
      yield* Effect.promise(() => writeFile(path, "previous launch\n"))

      const stream = yield* Effect.gen(function* () {
        const log = yield* openBackendLog(path)
        log.stream.write("current launch")

        return log.stream
      }).pipe(Effect.scoped)

      assert.strictEqual(stream.closed, true)
      assert.strictEqual(
        yield* Effect.promise(() => readFile(path, "utf8")),
        "previous launch\ncurrent launch",
      )
    }),
  )

  it.live("rotates a large log aside before appending", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const path = join(directory, "backend.log")
      const large = "x".repeat(5 * 1024 * 1024)
      yield* Effect.promise(() => writeFile(path, large))

      yield* Effect.gen(function* () {
        const log = yield* openBackendLog(path)
        log.stream.write("current launch")
      }).pipe(Effect.scoped)

      assert.strictEqual(yield* Effect.promise(() => readFile(path, "utf8")), "current launch")
      assert.strictEqual(
        yield* Effect.promise(() => readFile(join(directory, "backend.previous.log"), "utf8")),
        large,
      )
    }),
  )

  it.live("reports an unusable log path as a typed failure", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory
      const existing = join(directory, "existing")
      yield* Effect.promise(() => writeFile(existing, "not a directory"))

      const error = yield* openBackendLog(join(existing, "backend.log")).pipe(
        Effect.scoped,
        Effect.flip,
      )

      assert.instanceOf(error, BackendError)
      assert.match(error.message, /backend log/i)
    }),
  )

  it.live("reports errors after opening and closes the failed stream", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory

      const stream = yield* Effect.gen(function* () {
        const log = yield* openBackendLog(join(directory, "backend.log"))
        log.stream.destroy(new Error("simulated disk failure"))
        const error = yield* Effect.flip(log.failed)

        assert.instanceOf(error, BackendError)
        assert.include(error.message, "simulated disk failure")

        return log.stream
      }).pipe(Effect.scoped)

      assert.strictEqual(stream.closed, true)
    }),
  )
})

it.live("aborts the health request when startup is interrupted", () =>
  Effect.gen(function* () {
    const accepted = Promise.withResolvers<string>()
    const disconnected = Promise.withResolvers<void>()

    const server = createServer((request) => {
      request.once("close", () => disconnected.resolve())
      accepted.resolve(request.url ?? "")
    })

    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections()
              server.close(() => resolve())
            }),
        ),
    )

    const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(
      server.address(),
    )

    const starting = yield* waitForBackend(address.port, "test-token").pipe(Effect.forkChild())
    assert.strictEqual(yield* Effect.promise(() => accepted.promise), "/health?token=test-token")

    yield* Fiber.interrupt(starting)
    yield* Effect.promise(() => disconnected.promise)
  }),
)

const supervise = (runFor: (run: number) => Duration.Input) =>
  Effect.gen(function* () {
    let runs = 0
    const delays: Array<number> = []

    const fiber = yield* keepRunning(
      Effect.suspend(() => {
        runs++

        return Effect.sleep(runFor(runs)).pipe(
          Effect.andThen(Effect.fail(new BackendError({ message: `crash ${runs}` }))),
        )
      }),
      (_, delay) => Effect.sync(() => delays.push(Duration.toMillis(delay))),
    ).pipe(Effect.flip, Effect.forkChild())

    yield* TestClock.adjust("10 minutes")
    const error = yield* Fiber.join(fiber)

    return { runs, delays, error: error.message }
  })

describe("keepRunning", () => {
  it.effect("restarts with growing delays, then gives up with the last failure", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* supervise(() => 0), {
        runs: 4,
        delays: [500, 1000, 2000],
        error: "crash 4",
      })
    }),
  )

  it.effect("restores the restart budget after a run that stayed up", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* supervise((run) => (run === 4 ? "1 minute" : 0)), {
        runs: 7,
        delays: [500, 1000, 2000, 500, 1000, 2000],
        error: "crash 7",
      })
    }),
  )
})
