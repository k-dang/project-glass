import { assert, it } from "@effect/vitest"
import { PullRequestRef } from "@glass/contracts"
import { Deferred, Effect, Fiber, Option, Schema, SubscriptionRef } from "effect"
import { pullRequestJobs } from "./pullRequestJobs"
import { wideEvents } from "./wideEvents"

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
      const jobs = yield* pullRequestJobs({
        load: () => Effect.succeed("running"),
        inProgress: (state: string) => state === "running",
        idle: () => "idle",
        ...noBackground,
      })

      const job = yield* jobs.jobFor(pr)
      yield* jobs.begin(job, (replace) =>
        replace(
          Effect.die(new Error("Unexpected job failure")).pipe(
            jobs.settle(job, "Tour", (_state, error) => {
              assert.isTrue(Option.isNone(error))

              return "failed"
            }),
          ),
        ),
      )
      yield* Fiber.join(job.running!.fiber)
      assert.strictEqual(yield* SubscriptionRef.get(job.state), "failed")
    }).pipe(Effect.provide(wideEvents("backend", (line) => lines.push(decodeJobUnit(line)))))

    const [unit] = lines

    assert.strictEqual(lines.length, 1)
    assert.include(unit, { level: "ERROR", event: "Tour", pr: "octo-org/hello-world#1" })
    assert.strictEqual(unit?.error.tag, "Defect")
    assert.include(unit?.error.message, "Unexpected job failure")
  }).pipe(Effect.scoped),
)
