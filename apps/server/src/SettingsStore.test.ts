import { assert, describe, it } from "@effect/vitest"
import { defaultReviewPrompt } from "@glass/contracts"
import { Effect } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isolatedHome, startBackend } from "../test/harness"

const defaultModels = {
  "claude-code": "claude-sonnet-5-5",
  pi: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
}

describe("settings file", () => {
  it.live("is created with the default settings at startup", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      yield* startBackend({}, home)

      const saved = yield* Effect.promise(() =>
        readFile(join(home, ".project-glass", "settings.json"), "utf8"),
      )

      assert.deepStrictEqual(JSON.parse(saved), {
        followedRepositories: [],
        tourModels: defaultModels,
        tourEngine: "claude-code",
        queueTours: false,
        agentReviewModels: defaultModels,
        agentReviewEngine: "pi",
        reviewPrompt: defaultReviewPrompt,
      })
    }),
  )

  it.live("gains missing Tour models at startup and keeps everything already set", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const path = join(home, ".project-glass", "settings.json")
      const followedRepositories = [{ owner: "octo-org", repo: "glass" }]
      yield* Effect.promise(() => mkdir(join(home, ".project-glass")))
      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({
            followedRepositories,
            tourModels: { pi: { provider: "openai", modelId: "gpt-test" } },
            tourEngine: "pi",
            queueTours: true,
          }),
        ),
      )
      yield* startBackend({}, home)

      assert.deepStrictEqual(JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))), {
        followedRepositories,
        tourModels: { ...defaultModels, pi: { provider: "openai", modelId: "gpt-test" } },
        tourEngine: "pi",
        queueTours: true,
        agentReviewModels: defaultModels,
        agentReviewEngine: "pi",
        reviewPrompt: defaultReviewPrompt,
      })
    }),
  )

  it.live(
    "saves the Tour and Agent review engines and models chosen in Settings apart, across backend restarts",
    () =>
      Effect.gen(function* () {
        const home = yield* isolatedHome

        const tourSettings = {
          engine: "claude-code" as const,
          models: {
            "claude-code": "claude-opus-5-5",
            pi: { provider: "litellm", modelId: "gpt-test" },
          },
        }

        const agentReviewSettings = {
          engine: "pi" as const,
          models: { ...defaultModels, pi: { provider: "litellm", modelId: "deepseek-test" } },
        }

        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* startBackend({}, home)
            assert.deepStrictEqual(yield* client.GetEngineSettings({ feature: "tours" }), {
              engine: "claude-code",
              models: defaultModels,
            })
            assert.deepStrictEqual(yield* client.GetEngineSettings({ feature: "agentReviews" }), {
              engine: "pi",
              models: defaultModels,
            })
            assert.deepStrictEqual(
              yield* client.SetEngineSettings({ feature: "tours", engineSettings: tourSettings }),
              tourSettings,
            )
            assert.deepStrictEqual(
              yield* client.SetEngineSettings({
                feature: "agentReviews",
                engineSettings: agentReviewSettings,
              }),
              agentReviewSettings,
            )
          }),
        )

        const { client } = yield* startBackend({}, home)
        assert.deepStrictEqual(yield* client.GetEngineSettings({ feature: "tours" }), tourSettings)
        assert.deepStrictEqual(
          yield* client.GetEngineSettings({ feature: "agentReviews" }),
          agentReviewSettings,
        )
      }),
  )

  it.live("is left untouched at startup when it can't be read", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const path = join(home, ".project-glass", "settings.json")
      yield* Effect.promise(() => mkdir(join(home, ".project-glass")))
      yield* Effect.promise(() => writeFile(path, "invalid json"))
      yield* startBackend({}, home)

      assert.equal(yield* Effect.promise(() => readFile(path, "utf8")), "invalid json")
    }),
  )
})
