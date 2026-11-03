import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { installedProgram } from "./replay"

/** The executable shipped by the Claude Agent SDK version Glass pins. */
export const pinnedClaude = () => {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")

  const platform = createRequire(sdk).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
  )

  return join(platform, "..", process.platform === "win32" ? "claude.exe" : "claude")
}

export const pinnedClaudeProgram = () =>
  installedProgram(
    join(
      dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")),
      "package.json",
    ),
  )

const isolatedEnvironment = (home: string) => ({
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
})

export const fakeAnthropicEnvironment = (home: string, url: string) => ({
  ...isolatedEnvironment(home),
  GLASS_CLAUDE_COMMAND: pinnedClaude(),
  ANTHROPIC_BASE_URL: url,
  ANTHROPIC_API_KEY: "sk-ant-glass-test-fake",
})

const Credentials = Schema.fromJsonString(
  Schema.Struct({
    claudeAiOauth: Schema.Struct({ accessToken: Schema.String, expiresAt: Schema.Number }),
  }),
)

const loginToken = () => {
  const given = process.env["CLAUDE_CODE_OAUTH_TOKEN"]

  if (given !== undefined && given !== "") return given

  const config = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude")

  const { claudeAiOauth } = Schema.decodeUnknownSync(Credentials)(
    readFileSync(join(config, ".credentials.json"), "utf8"),
  )

  if (claudeAiOauth.expiresAt < Date.now())
    throw new Error("Your Claude Code login has expired. Run claude once to renew it.")

  return claudeAiOauth.accessToken
}

// The login's access token, not a copy of its credentials file: Claude Code may renew a copied
// login, rotating the refresh token the user's own Claude Code still holds.
export const claudeLoginEnvironment = (home: string) => ({
  ...isolatedEnvironment(home),
  CLAUDE_CODE_OAUTH_TOKEN: loginToken(),
  ANTHROPIC_MODEL: "haiku",
})
