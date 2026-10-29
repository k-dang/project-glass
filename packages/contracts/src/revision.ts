import { Schema } from "effect"

export class Revision extends Schema.Class<Revision>("Revision")({
  base: Schema.String,
  head: Schema.String,
}) {}

export const RevisionSide = Schema.Literals(["base", "head"] as const satisfies ReadonlyArray<
  keyof Revision
>)

export type RevisionSide = typeof RevisionSide.Type

export class StaleRevision extends Schema.TaggedError<StaleRevision>()("StaleRevision", {}) {}
