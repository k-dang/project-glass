import { Duration, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { BackendError, keepRunning, openBackendLog, waitForBackend } from "./backendIo"

const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "glass-backend-io-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

describe("backend log", () => {
  it("appends to a small log and flushes output before closing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* tempDirectory
        const path = join(directory, "backend.log")
        yield* Effect.promise(() => writeFile(path, "previous launch\n"))

        const stream = yield* Effect.gen(function* () {
          const log = yield* openBackendLog(path)
          log.stream.write("current launch")

          return log.stream
        }).pipe(Effect.scoped)

        expect(stream.closed).toBe(true)
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          "previous launch\ncurrent launch",
        )
      }).pipe(Effect.scoped),
    ))

  it("rotates a large log aside before appending", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* tempDirectory
        const path = join(directory, "backend.log")
        const large = "x".repeat(5 * 1024 * 1024)
        yield* Effect.promise(() => writeFile(path, large))

        yield* Effect.gen(function* () {
          const log = yield* openBackendLog(path)
          log.stream.write("current launch")
        }).pipe(Effect.scoped)

        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe("current launch")
        expect(
          yield* Effect.promise(() => readFile(join(directory, "backend.previous.log"), "utf8")),
        ).toBe(large)
      }).pipe(Effect.scoped),
    ))

  it("reports an unusable log path as a typed failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* tempDirectory
        const existing = join(directory, "existing")
        yield* Effect.promise(() => writeFile(existing, "not a directory"))

        const error = yield* openBackendLog(join(existing, "backend.log")).pipe(
          Effect.scoped,
          Effect.flip,
        )

        expect(error).toBeInstanceOf(BackendError)
        expect(error.message).toMatch(/backend log/i)
      }).pipe(Effect.scoped),
    ))

  it("reports errors after opening and closes the failed stream", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* tempDirectory

        const stream = yield* Effect.gen(function* () {
          const log = yield* openBackendLog(join(directory, "backend.log"))
          log.stream.destroy(new Error("simulated disk failure"))
          const error = yield* Effect.flip(log.failed)

          expect(error).toBeInstanceOf(BackendError)
          expect(error.message).toContain("simulated disk failure")

          return log.stream
        }).pipe(Effect.scoped)

        expect(stream.closed).toBe(true)
      }).pipe(Effect.scoped),
    ))
})

it("aborts the health request when startup is interrupted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const accepted = Promise.withResolvers<string>()
      const disconnected = Promise.withResolvers<void>()

      const server = createServer((request) => {
        request.once("close", () => disconnected.resolve())
        accepted.resolve(request.url ?? "")
      })

      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        ),
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
      expect(yield* Effect.promise(() => accepted.promise)).toBe("/health?token=test-token")

      yield* Fiber.interrupt(starting)
      yield* Effect.promise(() => disconnected.promise).pipe(Effect.timeout("1 second"))
    }).pipe(Effect.scoped),
  ))

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
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

describe("keepRunning", () => {
  it("restarts with growing delays, then gives up with the last failure", async () => {
    expect(await supervise(() => 0)).toEqual({
      runs: 4,
      delays: [500, 1000, 2000],
      error: "crash 4",
    })
  })

  it("restores the restart budget after a run that stayed up", async () => {
    expect(await supervise((run) => (run === 4 ? "1 minute" : 0))).toEqual({
      runs: 7,
      delays: [500, 1000, 2000, 500, 1000, 2000],
      error: "crash 7",
    })
  })
})
