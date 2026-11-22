export type AgentTools = "none" | "read-only" | "shell"

const claudeReadTools = ["Read", "Grep", "Glob"]

type ToolList = Record<Exclude<AgentTools, "none">, ReadonlyArray<string>>

export const claudeTools: ToolList = {
  "read-only": claudeReadTools,
  shell: [...claudeReadTools, "Bash"],
}

const piReadTools = ["read", "grep", "find", "ls"]

export const piTools: ToolList = {
  "read-only": piReadTools,
  shell: [...piReadTools, "bash"],
}

export const piLoadsNothing = [
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  // WARNING: --no-approve makes pi ignore the folder's own settings and resources, which pi gates behind project trust.
  "--no-approve",
]
