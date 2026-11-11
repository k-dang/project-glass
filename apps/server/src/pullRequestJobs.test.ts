import { assert, it } from "@effect/vitest"
import { PullRequestRef } from "@glass/contracts"
import { Deferred, Effect, Option, Schema, Stream, SubscriptionRef } from "effect"
import { type JobState, type PullRequestJob, pullRequestJobs } from "./pullRequestJobs"
import { wideEvents } from "./wideEvents"

const prNumbered = (number: number) =>
  new PullRequestRef({ owner: "octo-org", repo: "hello-world", number })

const pr = prNumbered(1)

type State = JobState<string, { readonly label: string }, string>

const progress = { label: "working" }

const makeJobs = pullRequestJobs({
  load: () => Effect.succeed(null),
  toState: (state: State) => state,
  backgroundSlots: 1,
})

type Job = PullRequestJob<string, { readonly label: string }, string>

const until = (job: Job, status: string) =>
  SubscriptionRef.changes(job.state).pipe(
    Stream.filter(({ run }) => run.status === status),
    Stream.runHead,
  )

const neverUntilInterrupted = Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const interrupted = yield* Deferred.make<void>()

  return {
    started,
    interrupted,
    work: Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
    ),
  }
})

it.live("replaces work that waits to commit while the replacement holds the lock", () =>
  Effect.gen(function* () {
    const jobs = yield* makeJobs
    const job = yield* jobs.jobFor(pr)
    const replacing = yield* Deferred.make<void>()
    const first = yield* Deferred.make<void>()

    yield* jobs.begin(job, (replace) =>
      replace(
        progress,
        Deferred.await(replacing).pipe(
          Effect.andThen(jobs.commit(job, Effect.void, "first")),
          Effect.onInterrupt(() => Deferred.succeed(first, undefined)),
        ),
      ),
    )

    yield* jobs.begin(job, (replace) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(replacing, undefined)
        yield* Effect.yieldNow
        yield* replace(progress, jobs.commit(job, Effect.void, "second"))
      }),
    )

    yield* Deferred.await(first)
    yield* until(job, "idle")

    const { output, run } = yield* SubscriptionRef.get(job.state)

    assert.strictEqual(output, "second")
    assert.strictEqual(run.status, "idle")
  }).pipe(Effect.scoped),
)

it.live("turning off background work stops waiting and running background jobs only", () =>
  Effect.gen(function* () {
    const jobs = yield* makeJobs
    const running = yield* neverUntilInterrupted
    const waiting = yield* neverUntilInterrupted
    const manual = yield* neverUntilInterrupted

    const runningJob = yield* jobs.jobFor(prNumbered(2))
    const waitingJob = yield* jobs.jobFor(prNumbered(3))
    const manualJob = yield* jobs.jobFor(prNumbered(4))

    yield* jobs.startInBackground(prNumbered(2), Effect.succeed(progress), () => running.work)
    yield* until(runningJob, "running")
    yield* jobs.startInBackground(prNumbered(3), Effect.succeed(progress), () => waiting.work)
    assert.strictEqual((yield* SubscriptionRef.get(waitingJob.state)).run.status, "waiting")
    yield* jobs.begin(manualJob, (replace) => replace(progress, manual.work))
    yield* Deferred.await(running.started)
    yield* Deferred.await(manual.started)

    yield* jobs.stopBackground()
    yield* Deferred.await(running.interrupted)

    assert.strictEqual((yield* SubscriptionRef.get(runningJob.state)).run.status, "idle")
    assert.strictEqual((yield* SubscriptionRef.get(waitingJob.state)).run.status, "idle")
    assert.strictEqual((yield* SubscriptionRef.get(manualJob.state)).run.status, "running")
  }).pipe(Effect.scoped),
)

it.live("cancelling stops a manual job and a background job alike", () =>
  Effect.gen(function* () {
    const jobs = yield* makeJobs
    const manual = yield* neverUntilInterrupted
    const background = yield* neverUntilInterrupted
    const manualJob = yield* jobs.jobFor(prNumbered(2))
    const backgroundJob = yield* jobs.jobFor(prNumbered(3))

    yield* jobs.begin(manualJob, (replace) => replace(progress, manual.work))
    yield* jobs.startInBackground(prNumbered(3), Effect.succeed(progress), () => background.work)
    yield* Deferred.await(manual.started)
    yield* Deferred.await(background.started)

    yield* jobs.stop(prNumbered(2))
    yield* jobs.stop(prNumbered(3))
    yield* Deferred.await(manual.interrupted)
    yield* Deferred.await(background.interrupted)

    assert.strictEqual((yield* SubscriptionRef.get(manualJob.state)).run.status, "idle")
    assert.strictEqual((yield* SubscriptionRef.get(backgroundJob.state)).run.status, "idle")
  }).pipe(Effect.scoped),
)

const JobUnit = Schema.Struct({
  level: Schema.String,
  event: Schema.String,
  pr: Schema.String,
  error: Schema.Struct({ tag: Schema.String, message: Schema.String }),
})

const decodeJobUnit = Schema.decodeUnknownSync(Schema.fromJsonString(JobUnit))

it.live("records an unexpected defect on the job's unit and settles to a safe failure", () =>
  Effect.gen(function* () {
    const lines: Array<typeof JobUnit.Type> = []

    yield* Effect.gen(function* () {
      const jobs = yield* makeJobs
      const job = yield* jobs.jobFor(pr)
      yield* jobs.begin(job, (replace) =>
        replace(
          progress,
          Effect.die(new Error("Unexpected job failure")).pipe(
            jobs.settle(job, "Tour", (error: Option.Option<string>, current) => {
              assert.isTrue(Option.isNone(error))

              return `failed while ${current.label}`
            }),
          ),
        ),
      )
      const settled = yield* until(job, "failed")
      assert.deepStrictEqual(Option.getOrUndefined(settled)?.run, {
        status: "failed",
        failure: "failed while working",
      })
    }).pipe(Effect.provide(wideEvents("backend", (line) => lines.push(decodeJobUnit(line)))))

    const [unit] = lines

    assert.strictEqual(lines.length, 1)
    assert.include(unit, { level: "ERROR", event: "Tour", pr: "octo-org/hello-world#1" })
    assert.strictEqual(unit?.error.tag, "Defect")
    assert.include(unit?.error.message, "Unexpected job failure")
  }).pipe(Effect.scoped),
)
