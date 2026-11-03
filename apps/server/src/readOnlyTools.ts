/** The tools that read a folder without changing it, as each agent program names them. */
export const claudeReadOnlyTools = ["Read", "Grep", "Glob"]

export const piReadOnlyTools = ["read", "grep", "find", "ls"]

/**
 * Everything pi would load beyond the model, Glass's prompt, and the tools Glass names stays off:
 * the user's extensions, MCP servers, skills, prompt templates, themes, and the folder's context
 * files and trust-gated settings.
 */
export const piLoadsNothing = [
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
]
