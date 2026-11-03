export const claudeReadOnlyTools = ["Read", "Grep", "Glob"]

export const piReadOnlyTools = ["read", "grep", "find", "ls"]

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
