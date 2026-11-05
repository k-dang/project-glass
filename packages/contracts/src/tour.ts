import { Schema } from "effect"
import { AgentRunnerIdentity } from "./engine"
import { CheckoutRunReason } from "./checkoutRun"
import { DiffSide } from "./discussion"
import { Revision } from "./revision"

const DiagramChange = Schema.Literals(["unchanged", "added", "removed"])

export const TourCodeTarget = Schema.Struct({
  path: Schema.NonEmptyString,
  side: DiffSide,
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
})

export type TourCodeTarget = typeof TourCodeTarget.Type

export const TourDiagramNode = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isMaxLength(40)),
  label: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
  change: DiagramChange,
  target: TourCodeTarget,
})

export type TourDiagramNode = typeof TourDiagramNode.Type

const FlowStep = Schema.Struct({
  caption: Schema.NonEmptyString.check(Schema.isMaxLength(240)),
  nodes: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  edges: Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).check(
    Schema.isMaxLength(8),
  ),
  stateChanges: Schema.Array(
    Schema.Struct({
      label: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
      before: Schema.String.check(Schema.isMaxLength(160)),
      after: Schema.String.check(Schema.isMaxLength(160)),
    }),
  ).check(Schema.isMaxLength(4)),
})

export const TourDiagram = Schema.Struct({
  nodes: Schema.Array(TourDiagramNode).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
  edges: Schema.Array(
    Schema.Struct({
      from: Schema.NonEmptyString,
      to: Schema.NonEmptyString,
      change: DiagramChange,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  steps: Schema.optionalKey(
    Schema.Array(FlowStep).check(Schema.isMinLength(2), Schema.isMaxLength(12)),
  ),
})

export type TourDiagram = typeof TourDiagram.Type

export const TourBeforeAfter = Schema.Struct({
  title: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
  lines: Schema.Array(
    Schema.Struct({
      depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
      text: Schema.NonEmptyString.check(Schema.isMaxLength(120)),
      change: DiagramChange,
      target: Schema.NullOr(TourCodeTarget),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(24)),
})

export type TourBeforeAfter = typeof TourBeforeAfter.Type

export const TourCallouts = Schema.Array(
  Schema.Struct({
    label: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
    target: TourCodeTarget,
  }),
).check(Schema.isMaxLength(6))

export type TourCallouts = typeof TourCallouts.Type

export const Chapter = Schema.Struct({
  title: Schema.String,
  explanation: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, summary: Schema.String })),
  diagram: Schema.optionalKey(Schema.NullOr(TourDiagram)),
  beforeAfter: Schema.optionalKey(Schema.NullOr(TourBeforeAfter)),
  callouts: Schema.optionalKey(TourCallouts),
})

export type Chapter = typeof Chapter.Type

export const Tour = Schema.Struct({
  revision: Revision,
  writtenAt: Schema.DateTimeUtcFromString,
  intent: Schema.String,
  beforeAfter: Schema.optionalKey(Schema.NullOr(TourBeforeAfter)),
  chapters: Schema.Array(Chapter),
  everythingElse: Schema.Array(Schema.String),
})

export type Tour = typeof Tour.Type

export class TourFailure extends Schema.TaggedError<TourFailure>()("TourFailure", {
  reason: CheckoutRunReason,
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
