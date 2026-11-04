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
