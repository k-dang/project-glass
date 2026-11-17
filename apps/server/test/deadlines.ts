import { Clock, Duration, Effect, Queue } from "effect"

export const watchDeadlines = (deadline: number) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const set = yield* Queue.unbounded<void>()

    const sleep = (duration: Duration.Duration) =>
      Duration.toMillis(duration) === deadline
        ? Queue.offer(set, undefined).pipe(Effect.andThen(clock.sleep(duration)))
        : clock.sleep(duration)

    const watched: Clock.Clock = Object.assign(Object.create(clock), { sleep })

    return { watched, deadlineSet: Queue.take(set) }
  })

export const withWatchedClock = <A, E, R>(
  deadline: Duration.Duration,
  test: (deadlineSet: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const { watched, deadlineSet } = yield* watchDeadlines(Duration.toMillis(deadline))

    return yield* test(deadlineSet).pipe(Effect.provideService(Clock.Clock, watched))
  })
