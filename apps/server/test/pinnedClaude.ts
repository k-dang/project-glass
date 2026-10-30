import { createRequire } from "node:module"
import { join } from "node:path"

/** The executable shipped by the Claude Agent SDK version Glass pins. */
const pinnedClaude = () => {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")

  const platform = createRequire(sdk).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
  )

  return join(platform, "..", process.platform === "win32" ? "claude.exe" : "claude")
}

export const fakeAnthropicEnvironment = (home: string, url: string) => ({
  GLASS_CLAUDE_COMMAND: pinnedClaude(),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  ANTHROPIC_BASE_URL: url,
  ANTHROPIC_API_KEY: "sk-ant-glass-test-fake",
  ANTHROPIC_AUTH_TOKEN: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
})
