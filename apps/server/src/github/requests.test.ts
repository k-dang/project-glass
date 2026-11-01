import { assert, describe, it } from "@effect/vitest"
import { GitHubUnavailable } from "@glass/contracts"
import { Context, Deferred, Effect, Fiber, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { ServerConfig } from "../ServerConfig"
import { GitHubAuth } from "./GitHubAuth"
import { GitHubClient } from "./GitHubClient"

const Operation = Schema.Struct({
  operationName: Schema.String,
  variables: Schema.Struct({ id: Schema.String }),
})

const clientWith = Effect.fnUntraced(function* (
  fetch: typeof globalThis.fetch,
  auth: GitHubAuth["Service"] = {
    resolveToken: Effect.succeed({ token: Redacted.make("test-token"), source: "gh" as const }),
  },
) {
  const services = yield* Layer.build(
    GitHubClient.layer.pipe(
      Layer.provide(Layer.succeed(GitHubAuth, auth)),
      Layer.provide(
        Layer.succeed(ServerConfig, {
          port: 0,
          token: Redacted.make("test-launch-token"),
          allowedOrigins: new Set<string>(),
          githubApiUrl: "http://127.0.0.1",
          claudeCommand: "claude",
          piCommand: "pi",
          tourTimeoutMs: 300_000,
          askTimeoutMs: 300_000,
          agentReviewTimeoutMs: 900_000,
          gitRemote: "https://github.com",
          checkoutTimeoutMs: 300_000,
          dataDirectory: "",
        }),
      ),
    ),
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))

  return Context.get(services, GitHubClient)
})

describe("GitHub request deadlines", () => {
  it.effect("a later reader cannot extend a shared request's deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()

      const github = yield* clientWith(async (input, init) => {
        const request = new Request(input, init)

        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              Deferred.doneUnsafe(aborted, Effect.void)
              reject(new Error("Aborted"))
            },
            { once: true },
          )
          Deferred.doneUnsafe(started, Effect.void)
        })
      })

      const first = yield* github.viewer.pipe(
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )

      yield* Deferred.await(started)
      yield* TestClock.adjust("29 seconds")

      const second = yield* github.viewer.pipe(
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )

      yield* TestClock.adjust("2 seconds")
      assert.instanceOf(yield* Fiber.join(first), GitHubUnavailable)
      assert.instanceOf(yield* Fiber.join(second), GitHubUnavailable)
      yield* Deferred.await(aborted)
    }),
  )

  for (const stall of ["credentials", "headers", "body"] as const) {
    it.effect(`times out stalled ${stall}, aborting the request and releasing the next write`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const aborted = yield* Deferred.make<void>()
        const operations: Array<typeof Operation.Type> = []
        let held = true

        const auth = GitHubAuth.of({
          resolveToken: Effect.suspend(() => {
            if (stall === "credentials" && held) {
              held = false

              return Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(aborted, undefined)),
              )
            }

            return Effect.succeed({ token: Redacted.make("test-token"), source: "gh" as const })
          }),
        })

        const fetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(input, init)
          const operation = Schema.decodeUnknownSync(Operation)(await request.json())
          operations.push(operation)

          if (held) {
            held = false

            const abort = (stop: (error: Error) => void) => {
              request.signal.addEventListener(
                "abort",
                () => {
                  Deferred.doneUnsafe(aborted, Effect.void)
                  stop(new Error("Request aborted"))
                },
                { once: true },
              )
            }

            return new Promise<Response>((resolve, reject) => {
              if (stall === "body") {
                resolve(
                  new Response(
                    new ReadableStream({
                      start(controller) {
                        abort((error) => controller.error(error))
                        controller.enqueue(new TextEncoder().encode('{"data":'))
                      },
                    }),
                  ),
                )
              } else {
                abort(reject)
              }

              Deferred.doneUnsafe(started, Effect.void)
            })
          }

          return Response.json({
            data:
              operation.operationName === "DraftState"
                ? { node: { state: "PENDING" } }
                : { updatePullRequestReviewComment: { clientMutationId: null } },
          })
        }

        const github = yield* clientWith(fetch, auth)

        const first = yield* github
          .updateDraft("D1", "First")
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)

        const next = yield* github
          .updateDraft("D2", "Next")
          .pipe(Effect.forkChild({ startImmediately: true }))

        assert.isUndefined(first.pollUnsafe())
        assert.isUndefined(next.pollUnsafe())

        yield* TestClock.adjust("31 seconds")
        assert.deepStrictEqual(
          yield* Fiber.join(first),
          new GitHubUnavailable({
            message: "GitHub took too long answering. Reload before trying again.",
          }),
        )
        yield* Deferred.await(aborted)
        yield* Fiber.join(next)

        assert.deepStrictEqual(
          operations.map(({ variables }) => variables.id),
          stall === "credentials" ? ["D2", "D2"] : ["D1", "D2", "D2"],
        )
      }),
    )
  }
})

