import { type PullRequestRef, referenceKey } from "@glass/contracts"
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Option,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"

type Run<P, F> =
  | { readonly status: "idle" }
  | { readonly status: "waiting"; readonly fiber: Fiber.Fiber<void> }
  | {
      readonly status: "running"
      readonly fiber: Fiber.Fiber<void>
      readonly background: boolean
      readonly progress: P
    }
  | { readonly status: "failed"; readonly failure: F }

type Waiting<P, F> = Extract<Run<P, F>, { status: "waiting" }>

type Running<P, F> = Extract<Run<P, F>, { status: "running" }>

const isWaiting = <P, F>(run: Run<P, F>): run is Waiting<P, F> => run.status === "waiting"

const isRunning = <P, F>(run: Run<P, F>): run is Running<P, F> => run.status === "running"

const active = <P, F>(run: Run<P, F>) => isWaiting(run) || isRunning(run)

export interface JobState<O, P, F> {
  readonly output: O | null
  readonly run: Run<P, F>
}

export interface PullRequestJob<O, P, F> {
  readonly pr: string
  readonly state: SubscriptionRef.SubscriptionRef<JobState<O, P, F>>
  readonly lock: Semaphore.Semaphore
}

export const pullRequestJobs = Effect.fnUntraced(function* <O, P, F, S, E>(options: {
  readonly load: (pr: PullRequestRef) => Effect.Effect<O | null, E>
  readonly toState: (state: JobState<O, P, F>) => S
  readonly backgroundSlots: number
}) {
  const scope = yield* Scope.Scope
  const jobs = new Map<string, PullRequestJob<O, P, F>>()
  const jobsLock = yield* Semaphore.make(1)
  const backgroundSlots = yield* Semaphore.make(options.backgroundSlots)

  const jobFor = Effect.fnUntraced(function* (pr: PullRequestRef) {
    const key = referenceKey(pr)
    const existing = jobs.get(key)

    if (existing !== undefined) return existing

    const job: PullRequestJob<O, P, F> = {
      pr: key,
      state: yield* SubscriptionRef.make<JobState<O, P, F>>({
        output: yield* options.load(pr),
        run: { status: "idle" },
      }),
      lock: yield* Semaphore.make(1),
    }

    jobs.set(key, job)

    return job
  }, jobsLock.withPermits(1))

  const locked = <A, E2, R>(job: PullRequestJob<O, P, F>, change: Effect.Effect<A, E2, R>) =>
    change.pipe(job.lock.withPermits(1), Effect.uninterruptible)

  const setRun = (job: PullRequestJob<O, P, F>, run: Run<P, F>) =>
    SubscriptionRef.update(job.state, ({ output }) => ({ output, run }))

  const updateRun = <R extends Run<P, F>>(
    job: PullRequestJob<O, P, F>,
    is: (run: Run<P, F>) => run is R,
    change: (run: R) => Run<P, F>,
  ) =>
    SubscriptionRef.updateSome(job.state, ({ output, run }) =>
      is(run) ? Option.some({ output, run: change(run) }) : Option.none(),
    )

  const launch = Effect.fnUntraced(function* (
    job: PullRequestJob<O, P, F>,
    work: Effect.Effect<void>,
    started: (fiber: Fiber.Fiber<void>) => Run<P, F>,
  ) {
    const { run } = yield* SubscriptionRef.get(job.state)

    if (active(run)) yield* Fiber.interrupt(run.fiber)

    const ready = yield* Deferred.make<void>()

    const fiber = yield* Deferred.await(ready).pipe(
      Effect.andThen(work),
      Effect.forkIn(scope, { uninterruptible: false }),
    )

    yield* setRun(job, started(fiber))
    yield* Deferred.succeed(ready, undefined)
  })

  const replace = (job: PullRequestJob<O, P, F>, progress: P, work: Effect.Effect<void>) =>
    launch(job, work, (fiber) => ({ status: "running", fiber, background: false, progress }))

  const stopJob = (job: PullRequestJob<O, P, F>, onlyBackground: boolean) =>
    locked(
      job,
      Effect.gen(function* () {
        const { run } = yield* SubscriptionRef.get(job.state)

        if (!active(run) || (onlyBackground && run.status === "running" && !run.background)) return

        yield* Fiber.interrupt(run.fiber)
        yield* setRun(job, { status: "idle" })
      }),
    )

  /** Saves and settles the job, deriving the new output from the current one so a change made meanwhile survives. */
  const commit = <E2>(
    job: PullRequestJob<O, P, F>,
    save: Effect.Effect<void, E2>,
    change: (output: O | null) => O,
  ) =>
    save.pipe(
      Effect.andThen(
        SubscriptionRef.update(job.state, ({ output }): JobState<O, P, F> => ({
          output: change(output),
          run: { status: "idle" },
        })),
      ),
      Effect.uninterruptible,
      job.lock.withPermits(1),
    )

  /** Changes the saved output without touching the run, so a job in progress keeps going. */
  const amend = <E2>(
    job: PullRequestJob<O, P, F>,
    change: (output: O | null) => Effect.Effect<O | null, E2>,
  ) =>
    locked(
      job,
      Effect.gen(function* () {
        const { output } = yield* SubscriptionRef.get(job.state)
        const next = yield* change(output)

        if (next !== output)
          yield* SubscriptionRef.update(job.state, ({ run }) => ({ output: next, run }))
      }),
    )

  const progress = (job: PullRequestJob<O, P, F>, change: (progress: P) => P) =>
    updateRun(job, isRunning, (run) => ({ ...run, progress: change(run.progress) }))

  const settle =
    <E2>(
      job: PullRequestJob<O, P, F>,
      event: string,
      failed: (error: Option.Option<E2>, progress: P) => F,
    ) =>
    <A>(work: Effect.Effect<A, E2>) =>
      work.pipe(
        Effect.withSpan(event, { root: true, attributes: { pr: job.pr } }),
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(cause)) yield* Effect.interrupt

            yield* updateRun(job, isRunning, (run) => ({
              status: "failed",
              failure: failed(Cause.findErrorOption(cause), run.progress),
            }))
          }),
        ),
      )

  const startInBackground = Effect.fnUntraced(function* (
    pr: PullRequestRef,
    start: Effect.Effect<P>,
    run: (job: PullRequestJob<O, P, F>) => Effect.Effect<void>,
  ) {
    const job = yield* jobFor(pr)

    yield* locked(
      job,
      Effect.gen(function* () {
        const { output, run: current } = yield* SubscriptionRef.get(job.state)

        if (output !== null || current.status !== "idle") return

        yield* launch(
          job,
          backgroundSlots.withPermits(1)(
            Effect.gen(function* () {
              const initial = yield* start

              yield* updateRun(job, isWaiting, (waiting) => ({
                ...waiting,
                status: "running",
                background: true,
                progress: initial,
              }))
              yield* run(job)
            }),
          ),
          (fiber) => ({ status: "waiting", fiber }),
        )
      }),
    )
  })

  const stop = (pr: PullRequestRef) => {
    const job = jobs.get(referenceKey(pr))

    return job === undefined ? Effect.void : stopJob(job, false)
  }

  const watch = (pr: PullRequestRef) =>
    Stream.unwrap(
      jobFor(pr).pipe(
        Effect.map((job) => SubscriptionRef.changes(job.state).pipe(Stream.map(options.toState))),
      ),
    )

  return {
    jobFor,
    begin: <A, E2, R>(
      job: PullRequestJob<O, P, F>,
      next: (
        replace: (progress: P, work: Effect.Effect<void>) => Effect.Effect<void>,
      ) => Effect.Effect<A, E2, R>,
    ) =>
      locked(
        job,
        Effect.suspend(() => next((initial, work) => replace(job, initial, work))),
      ),
    startInBackground,
    stop,
    stopBackground: () =>
      Effect.forEach([...jobs.values()], (job) => stopJob(job, true), {
        concurrency: "unbounded",
        discard: true,
      }),
    commit,
    amend,
    progress,
    settle,
    watch,
  }
})
