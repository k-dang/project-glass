import {
  CheckIn,
  CheckInApproved,
  CheckInCancelled,
  CheckInChanges,
  CheckInError,
  CheckInFeedback,
  CheckInNoChanges,
  checkInNoteKeys,
  CheckInNotWaiting,
  CheckInTimedOut,
  type CheckInAnswer,
  type CheckInResult,
  type ConversationError,
  type FeedbackNote,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  type Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
  Stream,
  Struct,
} from "effect"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { Changes, changesId } from "./Changes"
import { FeedbackNotes, folderNotes, type NotesOwner } from "./FeedbackNotes"
import { defaultBranchOf, Git, topLevelOf } from "./git"
import { inboxWaitsOf } from "./inboxWaits"

export const CHECK_IN_TIMEOUT_SECONDS = 60 * 60

export const CHECK_IN_MAX_TIMEOUT_SECONDS = 2 * 60 * 60

export class CheckInRefused extends Schema.TaggedError<CheckInRefused>()("CheckInRefused", {
  message: Schema.String,
}) {}

interface CheckInInput {
  readonly folder: string
  readonly baseRef: string | null
  readonly summary: string | null
  readonly session: string
  readonly askedBy: string
  readonly timeout: Duration.Duration
}

interface Waiting {
  readonly checkIn: CheckIn
  readonly changes: CheckInChanges
}

const refused = (message: string) => () => new CheckInRefused({ message })

const asCheckInError = Effect.mapError(
  ({ message }: ConversationError) => new CheckInError({ message }),
)

const forAgent = (changes: CheckInChanges) => (note: FeedbackNote) => ({
  ...Struct.pick(note, checkInNoteKeys),
  outdated: note.changesId !== changes.id,
})

export class CheckIns extends Context.Service<
  CheckIns,
  {
    readonly ask: (input: CheckInInput) => Effect.Effect<CheckInResult, CheckInRefused>
    readonly changes: (checkInId: string) => Effect.Effect<CheckInChanges, CheckInNotWaiting>
    readonly notes: (
      checkInId: string,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, CheckInNotWaiting | CheckInError>
    readonly saveNote: (
      checkInId: string,
      note: FeedbackNote,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, CheckInNotWaiting | CheckInError>
    readonly removeNote: (
      checkInId: string,
      noteId: string,
    ) => Effect.Effect<ReadonlyArray<FeedbackNote>, CheckInNotWaiting | CheckInError>
    readonly answer: (
      checkInId: string,
      answer: CheckInAnswer,
    ) => Effect.Effect<void, CheckInNotWaiting | CheckInError>
    readonly watch: () => Stream.Stream<ReadonlyArray<CheckIn>>
    readonly cancelAll: () => Effect.Effect<void>
  }
>()("@glass/server/CheckIns") {
  static readonly layer = Layer.effect(
    CheckIns,
    Effect.gen(function* () {
      const git = yield* Git
      const changes = yield* Changes
      const notes = yield* FeedbackNotes

      const waits = yield* inboxWaitsOf<Waiting, CheckInResult>({
        idOf: ({ checkIn }) => checkIn.id,
        subjectOf: ({ checkIn }) => checkIn.folder,
        timedOut: CheckInTimedOut.make({}),
        cancelled: CheckInCancelled.make({}),
      })

      const waiting = (checkInId: string) =>
        waits.find(checkInId).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.mapError(() => new CheckInNotWaiting()),
        )

      const listedFor = (
        checkInId: string,
        write: (
          owner: NotesOwner,
        ) => Effect.Effect<{ readonly notes: ReadonlyArray<FeedbackNote> }, ConversationError>,
      ) =>
        waiting(checkInId).pipe(
          Effect.flatMap(({ checkIn }) => write(folderNotes(checkIn.folder)).pipe(asCheckInError)),
          Effect.map(({ notes: listed }) => listed),
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

      const ask = Effect.fnUntraced(function* (input: CheckInInput) {
        const { root, changes: snapshot } = yield* read(input.folder, input.baseRef)

        if (snapshot.files.length === 0) return CheckInNoChanges.make({})

        const checkIn = CheckIn.make({
          id: randomUUID(),
          folder: root,
          summary: input.summary,
          askedBy: input.askedBy,
          since: yield* DateTime.now,
        })

        return yield* waits
          .wait({ checkIn, changes: snapshot }, input.session, input.timeout)
          .pipe(
            Effect.mapError(({ on }) =>
              Match.value(on).pipe(
                Match.when(
                  "session",
                  refused("A Check-in from this session is already waiting in the Inbox."),
                ),
                Match.when(
                  "subject",
                  refused(`A Check-in on ${root} is already waiting in the Inbox.`),
                ),
                Match.exhaustive,
              ),
            ),
          )
      })

      const answer = Effect.fnUntraced(function* (checkInId: string, given: CheckInAnswer) {
        const { checkIn, changes: snapshot } = yield* waiting(checkInId)
        const owner = folderNotes(checkIn.folder)
        const taken = yield* notes.takeAll(owner).pipe(asCheckInError)

        if (
          Predicate.isTagged(given, "SendFeedback") &&
          taken.length === 0 &&
          given.message === null
        )
          yield* new CheckInError({
            message: "Leave a Feedback note or a message before you send feedback.",
          })

        const sent = { message: given.message, notes: taken.map(forAgent(snapshot)) }

        const answered = yield* waits.resolve(
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

      return CheckIns.of({
        ask,
        changes: (checkInId) =>
          waiting(checkInId).pipe(Effect.map(({ changes: snapshot }) => snapshot)),
        notes: (checkInId) => listedFor(checkInId, (owner) => notes.list(owner)),
        saveNote: (checkInId, note) => listedFor(checkInId, (owner) => notes.save(owner, note)),
        removeNote: (checkInId, noteId) =>
          listedFor(checkInId, (owner) => notes.remove(owner, noteId)),
        answer,
        watch: () => waits.watch().pipe(Stream.map((items) => items.map(({ checkIn }) => checkIn))),
        cancelAll: waits.cancelAll,
      })
    }),
  )
}
