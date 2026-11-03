import { assert, it } from "@effect/vitest"
import { PullRequestRef } from "@glass/contracts"
import { Cause, Deferred, Effect, Fiber, Logger, Option, Result, SubscriptionRef } from "effect"
import { pullRequestJobs } from "./pullRequestJobs"

const pr = new PullRequestRef({ owner: "octo-org", repo: "hello-world", number: 1 })

const noBackground = {
  backgroundSlots: 1,
  needsBackground: () => false,
  waiting: (state: string) => state,
}

it.live("replaces work that waits to commit while the replacement holds the lock", () =>
  Effect.gen(function* () {
    const jobs = yield* pullRequestJobs({
      load: () => Effect.succeed("idle"),
      inProgress: (state) => state === "running",
      idle: () => "idle",
      ...noBackground,
    })

    const job = yield* jobs.jobFor(pr)
    const replacing = yield* Deferred.make<void>()

    yield* jobs.begin(job, (replace) =>
      replace(
        Deferred.await(replacing).pipe(Effect.andThen(jobs.commit(job, Effect.void, "first"))),
      ),
    )

    yield* jobs.begin(job, (replace) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(replacing, undefined)
        yield* Effect.yieldNow
        yield* replace(jobs.commit(job, Effect.void, "second"))
      }),
    )

    yield* Fiber.join(job.running!.fiber)
    assert.strictEqual(yield* SubscriptionRef.get(job.state), "second")
  }).pipe(Effect.scoped),
)

it.live("logs the full unexpected defect before settling the job to a safe failure", () =>
  Effect.gen(function* () {
    const logs: Array<Logger.Options<unknown>> = []
    const logger = Logger.make((entry) => logs.push(entry))
    const defect = new Error("Unexpected job failure")

    yield* Effect.gen(function* () {
      const jobs = yield* pullRequestJobs({
        load: () => Effect.succeed("running"),
        inProgress: (state: string) => state === "running",
        idle: () => "idle",
        ...noBackground,
      })

      const job = yield* jobs.jobFor(pr)
      yield* jobs.begin(job, (replace) =>
        replace(
          Effect.die(defect).pipe(
            jobs.settle(job, (_state, error) => {
              assert.isTrue(Option.isNone(error))

              return "failed"
            }),
          ),
        ),
      )
      yield* Fiber.join(job.running!.fiber)
      assert.strictEqual(yield* SubscriptionRef.get(job.state), "failed")
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))

    assert.strictEqual(logs.length, 1)
    assert.strictEqual(logs[0]!.logLevel, "Error")
    assert.strictEqual(Result.getOrThrow(Cause.findDefect(logs[0]!.cause)), defect)
  }).pipe(Effect.scoped),
)
