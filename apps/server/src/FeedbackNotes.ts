import { AgentError, FeedbackNote } from "@glass/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(FeedbackNote))

const guarded =
  (doing: "read" | "save" | "remove") =>
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
    readonly list: (agentId: string) => Effect.Effect<ReadonlyArray<FeedbackNote>, AgentError>
    readonly save: (agentId: string, note: FeedbackNote) => Effect.Effect<void, AgentError>
    readonly remove: (agentId: string, noteId: string) => Effect.Effect<void, AgentError>
    readonly removeAll: (agentId: string) => Effect.Effect<void, AgentError>
  }
>()("@glass/server/FeedbackNotes") {
  static readonly layer = Layer.effect(
    FeedbackNotes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return FeedbackNotes.of({
        list: Effect.fn("FeedbackNotes.list")((agentId) =>
          sql`
            SELECT id, path, side, start_line AS start, end_line AS end, code,
              changes_id AS changesId, text
            FROM agent_feedback_note WHERE agent_id = ${agentId} ORDER BY rowid
          `.pipe(Effect.flatMap(decodeNotes), guarded("read")),
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
