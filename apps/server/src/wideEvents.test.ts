import { assert, it } from "@effect/vitest"
import { Data, Effect, Schema } from "effect"
import { annotateUnit, recordDuration, wideEvents } from "./wideEvents"

class ReviewFailed extends Data.TaggedError("ReviewFailed")<{
  readonly message: string
  readonly prompt: string
}> {}

const Line = Schema.Struct({
  level: Schema.String,
  message: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Array(Schema.String)),
  source: Schema.String,
  launch_id: Schema.String,
  trace_id: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  pr: Schema.optional(Schema.String),
  clone: Schema.optional(Schema.String),
  agent_ms: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Struct({ tag: Schema.String, message: Schema.String })),
})

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(Line))

const capture = () => {
  const raw: Array<string> = []
  const lines: Array<typeof Line.Type> = []

  const layer = wideEvents("backend", (line) => {
    raw.push(line)
    lines.push(decodeLine(line))
  })

  return { raw, lines, layer }
}

it.effect("writes one line for a unit of work, and its logs as they happen", () =>
  Effect.gen(function* () {
    const { raw, lines, layer } = capture()

    const readBrief = Effect.fn("AgentReviews.readBrief")(function* () {
      yield* annotateUnit({ pr: "octo-org/hello-world#1", clone: "existing" })
      yield* Effect.logWarning("Couldn't read a review brief", "ENOENT").pipe(
        Effect.annotateLogs({ level: "DEBUG" }),
      )

      return yield* new ReviewFailed({ message: "Couldn't start the review", prompt: "secret" })
    })

    yield* readBrief().pipe(
      Effect.withSpan("StartAgentReview", { kind: "server" }),
      Effect.ignore,
      Effect.provide(layer),
    )

    const [warning, unit] = lines

    assert.strictEqual(lines.length, 2)
    assert.include(warning, { level: "WARN", message: "Couldn't read a review brief" })
    assert.deepStrictEqual(warning?.details, ["ENOENT"])
    assert.strictEqual(warning?.trace_id, unit?.trace_id)
    assert.include(unit, {
      level: "WARN",
      event: "StartAgentReview",
      outcome: "failure",
      pr: "octo-org/hello-world#1",
      clone: "existing",
      source: "backend",
    })
    assert.strictEqual(unit?.launch_id, warning?.launch_id)
    assert.deepStrictEqual(unit?.error, {
      tag: "ReviewFailed",
      message: "Couldn't start the review",
    })
    assert.notInclude(raw.join("\n"), "secret")
    assert.isNumber(unit?.duration_ms)
  }),
)

it.effect("treats root spans as units and their children as part of them", () =>
  Effect.gen(function* () {
    const { lines, layer } = capture()

    yield* Effect.void.pipe(
      Effect.withSpan("PullRequestMirror.read"),
      Effect.withSpan("PullRequestJob.tour", { root: true }),
      Effect.provide(layer),
    )

    yield* Effect.void.pipe(Effect.withSpan("Transcripts.endRunning"), Effect.provide(layer))

    assert.deepStrictEqual(
      lines.map(({ event, outcome }) => ({ event, outcome })),
      [{ event: "PullRequestJob.tour", outcome: "success" }],
    )
  }),
)

it.effect("records a duration even when the timed work fails", () =>
  Effect.gen(function* () {
    const { lines, layer } = capture()

    yield* Effect.fail("timed out").pipe(
      recordDuration("agent_ms"),
      Effect.withSpan("Tour", { root: true }),
      Effect.ignore,
      Effect.provide(layer),
    )

    assert.isNumber(lines[0]?.agent_ms)
  }),
)

it.effect("records a defect with its full cause", () =>
  Effect.gen(function* () {
    const { lines, layer } = capture()

    yield* Effect.die(new Error("boom")).pipe(
      Effect.withSpan("ListPullRequests", { kind: "server" }),
      Effect.ignoreCause,
      Effect.provide(layer),
    )

    const [unit] = lines

    assert.include(unit, { level: "ERROR", outcome: "failure" })
    assert.strictEqual(unit?.error?.tag, "Defect")
    assert.include(unit?.error?.message, "boom")
  }),
)
