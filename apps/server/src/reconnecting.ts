import { Duration, Effect, Result } from "effect"
import { isSandboxGone } from "./sandboxFailures"

const LOST_AFTER_MISSES = 4

const QUICK_RETRY_SPACING = Duration.millis(500)

const FIRST_LOST_RETRY_SPACING = Duration.seconds(5)

const MAX_LOST_RETRY_SPACING = Duration.minutes(5)

const GIVE_UP_AFTER = Duration.hours(1)

export const reconnecting = <E, R>(
  session: (connected: Effect.Effect<void>) => Effect.Effect<void, E, R>,
  onLost: (error: E) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    let misses = 0
    let lostFor = Duration.zero

    const connected = Effect.sync(() => {
      misses = 0
      lostFor = Duration.zero
    })

    for (;;) {
      const ended = yield* Effect.result(session(connected))

      if (Result.isSuccess(ended)) return yield* Effect.void

      const error = ended.failure

      if (isSandboxGone(error)) return yield* Effect.fail(error)

      misses += 1

      if (misses < LOST_AFTER_MISSES) {
        yield* Effect.sleep(QUICK_RETRY_SPACING)
        continue
      }

      if (misses === LOST_AFTER_MISSES) yield* onLost(error)

      if (Duration.isGreaterThanOrEqualTo(lostFor, GIVE_UP_AFTER)) return yield* Effect.fail(error)

      const spacing = Duration.min(
        Duration.times(FIRST_LOST_RETRY_SPACING, 2 ** (misses - LOST_AFTER_MISSES)),
        MAX_LOST_RETRY_SPACING,
      )

      lostFor = Duration.sum(lostFor, spacing)
      yield* Effect.sleep(spacing)
    }
  })
