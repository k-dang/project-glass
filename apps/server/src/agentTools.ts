export type AgentTools = "none" | "read-only"

const claudeReadTools = ["Read", "Grep", "Glob"]

type ToolList = Record<"read-only" | "review", ReadonlyArray<string>>

export const claudeTools: ToolList = {
  "read-only": claudeReadTools,
  review: [...claudeReadTools, "Bash"],
}

const piReadTools = ["read", "grep", "find", "ls"]

export const piTools: ToolList = {
  "read-only": piReadTools,
  review: [...piReadTools, "bash"],
}

export const piFilesFolder = (folder: string) => `${folder}.pi`

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
