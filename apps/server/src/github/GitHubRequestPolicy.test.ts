import { assert, describe, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber } from "effect"
import {
  BackgroundGitHubRequest,
  GitHubRequestPaused,
  GitHubRequestPolicy,
} from "./GitHubRequestPolicy"

describe("GitHub request policy", () => {
  it.live("bounds all requests and releases slots when held work finishes", () =>
    Effect.gen(function* () {
      const policy = yield* GitHubRequestPolicy
      const full = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let running = 0
      let peak = 0

      const request = Effect.gen(function* () {
        running++
        peak = Math.max(peak, running)

        if (running === 4) yield* Deferred.succeed(full, undefined)

        yield* Deferred.await(release)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running--
          }),
        ),
      )

      const fibers = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => index),
        (index) =>
          policy
            .run(`credential-${index % 2}`, index % 2 === 0 ? "core" : "graphql", request)
            .pipe(Effect.forkChild({ startImmediately: true })),
      )

      yield* Deferred.await(full)
      assert.strictEqual(running, 4)
      yield* Deferred.succeed(release, undefined)
      yield* Effect.forEach(fibers, Fiber.join)
      assert.strictEqual(peak, 4)
      assert.strictEqual(running, 0)
    }).pipe(Effect.provide(GitHubRequestPolicy.layer)),
  )

  it.live(
    "keeps interactive quota available while background reads defer, scoped by credential and resource",
    () =>
      Effect.gen(function* () {
        const policy = yield* GitHubRequestPolicy
        const now = yield* Clock.currentTimeMillis

        const headers = {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "9",
          "x-ratelimit-reset": String(Math.ceil(now / 1000) + 3600),
        }

        yield* policy.observe("alice", "graphql", 200, headers, undefined)

        const background = policy
          .run("alice", "graphql", Effect.succeed("read"))
          .pipe(Effect.provideService(BackgroundGitHubRequest, true))

        assert.instanceOf(yield* Effect.flip(background), GitHubRequestPaused)
        assert.strictEqual(yield* policy.run("alice", "graphql", Effect.succeed("open")), "open")
        assert.strictEqual(yield* policy.run("alice", "core", Effect.succeed("rest")), "rest")
        assert.strictEqual(yield* policy.run("bob", "graphql", Effect.succeed("other")), "other")

        yield* policy.observe(
          "alice",
          "graphql",
          200,
          { ...headers, "x-ratelimit-remaining": "0" },
          undefined,
        )
        assert.instanceOf(
          yield* Effect.flip(policy.run("alice", "graphql", Effect.void)),
          GitHubRequestPaused,
        )
      }).pipe(Effect.provide(GitHubRequestPolicy.layer)),
  )

  it.live(
    "shares server-directed cooldowns across traffic classes and recognizes GraphQL HTTP-200 throttles",
    () =>
      Effect.gen(function* () {
        const policy = yield* GitHubRequestPolicy
        const now = yield* Clock.currentTimeMillis
        const retryAt = Math.ceil(now / 1000) * 1000 + 120_000

        for (const status of [200, 403, 429]) {
          const credential = `credential-${status}`

          const error = yield* Effect.flip(
            policy.observe(
              credential,
              "graphql",
              status,
              { "retry-after": new Date(retryAt).toUTCString() },
              status === 200
                ? { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }
                : { message: "Secondary rate limit" },
            ),
          )

          assert.strictEqual(error.retryAt, retryAt)
          assert.instanceOf(
            yield* Effect.flip(policy.run(credential, "core", Effect.void)),
            GitHubRequestPaused,
          )
          assert.instanceOf(
            yield* Effect.flip(
              policy
                .run(credential, "graphql", Effect.void)
                .pipe(Effect.provideService(BackgroundGitHubRequest, true)),
            ),
            GitHubRequestPaused,
          )
        }

        yield* policy.observe("forbidden", "core", 403, {}, { message: "Resource not accessible" })
        yield* policy.run("forbidden", "core", Effect.void)
      }).pipe(Effect.provide(GitHubRequestPolicy.layer)),
  )

  it.live("an older successful request cannot clear a newer cooldown", () =>
    Effect.gen(function* () {
      const policy = yield* GitHubRequestPolicy
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const old = yield* policy
        .run(
          "alice",
          "core",
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(started)
      yield* Effect.flip(
        policy.observe("alice", "graphql", 429, { "retry-after": "120" }, undefined),
      )
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(old)
      assert.instanceOf(
        yield* Effect.flip(policy.run("alice", "core", Effect.void)),
        GitHubRequestPaused,
      )
    }).pipe(Effect.provide(GitHubRequestPolicy.layer)),
  )
})
