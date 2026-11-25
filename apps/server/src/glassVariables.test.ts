import { assert, it } from "@effect/vitest"
import { Config, Effect, Redacted } from "effect"
import { takeGlassVariables } from "./glassVariables"

it.effect("takes Glass's variables out of the environment its children inherit", () =>
  Effect.gen(function* () {
    const env = { GLASS_TOKEN: "launch-token", PATH: "/bin" }

    const token = yield* Config.Redacted("GLASS_TOKEN").pipe(
      Effect.provide(takeGlassVariables(env)),
    )

    assert.strictEqual(Redacted.value(token), "launch-token")
    assert.deepStrictEqual(Object.keys(env), ["PATH"])
  }),
)
