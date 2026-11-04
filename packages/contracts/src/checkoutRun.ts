import { Schema } from "effect"

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
