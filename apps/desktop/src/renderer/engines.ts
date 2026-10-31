import type { AgentEngine, AgentRunnerIdentity } from "@glass/contracts"

export const engineNames: Record<AgentEngine, string> = {
  "claude-code": "Claude Code",
  pi: "pi",
}

export const runnerLabel = ({ engine, model }: AgentRunnerIdentity) =>
  `${engineNames[engine]} · ${model}`
