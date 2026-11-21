import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { keyedLock } from "./keyedLock"

const holding = (log: Array<string>, name: string, release: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    log.push(`${name} start`)
    yield* Deferred.await(release)
    log.push(`${name} end`)
  })

it.effect("runs one holder per key at a time and forgets the key once released", () =>
  Effect.gen(function* () {
    const lock = keyedLock()
    const log: Array<string> = []
    const releaseFirst = yield* Deferred.make<void>()
    const releaseSecond = yield* Deferred.make<void>()

    const first = yield* Effect.forkChild(lock.withLock("a", holding(log, "first", releaseFirst)), {
      startImmediately: true,
    })

    const second = yield* Effect.forkChild(
      lock.withLock("a", holding(log, "second", releaseSecond)),
      { startImmediately: true },
    )

    assert.deepStrictEqual(log, ["first start"])
    assert.deepStrictEqual(yield* lock.activeKeys, ["a"])

    yield* Deferred.succeed(releaseFirst, undefined)
    yield* Fiber.join(first)
    assert.deepStrictEqual(yield* lock.activeKeys, ["a"])
    yield* Deferred.succeed(releaseSecond, undefined)
    yield* Fiber.join(second)

    assert.deepStrictEqual(log, ["first start", "first end", "second start", "second end"])
    assert.deepStrictEqual(yield* lock.activeKeys, [])
  }),
)

it.effect("runs different keys concurrently", () =>
  Effect.gen(function* () {
    const lock = keyedLock()
    const release = yield* Deferred.make<void>()
    const entered = yield* Deferred.make<void>()

    const holder = yield* Effect.forkChild(
      lock.withLock(
        "a",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    )

    yield* Deferred.await(entered)
    yield* lock.withLock("b", Effect.void)

    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    assert.deepStrictEqual(yield* lock.activeKeys, [])
  }),
)

it.effect("forgets the key when the holder and a waiter are interrupted", () =>
  Effect.gen(function* () {
    const lock = keyedLock()
    const entered = yield* Deferred.make<void>()

    const holder = yield* Effect.forkChild(
      lock.withLock("a", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
    )

    yield* Deferred.await(entered)

    const waiter = yield* Effect.forkChild(lock.withLock("a", Effect.void), {
      startImmediately: true,
    })

    yield* Fiber.interrupt(waiter)
    assert.deepStrictEqual(yield* lock.activeKeys, ["a"])

    yield* Fiber.interrupt(holder)
    assert.deepStrictEqual(yield* lock.activeKeys, [])
  }),
)
