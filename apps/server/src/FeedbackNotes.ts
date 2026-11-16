import { ConversationError, FeedbackNote, UnsentFeedback } from "@glass/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(FeedbackNote))

const decodeStaged = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String, staged: Schema.BooleanFromBit })),
)

const row = (conversationId: string, note: FeedbackNote) => ({
  id: note.id,
  conversation_id: conversationId,
  path: note.path,
  side: note.side,
  start_line: note.start,
  end_line: note.end,
  code: note.code,
  changes_id: note.changesId,
  text: note.text,
})

const guarded =
  (doing: "read" | "save" | "remove" | "stage" | "send" | "restore") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(`Couldn't ${doing} Feedback notes`, cause)),
      Effect.mapError(
        () =>
          new ConversationError({ message: `Couldn't ${doing} your Feedback notes. Try again.` }),
      ),
    )

export class FeedbackNotes extends Context.Service<
  FeedbackNotes,
  {
    readonly list: (conversationId: string) => Effect.Effect<UnsentFeedback, ConversationError>
    readonly save: (
      conversationId: string,
      note: FeedbackNote,
    ) => Effect.Effect<UnsentFeedback, ConversationError>
    readonly remove: (
      conversationId: string,
      noteId: string,
    ) => Effect.Effect<UnsentFeedback, ConversationError>
    readonly stage: (conversationId: string) => Effect.Effect<UnsentFeedback, ConversationError>
    readonly take: (
      conversationId: string,
      noteIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, ConversationError>
    readonly restore: (
      conversationId: string,
      notes: ReadonlyArray<FeedbackNote>,
    ) => Effect.Effect<void, ConversationError>
    readonly removeAll: (conversationId: string) => Effect.Effect<void, ConversationError>
  }
>()("@glass/server/FeedbackNotes") {
  static readonly layer = Layer.effect(
    FeedbackNotes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const columns = sql`
        id, path, side, start_line AS start, end_line AS end, code, changes_id AS changesId, text
      `

      const list = Effect.fn("FeedbackNotes.list")((conversationId: string) =>
        sql`
            SELECT ${columns}, staged FROM conversation_feedback_note
            WHERE conversation_id = ${conversationId} ORDER BY rowid
          `.pipe(
          Effect.flatMap((rows) =>
            Effect.all({
              notes: decodeNotes(rows),
              staged: decodeStaged(rows).pipe(
                Effect.map((flags) => flags.flatMap(({ id, staged }) => (staged ? [id] : []))),
              ),
            }),
          ),
          Effect.map((unsent) => new UnsentFeedback(unsent)),
          guarded("read"),
        ),
      )

      return FeedbackNotes.of({
        list,
        save: Effect.fn("FeedbackNotes.save")((conversationId, note) =>
          sql`
            INSERT INTO conversation_feedback_note ${sql.insert(row(conversationId, note))}
            ON CONFLICT (conversation_id, id) DO UPDATE SET text = excluded.text
          `.pipe(guarded("save"), Effect.andThen(list(conversationId))),
        ),
        remove: Effect.fn("FeedbackNotes.remove")((conversationId, noteId) =>
          sql`
            DELETE FROM conversation_feedback_note WHERE id = ${noteId} AND conversation_id = ${conversationId}
          `.pipe(guarded("remove"), Effect.andThen(list(conversationId))),
        ),
        stage: Effect.fn("FeedbackNotes.stage")((conversationId) =>
          sql`UPDATE conversation_feedback_note SET staged = 1 WHERE conversation_id = ${conversationId}`.pipe(
            guarded("stage"),
            Effect.andThen(list(conversationId)),
          ),
        ),
        take: Effect.fn("FeedbackNotes.take")(function* (conversationId, noteIds) {
          if (noteIds.length === 0) return []

          const ids = Array.from(new Set(noteIds))

          const taken = yield* sql`
            DELETE FROM conversation_feedback_note WHERE conversation_id = ${conversationId} AND staged = 1 AND ${sql.in("id", noteIds)}
            RETURNING ${columns}
          `.pipe(
            Effect.flatMap(decodeNotes),
            Effect.map((found) => ids.flatMap((id) => found.find((note) => note.id === id) ?? [])),
            guarded("send"),
          )

          if (taken.length !== ids.length)
            return yield* new ConversationError({
              message:
                "Some of these Feedback notes were already sent or removed. Review your feedback again.",
            })

          return taken
        }),
        restore: Effect.fn("FeedbackNotes.restore")((conversationId, notes) =>
          notes.length === 0
            ? Effect.void
            : sql`
                INSERT INTO conversation_feedback_note ${sql.insert(notes.map((note) => row(conversationId, note)))}
                ON CONFLICT (conversation_id, id) DO NOTHING
              `.pipe(Effect.asVoid, guarded("restore")),
        ),
        removeAll: Effect.fn("FeedbackNotes.removeAll")((conversationId) =>
          sql`DELETE FROM conversation_feedback_note WHERE conversation_id = ${conversationId}`.pipe(
            Effect.asVoid,
            guarded("remove"),
          ),
        ),
      })
    }),
  )
}
