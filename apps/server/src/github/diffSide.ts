import type { DiffSide } from "@glass/contracts"
import { Schema } from "effect"

export const GitHubDiffSide = Schema.Literals(["LEFT", "RIGHT"])

export const fromGitHubSide = (side: typeof GitHubDiffSide.Type): DiffSide =>
  side === "LEFT" ? "old" : "new"

export const toGitHubSide = (side: DiffSide): typeof GitHubDiffSide.Type =>
  side === "old" ? "LEFT" : "RIGHT"
