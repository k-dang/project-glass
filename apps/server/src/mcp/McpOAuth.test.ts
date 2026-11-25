import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Context, Duration, Effect, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { withWatchedClock } from "../../test/deadlines"
import { isolatedHome, LAUNCH_TOKEN } from "../../test/harness"
import { ServerConfig } from "../ServerConfig"
import { type Authorization, MAX_WAITING_REQUESTS, McpOAuth, REQUEST_TTL } from "./McpOAuth"

const start = Effect.gen(function* () {
  const home = yield* isolatedHome

  const services = yield* Layer.build(
    McpOAuth.layer.pipe(
      Layer.provide(ServerConfig.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            GLASS_PORT: "0",
            GLASS_TOKEN: LAUNCH_TOKEN,
            GLASS_HOME: home,
          }),
        ),
      ),
      Layer.provide(NodeFileSystem.layer),
    ),
  )

  return Context.get(services, McpOAuth)
})

const authorization = (state: string): Authorization => ({
  clientId: "client",
  name: "Claude Code",
  redirectUri: "http://127.0.0.1:9/callback",
  codeChallenge: "A".repeat(43),
  state,
  issuer: "http://127.0.0.1:1",
  resource: "http://127.0.0.1:1/mcp",
})

const waitingNow = (oauth: McpOAuth["Service"]) =>
  oauth.watchRequests().pipe(Stream.runHead, Effect.map(Option.getOrThrow))

describe("McpOAuth", () => {
  it.effect("keeps the newest waiting sign-ins and ends the oldest past the cap", () =>
    Effect.gen(function* () {
      const oauth = yield* start

      const opened = yield* Effect.forEach(
        Array.from({ length: MAX_WAITING_REQUESTS + 1 }, (_, index) => `state-${index}`),
        (state) => oauth.open(authorization(state)),
      )

      const [oldest, ...kept] = opened

      assert.ok(oldest !== undefined)
      assert.deepStrictEqual(
        (yield* waitingNow(oauth)).map(({ id }) => id),
        kept.map(({ id }) => id),
      )
      assert.strictEqual((yield* oauth.collect(oldest.id).pipe(Effect.flip))._tag, "OAuthPageError")
    }),
  )

  it.effect("ends a waiting sign-in when its time runs out", () =>
    withWatchedClock(REQUEST_TTL, (deadlineSet) =>
      Effect.gen(function* () {
        const oauth = yield* start
        const opened = yield* oauth.open(authorization("expiring"))

        yield* deadlineSet
        yield* TestClock.adjust(Duration.subtract(REQUEST_TTL, Duration.millis(1)))

        assert.deepStrictEqual(
          (yield* waitingNow(oauth)).map(({ id }) => id),
          [opened.id],
        )

        yield* TestClock.adjust(Duration.millis(1))
        yield* oauth.watchRequests().pipe(
          Stream.filter((waiting) => waiting.length === 0),
          Stream.runHead,
        )

        assert.strictEqual(
          (yield* oauth.collect(opened.id).pipe(Effect.flip))._tag,
          "OAuthPageError",
        )
      }),
    ),
  )
})
