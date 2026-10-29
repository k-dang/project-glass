import type { AgentRunnerIdentity, Engine } from "@glass/contracts"

export const engineLabels: Record<Engine, string> = {
  "claude-code": "Claude Code",
  pi: "pi",
  "pi-cli": "pi CLI",
}

export const runnerLabel = ({ engine, model }: AgentRunnerIdentity) =>
  `${engineLabels[engine]} · ${model}`
