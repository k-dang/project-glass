import {
  Conversation,
  ConversationBusy,
  type AgentHarness,
  ConversationError,
  type ConversationFile,
  type AgentCommand,
  AgentModels,
  type ConnectionError,
  ConversationNotFound,
  type ConversationPlace,
  asksPermission,
  ConversationChanges,
  ConversationStarted,
  ChangedFile,
  type FeedbackNote,
  FollowedRepository,
  type InvalidLocalCheckout,
  type MessageDelivery,
  type MessageInput,
  type ModelChoice,
  defaultPermissionMode,
  harnessCapabilities,
  type NewConversation,
  type PermissionMode,
  RemovalWarnings,
  type QueuedMessageStarted,
  type RequestAnswer,
  NoPermissionModes,
  type RequestNotWaiting,
  type RequestWaiting,
  type Revision,
  localPlace,
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
import { conversationWith, decodeStored, sandboxProviderOf, toRow } from "./conversationRows"
import { type ClaimedConversation, ConversationTurns } from "./ConversationTurns"
import { conversationNotes, FeedbackNotes } from "./FeedbackNotes"
import {
  asConversationError,
  type HostCallError,
  type HostClient,
  type PlacedConversation,
  type ConversationHosting,
  type Placement,
} from "./Placement"
import { Sandboxes } from "./Sandboxes"
import { LocalPlacement } from "./LocalPlacement"
import { type RepositoryRole, ReviewBrief, ReviewRole, WorkRole } from "./agentHost/protocol"
import { LocalSkills } from "./LocalSkills"
import { SkillPacks } from "./SkillPacks"
import { Transcripts, type WaitingRequest } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

const changesOf = (files: ReadonlyArray<ChangedFile>) =>
  new ConversationChanges({
    id: changesId(files),
    files,
  })

const BriefJson = Schema.fromJsonString(ReviewBrief)

const encodeBrief = Schema.encodeSync(BriefJson)

const decodeBrief = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ brief: BriefJson })))

const annotateConversation = ({ id, harness, model, place }: Conversation) =>
  annotateUnit({ conversation_id: id, harness, model, sandbox_provider: sandboxProviderOf(place) })

const storageFailure = () =>
  new ConversationError({ message: "Couldn't read or save your Conversations. Try again." })

const couldNotSave = (cause: SqlError.SqlError) =>
  Effect.logWarning("Couldn't save a Conversation", cause).pipe(
    Effect.andThen(Effect.fail(storageFailure())),
  )

type Purpose = Data.TaggedEnum<{
  Work: { readonly packs: ReadonlyArray<string> }
  Review: { readonly brief: ReviewBrief }
}>

const Purpose = Data.taggedEnum<Purpose>()

export interface NewReviewConversation {
  readonly name: string
  readonly repository: FollowedRepository
  readonly revision: Revision
  readonly harness: AgentHarness
  readonly model: string | null
  readonly checkout: string
  readonly review: ReviewBrief
  readonly message: string
}

export interface WaitingConversation {
  readonly conversation: Conversation
  readonly requests: Arr.NonEmptyReadonlyArray<WaitingRequest>
}

export interface FinishedConversation {
  readonly conversation: Conversation
  readonly ended: TurnEnd
}