describe("Sharing GitHub reads", () => {
  it.live(
    "shares pending reads without keeping a settled response, and one reader can leave independently",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const answer = Promise.withResolvers<Response>()
        let requests = 0
        let aborted = false

        const github = yield* clientWith(async (input, init) => {
          requests++
          const request = new Request(input, init)
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true
            },
            { once: true },
          )

          if (requests > 1) return Response.json({ login: "latest" })

          Deferred.doneUnsafe(started, Effect.void)

          return answer.promise
        })

        const first = yield* github.viewer.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        const second = yield* github.viewer.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Fiber.interrupt(first)
        assert.isFalse(aborted)
        answer.resolve(Response.json({ login: "shared" }))
        assert.strictEqual((yield* Fiber.join(second)).login, "shared")
        assert.strictEqual(requests, 1)
        assert.strictEqual((yield* github.viewer).login, "latest")
        assert.strictEqual(requests, 2)
      }),
  )

  it.live("a refresh after a write cannot join a read started before that write", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const answer = Promise.withResolvers<Response>()
      let reads = 0
      const writes: Array<string> = []

      const github = yield* clientWith(async (input, init) => {
        const request = new Request(input, init)

        if (request.method === "GET") {
          reads++

          if (reads > 1) return Response.json({ login: "fresh" })

          Deferred.doneUnsafe(started, Effect.void)

          return answer.promise
        }

        const operation = Schema.decodeUnknownSync(Operation)(await request.json())
        writes.push(operation.operationName)

        return Response.json({
          data:
            operation.operationName === "DraftState"
              ? { node: { state: "PENDING" } }
              : { updatePullRequestReviewComment: { clientMutationId: null } },
        })
      })

      const old = yield* github.viewer.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* github.updateDraft("D1", "New feedback")
      assert.strictEqual((yield* github.viewer).login, "fresh")
      answer.resolve(Response.json({ login: "old" }))
      assert.strictEqual((yield* Fiber.join(old)).login, "old")
      assert.strictEqual(reads, 2)
      assert.deepStrictEqual(writes, ["DraftState", "UpdatePullRequestReviewComment"])
    }),
  )

  it.live("a GraphQL throttle pauses later REST reads and writes without replaying feedback", () =>
    Effect.gen(function* () {
      let requests = 0

      const github = yield* clientWith(async () => {
        requests++

        return Response.json(
          { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
          {
            headers: { "retry-after": "120" },
          },
        )
      })

      const error = yield* Effect.flip(github.updateDraft("D1", "Feedback"))
      assert.instanceOf(error, GitHubUnavailable)
      assert.include(error.message, "paused until")
      assert.instanceOf(yield* Effect.flip(github.viewer), GitHubUnavailable)
      assert.instanceOf(yield* Effect.flip(github.updateDraft("D1", "Feedback")), GitHubUnavailable)
      assert.strictEqual(requests, 1)
    }),
  )
})
