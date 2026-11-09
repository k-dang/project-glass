import { AgentError, FeedbackNote, UnsentFeedback } from "@glass/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(FeedbackNote))

const decodeStaged = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String, staged: Schema.BooleanFromBit })),
)

const guarded =
  (doing: "read" | "save" | "remove" | "stage" | "send") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(`Couldn't ${doing} Feedback notes`, cause)),
      Effect.mapError(
        () => new AgentError({ message: `Couldn't ${doing} your Feedback notes. Try again.` }),
      ),
    )

export class FeedbackNotes extends Context.Service<
  FeedbackNotes,
  {
    readonly list: (agentId: string) => Effect.Effect<UnsentFeedback, AgentError>
    readonly save: (agentId: string, note: FeedbackNote) => Effect.Effect<void, AgentError>
    readonly remove: (agentId: string, noteId: string) => Effect.Effect<void, AgentError>
    readonly stage: (
      agentId: string,
      noteIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, AgentError>
    readonly take: (
      agentId: string,
      noteIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, AgentError>
    readonly removeAll: (agentId: string) => Effect.Effect<void, AgentError>
  }
>()("@glass/server/FeedbackNotes") {
  static readonly layer = Layer.effect(
    FeedbackNotes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const columns = sql`
        id, path, side, start_line AS start, end_line AS end, code, changes_id AS changesId, text
      `

      return FeedbackNotes.of({
        list: Effect.fn("FeedbackNotes.list")((agentId) =>
          sql`
            SELECT ${columns}, staged FROM agent_feedback_note
            WHERE agent_id = ${agentId} ORDER BY rowid
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
        ),
        save: Effect.fn("FeedbackNotes.save")((agentId, note) =>
          sql`
            INSERT INTO agent_feedback_note ${sql.insert({
              id: note.id,
              agent_id: agentId,
              path: note.path,
              side: note.side,
              start_line: note.start,
              end_line: note.end,
              code: note.code,
              changes_id: note.changesId,
              text: note.text,
            })}
            ON CONFLICT (agent_id, id) DO UPDATE SET text = excluded.text
          `.pipe(Effect.asVoid, guarded("save")),
        ),
        remove: Effect.fn("FeedbackNotes.remove")((agentId, noteId) =>
          sql`
            DELETE FROM agent_feedback_note WHERE id = ${noteId} AND agent_id = ${agentId}
          `.pipe(Effect.asVoid, guarded("remove")),
        ),
        stage: Effect.fn("FeedbackNotes.stage")((agentId, noteIds) =>
          sql`
            UPDATE agent_feedback_note
            SET staged = ${noteIds.length === 0 ? sql`0` : sql`${sql.in("id", noteIds)}`}
            WHERE agent_id = ${agentId}
          `.pipe(Effect.asVoid, guarded("stage")),
        ),
        take: Effect.fn("FeedbackNotes.take")(function* (agentId, noteIds) {
          if (noteIds.length === 0) return []

          const ids = Array.from(new Set(noteIds))

          const taken = yield* sql`
            DELETE FROM agent_feedback_note WHERE agent_id = ${agentId} AND ${sql.in("id", noteIds)}
            RETURNING ${columns}
          `.pipe(
            Effect.flatMap(decodeNotes),
            Effect.map((found) => ids.flatMap((id) => found.find((note) => note.id === id) ?? [])),
            guarded("send"),
          )

          if (taken.length !== ids.length)
            return yield* new AgentError({
              message:
                "Some of these Feedback notes were already sent or removed. Review your feedback again.",
            })

          return taken
        }),
        removeAll: Effect.fn("FeedbackNotes.removeAll")((agentId) =>
          sql`DELETE FROM agent_feedback_note WHERE agent_id = ${agentId}`.pipe(
            Effect.asVoid,
            guarded("remove"),
          ),
        ),
      })
    }),
  )
}
