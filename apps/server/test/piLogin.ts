import { Schema } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PiSettings } from "./fakeModelProvider"

export const PI_PROVIDER = "vercel-ai-gateway"

export const PI_MODEL = "anthropic/claude-haiku-5.5"

const Auth = Schema.fromJsonString(
  Schema.Struct({ [PI_PROVIDER]: Schema.Struct({ key: Schema.String }) }),
)

const gatewayKey = () => {
  const given = process.env["AI_GATEWAY_API_KEY"]

  if (given !== undefined && given !== "") return given

  const auth = readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")

  return Schema.decodeUnknownSync(Auth)(auth)[PI_PROVIDER].key
}

export const writePiSettings = (home: string, settings: PiSettings) => {
  const agent = join(home, ".pi", "agent")
  mkdirSync(agent, { recursive: true })
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ defaultProvider: PI_PROVIDER, defaultModel: PI_MODEL, ...settings }),
  )
}

export const writePiLogin = (home: string, key = gatewayKey()) =>
  writeFileSync(
    join(home, ".pi", "agent", "auth.json"),
    JSON.stringify({ [PI_PROVIDER]: { type: "api_key", key } }),
  )
