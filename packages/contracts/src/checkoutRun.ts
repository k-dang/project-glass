import { Schema } from "effect"

/** Why an agent run over a checkout of the PR, an Agent review or an Ask, failed. */
export const CheckoutRunReason = Schema.Literals([
  "not-ready",
  "runner",
  "no-access",
  "fetch-failed",
  "stale-revision",
  "unusable-output",
  "timeout",
  "github",
  "storage",
])

export type CheckoutRunReason = typeof CheckoutRunReason.Type
