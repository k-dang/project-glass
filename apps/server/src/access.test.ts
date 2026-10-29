import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { LAUNCH_TOKEN, RENDERER_ORIGIN, startBackend } from "../test/harness"

const health = (baseUrl: string, init: { token?: string; origin?: string }) =>
  Effect.promise(() =>
    fetch(`${baseUrl}/health${init.token === undefined ? "" : `?token=${init.token}`}`, {
      headers: init.origin === undefined ? {} : { origin: init.origin },
    }),
  ).pipe(Effect.map((response) => response.status))

describe("access control", () => {
  it.live("requires the launch secret", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startBackend({})

      assert.strictEqual(yield* health(baseUrl, {}), 401)
      assert.strictEqual(yield* health(baseUrl, { token: "wrong" }), 401)
      assert.strictEqual(yield* health(baseUrl, { origin: RENDERER_ORIGIN }), 401)
      assert.strictEqual(yield* health(baseUrl, { token: "wrong", origin: RENDERER_ORIGIN }), 401)
    }),
  )

  it.live("allows the launch secret without an Origin header", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startBackend({})

      assert.strictEqual(yield* health(baseUrl, { token: LAUNCH_TOKEN }), 204)
    }),
  )

  it.live("allows only the renderer's browser origin", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* startBackend({})

      assert.strictEqual(
        yield* health(baseUrl, { token: LAUNCH_TOKEN, origin: "https://evil.example" }),
        403,
      )
      assert.strictEqual(yield* health(baseUrl, { token: LAUNCH_TOKEN, origin: "null" }), 403)
      assert.strictEqual(
        yield* health(baseUrl, { token: LAUNCH_TOKEN, origin: RENDERER_ORIGIN }),
        204,
      )
    }),
  )
})
