import { assert, it } from "@effect/vitest"
import { Clock, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { reconnecting } from "./reconnecting"
import { SandboxGone } from "./sandboxFailures"

const minutes = (millis: number) => millis / 60_000

it.effect("tries a lost Sandbox ever less often, and gives up after 15 minutes", () =>
  Effect.gen(function* () {
    const tries: Array<number> = []
    let lost = 0

    const running = yield* reconnecting(
      () =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.fail(`refused ${tries.push(now)}`)),
        ),
      () =>
        Effect.sync(() => {
          lost += 1
        }),
    ).pipe(Effect.forkChild)

    yield* TestClock.adjust("1 hour")

    assert.isTrue(Exit.isFailure(yield* Fiber.await(running)))
    assert.equal(lost, 1)

    const gaps = tries.slice(1).map((at, index) => at - tries[index]!)
    assert.deepStrictEqual(gaps.slice(0, 5), [500, 500, 500, 5_000, 10_000])
    assert.isAtMost(Math.max(...gaps), 5 * 60_000)

    const lostAt = tries[3]!
    const lastTry = tries.at(-1)!
    assert.isAtLeast(minutes(lastTry - lostAt), 15)
    assert.isBelow(minutes(lastTry - lostAt), 20)
  }),
)

it.effect("keeps trying a Sandbox that answers each time, and stops once it's gone", () =>
  Effect.gen(function* () {
    let tries = 0
    let lost = 0

    const running = yield* reconnecting(
      (connected) =>
        connected.pipe(
          Effect.andThen(
            Effect.suspend(() => Effect.fail(++tries > 1000 ? new SandboxGone() : "dropped")),
          ),
        ),
      () =>
        Effect.sync(() => {
          lost += 1
        }),
    ).pipe(Effect.forkChild)

    yield* TestClock.adjust("1 day")

    assert.instanceOf(yield* Fiber.join(running).pipe(Effect.flip), SandboxGone)
    assert.equal(lost, 0)
    assert.equal(tries, 1001)
  }),
)
