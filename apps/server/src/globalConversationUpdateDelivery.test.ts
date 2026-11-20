import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { ConversationError, ConversationOutcome, GlobalConversationUpdate } from "@glass/contracts"
import { DateTime, Effect, Layer, Stream, Option } from "effect"
import { SqlClient } from "effect/sql"
import { Conversations } from "./Conversations"
import { AgentReviews } from "./AgentReviews"
import { migrationLoader } from "./Migrations"
import { StartedWork } from "./StartedWork"
import { Transcripts } from "./Transcripts"

const layer = StartedWork.layer.pipe(
  Layer.provideMerge(Transcripts.layer),
  Layer.provide(
    Layer.mock(Conversations)({ harnesses: () => ["pi"], markTurnSeen: () => Effect.void }),
  ),
  Layer.provide(Layer.mock(AgentReviews)({})),
  Layer.provideMerge(SqliteMigrator.layer({ loader: migrationLoader })),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)

const at = DateTime.makeUnsafe("2026-11-14T12:00:00Z")

const globalConversationUpdate = GlobalConversationUpdate.make({
  work: [
    ConversationOutcome.make({
      conversationId: "started",
      name: "Started",
      askedWith: "Build it",
      outcome: "finished",
      reason: null,
    }),
  ],
})

const globalConversationUpdateTurn = {
  message: "",
  images: [],
  context: globalConversationUpdate,
  retriesDelivery: true,
}

it.live(
  "commits the Global conversation update and its covered outcomes together, publishing only after commit",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const started = yield* StartedWork
      yield* sql`INSERT INTO global_started_conversation (global_conversation_id, conversation_id, started_at)
      VALUES ('global', 'started', ${DateTime.formatIso(at)})`
      const published = yield* transcripts.subscribeStarted

      const record = (turnId: string) =>
        started.recordGlobalConversationUpdate("global", turnId, [
          { work: globalConversationUpdate.work[0], at },
        ])

      const failed = yield* Effect.exit(
        transcripts.startIfIdle("session", globalConversationUpdateTurn, (turnId) =>
          record(turnId).pipe(
            Effect.andThen(new ConversationError({ message: "Crash before commit" })),
          ),
        ),
      )

      assert.equal(failed._tag, "Failure")
      assert.deepStrictEqual(
        yield* sql`SELECT global_conversation_update_outcome_at, global_conversation_update_turn_id FROM global_started_conversation`,
        [{ global_conversation_update_outcome_at: null, global_conversation_update_turn_id: null }],
      )
      assert.deepStrictEqual((yield* transcripts.read("session")).turns, [])

      yield* transcripts.startIfIdle("session", globalConversationUpdateTurn, record)
      const event = yield* published.pipe(Stream.runHead)
      const [turn] = (yield* transcripts.read("session")).turns
      assert.isDefined(turn)
      assert.equal(Option.getOrThrow(event).turnId, turn.id)
      assert.deepStrictEqual(
        yield* sql`SELECT global_conversation_update_outcome_at, global_conversation_update_turn_id FROM global_started_conversation`,
        [
          {
            global_conversation_update_outcome_at: DateTime.formatIso(at),
            global_conversation_update_turn_id: turn.id,
          },
        ],
      )
    }).pipe(Effect.provide(layer)),
)
