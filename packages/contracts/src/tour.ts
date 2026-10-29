import { Schema } from "effect"
import { AgentRunnerIdentity } from "./engine"
import { Revision } from "./revision"

export const Chapter = Schema.Struct({
  title: Schema.String,
  explanation: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, summary: Schema.String })),
})

export type Chapter = typeof Chapter.Type

export const Tour = Schema.Struct({
  revision: Revision,
  writtenAt: Schema.DateTimeUtcFromString,
  intent: Schema.String,
  chapters: Schema.Array(Chapter),
  everythingElse: Schema.Array(Schema.String),
})

export type Tour = typeof Tour.Type

export class TourFailure extends Schema.TaggedError<TourFailure>()("TourFailure", {
  reason: Schema.Literals([
    "not-installed",
    "not-ready",
    "authentication",
    "runner",
    "timeout",
    "unusable-output",
    "github",
    "storage",
  ]),
  message: Schema.String,
  runner: Schema.NullOr(AgentRunnerIdentity),
}) {}

export const TourState = Schema.Struct({
  tour: Schema.NullOr(Tour),
  job: Schema.Union([
    Schema.Struct({ status: Schema.Literal("idle") }),
    Schema.Struct({ status: Schema.Literal("waiting") }),
    Schema.Struct({
      status: Schema.Literal("writing"),
      startedAt: Schema.Number,
      runner: Schema.NullOr(AgentRunnerIdentity),
    }),
    Schema.Struct({ status: Schema.Literal("failed"), reason: TourFailure }),
  ]),
})

export type TourState = typeof TourState.Type
