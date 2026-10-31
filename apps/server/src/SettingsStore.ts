import {
  AgentEngine,
  defaultReviewPrompt,
  type EngineFeature,
  EngineModels,
  type EngineSettings,
  FollowedRepository,
  ReviewPrompt,
  SettingsError,
} from "@glass/contracts"
import { Context, Effect, FileSystem, Layer, Schema, Semaphore } from "effect"
import { join } from "node:path"
import { writeDataFile } from "./dataFiles"
import { ServerConfig } from "./ServerConfig"

const defaultPiModel = Effect.succeed({ provider: "anthropic", modelId: "claude-sonnet-5-5" })

const SavedModels = Schema.Struct({
  "claude-code": EngineModels.fields["claude-code"].pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("claude-sonnet-5-5")),
  ),
  "pi-cli": EngineModels.fields["pi-cli"].pipe(Schema.withDecodingDefaultKey(defaultPiModel)),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({})))

const Settings = Schema.Struct({
  followedRepositories: Schema.Array(FollowedRepository).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  tourModels: SavedModels,
  tourEngine: AgentEngine.pipe(Schema.withDecodingDefaultKey(Effect.succeed("claude-code"))),
  queueTours: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  agentReviewModels: SavedModels,
  agentReviewEngine: AgentEngine.pipe(Schema.withDecodingDefaultKey(Effect.succeed("pi-cli"))),
  reviewPrompt: ReviewPrompt.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultReviewPrompt)),
  ),
})

export type Settings = typeof Settings.Type

const engineKeys = {
  tours: { engine: "tourEngine", models: "tourModels" },
  agentReviews: { engine: "agentReviewEngine", models: "agentReviewModels" },
} as const satisfies Record<EngineFeature, { engine: keyof Settings; models: keyof Settings }>

export const engineSettingsOf = (settings: Settings, feature: EngineFeature): EngineSettings => {
  const keys = engineKeys[feature]

  return { engine: settings[keys.engine], models: settings[keys.models] }
}

export const withEngineSettings = (
  settings: Settings,
  feature: EngineFeature,
  { engine, models }: EngineSettings,
): Settings => {
  const keys = engineKeys[feature]

  return { ...settings, [keys.engine]: engine, [keys.models]: models }
}

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(Settings))

const encodeSettings = Schema.encodeEffect(Settings)

export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    readonly read: () => Effect.Effect<Settings, SettingsError>
    readonly update: (
      change: (settings: Settings) => Settings,
    ) => Effect.Effect<Settings, SettingsError>
  }
>()("@glass/server/SettingsStore") {
  static readonly layer = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const lock = yield* Semaphore.make(1)
      const { dataDirectory } = yield* ServerConfig
      const path = join(dataDirectory, "settings.json")

      const load = Effect.fn("SettingsStore.load")(() =>
        fs.readFileString(path).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("{}")),
          Effect.flatMap(decodeSettings),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read the settings file", cause)),
          Effect.mapError(
            () =>
              new SettingsError({
                message: `Couldn't read settings from ${path}. Check that the file is valid and readable, then retry.`,
              }),
          ),
        ),
      )

      const write = Effect.fn("SettingsStore.write")(
        function* (settings: Settings) {
          const contents = JSON.stringify(yield* encodeSettings(settings), null, 2)
          yield* writeDataFile(fs, path, `${contents}\n`)
        },
        Effect.tapError((cause) => Effect.logWarning("Couldn't save the settings file", cause)),
        Effect.mapError(
          () =>
            new SettingsError({
              message: `Couldn't save settings to ${path}. Check that the directory is writable and has free space, then retry.`,
            }),
        ),
      )

      yield* load().pipe(
        Effect.flatMap(write),
        Effect.catch((error) => Effect.logWarning("Couldn't fill in the settings file", error)),
      )

      return SettingsStore.of({
        read: Effect.fn("SettingsStore.read")(() => lock.withPermit(load())),
        update: Effect.fn("SettingsStore.update")(
          function* (change) {
            const updated = change(yield* load())
            yield* write(updated)

            return updated
          },
          Effect.uninterruptible,
          lock.withPermits(1),
        ),
      })
    }),
  )
}
