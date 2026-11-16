import type { AgentHarness, AgentRunnerIdentity } from "@glass/contracts"

export const harnessNames: Record<AgentHarness, string> = {
  "claude-code": "Claude Code",
  pi: "pi",
}

export const runnerLabel = ({ harness, model }: AgentRunnerIdentity) =>
  `${harnessNames[harness]} · ${model}`
