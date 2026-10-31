import type { AgentEngine, AgentRunnerIdentity } from "@glass/contracts"

export const engineLabels: Record<AgentEngine, string> = {
  "claude-code": "Claude Code",
  "pi-cli": "pi CLI",
}

export const runnerLabel = ({ engine, model }: AgentRunnerIdentity) =>
  `${engineLabels[engine]} · ${model}`
