import {
  CheckIn,
  type CheckInAnswer,
  type CheckInAnswered,
  CheckInApproved,
  CheckInChanges,
  CheckedIn,
  CheckInError,
  CheckInFeedback,
  CheckInNoChanges,
  checkInNoteKeys,
  CheckInNotWaiting,
  CheckInOutcome,
  CheckInReplaced,
  type CheckInStarted,
  type CheckInState,
  type FeedbackNote,
  isLineNote,
  type LineNote,
  QuestionSetAside,
  QuestionWaiting,
  type ThreadError,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
  Stream,
  Struct,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { Changes, changesId } from "./Changes"
import { FeedbackNotes, folderNotes, type NotesOwner } from "./FeedbackNotes"
import { defaultBranchOf, Git, topLevelOf } from "./git"

class CheckInRefused extends Schema.TaggedError<CheckInRefused>()("CheckInRefused", {
  message: Schema.String,
}) {}

interface CheckInInput {
  readonly folder: string
  readonly baseRef: string | null
  readonly summary: string | null
  readonly agentId: string
  readonly askedBy: string
}

const CheckInRow = Schema.Struct({
  id: Schema.String,
  agent_id: Schema.String,
  asked_by: Schema.String,
  folder: Schema.String,
  summary: Schema.NullOr(Schema.String),
  changes_id: Schema.String,
  asked_at: Schema.DateTimeUtcFromString,
  outcome: Schema.NullOr(Schema.fromJsonString(CheckInOutcome)),
})

type CheckInRow = typeof CheckInRow.Type

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(CheckInRow))

const rowsOf = (query: Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
  query.pipe(Effect.flatMap(decodeRows), Effect.orDie)

const decodeChanges = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ changes: Schema.fromJsonString(CheckInChanges) })),
)

const encodeChanges = Schema.encodeSync(Schema.fromJsonString(CheckInChanges))

const encodeOutcome = Schema.encodeSync(Schema.fromJsonString(CheckInOutcome))

const refused = (message: string) => () => new CheckInRefused({ message })

const asCheckInError = Effect.mapError(({ message }: ThreadError) => new CheckInError({ message }))

const forAgent = (readId: string) => (note: LineNote) => ({
  ...Struct.pick(note, checkInNoteKeys),
  outdated: note.changesId !== readId,
})

const checkInOf = (row: CheckInRow) =>
  CheckIn.make({
    id: row.id,
    folder: row.folder,
    summary: row.summary,
    askedBy: row.asked_by,
    since: row.asked_at,
  })

const stateOf = (row: CheckInRow): CheckInState => row.outcome ?? QuestionWaiting.make({})

export class CheckIns extends Context.Service<
  CheckIns,
  {
    readonly ask: (input: CheckInInput) => Effect.Effect<CheckInStarted, CheckInRefused>
    readonly changes: (checkInId: string) => Effect.Effect<CheckInChanges, CheckInNotWaiting>
    readonly notes: (
      checkInId: string,
    ) => Effect.Effect<ReadonlyArray<LineNote>, CheckInNotWaiting | CheckInError>
    readonly saveNote: (
      checkInId: string,
      note: LineNote,
    ) => Effect.Effect<ReadonlyArray<LineNote>, CheckInNotWaiting | CheckInError>
    readonly removeNote: (
      checkInId: string,
      noteId: string,
    ) => Effect.Effect<ReadonlyArray<LineNote>, CheckInNotWaiting | CheckInError>
    readonly answer: (
      checkInId: string,
      answer: CheckInAnswer,
    ) => Effect.Effect<void, CheckInNotWaiting | CheckInError>
    readonly setAside: (checkInId: string) => Effect.Effect<void, CheckInNotWaiting>
    readonly stateFor: (
      checkInId: string,
      agentId: string,
    ) => Effect.Effect<Option.Option<CheckInState>>
    readonly watch: () => Stream.Stream<ReadonlyArray<CheckIn>>
    readonly forgetAgent: (agentId: string) => Effect.Effect<void>
  }
