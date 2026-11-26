import { assert, describe, it } from "@effect/vitest"
import { NoCredentials, TokenRejected } from "@glass/contracts"
import { ConfigProvider, Context, Effect, Layer, Redacted, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { clientWith } from "../../test/gitHubClient"
import { playedHandle } from "../../test/replay"
import { GitHubAuth } from "./GitHubAuth"

const ghCli = Effect.fnUntraced(function* (token: string) {
  const gh = { token, lookups: 0 }

  const spawner = ChildProcessSpawner.make(() =>
    Effect.sync(() => {
      gh.lookups++

      return playedHandle({
        stdout: Stream.make(new TextEncoder().encode(`${gh.token}\n`)),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
      })
    }),
  )

  const services = yield* Layer.build(
    GitHubAuth.layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    ),
  )

  return { gh, auth: Context.get(services, GitHubAuth) }
})

const withoutTokenVariables = Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))

describe("GitHubAuth", () => {
  it.effect("reuses gh's token, then picks up a gh account switch within a minute", () =>
    Effect.gen(function* () {
      const { gh, auth } = yield* ghCli("first-token")

      yield* auth.resolveToken
      const reused = yield* auth.resolveToken
      assert.strictEqual(Redacted.value(reused.token), "first-token")
      assert.strictEqual(gh.lookups, 1)

      gh.token = "second-token"
      yield* TestClock.adjust("1 minute")

      const switched = yield* auth.resolveToken
      assert.strictEqual(Redacted.value(switched.token), "second-token")
    }).pipe(withoutTokenVariables),
  )

  it.effect("looks up gh's token again once GitHub rejects it", () =>
    Effect.gen(function* () {
      const { gh, auth } = yield* ghCli("revoked-token")

      const github = yield* clientWith(async (input, init) => {
        const authorization = new Request(input, init).headers.get("authorization")

        return authorization === "Bearer signed-in-again"
          ? Response.json({ login: "kevin" })
          : new Response(null, { status: 401 })
      }, auth)

      assert.instanceOf(yield* Effect.flip(github.viewer), TokenRejected)

      gh.token = "signed-in-again"

      assert.strictEqual((yield* github.viewer).login, "kevin")
    }).pipe(withoutTokenVariables),
  )

  it.effect("picks up a gh sign-in right after finding no credentials", () =>
    Effect.gen(function* () {
      const { gh, auth } = yield* ghCli("")

      assert.instanceOf(yield* Effect.flip(auth.resolveToken), NoCredentials)

      gh.token = "signed-in"

      assert.strictEqual(Redacted.value((yield* auth.resolveToken).token), "signed-in")
    }).pipe(withoutTokenVariables),
  )
})
