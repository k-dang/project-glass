import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface PiSettings {
  readonly defaultModel?: string
  readonly enabledModels?: ReadonlyArray<string>
  readonly retry?: {
    readonly enabled: boolean
    readonly maxRetries?: number
    readonly baseDelayMs?: number
  }
}

const [recordedProvider = "", ...recordedModel] = (
  process.env["GLASS_RECORD_PI_MODEL"] ?? "recorded-provider/recorded-model"
).split("/")

export const PI_PROVIDER = recordedProvider

export const PI_MODEL = recordedModel.join("/")

export const PI_MODEL_ID = `${PI_PROVIDER}/${PI_MODEL}`

const agentDirectory = (home: string) => {
  const directory = join(home, ".pi", "agent")
  mkdirSync(directory, { recursive: true })

  return directory
}

export const writePiSettings = (
  home: string,
  provider: string,
  model: string,
  settings: PiSettings,
) =>
  writeFileSync(
    join(agentDirectory(home), "settings.json"),
    JSON.stringify({ defaultProvider: provider, defaultModel: model, ...settings }),
  )

export const writePiLogin = (home: string, provider: string, key: string) =>
  writeFileSync(
    join(agentDirectory(home), "auth.json"),
    JSON.stringify({ [provider]: { type: "api_key", key } }),
  )
