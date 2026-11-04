import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { installedProgram } from "./replay"

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
  const file = join(config, ".credentials.json")

  // On macOS, Claude Code keeps the login in the Keychain rather than the file.
  const stored = existsSync(file)
    ? readFileSync(file, "utf8")
    : execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
      })

  const { claudeAiOauth } = Schema.decodeUnknownSync(Credentials)(stored)

  if (claudeAiOauth.expiresAt < Date.now())
    throw new Error("Your Claude Code login has expired. Run claude once to renew it.")

  return claudeAiOauth.accessToken
}

export const claudeLoginEnvironment = (home: string) => ({
  ...isolatedEnvironment(home),
  CLAUDE_CODE_OAUTH_TOKEN: loginToken(),
  ANTHROPIC_MODEL: "haiku",
})
