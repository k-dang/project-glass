import { assert, it } from "@effect/vitest"
import { PullRequestRef } from "@glass/contracts"
import { Deferred, Effect, SubscriptionRef } from "effect"
import { pullRequestJobs } from "./pullRequestJobs"

const pr = new PullRequestRef({ owner: "octo-org", repo: "hello-world", number: 1 })

it.live("replaces work that waits to commit while the replacement holds the lock", () =>
  Effect.gen(function* () {
    const jobs = yield* pullRequestJobs({
      load: () => Effect.succeed("idle"),
      inProgress: (state) => state === "running",
      idle: () => "idle",
    })

    const job = yield* jobs.jobFor(pr)
    const replacing = yield* Deferred.make<void>()

    yield* jobs.begin(job, (replace) =>
      replace(
        Deferred.await(replacing).pipe(Effect.andThen(jobs.commit(job, Effect.void, "first"))),
      ),
    )

    yield* jobs
      .begin(job, (replace) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(replacing, undefined)
          yield* Effect.sleep("50 millis")
          yield* replace(jobs.commit(job, Effect.void, "second"))
        }),
      )
      .pipe(Effect.timeout("2 seconds"))

    yield* Effect.sleep("50 millis")
    assert.strictEqual(yield* SubscriptionRef.get(job.state), "second")
  }).pipe(Effect.scoped),
)
