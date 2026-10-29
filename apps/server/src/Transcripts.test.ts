import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  applyTranscriptUpdate,
  emptyTranscript,
  TurnDone,
  TurnEnded,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Effect, Layer, Option, Stream } from "effect"
import { migrationLoader } from "./Migrations"
import { Transcripts } from "./Transcripts"

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
      yield* transcripts.startOrQueue("agent-1", { message: "Build it", images: [] })
      yield* transcripts.startOrQueue("agent-1", { message: "Then docs", images: [] })
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
