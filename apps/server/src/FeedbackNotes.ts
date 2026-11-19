import { ConversationError, FeedbackNote, UnsentFeedback } from "@glass/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

/** Whose Feedback notes these are: one Conversation's, or one folder's for its Check-ins. */
export type NotesOwner = `conversation:${string}` | `folder:${string}`

export const conversationNotes = (conversationId: string): NotesOwner =>
  `conversation:${conversationId}`

export const folderNotes = (folder: string): NotesOwner => `folder:${folder}`

const decodeNotes = Schema.decodeUnknownEffect(Schema.Array(FeedbackNote))

const decodeStaged = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String, staged: Schema.BooleanFromBit })),
)

const row = (owner: NotesOwner, note: FeedbackNote) => ({
  id: note.id,
  owner,
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
    readonly list: (owner: NotesOwner) => Effect.Effect<UnsentFeedback, ConversationError>
    readonly save: (
      owner: NotesOwner,
      note: FeedbackNote,
    ) => Effect.Effect<UnsentFeedback, ConversationError>
    readonly remove: (
      owner: NotesOwner,
      noteId: string,
    ) => Effect.Effect<UnsentFeedback, ConversationError>
    readonly stage: (owner: NotesOwner) => Effect.Effect<UnsentFeedback, ConversationError>
    /** Removes and returns the staged notes named, failing unless all of them are still there. */
    readonly take: (
      owner: NotesOwner,
      noteIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, ConversationError>
    /** Removes and returns every note, in the order they were left. */
    readonly takeAll: (
      owner: NotesOwner,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, ConversationError>
    readonly restore: (
      owner: NotesOwner,
      notes: ReadonlyArray<FeedbackNote>,
    ) => Effect.Effect<void, ConversationError>
    readonly removeAll: (owner: NotesOwner) => Effect.Effect<void, ConversationError>
  }
>()("@glass/server/FeedbackNotes") {
  static readonly layer = Layer.effect(
    FeedbackNotes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const columns = sql`
        id, path, side, start_line AS start, end_line AS end, code, changes_id AS changesId, text
      `

      const list = Effect.fn("FeedbackNotes.list")((owner: NotesOwner) =>
        sql`
            SELECT ${columns}, staged FROM feedback_note
            WHERE owner = ${owner} ORDER BY rowid
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
        save: Effect.fn("FeedbackNotes.save")((owner, note) =>
          sql`
            INSERT INTO feedback_note ${sql.insert(row(owner, note))}
            ON CONFLICT (owner, id) DO UPDATE SET text = excluded.text
          `.pipe(guarded("save"), Effect.andThen(list(owner))),
        ),
        remove: Effect.fn("FeedbackNotes.remove")((owner, noteId) =>
          sql`DELETE FROM feedback_note WHERE id = ${noteId} AND owner = ${owner}`.pipe(
            guarded("remove"),
            Effect.andThen(list(owner)),
          ),
        ),
        stage: Effect.fn("FeedbackNotes.stage")((owner) =>
          sql`UPDATE feedback_note SET staged = 1 WHERE owner = ${owner}`.pipe(
            guarded("stage"),
            Effect.andThen(list(owner)),
          ),
        ),
        take: Effect.fn("FeedbackNotes.take")(function* (owner, noteIds) {
          if (noteIds.length === 0) return []

          const ids = Array.from(new Set(noteIds))

          const taken = yield* sql`
            DELETE FROM feedback_note WHERE owner = ${owner} AND staged = 1 AND ${sql.in("id", noteIds)}
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
        takeAll: Effect.fn("FeedbackNotes.takeAll")((owner) =>
          sql<{ readonly position: number }>`
            DELETE FROM feedback_note WHERE owner = ${owner}
            RETURNING rowid AS position, ${columns}
          `.pipe(
            Effect.map((rows) => rows.toSorted((a, b) => a.position - b.position)),
            Effect.flatMap(decodeNotes),
            guarded("send"),
          ),
        ),
        restore: Effect.fn("FeedbackNotes.restore")((owner, notes) =>
          notes.length === 0
            ? Effect.void
            : sql`
                INSERT INTO feedback_note ${sql.insert(notes.map((note) => row(owner, note)))}
                ON CONFLICT (owner, id) DO NOTHING
              `.pipe(Effect.asVoid, guarded("restore")),
        ),
        removeAll: Effect.fn("FeedbackNotes.removeAll")((owner) =>
          sql`DELETE FROM feedback_note WHERE owner = ${owner}`.pipe(
            Effect.asVoid,
            guarded("remove"),
          ),
        ),
      })
    }),
  )
}
