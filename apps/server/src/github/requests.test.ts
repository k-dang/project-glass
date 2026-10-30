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

describe("GitHub request deadlines", () => {
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

        const github = Context.get(services, GitHubClient)

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
