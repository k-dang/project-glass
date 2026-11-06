import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  applyTranscriptUpdate,
  emptyTranscript,
  PartSet,
  ToolCallPart,
  TurnCutOff,
  TurnDone,
  TurnEnded,
  TurnFailed,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { migrationLoader } from "./Migrations"
import { Transcripts } from "./Transcripts"
import { wideEvents } from "./wideEvents"

const database = SqliteClient.layer({ filename: ":memory:" })

const transcriptsLayer = Transcripts.layer.pipe(
  Layer.provide(SqliteMigrator.layer({ loader: migrationLoader })),
  Layer.provide(database),
)

it.live(
  "keeps a stopped Turn stopped, and its Queued messages waiting, when its program ends it late",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts
      yield* transcripts.startOrQueue("agent-1", { message: "Build it", images: [], context: null })
      yield* transcripts.startOrQueue("agent-1", {
        message: "Then docs",
        images: [],
        context: null,
      })
      const turnId = yield* transcripts.runningTurn("agent-1")

      yield* transcripts.endRunning(TurnStopped.make({}), ["agent-1"])
      yield* transcripts.save("agent-1", [
        TurnEnded.make({
          turnId: turnId ?? "",
          ended: { at: yield* DateTime.now, ending: TurnDone.make({}) },
        }),
      ])

      const { turns, queued } = applyTranscriptUpdate(
        emptyTranscript,
        Option.getOrThrow(yield* Stream.runHead(transcripts.watch("agent-1"))),
      )

      assert.deepStrictEqual(turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.deepStrictEqual(
        queued.map(({ message }) => message),
        ["Then docs"],
      )
    }).pipe(Effect.provide(transcriptsLayer)),
)

const TurnUnit = Schema.Struct({
  level: Schema.String,
  event: Schema.String,
  outcome: Schema.String,
  error: Schema.optional(Schema.Struct({ tag: Schema.String, message: Schema.String })),
  duration_ms: Schema.Number,
  agent_id: Schema.String,
  turn_id: Schema.String,
  ending: Schema.String,
  engine: Schema.Null,
  tool_calls: Schema.Number,
  failed_tool_calls: Schema.Number,
})

const decodeTurnUnit = Schema.decodeUnknownSync(Schema.fromJsonString(TurnUnit))

it.effect("records a Turn as a unit of work when it ends", () =>
  Effect.gen(function* () {
    const lines: Array<typeof TurnUnit.Type> = []
    const transcripts = yield* Transcripts
    yield* transcripts.startOrQueue("agent-1", { message: "Build it", images: [], context: null })
    const turnId = (yield* transcripts.runningTurn("agent-1")) ?? ""

    const toolCall = (index: number, status: "done" | "failed") =>
      PartSet.make({
        turnId,
        index,
        part: ToolCallPart.make({
          toolCallId: `call-${index}`,
          name: "Bash",
          inputSummary: "pnpm test",
          input: "{}",
          output: null,
          status,
          parentToolCallId: null,
        }),
      })

    yield* transcripts.save("agent-1", [toolCall(0, "done"), toolCall(1, "failed")])
    yield* TestClock.adjust("3 seconds")

    yield* transcripts
      .save("agent-1", [
        TurnEnded.make({
          turnId,
          ended: { at: yield* DateTime.now, ending: TurnFailed.make({ reason: "pi exited" }) },
        }),
      ])
      .pipe(Effect.provide(wideEvents("backend", (line) => lines.push(decodeTurnUnit(line)))))

    assert.deepStrictEqual(lines, [
      {
        level: "WARN",
        event: "Turn",
        outcome: "failure",
        error: { tag: "TurnFailure", message: "pi exited" },
        duration_ms: 3000,
        agent_id: "agent-1",
        turn_id: turnId,
        ending: "Failed",
        engine: null,
        tool_calls: 2,
        failed_tool_calls: 1,
      },
    ])
  }).pipe(Effect.provide(transcriptsLayer)),
)

it.effect("records a cut-off Turn again when its real end arrives", () =>
  Effect.gen(function* () {
    const lines: Array<typeof TurnUnit.Type> = []
    const transcripts = yield* Transcripts
    yield* transcripts.startOrQueue("agent-1", { message: "Build it", images: [], context: null })
    const turnId = (yield* transcripts.runningTurn("agent-1")) ?? ""

    yield* Effect.gen(function* () {
      yield* transcripts.endRunning(TurnCutOff.make({}), ["agent-1"])
      yield* transcripts.save("agent-1", [
        TurnEnded.make({ turnId, ended: { at: yield* DateTime.now, ending: TurnDone.make({}) } }),
      ])
    }).pipe(Effect.provide(wideEvents("backend", (line) => lines.push(decodeTurnUnit(line)))))

    assert.deepStrictEqual(
      lines.map(({ turn_id, ending, outcome }) => ({ turn_id, ending, outcome })),
      [
        { turn_id: turnId, ending: "CutOff", outcome: "interrupted" },
        { turn_id: turnId, ending: "Done", outcome: "success" },
      ],
    )
  }).pipe(Effect.provide(transcriptsLayer)),
)
