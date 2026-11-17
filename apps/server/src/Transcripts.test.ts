import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  applyTranscriptUpdate,
  emptyTranscript,
  ExtensionStatusesChanged,
  PartAppended,
  PartSet,
  TextPart,
  ToolCallPart,
  type Transcript,
  type TranscriptUpdate,
  TurnCutOff,
  TurnDone,
  TurnEnded,
  TurnFailed,
  TurnStarted,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Effect, Layer, Option, Predicate, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { migrationLoader } from "./Migrations"
import { RECENT_TURNS, Transcripts } from "./Transcripts"
import { wideEvents } from "./wideEvents"

const database = SqliteClient.layer({ filename: ":memory:" })

const transcriptsLayer = Transcripts.layer.pipe(
  Layer.provide(SqliteMigrator.layer({ loader: migrationLoader })),
  Layer.provide(database),
)

it.live(
  "keeps a stopped Turn stopped, and its Queued messages waiting, when its harness ends it late",
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

it.live(
  "hands its harness only the Turns Glass started, not one the Conversation started itself",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts
      const started = yield* transcripts.subscribeStarted
      const at = yield* DateTime.now

      yield* transcripts.save("agent-1", [
        TurnStarted.make({
          turnId: "woke",
          message: "",
          images: [],
          context: null,
          feedback: [],
          sentAt: at,
        }),
      ])
      yield* transcripts.startOrQueue("agent-1", { message: "Next", images: [], context: null })
      yield* transcripts.save("agent-1", [
        TurnEnded.make({ turnId: "woke", ended: { at, ending: TurnDone.make({}) } }),
      ])

      const first = Option.getOrThrow(yield* Stream.runHead(started))
      assert.equal(first.message, "Next")

      const { turns } = yield* transcripts.read("agent-1")
      assert.deepStrictEqual(
        turns.map(({ message }) => message),
        ["", "Next"],
      )
    }).pipe(Effect.scoped, Effect.provide(transcriptsLayer)),
)

it.live("shows a Conversation's extension statuses until Glass loses the Conversation", () =>
  Effect.gen(function* () {
    const transcripts = yield* Transcripts

    yield* transcripts.save("agent-1", [
      ExtensionStatusesChanged.make({ extensionStatuses: ["Plan mode"] }),
    ])
    assert.deepStrictEqual((yield* transcripts.read("agent-1")).extensionStatuses, ["Plan mode"])

    yield* transcripts.endRunning(TurnCutOff.make({}), ["agent-1"])
    assert.deepStrictEqual((yield* transcripts.read("agent-1")).extensionStatuses, [])
  }).pipe(Effect.provide(transcriptsLayer)),
)

const TurnUnit = Schema.Struct({
  level: Schema.String,
  event: Schema.String,
  outcome: Schema.String,
  error: Schema.optional(Schema.Struct({ tag: Schema.String, message: Schema.String })),
  duration_ms: Schema.Number,
  conversation_id: Schema.String,
  turn_id: Schema.String,
  ending: Schema.String,
  harness: Schema.Null,
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
        conversation_id: "agent-1",
        turn_id: turnId,
        ending: "Failed",
        harness: null,
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

const turnIds = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `turn-${from + index}`)

const addEndedTurns = Effect.fnUntraced(function* (agentId: string, ids: ReadonlyArray<string>) {
  const transcripts = yield* Transcripts
  const at = yield* DateTime.now

  for (const turnId of ids)
    yield* transcripts.save(agentId, [
      TurnStarted.make({
        turnId,
        message: turnId,
        images: [],
        context: null,
        feedback: [],
        sentAt: at,
      }),
      TurnEnded.make({ turnId, ended: { at, ending: TurnDone.make({}) } }),
    ])
})

it.effect(
  "reads only the latest Turns and pages back with a cursor that holds as Turns arrive",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts
      yield* addEndedTurns("agent-1", turnIds(1, 45))

      const pull = yield* Stream.toPull(transcripts.watch("agent-1"))
      let transcript = (yield* pull).reduce(applyTranscriptUpdate, emptyTranscript)

      assert.deepStrictEqual(
        transcript.turns.map(({ id }) => id),
        turnIds(46 - RECENT_TURNS, 45),
      )
      assert.equal(transcript.earlierTurns, 45 - RECENT_TURNS)

      yield* addEndedTurns("agent-1", turnIds(46, 47))

      while (transcript.earlierTurns > 0) {
        const before = transcript.turns[0]?.id ?? ""
        yield* transcripts.loadEarlier("agent-1", before)

        while (transcript.turns[0]?.id === before)
          transcript = (yield* pull).reduce(applyTranscriptUpdate, transcript)
      }

      while (transcript.turns.at(-1)?.ended === null || transcript.turns.at(-1)?.id !== "turn-47")
        transcript = (yield* pull).reduce(applyTranscriptUpdate, transcript)

      assert.deepStrictEqual(
        transcript.turns.map(({ id }) => id),
        turnIds(1, 47),
      )
      assert.deepStrictEqual(
        (yield* transcripts.read("agent-1", 3)).turns.map(({ id }) => id),
        turnIds(45, 47),
      )
    }).pipe(Effect.scoped, Effect.provide(transcriptsLayer)),
)