>()("@glass/server/CheckIns") {
  static readonly layer = Layer.effect(
    CheckIns,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const git = yield* Git
      const changes = yield* Changes
      const notes = yield* FeedbackNotes
      const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))

      const columns = sql`
        id, agent_id, asked_by, folder, summary, changes_id, asked_at, outcome
      `

      const readWaiting = rowsOf(
        sql`SELECT ${columns} FROM check_in WHERE outcome IS NULL ORDER BY asked_at, rowid`,
      ).pipe(Effect.map((rows) => rows.map(checkInOf)))

      const waitingList = yield* SubscriptionRef.make(yield* readWaiting)

      const refresh = readWaiting.pipe(
        Effect.flatMap((list) => SubscriptionRef.set(waitingList, list)),
      )

      const waiting = (checkInId: string) =>
        rowsOf(
          sql`SELECT ${columns} FROM check_in WHERE id = ${checkInId} AND outcome IS NULL`,
        ).pipe(
          Effect.flatMap(([row]) =>
            row === undefined ? Effect.fail(new CheckInNotWaiting()) : Effect.succeed(row),
          ),
        )

      const listedFor = (
        checkInId: string,
        write: (
          owner: NotesOwner,
        ) => Effect.Effect<{ readonly notes: ReadonlyArray<FeedbackNote> }, ThreadError>,
      ) =>
        waiting(checkInId).pipe(
          Effect.flatMap(({ folder }) => write(folderNotes(folder)).pipe(asCheckInError)),
          Effect.map(({ notes: listed }) => listed.filter(isLineNote)),
        )

      const read = Effect.fnUntraced(function* (folder: string, baseRef: string | null) {
        if (!isAbsolute(folder))
          return yield* new CheckInRefused({
            message: "folder must be an absolute path, such as your working directory.",
          })

        const [root, defaultBranch] = yield* Effect.all(
          [
            topLevelOf(git, folder).pipe(
              Effect.mapError(refused(`Glass found no git repository at ${folder}.`)),
            ),
            baseRef === null ? defaultBranchOf(git, folder, "origin") : Effect.succeedNone,
          ],
          { concurrency: "unbounded" },
        )

        const base =
          baseRef ?? Option.getOrNull(Option.map(defaultBranch, (branch) => `origin/${branch}`))

        if (base === null)
          return yield* new CheckInRefused({
            message:
              "The repository names no default branch (origin/HEAD), so pass baseRef, such as main.",
          })

        const files = yield* changes.since(root, base).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Couldn't read a Check-in's changes", cause),
          ),
          Effect.mapError(
            refused(
              `Glass couldn't read the changes in ${root} against ${base}. Check that baseRef names a branch or commit there.`,
            ),
          ),
        )

        return { root, changes: new CheckInChanges({ id: changesId(files), baseRef: base, files }) }
      })

      const ask = Effect.fn("CheckIns.ask")(function* (input: CheckInInput) {
        const { root, changes: snapshot } = yield* read(input.folder, input.baseRef)

        if (snapshot.files.length === 0) return CheckInNoChanges.make({})

        const id = randomUUID()
        const at = yield* now

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const [held] = yield* sql<{ readonly agent_id: string }>`
                SELECT agent_id FROM check_in WHERE folder = ${root} AND outcome IS NULL
              `

              if (held !== undefined && held.agent_id !== input.agentId)
                yield* new CheckInRefused({
                  message: `Another agent's Check-in on ${root} is waiting in the Inbox.`,
                })

              yield* sql`
                UPDATE check_in
                SET outcome = ${encodeOutcome(CheckInReplaced.make({ checkInId: id }))}
                WHERE folder = ${root} AND outcome IS NULL
              `
              yield* sql`
                INSERT INTO check_in ${sql.insert({
                  id,
                  agent_id: input.agentId,
                  asked_by: input.askedBy,
                  folder: root,
                  summary: input.summary,
                  changes: encodeChanges(snapshot),
                  changes_id: snapshot.id,
                  asked_at: at,
                })}
              `
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die))
        yield* refresh

        return CheckedIn.make({ checkInId: id })
      })

      const settle = Effect.fnUntraced(function* (checkInId: string, answered: CheckInAnswered) {
        const settled = yield* sql`
          UPDATE check_in SET outcome = ${encodeOutcome(answered)}
          WHERE id = ${checkInId} AND outcome IS NULL
          RETURNING id
        `.pipe(Effect.orDie)

        if (settled.length > 0) yield* refresh

        return settled.length > 0
      })

      const answer = Effect.fn("CheckIns.answer")(function* (
        checkInId: string,
        given: CheckInAnswer,
      ) {
        const row = yield* waiting(checkInId)
        const owner = folderNotes(row.folder)
        const taken = yield* notes.takeAll(owner).pipe(asCheckInError)

        if (
          Predicate.isTagged(given, "SendFeedback") &&
          taken.length === 0 &&
          given.message === null
        )
          yield* new CheckInError({
            message: "Leave a Feedback note or a message before you send feedback.",
          })

        const sent = {
          message: given.message,
          notes: taken.filter(isLineNote).map(forAgent(row.changes_id)),
        }

        const answered = yield* settle(
          checkInId,
          Match.value(given).pipe(
            Match.tag("Approve", () => CheckInApproved.make(sent)),
            Match.tag("SendFeedback", () => CheckInFeedback.make(sent)),
            Match.exhaustive,
          ),
        )

        if (!answered) {
          yield* notes.restore(owner, taken).pipe(Effect.ignore)
          yield* new CheckInNotWaiting()
        }
      })

      const setAside = Effect.fn("CheckIns.setAside")(function* (checkInId: string) {
        const settled = yield* sql`
          UPDATE check_in SET outcome = ${encodeOutcome(QuestionSetAside.make({}))}
          WHERE id = ${checkInId} AND outcome IS NULL
          RETURNING id
        `.pipe(Effect.orDie)

        if (settled.length === 0) yield* new CheckInNotWaiting()

        yield* refresh
      })

      const stateFor = Effect.fn("CheckIns.stateFor")(function* (
        checkInId: string,
        agentId: string,
      ) {
        const [row] = yield* rowsOf(
          sql`SELECT ${columns} FROM check_in WHERE id = ${checkInId} AND agent_id = ${agentId}`,
        )

        return Option.map(Option.fromNullishOr(row), stateOf)
      })

      return CheckIns.of({
        ask,
        changes: (checkInId) =>
          sql`SELECT changes FROM check_in WHERE id = ${checkInId} AND outcome IS NULL`.pipe(
            Effect.flatMap(decodeChanges),
            Effect.orDie,
            Effect.flatMap(([row]) =>
              row === undefined
                ? Effect.fail(new CheckInNotWaiting())
                : Effect.succeed(row.changes),
            ),
          ),
        notes: (checkInId) => listedFor(checkInId, (owner) => notes.list(owner)),
        saveNote: (checkInId, note) => listedFor(checkInId, (owner) => notes.save(owner, note)),
        removeNote: (checkInId, noteId) =>
          listedFor(checkInId, (owner) => notes.remove(owner, noteId)),
        answer,
        setAside,
        stateFor,
        watch: () => SubscriptionRef.changes(waitingList),
        forgetAgent: (agentId) =>
          sql`
            DELETE FROM check_in WHERE agent_id = ${agentId} AND outcome IS NULL RETURNING id
          `.pipe(
            Effect.orDie,
            Effect.flatMap((gone) => (gone.length === 0 ? Effect.void : refresh)),
          ),
      })
    }),
  )
}