export class Conversations extends Context.Service<
  Conversations,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<Conversation>, ConversationError>
    readonly watchWaiting: () => Stream.Stream<ReadonlyArray<WaitingConversation>>
    readonly watchFinished: () => Stream.Stream<ReadonlyArray<FinishedConversation>>
    readonly watchWorking: () => Stream.Stream<ReadonlyArray<string>>
    readonly markTurnSeen: (
      conversationId: string,
      endedAt: DateTime.Utc,
    ) => Effect.Effect<void, ConversationError>
    readonly readTranscript: (
      conversationId: string,
      turns: number,
    ) => Effect.Effect<Transcript, ConversationNotFound | ConversationError>
    readonly loadEarlierTurns: (
      conversationId: string,
      before: string,
    ) => Effect.Effect<void, ConversationNotFound | ConversationError>
    readonly transcript: (
      conversationId: string,
    ) => Stream.Stream<TranscriptUpdate, ConversationNotFound | ConversationError>
    readonly harnesses: (place: ConversationPlace) => ReadonlyArray<AgentHarness>
    readonly models: (
      harness: AgentHarness,
      place: ConversationPlace,
    ) => Effect.Effect<AgentModels, ConversationError>
    readonly newConversationCommands: (
      harness: AgentHarness,
      place: ConversationPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, InvalidLocalCheckout | ConversationError>
    readonly commands: (
      conversationId: string,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, ConversationNotFound | ConversationError>
    readonly newConversationDefaultBranch: (
      place: ConversationPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<string | null, InvalidLocalCheckout | ConnectionError | ConversationError>
    readonly newConversationBranches: (
      place: ConversationPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<
      ReadonlyArray<string>,
      InvalidLocalCheckout | ConnectionError | ConversationError
    >
    readonly newConversationFiles: (
      place: ConversationPlace,
      repository: FollowedRepository,
      baseBranch: string,
    ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | ConversationError>
    readonly files: (
      conversationId: string,
    ) => Effect.Effect<ReadonlyArray<string>, ConversationNotFound | ConversationError>
    readonly existingFiles: (
      conversationId: string,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, ConversationNotFound | ConversationError>
    readonly file: (
      conversationId: string,
      path: string,
    ) => Effect.Effect<ConversationFile, ConversationNotFound | ConversationError>
    readonly create: (
      input: NewConversation,
    ) => Effect.Effect<Conversation, InvalidLocalCheckout | ConversationError>
    readonly createForReview: (
      input: NewReviewConversation,
    ) => Effect.Effect<Conversation, ConversationError>
    readonly send: (
      conversationId: string,
      input: SentMessage,
      feedback?: ReadonlyArray<string>,
    ) => Effect.Effect<MessageDelivery, ConversationNotFound | RequestWaiting | ConversationError>
    readonly steer: (
      conversationId: string,
      input: MessageInput,
    ) => Effect.Effect<void, ConversationNotFound | RequestWaiting | ConversationError>
    readonly cancelQueued: (
      conversationId: string,
      queuedId: string,
    ) => Effect.Effect<
      UnsentFeedback,
      ConversationNotFound | QueuedMessageStarted | ConversationError
    >
    readonly sendQueued: (
      conversationId: string,
      queuedId: string,
    ) => Effect.Effect<void, ConversationNotFound | ConversationBusy | ConversationError>
    readonly changes: (
      conversationId: string,
    ) => Effect.Effect<ConversationChanges, ConversationNotFound | ConversationError>
    readonly feedbackNotes: (
      conversationId: string,
    ) => Effect.Effect<UnsentFeedback, ConversationNotFound | ConversationError>
    readonly stageFeedbackNotes: (
      conversationId: string,
    ) => Effect.Effect<UnsentFeedback, ConversationNotFound | ConversationError>
    readonly saveFeedbackNote: (
      conversationId: string,
      note: FeedbackNote,
    ) => Effect.Effect<UnsentFeedback, ConversationNotFound | ConversationError>
    readonly removeFeedbackNote: (
      conversationId: string,
      noteId: string,
    ) => Effect.Effect<UnsentFeedback, ConversationNotFound | ConversationError>
    readonly stop: (
      conversationId: string,
    ) => Effect.Effect<void, ConversationNotFound | ConversationError>
    readonly reachSandbox: (
      conversationId: string,
    ) => Effect.Effect<void, ConversationNotFound | ConversationError>
    readonly unsent: (
      conversationId: string,
    ) => Effect.Effect<SentMessage, ConversationNotFound | ConversationError>
    readonly saveUnsent: (
      conversationId: string,
      unsent: SentMessage,
    ) => Effect.Effect<void, ConversationNotFound | ConversationError>
    readonly changeModel: (
      conversationId: string,
      choice: ModelChoice,
    ) => Effect.Effect<Conversation, ConversationNotFound | ConversationError>
    readonly changePermissionMode: (
      conversationId: string,
      permissionMode: PermissionMode,
    ) => Effect.Effect<Conversation, ConversationNotFound | NoPermissionModes | ConversationError>
    readonly answer: (
      conversationId: string,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, ConversationNotFound | RequestNotWaiting | ConversationError>
    readonly removalWarnings: (
      conversationId: string,
    ) => Effect.Effect<RemovalWarnings, ConversationNotFound | ConversationError>
    readonly remove: (
      conversationId: string,
    ) => Effect.Effect<void, ConversationNotFound | ConversationError>
    readonly followBranch: (
      conversationId: string,
    ) => Effect.Effect<boolean, ConversationNotFound | ConversationError>
  }
>()("@glass/server/Conversations") {
  static readonly layer = Layer.effect(
    Conversations,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const localPlacement = yield* LocalPlacement
      const sandboxes = yield* Sandboxes
      const activityLog = yield* ActivityLog
      const turns = yield* ConversationTurns
      const notes = yield* FeedbackNotes
      const skillPacks = yield* SkillPacks
      const localSkills = yield* LocalSkills
      const fs = yield* FileSystem.FileSystem
      const lock = yield* Semaphore.make(1)

      const stored = yield* sql`
        SELECT id, name, sandbox_provider AS sandboxProvider, owner, repo, base_branch AS baseBranch,
          branch, harness, model, effort, permission_mode AS permissionMode, local_skills AS localSkills, folder,
          created_at AS createdAt,
          review_brief IS NOT NULL AS forReview
        FROM conversation ORDER BY created_at
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const packsOfConversations = yield* skillPacks.conversationPacks.pipe(Effect.orDie)

      const rows = yield* SubscriptionRef.make<ReadonlyArray<PlacedConversation>>(
        stored.map((conversation) =>
          toRow(conversation, packsOfConversations.get(conversation.id) ?? []),
        ),
      )

      const find = Effect.fnUntraced(function* (conversationId: string) {
        const found = (yield* SubscriptionRef.get(rows)).find(
          ({ conversation }) => conversation.id === conversationId,
        )

        if (found === undefined) return yield* new ConversationNotFound({ conversationId })

        yield* annotateConversation(found.conversation)

        return found
      })

      const placementFor = (place: ConversationPlace): Placement =>
        Predicate.isTagged(place, "sandbox")
          ? sandboxes.placement(place.providerId)
          : localPlacement

      const placementRunning = (
        place: ConversationPlace,
        harness: AgentHarness,
      ): Effect.Effect<Placement, ConversationError> => {
        const placement = placementFor(place)

        return placement.harnesses.includes(harness)
          ? Effect.succeed(placement)
          : Effect.fail(
              new ConversationError({
                message: "This place doesn't run that Agent harness. Pick another.",
              }),
            )
      }

      const reviewHosting: ConversationHosting = {
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

      const hostingOf = (row: PlacedConversation): ConversationHosting =>
        row.forReview ? reviewHosting : placementFor(row.conversation.place)

      const withSandbox = (conversation: Conversation) =>
        sandboxes
          .status(conversation.id)
          .pipe(Effect.map((sandbox) => conversationWith(conversation, { sandbox })))

      const reviewBrief = (row: PlacedConversation) =>
        sql`SELECT review_brief AS brief FROM conversation WHERE id = ${row.conversation.id}`.pipe(
          Effect.flatMap(decodeBrief),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read a review brief", cause)),
          Effect.mapError(storageFailure),
          Effect.flatMap(([found]) =>
            found === undefined
              ? Effect.fail(new ConversationError({ message: "This Conversation was removed." }))
              : Effect.succeed(found.brief),
          ),
        )

      // WARNING: pi keeps the first skill of a name, so Local skills go first to win over a pack's.
      const skillsOf = (conversation: Conversation) =>
        Effect.all(
          [
            conversation.localSkills
              ? localSkills.source(conversation.harness).pipe(
                  Effect.map(Option.toArray),
                  Effect.mapError(({ message }) => new ConversationError({ message })),
                )
              : Effect.succeed([]),
            skillPacks
              .conversationSkills(conversation.id)
              .pipe(Effect.mapError(({ message }) => new ConversationError({ message }))),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([local, packs]) => [...local, ...packs]))

      const conversationOf = (row: PlacedConversation): ClaimedConversation => {
        const hosting = hostingOf(row)
        const { id, harness, model, effort, permissionMode } = row.conversation

        const role: Effect.Effect<RepositoryRole, ConversationError> = row.forReview
          ? reviewBrief(row).pipe(Effect.map((brief) => ReviewRole.make({ brief })))
          : Effect.succeed(WorkRole.make({}))

        return {
          id,
          ensureStarted: (client) =>
            Effect.all([role, skillsOf(row.conversation)], { concurrency: "unbounded" }).pipe(
              Effect.flatMap(([started, skills]) =>
                client.StartConversation({
                  conversationId: id,
                  harness,
                  folder: row.folder,
                  role: started,
                  skills,
                }),
              ),
              Effect.asVoid,
            ),
          settings: { model, effort, permissionMode },
          prepareHost: hosting.prepareHost(row),
          connectedHost: hosting.connectedHost(row),
        }
      }

      yield* turns.serve({
        claim: (conversationId) =>
          find(conversationId).pipe(
            Effect.map((row) => Option.some(conversationOf(row))),
            Effect.catchTag("ConversationNotFound", () => Effect.succeedNone),
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

      const replace = (conversation: Conversation) =>
        SubscriptionRef.update(rows, (current) =>
          current.map((row) =>
            row.conversation.id === conversation.id ? { ...row, conversation } : row,
          ),
        )

      const followBranch = Effect.fn("Conversations.followBranch")(function* (
        conversationId: string,
      ) {
        const row = yield* find(conversationId)

        if (row.forReview) return false

        const host = yield* hostingOf(row).connectedHost(row)

        if (Option.isNone(host)) return false

        const branch = yield* host.value
          .CurrentBranch({ folder: row.folder })
          .pipe(Effect.mapError(asConversationError))

        if (branch !== row.conversation.branch)
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const found = yield* find(conversationId)

              yield* sql`UPDATE conversation SET branch = ${branch} WHERE id = ${conversationId}`.pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("Couldn't save a Conversation's branch", cause),
                ),
                Effect.mapError(storageFailure),
              )
              yield* replace(conversationWith(found.conversation, { branch }))
            }),
          )

        return true
      })

      const insert = (placed: PlacedConversation, first: MessageInput, purpose: Purpose) => {
        const { id, place, repository } = placed.conversation

        const forget = SubscriptionRef.update(rows, (current) =>
          current.filter((kept) => kept.conversation.id !== id),
        )

        return lock
          .withPermits(1)(
            Effect.gen(function* () {
              const conversation = conversationWith(placed.conversation, {
                skillPacks: yield* skillPacks.pinForConversation(
                  id,
                  Purpose.$match(purpose, { Work: ({ packs }) => packs, Review: () => [] }),
                ),
              })

              yield* annotateConversation(conversation)
              yield* sql`INSERT INTO conversation ${sql.insert({
                id,
                name: conversation.name,
                sandbox_provider: sandboxProviderOf(place),
                owner: repository.owner,
                repo: repository.repo,
                base_branch: conversation.baseBranch,
                branch: conversation.branch,
                harness: conversation.harness,
                model: conversation.model,
                effort: conversation.effort,
                permission_mode: conversation.permissionMode,
                local_skills: conversation.localSkills ? 1 : 0,
                folder: placed.folder,
                created_at: DateTime.formatIso(conversation.createdAt),
                review_brief: Purpose.$match(purpose, {
                  Work: () => null,
                  Review: ({ brief }) => encodeBrief(brief),
                }),
              })}`

              yield* SubscriptionRef.update(rows, (current) => [
                ...current,
                { ...placed, conversation },
              ])
              yield* transcripts.startOrQueue(id, { ...first, context: null })

              return conversation
            }).pipe(sql.withTransaction),
          )
          .pipe(
            Effect.catchTags({
              SkillPackNotFound: ({ name }) =>
                Effect.fail(
                  new ConversationError({
                    message: `The Skill pack ${name} was removed. Choose the Conversation's Skill packs again.`,
                  }),
                ),
              SkillPackError: ({ message }) => Effect.fail(new ConversationError({ message })),
              SqlError: couldNotSave,
            }),
            Effect.onError(() => forget),
          )
      }

      const createForReview = Effect.fn("Conversations.createForReview")(function* (
        input: NewReviewConversation,
      ) {
        const conversation = new Conversation({
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
          { conversation, folder: input.checkout, forReview: true },
          { message: input.message, images: [] },
          Purpose.Review({ brief: input.review }),
        )
      })

      const create = Effect.fn("Conversations.create")(function* (input: NewConversation) {
        const { repository, baseBranch, harness, model, effort, place } = input
        const { message, images } = input
        const placement = yield* placementRunning(place, harness)

        const permissionMode =
          harnessCapabilities[harness].permissionModes.length === 0
            ? null
            : asksPermission(place)
              ? (input.permissionMode ?? defaultPermissionMode)
              : "bypassPermissions"

        const { name, branch, folder, discard } = yield* placement.place(repository, baseBranch)

        const conversation = new Conversation({
          id: randomUUID(),
          name,
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

        const created = yield* insert(
          { conversation, folder, forReview: false },
          { message, images },
          Purpose.Work({ packs: input.skillPacks }),
        ).pipe(Effect.onError(() => discard))

        yield* activityLog.record(
          ConversationStarted.make({
            conversationId: conversation.id,
            name,
            repository,
            machine: place._tag,
            harness: conversation.harness,
            message,
          }),
        )

        return yield* withSandbox(created)
      })

      const findWritable = (conversationId: string) =>
        find(conversationId).pipe(Effect.tap(() => sandboxes.refuseIfGone(conversationId)))

      const send = Effect.fn("Conversations.send")(function* (
        conversationId: string,
        { message, images }: SentMessage,
        feedback: ReadonlyArray<string> = [],
      ) {
        yield* findWritable(conversationId)

        return yield* turns.send(
          conversationId,
          { message, images, context: null },
          notes.take(conversationNotes(conversationId), feedback),
        )
      })

      const steer = Effect.fn("Conversations.steer")(function* (
        conversationId: string,
        input: MessageInput,
      ) {
        const row = yield* findWritable(conversationId)
        yield* turns.steer(conversationOf(row), { ...input, context: null })
      })

      const sendQueued = Effect.fn("Conversations.sendQueued")(function* (
        conversationId: string,
        queuedId: string,
      ) {
        yield* findWritable(conversationId)
        yield* turns.sendQueued(conversationId, queuedId)
      })

      const stop = Effect.fn("Conversations.stop")(function* (conversationId: string) {
        yield* turns.stop(conversationOf(yield* find(conversationId)))
      })

      const unsent = Effect.fn("Conversations.unsent")(function* (conversationId: string) {
        yield* find(conversationId)

        return yield* turns.unsent(conversationId)
      })

      const saveUnsent = Effect.fn("Conversations.saveUnsent")(function* (
        conversationId: string,
        unsentMessage: SentMessage,
      ) {
        yield* find(conversationId)
        yield* turns.saveUnsent(conversationId, unsentMessage)
      })

      const changes = Effect.fn("Conversations.changes")(function* (conversationId: string) {
        const row = yield* find(conversationId)
        const hosting = hostingOf(row)

        const host = yield* hosting.hostIfPrepared(row)

        if (Option.isNone(host)) return changesOf([])

        const baseRef = yield* hosting.baseRef(row)

        return yield* host.value
          .GetChanges({ folder: row.folder, baseRef })
          .pipe(Effect.mapError(asConversationError), Effect.map(changesOf))
      })

      const onHost = Effect.fnUntraced(function* <A, E>(
        conversationId: string,
        call: (host: HostClient, row: PlacedConversation) => Effect.Effect<A, HostCallError>,
        absent: Effect.Effect<A, E>,
      ) {
        const row = yield* find(conversationId)
        const host = yield* hostingOf(row).hostIfPrepared(row)

        if (Option.isNone(host)) return yield* absent

        return yield* call(host.value, row).pipe(Effect.mapError(asConversationError))
      })

      const listedByHost = <A>(
        conversationId: string,
        list: (
          host: HostClient,
          row: PlacedConversation,
        ) => Effect.Effect<ReadonlyArray<A>, HostCallError>,
      ) => onHost(conversationId, list, Effect.succeed<ReadonlyArray<A>>([]))

      const commands = (conversationId: string) =>
        listedByHost(conversationId, (host, row) =>
          skillsOf(row.conversation).pipe(
            Effect.flatMap((skills) =>
              host.ListCommands({ harness: row.conversation.harness, folder: row.folder, skills }),
            ),
          ),
        ).pipe(Effect.withSpan("Conversations.commands"))

      const files = (conversationId: string) =>
        listedByHost(conversationId, (host, row) => host.ListFiles({ folder: row.folder })).pipe(
          Effect.withSpan("Conversations.files"),
        )

      const existingFiles = (conversationId: string, paths: ReadonlyArray<string>) =>
        listedByHost(conversationId, (host, row) =>
          host.ExistingFiles({ folder: row.folder, paths }),
        ).pipe(Effect.withSpan("Conversations.existingFiles"))

      const file = (conversationId: string, path: string) =>
        onHost(
          conversationId,
          (host, row) => host.ReadFile({ folder: row.folder, path }),
          new ConversationError({
            message: "This Conversation's folder isn't ready yet. Try again once it's up.",
          }),
        ).pipe(Effect.withSpan("Conversations.file"))

      const update = Effect.fn("Conversations.update")(function* (
        conversationId: string,
        change: Partial<Pick<Conversation, "model" | "effort" | "permissionMode">>,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const found = yield* find(conversationId)
            const conversation = conversationWith(found.conversation, change)

            yield* sql`
              UPDATE conversation SET model = ${conversation.model}, effort = ${conversation.effort},
                permission_mode = ${conversation.permissionMode}
              WHERE id = ${conversationId}
            `.pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Couldn't save a Conversation's settings", cause),
              ),
              Effect.mapError(storageFailure),
            )
            yield* replace(conversation)

            return yield* withSandbox(conversation)
          }),
        )
      })

      const changePermissionMode = Effect.fn("Conversations.changePermissionMode")(function* (
        conversationId: string,
        permissionMode: PermissionMode,
      ) {
        const { conversation } = yield* find(conversationId)

        if (conversation.permissionMode === null || !asksPermission(conversation.place))
          return yield* new NoPermissionModes()

        return yield* update(conversationId, { permissionMode })
      })

      const answer = Effect.fn("Conversations.answer")(function* (
        conversationId: string,
        requestId: string,
        given: RequestAnswer,
      ) {
        return yield* turns.answer(conversationOf(yield* find(conversationId)), requestId, given)
      })

      const removalWarnings = Effect.fn("Conversations.removalWarnings")(function* (
        conversationId: string,
      ) {
        const row = yield* find(conversationId)

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
              Effect.logWarning("Couldn't check a Conversation for uncommitted work", cause).pipe(
                Effect.as(new RemovalWarnings({ uncommittedChanges: "unchecked" })),
              ),
            ),
          )
      })

      const remove = Effect.fn("Conversations.remove")(function* (conversationId: string) {
        const row = yield* lock.withPermits(1)(
          find(conversationId).pipe(
            Effect.tap(() =>
              SubscriptionRef.update(rows, (current) =>
                current.filter(({ conversation }) => conversation.id !== conversationId),
              ),
            ),
          ),
        )

        yield* Effect.gen(function* () {
          const hosting = hostingOf(row)
          const running = yield* hosting.connectedHost(row)

          if (Option.isSome(running))
            yield* running.value.StopConversation({ conversationId }).pipe(
              Effect.tapError((cause) => Effect.logWarning("Couldn't stop a Conversation", cause)),
              Effect.ignore,
            )

          yield* hosting.remove(row)

          yield* Effect.gen(function* () {
            yield* transcripts.remove(conversationId)
            yield* turns.removeUnsent(conversationId)
            yield* notes.removeAll(conversationNotes(conversationId))
            yield* skillPacks.releaseConversation(conversationId)
            yield* sql`DELETE FROM global_started_conversation WHERE conversation_id = ${conversationId}`
            yield* sql`DELETE FROM conversation WHERE id = ${conversationId}`
          }).pipe(sql.withTransaction, Effect.mapError(storageFailure))
        }).pipe(
          Effect.tapError(() =>
            SubscriptionRef.update(rows, (current) =>
              [...current, row].toSorted((a, b) =>
                DateTime.Order(a.conversation.createdAt, b.conversation.createdAt),
              ),
            ),
          ),
        )
      })

      const placed = Stream.zipLatest(SubscriptionRef.changes(rows), sandboxes.statuses).pipe(
        Stream.map(([current, statuses]) =>
          current.map((row) => ({
            ...row,
            conversation: conversationWith(row.conversation, {
              sandbox: statuses.get(row.conversation.id) ?? null,
            }),
          })),
        ),
      )

      return Conversations.of({
        watch: () =>
          placed.pipe(Stream.map((current) => current.map(({ conversation }) => conversation))),
        transcript: (conversationId) =>
          Stream.unwrap(find(conversationId).pipe(Effect.as(transcripts.watch(conversationId)))),
        readTranscript: (conversationId, latest) =>
          find(conversationId).pipe(Effect.andThen(transcripts.read(conversationId, latest))),
        loadEarlierTurns: (conversationId, before) =>
          find(conversationId).pipe(
            Effect.andThen(transcripts.loadEarlier(conversationId, before)),
          ),
        harnesses: (place) => placementFor(place).harnesses,
        models: (harness, place) =>
          placementRunning(place, harness).pipe(
            Effect.flatMap((placement) => placement.models(harness)),
          ),
        newConversationCommands: (harness, place, repository) =>
          placementRunning(place, harness).pipe(
            Effect.flatMap((placement) => placement.commands(harness, repository)),
          ),
        newConversationDefaultBranch: (place, repository) =>
          placementFor(place).defaultBranch(repository),
        newConversationBranches: (place, repository) => placementFor(place).branches(repository),
        commands,
        newConversationFiles: (place, repository, baseBranch) =>
          placementFor(place).files(repository, baseBranch),
        files,
        existingFiles,
        file,
        create,
        createForReview,
        send,
        changes,
        feedbackNotes: (conversationId) =>
          find(conversationId).pipe(Effect.andThen(notes.list(conversationNotes(conversationId)))),
        stageFeedbackNotes: (conversationId) =>
          find(conversationId).pipe(Effect.andThen(notes.stage(conversationNotes(conversationId)))),
        saveFeedbackNote: (conversationId, note) =>
          find(conversationId).pipe(
            Effect.andThen(notes.save(conversationNotes(conversationId), note)),
          ),
        removeFeedbackNote: (conversationId, noteId) =>
          find(conversationId).pipe(
            Effect.andThen(notes.remove(conversationNotes(conversationId), noteId)),
          ),
        steer,
        cancelQueued: (conversationId, queuedId) =>
          find(conversationId).pipe(
            Effect.andThen(
              transcripts.cancelQueued(conversationId, queuedId, (feedback) =>
                notes.restore(conversationNotes(conversationId), feedback),
              ),
            ),
            Effect.andThen(notes.list(conversationNotes(conversationId))),
          ),
        sendQueued,
        stop,
        reachSandbox: (conversationId) =>
          find(conversationId).pipe(
            Effect.flatMap((row) => hostingOf(row).prepareHost(row)),
            Effect.asVoid,
          ),
        unsent,
        saveUnsent,
        watchWaiting: () =>
          Stream.zipLatest(placed, transcripts.waiting).pipe(
            Stream.map(([current, waiting]) =>
              current.flatMap(({ conversation }) => {
                const requests = waiting.get(conversation.id)

                return requests === undefined ? [] : [{ conversation, requests }]
              }),
            ),
          ),
        watchFinished: () =>
          Stream.zipLatest(placed, transcripts.unseen).pipe(
            Stream.map(([current, unseen]) =>
              current.flatMap(({ conversation }) => {
                const ended = unseen.get(conversation.id)

                return ended === undefined ||
                  conversation.forReview ||
                  Predicate.isTagged(ended.ending, "Stopped")
                  ? []
                  : [{ conversation, ended }]
              }),
            ),
          ),
        watchWorking: () =>
          Stream.zipLatest(placed, transcripts.running).pipe(
            Stream.map(([current, running]) =>
              current.flatMap(({ conversation }) =>
                running.has(conversation.id) ? [conversation.id] : [],
              ),
            ),
          ),
        markTurnSeen: transcripts.markSeen,
        followBranch,
        changeModel: update,
        changePermissionMode,
        answer,
        removalWarnings,
        remove,
      })
    }),
  )
}
