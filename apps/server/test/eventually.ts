import { Effect, Exit } from "effect"

// Native timers, so polling keeps going while a test holds the TestClock still.
const liveSleep = (millis: number) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), millis)

    return Effect.sync(() => clearTimeout(timer))
  })

export const eventually = <A, E, R>(check: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 25_000

    while (true) {
      const exit = yield* Effect.exit(check)

      if (Exit.isSuccess(exit) || Date.now() > deadline) return yield* exit
      yield* liveSleep(20)
    }
  })
