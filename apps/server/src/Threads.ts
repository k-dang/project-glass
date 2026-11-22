import {
  Thread,
  ThreadBusy,
  type AgentHarness,
  ThreadError,
  type ThreadFile,
  type AgentCommand,
  AgentModels,
  type ConnectionError,
  ThreadNotFound,
  type ThreadPlace,
  asksLessThan,
  asksPermission,
  startingPermissionMode,
  ThreadChanges,
  ThreadStarted,
  ChangedFile,
  type FeedbackNote,
  FollowedRepository,
  type InvalidLocalCheckout,
  type MessageDelivery,
  type MessageInput,
  type ModelChoice,
  type NewThread,
  type PermissionMode,
  RemovalWarnings,
  type QueuedMessageStarted,
  type RequestAnswer,
  NoPermissionModes,
  type RequestNotWaiting,
  type RequestWaiting,
  type Revision,
  localPlace,
  mentionedToDoIds,
  repositoryKey,
  type Transcript,
  type TranscriptUpdate,
  type TurnEnd,
  type SentMessage,
  type UnsentFeedback,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { randomUUID } from "node:crypto"
import { changesId } from "./Changes"
import { ActivityLog } from "./ActivityLog"
import { firstFreeBranch } from "./BranchNames"
import { threadBranchNaming } from "./threadBranchNaming"
import { threadWith, decodeStored, sandboxProviderOf, toRow } from "./threadRows"
import { type ClaimedThread, type ThreadHost, ThreadTurns } from "./ThreadTurns"
import { threadNotes, FeedbackNotes } from "./FeedbackNotes"
import {
  asThreadError,
  type HostCallError,
  type HostClient,
  type PlacedThread,
  type ThreadHosting,
  type Placement,
} from "./Placement"
import { Sandboxes } from "./Sandboxes"
import { LocalPlacement } from "./LocalPlacement"
import { type RepositoryRole, ReviewBrief, ReviewRole, WorkRole } from "./agentHost/protocol"
import { LocalSkills } from "./LocalSkills"
import { SkillPacks } from "./SkillPacks"
import { ToDos } from "./ToDos"
import { Transcripts, type WaitingRequest } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

const changesOf = (files: ReadonlyArray<ChangedFile>) =>
  new ThreadChanges({
    id: changesId(files),
    files,
  })

const BriefJson = Schema.fromJsonString(ReviewBrief)

const encodeBrief = Schema.encodeSync(BriefJson)

const decodeBrief = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ brief: BriefJson })))

const decodeKeptGoing = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String, keptGoingAt: Schema.DateTimeUtcFromString })),
)

const annotateThread = ({ id, harness, model, place }: Thread) =>
  annotateUnit({ thread_id: id, harness, model, sandbox_provider: sandboxProviderOf(place) })

const inSandbox = (place: ThreadPlace) => Predicate.isTagged(place, "sandbox")

const refuseReach = (
  from: Thread,
  to: Pick<Thread, "place" | "permissionMode">,
  refusals: { readonly leavesSandbox: string; readonly asksLess: string },
) =>
  inSandbox(from.place) && !inSandbox(to.place)
    ? Effect.fail(new ThreadError({ message: refusals.leavesSandbox }))
    : asksLessThan(to.permissionMode, from.permissionMode)
      ? Effect.fail(new ThreadError({ message: refusals.asksLess }))
      : Effect.void

const storageFailure = () =>
  new ThreadError({ message: "Couldn't read or save your Threads. Try again." })

const couldNotSave = (cause: SqlError.SqlError) =>
  Effect.logWarning("Couldn't save a Thread", cause).pipe(
    Effect.andThen(Effect.fail(storageFailure())),
  )

type Purpose = Data.TaggedEnum<{
  Work: { readonly packs: ReadonlyArray<string> }
  Review: { readonly brief: ReviewBrief }
}>

const Purpose = Data.taggedEnum<Purpose>()

interface NewReviewThread {
  readonly name: string
  readonly repository: FollowedRepository
  readonly revision: Revision
  readonly harness: AgentHarness
  readonly model: string | null
  readonly checkout: string
  readonly review: ReviewBrief
  readonly message: string
}

export interface WaitingThread {
  readonly thread: Thread
  readonly requests: Arr.NonEmptyReadonlyArray<WaitingRequest>
}

export interface FinishedThread {
  readonly thread: Thread
  readonly ended: TurnEnd
}

