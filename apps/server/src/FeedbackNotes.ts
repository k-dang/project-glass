import { AgentError, FeedbackNote, UnsentFeedback } from "@glass/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(FeedbackNote))

const decodeListed = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...FeedbackNote.fields, staged: Schema.BooleanFromBit })),
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

      const notesWhere = (agentId: string, only: ReadonlyArray<string>) => sql`
        SELECT id, path, side, start_line AS start, end_line AS end, code,
          changes_id AS changesId, text
        FROM agent_feedback_note
        WHERE agent_id = ${agentId} AND ${sql.in("id", only)}
        ORDER BY rowid
      `

      return FeedbackNotes.of({
        list: Effect.fn("FeedbackNotes.list")((agentId) =>
          sql`
            SELECT id, path, side, start_line AS start, end_line AS end, code,
              changes_id AS changesId, text, staged
            FROM agent_feedback_note WHERE agent_id = ${agentId} ORDER BY rowid
          `.pipe(
            Effect.flatMap(decodeListed),
            Effect.map(
              (rows) =>
                new UnsentFeedback({
                  notes: rows.map(
                    ({ id, path, side, start, end, code, changesId, text }) =>
                      new FeedbackNote({ id, path, side, start, end, code, changesId, text }),
                  ),
                  staged: rows.flatMap(({ id, staged }) => (staged ? [id] : [])),
                }),
            ),
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

          const taken = yield* Effect.gen(function* () {
            const found = yield* notesWhere(agentId, noteIds).pipe(Effect.flatMap(decodeNotes))

            yield* sql`
              DELETE FROM agent_feedback_note WHERE agent_id = ${agentId} AND ${sql.in("id", noteIds)}
            `

            return found
          }).pipe(guarded("send"))

          if (taken.length !== new Set(noteIds).size)
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
