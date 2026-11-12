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