export class Threads extends Context.Service<
  Threads,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<Thread>, ThreadError>
    readonly watchWaiting: () => Stream.Stream<ReadonlyArray<WaitingThread>>
    readonly watchFinished: () => Stream.Stream<ReadonlyArray<FinishedThread>>
    readonly watchWorking: () => Stream.Stream<ReadonlyArray<string>>
    readonly keptGoing: Stream.Stream<ReadonlyMap<string, DateTime.Utc>>
    readonly bringBack: (threadId: string) => Effect.Effect<void, ThreadNotFound | ThreadError>
    readonly markTurnSeen: (
      threadId: string,
      endedAt: DateTime.Utc,
    ) => Effect.Effect<void, ThreadError>
    readonly readTranscript: (
      threadId: string,
      turns: number,
    ) => Effect.Effect<Transcript, ThreadNotFound | ThreadError>
    readonly loadEarlierTurns: (
      threadId: string,
      before: string,
    ) => Effect.Effect<void, ThreadNotFound | ThreadError>
    readonly transcript: (
      threadId: string,
    ) => Stream.Stream<TranscriptUpdate, ThreadNotFound | ThreadError>
    readonly harnesses: (place: ThreadPlace) => ReadonlyArray<AgentHarness>
    readonly models: (
      harness: AgentHarness,
      place: ThreadPlace,
    ) => Effect.Effect<AgentModels, ThreadError>
    readonly newThreadCommands: (
      harness: AgentHarness,
      place: ThreadPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, InvalidLocalCheckout | ThreadError>
    readonly commands: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, ThreadNotFound | ThreadError>
    readonly newThreadDefaultBranch: (
      place: ThreadPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<string | null, InvalidLocalCheckout | ConnectionError | ThreadError>
    readonly newThreadBranches: (
      place: ThreadPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | ConnectionError | ThreadError>
    readonly newThreadFiles: (
      place: ThreadPlace,
      repository: FollowedRepository,
      baseBranch: string,
    ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | ThreadError>
    readonly files: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<string>, ThreadNotFound | ThreadError>
    readonly existingFiles: (
      threadId: string,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, ThreadNotFound | ThreadError>
    readonly file: (
      threadId: string,
      path: string,
    ) => Effect.Effect<ThreadFile, ThreadNotFound | ThreadError>
    readonly create: (input: NewThread) => Effect.Effect<Thread, InvalidLocalCheckout | ThreadError>
    readonly createFrom: (
      parentId: string,
      input: Omit<NewThread, "permissionMode">,
    ) => Effect.Effect<Thread, ThreadNotFound | InvalidLocalCheckout | ThreadError>
    readonly createForReview: (input: NewReviewThread) => Effect.Effect<Thread, ThreadError>
    readonly send: (
      threadId: string,
      input: SentMessage,
      feedback?: ReadonlyArray<string>,
    ) => Effect.Effect<MessageDelivery, ThreadNotFound | RequestWaiting | ThreadError>
    readonly sendFrom: (
      senderId: string,
      threadId: string,
      input: SentMessage,
    ) => Effect.Effect<MessageDelivery, ThreadNotFound | RequestWaiting | ThreadError>
    readonly steer: (
      threadId: string,
      input: MessageInput,
    ) => Effect.Effect<void, ThreadNotFound | RequestWaiting | ThreadError>
    readonly cancelQueued: (
      threadId: string,
      queuedId: string,
    ) => Effect.Effect<UnsentFeedback, ThreadNotFound | QueuedMessageStarted | ThreadError>
    readonly sendQueued: (
      threadId: string,
      queuedId: string,
    ) => Effect.Effect<void, ThreadNotFound | ThreadBusy | ThreadError>
    readonly changes: (
      threadId: string,
    ) => Effect.Effect<ThreadChanges, ThreadNotFound | ThreadError>
    readonly feedbackNotes: (
      threadId: string,
    ) => Effect.Effect<UnsentFeedback, ThreadNotFound | ThreadError>
    readonly stageFeedbackNotes: (
      threadId: string,
    ) => Effect.Effect<UnsentFeedback, ThreadNotFound | ThreadError>
    readonly saveFeedbackNote: (
      threadId: string,
      note: FeedbackNote,
    ) => Effect.Effect<UnsentFeedback, ThreadNotFound | ThreadError>
    readonly removeFeedbackNote: (
      threadId: string,
      noteId: string,
    ) => Effect.Effect<UnsentFeedback, ThreadNotFound | ThreadError>
    readonly stop: (threadId: string) => Effect.Effect<void, ThreadNotFound | ThreadError>
    readonly reachSandbox: (threadId: string) => Effect.Effect<void, ThreadNotFound | ThreadError>
    readonly unsent: (threadId: string) => Effect.Effect<SentMessage, ThreadNotFound | ThreadError>
    readonly saveUnsent: (
      threadId: string,
      unsent: SentMessage,
    ) => Effect.Effect<void, ThreadNotFound | ThreadError>
    readonly changeModel: (
      threadId: string,
      choice: ModelChoice,
    ) => Effect.Effect<Thread, ThreadNotFound | ThreadError>
    readonly changePermissionMode: (
      threadId: string,
      permissionMode: PermissionMode,
    ) => Effect.Effect<Thread, ThreadNotFound | NoPermissionModes | ThreadError>
    readonly answer: (
      threadId: string,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, ThreadNotFound | RequestNotWaiting | ThreadError>
    readonly removalWarnings: (
      threadId: string,
    ) => Effect.Effect<RemovalWarnings, ThreadNotFound | ThreadError>
    readonly remove: (threadId: string) => Effect.Effect<void, ThreadNotFound | ThreadError>
    readonly followBranch: (
      threadId: string,
    ) => Effect.Effect<boolean, ThreadNotFound | ThreadError>
    readonly whenIdle: (typeof ThreadTurns.Service)["whenIdle"]
  }
>()("@glass/server/Threads") {
  static readonly layer = Layer.effect(
    Threads,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const localPlacement = yield* LocalPlacement
      const sandboxes = yield* Sandboxes
      const activityLog = yield* ActivityLog
      const turns = yield* ThreadTurns
      const notes = yield* FeedbackNotes
      const skillPacks = yield* SkillPacks
      const toDos = yield* ToDos
      const localSkills = yield* LocalSkills
      const fs = yield* FileSystem.FileSystem
      const lock = yield* Semaphore.make(1)

      const stored = yield* sql`
        SELECT id, name, sandbox_provider AS sandboxProvider, owner, repo, base_branch AS baseBranch,
          branch, harness, model, effort, permission_mode AS permissionMode, local_skills AS localSkills, folder,
          created_at AS createdAt,
          review_brief IS NOT NULL AS forReview
        FROM thread ORDER BY created_at
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const packsOfThreads = yield* skillPacks.threadPacks.pipe(Effect.orDie)

      const rows = yield* SubscriptionRef.make<ReadonlyArray<PlacedThread>>(
        stored.map((thread) => toRow(thread, packsOfThreads.get(thread.id) ?? [])),
      )

      const keptGoing = yield* SubscriptionRef.make<ReadonlyMap<string, DateTime.Utc>>(
        new Map(
          (yield* sql`
            SELECT id, kept_going_at AS keptGoingAt FROM thread WHERE kept_going_at IS NOT NULL
          `.pipe(Effect.flatMap(decodeKeptGoing), Effect.orDie)).map(
            ({ id, keptGoingAt }) => [id, keptGoingAt] as const,
          ),
        ),
      )

      const setKeptGoing = (threadId: string, at: DateTime.Utc) =>
        SubscriptionRef.update(keptGoing, (current) => new Map(current).set(threadId, at))

      const keepGoing = Effect.fnUntraced(function* (threadId: string) {
        const now = yield* DateTime.now

        yield* sql`
          UPDATE thread SET kept_going_at = ${DateTime.formatIso(now)} WHERE id = ${threadId}
        `.pipe(Effect.catchTag("SqlError", couldNotSave))
        yield* setKeptGoing(threadId, now)
      })

      const find = Effect.fnUntraced(function* (threadId: string) {
        const found = (yield* SubscriptionRef.get(rows)).find(
          ({ thread }) => thread.id === threadId,
        )

        if (found === undefined) return yield* new ThreadNotFound({ threadId })

        yield* annotateThread(found.thread)

        return found
      })

      const placementFor = (place: ThreadPlace): Placement =>
        Predicate.isTagged(place, "sandbox")
          ? sandboxes.placement(place.providerId)
          : localPlacement

      const placementRunning = (
        place: ThreadPlace,
        harness: AgentHarness,
      ): Effect.Effect<Placement, ThreadError> => {
        const placement = placementFor(place)

        return placement.harnesses.includes(harness)
          ? Effect.succeed(placement)
          : Effect.fail(
              new ThreadError({
                message: "This place doesn't run that Agent harness. Pick another.",
              }),
            )
      }

      const reviewHosting: ThreadHosting = {
        prepareHost: localPlacement.prepareHost,
        hostIfPrepared: () => Effect.succeedNone,
        connectedHost: localPlacement.connectedHost,
        baseRef: localPlacement.baseRef,
        remove: ({ folder }) =>
          fs.remove(folder, { recursive: true, force: true }).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Couldn't remove an Agent review's checkout", cause),
            ),
            Effect.mapError(storageFailure),
          ),
      }

      const hostingOf = (row: PlacedThread): ThreadHosting =>
        row.forReview ? reviewHosting : placementFor(row.thread.place)

      const saveBranch = (
        threadId: string,
        change: { readonly branch: string | null; readonly name?: string },
      ) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const found = yield* find(threadId)

            yield* sql`UPDATE thread SET ${sql.update(change)} WHERE id = ${threadId}`.pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Couldn't save a Thread's branch", cause),
              ),
              Effect.mapError(storageFailure),
            )
            yield* replace(threadWith(found.thread, change))
          }),
        )

      const claimBranch = Effect.fnUntraced(function* (threadId: string, suggested: string) {
        const row = yield* find(threadId)
        const { repository } = row.thread
        const placement = placementFor(row.thread.place)

        const known = (yield* SubscriptionRef.get(rows)).flatMap(({ thread }) =>
          thread.branch !== null && repositoryKey(thread.repository) === repositoryKey(repository)
            ? [thread.branch]
            : [],
        )

        const taken = [...(yield* placement.takenBranches(repository, suggested)), ...known]

        const branch = yield* firstFreeBranch(suggested, taken).pipe(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ThreadError({ message: `Every branch name like ${suggested} is taken.` }),
              ),
            onSome: Effect.succeed,
          }),
        )

        yield* placement.useBranch(row, branch)
        yield* saveBranch(threadId, { name: branch, branch })
      })

      const naming = yield* threadBranchNaming(claimBranch)

      // WARNING: A Sandbox makes its branch when its host is prepared, so the host waits for the name.
      const prepareHostOf = (threadId: string) =>
        naming.named(threadId).pipe(
          Effect.andThen(find(threadId)),
          Effect.flatMap((row) => hostingOf(row).prepareHost(row)),
        )

      const withSandbox = (thread: Thread) =>
        sandboxes.status(thread.id).pipe(Effect.map((sandbox) => threadWith(thread, { sandbox })))

      const reviewBrief = (row: PlacedThread) =>
        sql`SELECT review_brief AS brief FROM thread WHERE id = ${row.thread.id}`.pipe(
          Effect.flatMap(decodeBrief),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read a review brief", cause)),
          Effect.mapError(storageFailure),
          Effect.flatMap(([found]) =>
            found === undefined
              ? Effect.fail(new ThreadError({ message: "This Thread was removed." }))
              : Effect.succeed(found.brief),
          ),
        )

      // WARNING: pi keeps the first skill of a name, so Local skills go first to win over a pack's.
      const skillsOf = (thread: Thread) =>
        Effect.all(
          [
            thread.localSkills
              ? localSkills.source(thread.harness).pipe(
                  Effect.map(Option.toArray),
                  Effect.mapError(({ message }) => new ThreadError({ message })),
                )
              : Effect.succeed([]),
            skillPacks
              .threadSkills(thread.id)
              .pipe(Effect.mapError(({ message }) => new ThreadError({ message }))),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([local, packs]) => [...local, ...packs]))

      const threadOf = (row: PlacedThread): ClaimedThread => {
        const hosting = hostingOf(row)
        const { id, harness, model, effort, permissionMode } = row.thread

        const startAs = (client: ThreadHost, role: RepositoryRole) =>
          skillsOf(row.thread).pipe(
            Effect.flatMap((skills) =>
              client.StartThread({
                threadId: id,
                harness,
                folder: row.folder,
                role,
                skills,
              }),
            ),
          )

        return {
          id,
          ensureStarted: (client) =>
            (row.forReview
              ? reviewBrief(row).pipe(
                  Effect.flatMap((brief) => startAs(client, ReviewRole.make({ brief }))),
                )
              : startAs(client, WorkRole.make({}))
            ).pipe(Effect.asVoid),
          settings: { model, effort, permissionMode },
          prepareHost: prepareHostOf(id).pipe(
            Effect.catchTag("ThreadNotFound", () =>
              Effect.fail(new ThreadError({ message: "This Thread was removed." })),
            ),
          ),
          connectedHost: hosting.connectedHost(row),
        }
      }

      yield* turns.serve({
        claim: (threadId) =>
          find(threadId).pipe(
            Effect.map((row) => Option.some(threadOf(row))),
            Effect.catchTag("ThreadNotFound", () => Effect.succeedNone),
          ),
        lost: Stream.merge(yield* localPlacement.subscribeLost, yield* sandboxes.subscribeLost),
        interrupted: Effect.all([sandboxes.resume, localPlacement.resume], {
          concurrency: "unbounded",
        }).pipe(
          Effect.map(([inSandboxes, onThisDevice]) =>
            stored.flatMap(({ id }) => (inSandboxes.has(id) || onThisDevice.has(id) ? [] : [id])),
          ),
        ),
      })

      const replace = (thread: Thread) =>
        SubscriptionRef.update(rows, (current) =>
          current.map((row) => (row.thread.id === thread.id ? { ...row, thread } : row)),
        )

      const followBranch = Effect.fn("Threads.followBranch")(function* (threadId: string) {
        const row = yield* find(threadId)

        if (row.forReview) return false

        const host = yield* hostingOf(row).connectedHost(row)

        if (Option.isNone(host)) return false

        const branch = yield* host.value
          .CurrentBranch({ folder: row.folder })
          .pipe(Effect.mapError(asThreadError))

        if (branch !== row.thread.branch) yield* saveBranch(threadId, { branch })

        return true
      })

      const insert = (placed: PlacedThread, first: MessageInput, purpose: Purpose) => {
        const { id, place, repository } = placed.thread

        const forget = SubscriptionRef.update(rows, (current) =>
          current.filter((kept) => kept.thread.id !== id),
        )

        return lock
          .withPermits(1)(
            Effect.gen(function* () {
              const thread = threadWith(placed.thread, {
                skillPacks: yield* skillPacks.pinForThread(
                  id,
                  Purpose.$match(purpose, { Work: ({ packs }) => packs, Review: () => [] }),
                ),
              })

              yield* annotateThread(thread)
              yield* sql`INSERT INTO thread ${sql.insert({
                id,
                name: thread.name,
                sandbox_provider: sandboxProviderOf(place),
                owner: repository.owner,
                repo: repository.repo,
                base_branch: thread.baseBranch,
                branch: thread.branch,
                harness: thread.harness,
                model: thread.model,
                effort: thread.effort,
                permission_mode: thread.permissionMode,
                local_skills: thread.localSkills ? 1 : 0,
                folder: placed.folder,
                created_at: DateTime.formatIso(thread.createdAt),
                kept_going_at: DateTime.formatIso(thread.createdAt),
                review_brief: Purpose.$match(purpose, {
                  Work: () => null,
                  Review: ({ brief }) => encodeBrief(brief),
                }),
              })}`

              yield* Purpose.$match(purpose, {
                Work: () => toDos.linkThread(id, mentionedToDoIds(first.message)),
                Review: () => Effect.void,
              })

              yield* SubscriptionRef.update(rows, (current) => [...current, { ...placed, thread }])
              yield* setKeptGoing(id, thread.createdAt)
              yield* transcripts.startOrQueue(id, { ...first, context: null })

              return thread
            }).pipe(sql.withTransaction),
          )
          .pipe(
            Effect.catchTags({
              SkillPackNotFound: ({ name }) =>
                Effect.fail(
                  new ThreadError({
                    message: `The Skill pack ${name} was removed. Choose the Thread's Skill packs again.`,
                  }),
                ),
              SkillPackError: ({ message }) => Effect.fail(new ThreadError({ message })),
              SqlError: couldNotSave,
            }),
            Effect.onError(() => forget),
          )
      }

      const createForReview = Effect.fn("Threads.createForReview")(function* (
        input: NewReviewThread,
      ) {
        const thread = new Thread({
          id: randomUUID(),
          name: input.name,
          place: localPlace,
          repository: input.repository,
          baseBranch: input.revision.base,
          branch: null,
          harness: input.harness,
          model: input.model,
          effort: null,
          permissionMode: null,
          skillPacks: [],
          localSkills: false,
          createdAt: yield* DateTime.now,
          sandbox: null,
          forReview: true,
        })

        return yield* insert(
          { thread, folder: input.checkout, forReview: true },
          { message: input.message, images: [] },
          Purpose.Review({ brief: input.review }),
        )
      })

      const createWith = Effect.fnUntraced(function* (
        input: Omit<NewThread, "permissionMode">,
        permissionMode: PermissionMode | null,
      ) {
        const { repository, baseBranch, harness, model, effort, place } = input
        const { message, images } = input
        const placement = yield* placementRunning(place, harness)

        const { branch, folder, discard } = yield* placement.place(repository, baseBranch)

        const thread = new Thread({
          id: randomUUID(),
          name: branch,
          place,
          repository,
          baseBranch,
          branch,
          harness,
          model,
          effort,
          permissionMode,
          skillPacks: [],
          localSkills: Predicate.isTagged(place, "sandbox") && input.localSkills,
          createdAt: yield* DateTime.now,
          sandbox: null,
        })

        yield* naming.hold(thread.id)

        const created = yield* insert(
          { thread, folder, forReview: false },
          { message, images },
          Purpose.Work({ packs: input.skillPacks }),
        ).pipe(Effect.onError(() => discard.pipe(Effect.andThen(naming.release(thread.id)))))

        yield* naming.name(thread.id, message)

        yield* activityLog.record(
          ThreadStarted.make({
            threadId: thread.id,
            name: branch,
            repository,
            machine: place._tag,
            harness: thread.harness,
            message,
          }),
        )

        return yield* withSandbox(created)
      })

      const create = Effect.fn("Threads.create")(function* (input: NewThread) {
        return yield* createWith(
          input,
          startingPermissionMode(input.place, input.harness, input.permissionMode),
        )
      })

      const createFrom = Effect.fn("Threads.createFrom")(function* (
        parentId: string,
        input: Omit<NewThread, "permissionMode">,
      ) {
        const parent = (yield* find(parentId)).thread

        const permissionMode = startingPermissionMode(
          input.place,
          input.harness,
          parent.permissionMode,
        )

        yield* refuseReach(
          parent,
          { place: input.place, permissionMode },
          {
            leavesSandbox:
              "A Thread in a Sandbox can only create Threads in a Sandbox. Ask the user to start one on this device.",
            asksLess:
              "That Thread would ask the user less than you do, so you can't create it. Create one on this device with Claude Code instead, or ask the user to.",
          },
        )

        return yield* createWith(input, permissionMode)
      })

      const findWritable = (threadId: string) =>
        find(threadId).pipe(Effect.tap(() => sandboxes.refuseIfGone(threadId)))

      const send = Effect.fn("Threads.send")(function* (
        threadId: string,
        { message, images }: SentMessage,
        feedback: ReadonlyArray<string> = [],
      ) {
        yield* findWritable(threadId)

        const delivery = yield* turns.send(
          threadId,
          { message, images, context: null },
          notes.take(threadNotes(threadId), feedback),
        )

        yield* keepGoing(threadId)

        return delivery
      })

      const sendFrom = Effect.fn("Threads.sendFrom")(function* (
        senderId: string,
        threadId: string,
        input: SentMessage,
      ) {
        if (senderId === threadId)
          return yield* new ThreadError({
            message: "A Thread can't send a message to itself.",
          })

        const sender = (yield* find(senderId)).thread
        const target = (yield* find(threadId)).thread

        yield* refuseReach(sender, target, {
          leavesSandbox:
            "A Thread in a Sandbox can only message Threads in a Sandbox. Ask the user to message one on this device.",
          asksLess:
            "That Thread asks the user less than you do, so you can't send it a message. Ask the user to.",
        })

        return yield* send(threadId, input)
      })

      const steer = Effect.fn("Threads.steer")(function* (threadId: string, input: MessageInput) {
        const row = yield* findWritable(threadId)
        yield* turns.steer(threadOf(row), { ...input, context: null })
        yield* keepGoing(threadId)
      })

      const bringBack = Effect.fn("Threads.bringBack")(function* (threadId: string) {
        yield* find(threadId)
        yield* keepGoing(threadId)
      })

      const sendQueued = Effect.fn("Threads.sendQueued")(function* (
        threadId: string,
        queuedId: string,
      ) {
        yield* findWritable(threadId)
        yield* turns.sendQueued(threadId, queuedId)
      })

      const stop = Effect.fn("Threads.stop")(function* (threadId: string) {
        yield* turns.stop(threadOf(yield* find(threadId)))
      })

      const unsent = Effect.fn("Threads.unsent")(function* (threadId: string) {
        yield* find(threadId)

        return yield* turns.unsent(threadId)
      })

      const saveUnsent = Effect.fn("Threads.saveUnsent")(function* (
        threadId: string,
        unsentMessage: SentMessage,
      ) {
        yield* find(threadId)
        yield* turns.saveUnsent(threadId, unsentMessage)
      })

      const changes = Effect.fn("Threads.changes")(function* (threadId: string) {
        const row = yield* find(threadId)
        const hosting = hostingOf(row)

        const host = yield* hosting.hostIfPrepared(row)

        if (Option.isNone(host)) return changesOf([])

        const baseRef = yield* hosting.baseRef(row)

        return yield* host.value
          .GetChanges({ folder: row.folder, baseRef })
          .pipe(Effect.mapError(asThreadError), Effect.map(changesOf))
      })

      const onHost = Effect.fnUntraced(function* <A, E>(
        threadId: string,
        call: (host: HostClient, row: PlacedThread) => Effect.Effect<A, HostCallError>,
        absent: Effect.Effect<A, E>,
      ) {
        const row = yield* find(threadId)
        const host = yield* hostingOf(row).hostIfPrepared(row)

        if (Option.isNone(host)) return yield* absent

        return yield* call(host.value, row).pipe(Effect.mapError(asThreadError))
      })

      const listedByHost = <A>(
        threadId: string,
        list: (
          host: HostClient,
          row: PlacedThread,
        ) => Effect.Effect<ReadonlyArray<A>, HostCallError>,
      ) => onHost(threadId, list, Effect.succeed<ReadonlyArray<A>>([]))

      const commands = (threadId: string) =>
        listedByHost(threadId, (host, row) =>
          skillsOf(row.thread).pipe(
            Effect.flatMap((skills) =>
              host.ListCommands({ harness: row.thread.harness, folder: row.folder, skills }),
            ),
          ),
        ).pipe(Effect.withSpan("Threads.commands"))

      const files = (threadId: string) =>
        listedByHost(threadId, (host, row) => host.ListFiles({ folder: row.folder })).pipe(
          Effect.withSpan("Threads.files"),
        )

      const existingFiles = (threadId: string, paths: ReadonlyArray<string>) =>
        listedByHost(threadId, (host, row) =>
          host.ExistingFiles({ folder: row.folder, paths }),
        ).pipe(Effect.withSpan("Threads.existingFiles"))

      const file = (threadId: string, path: string) =>
        onHost(
          threadId,
          (host, row) => host.ReadFile({ folder: row.folder, path }),
          new ThreadError({
            message: "This Thread's folder isn't ready yet. Try again once it's up.",
          }),
        ).pipe(Effect.withSpan("Threads.file"))

      const update = Effect.fn("Threads.update")(function* (
        threadId: string,
        change: Partial<Pick<Thread, "model" | "effort" | "permissionMode">>,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const found = yield* find(threadId)
            const thread = threadWith(found.thread, change)

            yield* sql`
              UPDATE thread SET model = ${thread.model}, effort = ${thread.effort},
                permission_mode = ${thread.permissionMode}
              WHERE id = ${threadId}
            `.pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Couldn't save a Thread's settings", cause),
              ),
              Effect.mapError(storageFailure),
            )
            yield* replace(thread)

            return yield* withSandbox(thread)
          }),
        )
      })

      const changePermissionMode = Effect.fn("Threads.changePermissionMode")(function* (
        threadId: string,
        permissionMode: PermissionMode,
      ) {
        const { thread } = yield* find(threadId)

        if (thread.permissionMode === null || !asksPermission(thread.place))
          return yield* new NoPermissionModes()

        return yield* update(threadId, { permissionMode })
      })

      const answer = Effect.fn("Threads.answer")(function* (
        threadId: string,
        requestId: string,
        given: RequestAnswer,
      ) {
        return yield* turns.answer(threadOf(yield* find(threadId)), requestId, given)
      })

      const removalWarnings = Effect.fn("Threads.removalWarnings")(function* (threadId: string) {
        const row = yield* find(threadId)

        return yield* hostingOf(row)
          .hostIfPrepared(row)
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(false),
                onSome: (host) => host.HasUncommittedChanges({ folder: row.folder }),
              }),
            ),
            Effect.timeout("10 seconds"),
            Effect.map(
              (some) => new RemovalWarnings({ uncommittedChanges: some ? "some" : "none" }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Couldn't check a Thread for uncommitted work", cause).pipe(
                Effect.as(new RemovalWarnings({ uncommittedChanges: "unchecked" })),
              ),
            ),
          )
      })

      const remove = Effect.fn("Threads.remove")(function* (threadId: string) {
        const row = yield* lock.withPermits(1)(
          find(threadId).pipe(
            Effect.tap(() =>
              SubscriptionRef.update(rows, (current) =>
                current.filter(({ thread }) => thread.id !== threadId),
              ),
            ),
          ),
        )

        yield* Effect.gen(function* () {
          const hosting = hostingOf(row)
          const running = yield* hosting.connectedHost(row)

          if (Option.isSome(running))
            yield* running.value
              .StopThread({ threadId })
              .pipe(Effect.ignore({ log: "Warn", message: "Couldn't stop a Thread" }))

          yield* hosting.remove(row)

          yield* Effect.gen(function* () {
            yield* transcripts.remove(threadId)
            yield* turns.removeUnsent(threadId)
            yield* notes.removeAll(threadNotes(threadId))
            yield* skillPacks.releaseThread(threadId)
            yield* sql`DELETE FROM started_thread WHERE thread_id = ${threadId} OR started_by = ${threadId}`
            yield* sql`DELETE FROM started_agent_review WHERE started_by = ${threadId}`
            yield* toDos.unlinkThread(threadId)
            yield* sql`DELETE FROM thread WHERE id = ${threadId}`
          }).pipe(sql.withTransaction, Effect.mapError(storageFailure))
        }).pipe(
          Effect.tapError(() =>
            SubscriptionRef.update(rows, (current) =>
              [...current, row].toSorted((a, b) =>
                DateTime.Order(a.thread.createdAt, b.thread.createdAt),
              ),
            ),
          ),
        )
      })

      const placed = Stream.zipLatest(SubscriptionRef.changes(rows), sandboxes.statuses).pipe(
        Stream.map(([current, statuses]) =>
          current.map((row) => ({
            ...row,
            thread: threadWith(row.thread, {
              sandbox: statuses.get(row.thread.id) ?? null,
            }),
          })),
        ),
      )

      return Threads.of({
        keptGoing: SubscriptionRef.changes(keptGoing),
        bringBack,
        watch: () => placed.pipe(Stream.map((current) => current.map(({ thread }) => thread))),
        transcript: (threadId) =>
          Stream.unwrap(find(threadId).pipe(Effect.as(transcripts.watch(threadId)))),
        readTranscript: (threadId, latest) =>
          find(threadId).pipe(Effect.andThen(transcripts.read(threadId, latest))),
        loadEarlierTurns: (threadId, before) =>
          find(threadId).pipe(Effect.andThen(transcripts.loadEarlier(threadId, before))),
        harnesses: (place) => placementFor(place).harnesses,
        models: (harness, place) =>
          placementRunning(place, harness).pipe(
            Effect.flatMap((placement) => placement.models(harness)),
          ),
        newThreadCommands: (harness, place, repository) =>
          placementRunning(place, harness).pipe(
            Effect.flatMap((placement) => placement.commands(harness, repository)),
          ),
        newThreadDefaultBranch: (place, repository) =>
          placementFor(place).defaultBranch(repository),
        newThreadBranches: (place, repository) => placementFor(place).branches(repository),
        commands,
        newThreadFiles: (place, repository, baseBranch) =>
          placementFor(place).files(repository, baseBranch),
        files,
        existingFiles,
        file,
        create,
        createFrom,
        createForReview,
        send,
        sendFrom,
        changes,
        feedbackNotes: (threadId) =>
          find(threadId).pipe(Effect.andThen(notes.list(threadNotes(threadId)))),
        stageFeedbackNotes: (threadId) =>
          find(threadId).pipe(Effect.andThen(notes.stage(threadNotes(threadId)))),
        saveFeedbackNote: (threadId, note) =>
          find(threadId).pipe(Effect.andThen(notes.save(threadNotes(threadId), note))),
        removeFeedbackNote: (threadId, noteId) =>
          find(threadId).pipe(Effect.andThen(notes.remove(threadNotes(threadId), noteId))),
        steer,
        cancelQueued: (threadId, queuedId) =>
          find(threadId).pipe(
            Effect.andThen(
              transcripts.cancelQueued(threadId, queuedId, (feedback) =>
                notes.restore(threadNotes(threadId), feedback),
              ),
            ),
            Effect.andThen(notes.list(threadNotes(threadId))),
          ),
        sendQueued,
        stop,
        reachSandbox: (threadId) => prepareHostOf(threadId).pipe(Effect.asVoid),
        unsent,
        saveUnsent,
        watchWaiting: () =>
          Stream.zipLatest(placed, transcripts.waiting).pipe(
            Stream.map(([current, waiting]) =>
              current.flatMap(({ thread }) => {
                const requests = waiting.get(thread.id)

                return requests === undefined ? [] : [{ thread, requests }]
              }),
            ),
          ),
        watchFinished: () =>
          Stream.zipLatest(placed, transcripts.unseen).pipe(
            Stream.map(([current, unseen]) =>
              current.flatMap(({ thread }) => {
                const ended = unseen.get(thread.id)

                return ended === undefined ||
                  thread.forReview ||
                  Predicate.isTagged(ended.ending, "Stopped")
                  ? []
                  : [{ thread, ended }]
              }),
            ),
          ),
        watchWorking: () =>
          Stream.zipLatest(placed, transcripts.running).pipe(
            Stream.map(([current, running]) =>
              current.flatMap(({ thread }) => (running.has(thread.id) ? [thread.id] : [])),
            ),
          ),
        markTurnSeen: transcripts.markSeen,
        followBranch,
        whenIdle: turns.whenIdle,
        changeModel: update,
        changePermissionMode,
        answer,
        removalWarnings,
        remove,
      })
    }),
  )
}
