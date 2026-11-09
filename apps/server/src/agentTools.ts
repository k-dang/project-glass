// Read-only tasks (Tours, Ask) read the checkout and nothing else. Shell tasks (Agent reviews and
// their Follow-ups) also run commands, git above all, to find the change themselves (ADR 0005).
export type AgentTools = "read-only" | "shell"

const claudeReadTools = ["Read", "Grep", "Glob"]

export const claudeTools: Record<AgentTools, ReadonlyArray<string>> = {
  "read-only": claudeReadTools,
  shell: [...claudeReadTools, "Bash"],
}

const piReadTools = ["read", "grep", "find", "ls"]

export const piTools: Record<AgentTools, ReadonlyArray<string>> = {
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
  // Ignores the folder's own pi settings and resources, which pi gates behind project trust.
  "--no-approve",
]
