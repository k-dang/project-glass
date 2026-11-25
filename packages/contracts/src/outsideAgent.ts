import { Schema } from "effect"

export class OutsideAgent extends Schema.Class<OutsideAgent>("OutsideAgent")({
  id: Schema.String,
  name: Schema.String,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
}) {}

export class OutsideAgentNotFound extends Schema.TaggedError<OutsideAgentNotFound>()(
  "OutsideAgentNotFound",
  {},
) {}

export const OutsideAgentRequest = Schema.TaggedStruct("OutsideAgentRequest", {
  id: Schema.String,
  name: Schema.String,
  redirectHost: Schema.String,
  since: Schema.DateTimeUtcFromString,
})

export type OutsideAgentRequest = typeof OutsideAgentRequest.Type

export const OutsideAgentDecision = Schema.Literals(["approve", "deny"])

export type OutsideAgentDecision = typeof OutsideAgentDecision.Type

export class OutsideAgentRequestNotWaiting extends Schema.TaggedError<OutsideAgentRequestNotWaiting>()(
  "OutsideAgentRequestNotWaiting",
  {},
) {}
