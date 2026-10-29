import { type PullRequestRef, referenceKey } from "@glass/contracts"
import {
  Cause,
  Effect,
  Fiber,
  type Option,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"

export interface PullRequestJob<S> {
  readonly state: SubscriptionRef.SubscriptionRef<S>
  readonly lock: Semaphore.Semaphore
  running: { readonly fiber: Fiber.Fiber<void>; readonly background: boolean } | null
}

export const pullRequestJobs = Effect.fnUntraced(function* <S, E>(options: {
  readonly load: (pr: PullRequestRef) => Effect.Effect<S, E>
  readonly inProgress: (state: S) => boolean
  readonly idle: (state: S) => S
}) {
  const scope = yield* Scope.Scope
  const jobs = new Map<string, PullRequestJob<S>>()
  const jobsLock = yield* Semaphore.make(1)

  const jobFor = Effect.fnUntraced(function* (pr: PullRequestRef) {
    const key = referenceKey(pr)
    const existing = jobs.get(key)

    if (existing !== undefined) return existing

    const job: PullRequestJob<S> = {
      state: yield* SubscriptionRef.make(yield* options.load(pr)),
      lock: yield* Semaphore.make(1),
      running: null,
    }

    jobs.set(key, job)

    return job
  }, jobsLock.withPermits(1))

  const locked = <A, E2, R>(job: PullRequestJob<S>, change: Effect.Effect<A, E2, R>) =>
    change.pipe(job.lock.withPermits(1), Effect.uninterruptible)

  const replace = Effect.fnUntraced(function* (
    job: PullRequestJob<S>,
    work: Effect.Effect<void>,
    background = false,
  ) {
    if (job.running !== null) yield* Fiber.interrupt(job.running.fiber)

    job.running = {
      fiber: yield* work.pipe(Effect.forkIn(scope, { uninterruptible: false })),
      background,
    }
  })

  const stopJob = (job: PullRequestJob<S>, onlyBackground: boolean) =>
    locked(
      job,
      Effect.gen(function* () {
        if (job.running === null || (onlyBackground && !job.running.background)) return
        yield* Fiber.interrupt(job.running.fiber)
        job.running = null

        if (options.inProgress(yield* SubscriptionRef.get(job.state)))
          yield* SubscriptionRef.update(job.state, options.idle)
      }),
    )

  const commit = <E2>(job: PullRequestJob<S>, save: Effect.Effect<void, E2>, next: S) =>
    save.pipe(
      Effect.andThen(SubscriptionRef.set(job.state, next)),
      Effect.uninterruptible,
      job.lock.withPermits(1),
    )

  const settle =
    <F>(job: PullRequestJob<S>, failed: (state: S, error: Option.Option<F>) => S) =>
    <A>(work: Effect.Effect<A, F>) =>
      work.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(cause)) yield* Effect.interrupt

            yield* SubscriptionRef.update(job.state, (state) =>
              options.inProgress(state) ? failed(state, Cause.findErrorOption(cause)) : state,
            )
          }),
        ),
      )

  const watch = (pr: PullRequestRef) =>
    Stream.unwrap(jobFor(pr).pipe(Effect.map((job) => SubscriptionRef.changes(job.state))))

  return {
    jobFor,
    locked,
    begin: <A, E2, R>(
      job: PullRequestJob<S>,
      next: (
        replace: (work: Effect.Effect<void>, background?: boolean) => Effect.Effect<void>,
      ) => Effect.Effect<A, E2, R>,
    ) =>
      locked(
        job,
        Effect.suspend(() => next((work, background) => replace(job, work, background))),
      ),
    stop: (job: PullRequestJob<S>) => stopJob(job, false),
    stopBackground: () =>
      Effect.forEach([...jobs.values()], (job) => stopJob(job, true), {
        concurrency: "unbounded",
        discard: true,
      }),
    commit,
    settle,
    watch,
  }
})
