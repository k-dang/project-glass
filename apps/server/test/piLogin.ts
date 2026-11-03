import { Schema } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface PiSettings {
  readonly enabledModels?: ReadonlyArray<string>
  readonly retry?: {
    readonly enabled: boolean
    readonly maxRetries?: number
    readonly baseDelayMs?: number
  }
}

export const PI_PROVIDER = "vercel-ai-gateway"

export const PI_MODEL = "anthropic/claude-haiku-5.5"

const Auth = Schema.fromJsonString(
  Schema.Struct({ [PI_PROVIDER]: Schema.Struct({ key: Schema.String }) }),
)

export const gatewayKey = () => {
  const given = process.env["AI_GATEWAY_API_KEY"]

  if (given !== undefined && given !== "") return given

  const auth = readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")

  return Schema.decodeUnknownSync(Auth)(auth)[PI_PROVIDER].key
}

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
