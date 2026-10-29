import type { AgentReview, Revision } from "@glass/contracts"
import { DateTime } from "effect"
import { vi } from "vite-plus/test"
import type { AgentReviewControls } from "../src/renderer/useAgentReview"

export const controls = (overrides: Partial<AgentReviewControls>): AgentReviewControls => ({
  job: { status: "idle" },
  review: null,
  outdated: false,
  commandProblem: null,
  subscriptionProblem: null,
  reconnect: vi.fn<() => void>(),
  start: vi.fn<() => void>(),
  cancel: vi.fn<() => void>(),
  ...overrides,
})

export const reviewOf = (revision: Revision): AgentReview => ({
  revision,
  writtenAt: DateTime.makeUnsafe(0),
  markdown:
    "**The greeting changes a letter callers match on.** One line changes.\n\n## Callers expect the old letter\n\n`main.ts` matches on `b`.",
})
