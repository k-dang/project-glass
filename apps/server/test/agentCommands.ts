import { Schema } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const decodeSettings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))

export const writeAgentCommands = (
  dataDirectory: string,
  commands?: {
    readonly claudeCommand: string
    readonly piCommand: string
    readonly opencodeCommand?: string
  },
) => {
  const settings = join(dataDirectory, "settings.json")
  const saved = existsSync(settings) ? decodeSettings(readFileSync(settings, "utf8")) : {}

  const {
    claudeCommand: _claudeCommand,
    piCommand: _piCommand,
    opencodeCommand: _opencodeCommand,
    ...rest
  } = saved

  mkdirSync(dataDirectory, { recursive: true })
  writeFileSync(settings, JSON.stringify({ ...rest, ...commands }, null, 2))
}