const textOf = (transcript: Transcript, turnId: string) =>
  transcript.turns
    .find(({ id }) => id === turnId)
    ?.parts.flatMap((part) => (Predicate.isTagged(part, "Text") ? [part.text] : []))
    .join("")

it.effect(
  "hands earlier Turns to a watch in order with its events, so a Turn changed while unloaded changes once",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts
      const at = yield* DateTime.now

      yield* transcripts.save("agent-1", [
        TurnStarted.make({
          turnId: "cut-off",
          message: "Build it",
          images: [],
          context: null,
          feedback: [],
          sentAt: at,
        }),
        PartSet.make({ turnId: "cut-off", index: 0, part: TextPart.make({ text: "Hel" }) }),
      ])
      yield* transcripts.endRunning(TurnCutOff.make({}), ["agent-1"])
      yield* addEndedTurns("agent-1", turnIds(1, RECENT_TURNS))

      const pull = yield* Stream.toPull(transcripts.watch("agent-1"))
      const seen: Array<TranscriptUpdate> = [...(yield* pull)]
      let transcript = seen.reduce(applyTranscriptUpdate, emptyTranscript)

      assert.equal(transcript.earlierTurns, 1)
      assert.isUndefined(textOf(transcript, "cut-off"))

      yield* transcripts.save("agent-1", [
        PartAppended.make({ turnId: "cut-off", index: 0, text: "lo" }),
        TurnEnded.make({ turnId: "cut-off", ended: { at, ending: TurnDone.make({}) } }),
      ])
      yield* transcripts.loadEarlier("agent-1", "turn-1")
      yield* transcripts.save("agent-1", [
        PartAppended.make({ turnId: "cut-off", index: 0, text: "!" }),
      ])

      const afterPage = () =>
        seen.slice(seen.findIndex((update) => Predicate.isTagged(update, "EarlierTurns")) + 1)

      while (
        !seen.some((update) => Predicate.isTagged(update, "EarlierTurns")) ||
        !afterPage().some((update) => Predicate.isTagged(update, "PartAppended"))
      ) {
        const next = yield* pull
        seen.push(...next)
        transcript = next.reduce(applyTranscriptUpdate, transcript)
      }

      assert.deepStrictEqual(
        transcript.turns.map(({ id }) => id),
        ["cut-off", ...turnIds(1, RECENT_TURNS)],
      )
      assert.equal(transcript.earlierTurns, 0)
      assert.equal(textOf(transcript, "cut-off"), "Hello!")
      assert.deepStrictEqual(transcript.turns[0]?.ended?.ending, TurnDone.make({}))
    }).pipe(Effect.scoped, Effect.provide(transcriptsLayer)),
)
