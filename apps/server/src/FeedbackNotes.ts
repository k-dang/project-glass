import { AgentError, FeedbackNote, UnsentFeedback } from "@glass/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(FeedbackNote))

const decodeStaged = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String, staged: Schema.BooleanFromBit })),
)

const row = (agentId: string, note: FeedbackNote) => ({
  id: note.id,
  agent_id: agentId,
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
        () => new AgentError({ message: `Couldn't ${doing} your Feedback notes. Try again.` }),
      ),
    )

export class FeedbackNotes extends Context.Service<
  FeedbackNotes,
  {
    readonly list: (agentId: string) => Effect.Effect<UnsentFeedback, AgentError>
    readonly save: (
      agentId: string,
      note: FeedbackNote,
    ) => Effect.Effect<UnsentFeedback, AgentError>
    readonly remove: (agentId: string, noteId: string) => Effect.Effect<UnsentFeedback, AgentError>
    readonly stage: (agentId: string) => Effect.Effect<UnsentFeedback, AgentError>
    readonly take: (
      agentId: string,
      noteIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, AgentError>
    readonly restore: (
      agentId: string,
      notes: ReadonlyArray<FeedbackNote>,
    ) => Effect.Effect<void, AgentError>
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

      const list = Effect.fn("FeedbackNotes.list")((agentId: string) =>
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
      )

      return FeedbackNotes.of({
        list,
        save: Effect.fn("FeedbackNotes.save")((agentId, note) =>
          sql`
            INSERT INTO agent_feedback_note ${sql.insert(row(agentId, note))}
            ON CONFLICT (agent_id, id) DO UPDATE SET text = excluded.text
          `.pipe(guarded("save"), Effect.andThen(list(agentId))),
        ),
        remove: Effect.fn("FeedbackNotes.remove")((agentId, noteId) =>
          sql`
            DELETE FROM agent_feedback_note WHERE id = ${noteId} AND agent_id = ${agentId}
          `.pipe(guarded("remove"), Effect.andThen(list(agentId))),
        ),
        stage: Effect.fn("FeedbackNotes.stage")((agentId) =>
          sql`UPDATE agent_feedback_note SET staged = 1 WHERE agent_id = ${agentId}`.pipe(
            guarded("stage"),
            Effect.andThen(list(agentId)),
          ),
        ),
        take: Effect.fn("FeedbackNotes.take")(function* (agentId, noteIds) {
          if (noteIds.length === 0) return []

          const ids = Array.from(new Set(noteIds))

          const taken = yield* sql`
            DELETE FROM agent_feedback_note WHERE agent_id = ${agentId} AND staged = 1 AND ${sql.in("id", noteIds)}
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
        restore: Effect.fn("FeedbackNotes.restore")((agentId, notes) =>
          notes.length === 0
            ? Effect.void
            : sql`
                INSERT INTO agent_feedback_note ${sql.insert(notes.map((note) => row(agentId, note)))}
                ON CONFLICT (agent_id, id) DO NOTHING
              `.pipe(Effect.asVoid, guarded("restore")),
        ),
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
