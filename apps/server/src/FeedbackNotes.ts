import { ThreadError, FeedbackNote, isPageNote, UnsentFeedback } from "@glass/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

export type NotesOwner = `thread:${string}` | `folder:${string}`

export const threadNotes = (threadId: string): NotesOwner => `thread:${threadId}`

export const folderNotes = (folder: string): NotesOwner => `folder:${folder}`

const decodeNotes = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ note: Schema.fromJsonString(FeedbackNote) })),
)

const notesOf = (rows: ReadonlyArray<unknown>) =>
  decodeNotes(rows).pipe(Effect.map((decoded) => decoded.map(({ note }) => note)))

const encodeNote = Schema.encodeSync(Schema.fromJsonString(FeedbackNote))

const decodeStaged = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String, staged: Schema.BooleanFromBit })),
)

const row = (owner: NotesOwner, note: FeedbackNote) => ({
  owner,
  id: note.id,
  note: encodeNote(note),
  staged: isPageNote(note) ? 1 : 0,
})

const guarded =
  (doing: "read" | "save" | "remove" | "stage" | "send" | "restore") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(`Couldn't ${doing} Feedback notes`, cause)),
      Effect.mapError(
        () => new ThreadError({ message: `Couldn't ${doing} your Feedback notes. Try again.` }),
      ),
    )

export class FeedbackNotes extends Context.Service<
  FeedbackNotes,
  {
    readonly list: (owner: NotesOwner) => Effect.Effect<UnsentFeedback, ThreadError>
    readonly save: (
      owner: NotesOwner,
      note: FeedbackNote,
    ) => Effect.Effect<UnsentFeedback, ThreadError>
    readonly remove: (
      owner: NotesOwner,
      noteId: string,
    ) => Effect.Effect<UnsentFeedback, ThreadError>
    readonly stage: (owner: NotesOwner) => Effect.Effect<UnsentFeedback, ThreadError>
    readonly take: (
      owner: NotesOwner,
      noteIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, ThreadError>
    readonly takeAll: (owner: NotesOwner) => Effect.Effect<ReadonlyArray<FeedbackNote>, ThreadError>
    readonly restore: (
      owner: NotesOwner,
      notes: ReadonlyArray<FeedbackNote>,
    ) => Effect.Effect<void, ThreadError>
    readonly removeAll: (owner: NotesOwner) => Effect.Effect<void, ThreadError>
  }
>()("@glass/server/FeedbackNotes") {
  static readonly layer = Layer.effect(
    FeedbackNotes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const list = Effect.fn("FeedbackNotes.list")((owner: NotesOwner) =>
        sql`
            SELECT id, note, staged FROM feedback_note
            WHERE owner = ${owner} ORDER BY rowid
          `.pipe(
          Effect.flatMap((rows) =>
            Effect.all({
              notes: notesOf(rows),
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
            ON CONFLICT (owner, id) DO UPDATE SET note = excluded.note
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
            RETURNING id, note
          `.pipe(
            Effect.flatMap(notesOf),
            Effect.map((found) => ids.flatMap((id) => found.find((note) => note.id === id) ?? [])),
            guarded("send"),
          )

          if (taken.length !== ids.length)
            return yield* new ThreadError({
              message:
                "Some of these Feedback notes were already sent or removed. Review your feedback again.",
            })

          return taken
        }),
        takeAll: Effect.fn("FeedbackNotes.takeAll")((owner) =>
          sql<{ readonly position: number }>`
            DELETE FROM feedback_note WHERE owner = ${owner}
            RETURNING rowid AS position, note
          `.pipe(
            Effect.map((rows) => rows.toSorted((a, b) => a.position - b.position)),
            Effect.flatMap(notesOf),
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
