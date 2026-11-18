import {
  type Conversation,
  type AgentCommand,
  type AgentHarness,
  type ConversationMessageInput,
  type ConversationPlace,
  applyTranscriptUpdate,
  emptyTranscript,
  type FollowedRepository,
  type MessageInput,
  type ModelChoice,
  type NewConversation,
  type PermissionMode,
  type PlaceTag,
  type PullRequestSummary,
  type RequestAnswer,
  SandboxPlace,
  type SentMessage,
  type Transcript,
  type TranscriptUpdate,
  type UnsentFeedback,
  repositoryKey,
  localPlace,
} from "@glass/contracts"
import { Data, Effect, Exit, Option, Predicate, Schema, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import { Cloud, Laptop, type LucideIcon } from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Backend, type BackendError, backendRuntime, backendRuntimeOf } from "./backend"
import { problemOf } from "./problems"

export type ConversationTab = "chat" | "changes"

export const conversationsPanelOpenAtom = Atom.make(true)

export const ConversationSearch = Schema.Struct({
  view: Schema.optional(Schema.Literal("changes")),
})

export const placeKey = (place: ConversationPlace) =>
  Predicate.isTagged(place, "sandbox") ? `sandbox:${place.providerId}` : place._tag

export const placeOfKey = (key: string): ConversationPlace =>
  key.startsWith("sandbox:")
    ? SandboxPlace.make({ providerId: key.slice("sandbox:".length) })
    : localPlace

export const placeNames: Record<PlaceTag, string> = { local: "Local", sandbox: "Sandbox" }

export const placeIcons: Record<PlaceTag, LucideIcon> = { local: Laptop, sandbox: Cloud }

export const TRANSCRIPT_IDLE_TTL = "5 minutes"

const FRAME = "16 millis"

export const conversationsAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchConversations())))
  .pipe(Atom.keepAlive)

export const workingConversationsAtom = backendRuntime
  .atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchWorkingConversations())).pipe(
      Stream.map((ids): ReadonlySet<string> => new Set(ids)),
    ),
  )
  .pipe(Atom.keepAlive)

export const conversationPullRequestsAtom = backendRuntime
  .atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchConversationPullRequests())).pipe(
      Stream.map(
        (listed): ReadonlyMap<string, PullRequestSummary> =>
          new Map(listed.map(({ conversationId, pullRequest }) => [conversationId, pullRequest])),
      ),
    ),
  )
  .pipe(Atom.keepAlive)

export const transcriptOf = <E, R>(updates: Stream.Stream<TranscriptUpdate, E, R>) =>
  updates.pipe(
    Stream.groupedWithin(Number.POSITIVE_INFINITY, FRAME),
    Stream.mapAccum(
      (): Transcript => emptyTranscript,
      (transcript, batch) => {
        const next = batch.reduce(applyTranscriptUpdate, transcript)

        return [next, [next]] as const
      },
    ),
  )

export const transcriptAtom = Atom.family((conversationId: string) =>
  backendRuntime
    .atom(
      transcriptOf(
        Stream.unwrap(Backend.useSync((backend) => backend.WatchTranscript({ conversationId }))),
      ),
    )
    .pipe(Atom.setIdleTTL(TRANSCRIPT_IDLE_TTL)),
)

export const loadEarlierTurnsAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn((before: string) =>
    Backend.use((backend) => backend.LoadEarlierTurns({ conversationId, before })),
  ),
)

export const conversationChangesAtom = Atom.family((conversationId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetConversationChanges({ conversationId }))),
)

export const feedbackNotesAtom = Atom.family((conversationId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.ListFeedbackNotes({ conversationId }))),
)

export const writtenFeedbackAtom = Atom.family((_conversationId: string) =>
  Atom.make<UnsentFeedback | null>(null),
)

export const localCheckoutsAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListLocalCheckouts()))
  .pipe(Atom.keepAlive)

class PlaceRepository extends Data.Class<{
  readonly placeKey: string
  readonly repository: FollowedRepository
}> {}

const keptWhenFromGitHub = <A>(at: PlaceRepository, atom: Atom.Atom<A>) =>
  Predicate.isTagged(placeOfKey(at.placeKey), "sandbox") ? atom.pipe(Atom.keepAlive) : atom

const newConversationDefaultBranchFamily = Atom.family((at: PlaceRepository) =>
  keptWhenFromGitHub(
    at,
    backendRuntime.atom(
      Backend.use((backend) =>
        backend.GetNewConversationDefaultBranch({
          place: placeOfKey(at.placeKey),
          repository: at.repository,
        }),
      ),
    ),
  ),
)

const newConversationBranchesFamily = Atom.family((at: PlaceRepository) =>
  keptWhenFromGitHub(
    at,
    backendRuntime.atom(
      Backend.use((backend) =>
        backend.ListNewConversationBranches({
          place: placeOfKey(at.placeKey),
          repository: at.repository,
        }),
      ),
    ),
  ),
)

export const newConversationDefaultBranchAtom = (key: string, repository: FollowedRepository) =>
  newConversationDefaultBranchFamily(new PlaceRepository({ placeKey: key, repository }))

export const newConversationBranchesAtom = (key: string, repository: FollowedRepository) =>
  newConversationBranchesFamily(new PlaceRepository({ placeKey: key, repository }))

export const sandboxProvidersAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListSandboxProviders()))
  .pipe(Atom.keepAlive)

export const linkCheckoutAtom = backendRuntime.fn((path: string, get) =>
  Backend.use((backend) => backend.LinkLocalCheckout({ path })).pipe(
    Effect.tap(() => Effect.sync(() => get.refresh(localCheckoutsAtom))),
  ),
)

class HarnessPlace extends Data.Class<{
  readonly harness: AgentHarness
  readonly placeKey: string
}> {}

const harnessModelsAtom = Atom.family((harness: HarnessPlace) =>
  backendRuntime
    .atom(
      Backend.use((backend) =>
        backend.ListAgentModels({ harness: harness.harness, place: placeOfKey(harness.placeKey) }),
      ),
    )
    .pipe(Atom.keepAlive),
)

export const agentModelsAtom = (harness: AgentHarness, key: string) =>
  harnessModelsAtom(new HarnessPlace({ harness, placeKey: key }))

class NewConversationOf extends Data.Class<{
  readonly harness: AgentHarness
  readonly place: string
  readonly repository: FollowedRepository
}> {}

const COMPOSER_LISTING_IDLE_TTL = "5 minutes"

export const noCommands: ReadonlyArray<AgentCommand> = []

export const noFiles: ReadonlyArray<string> = []

const listedOr = <A>(
  listing: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>>,
  none: ReadonlyArray<A>,
) => Atom.map(listing, (listed) => Option.getOrElse(AsyncResult.value(listed), () => none))

const newConversationCommandsFamily = Atom.family((newConversation: NewConversationOf) =>
  listedOr(
    backendRuntime
      .atom(
        Backend.use((backend) =>
          backend.ListNewConversationCommands({
            harness: newConversation.harness,
            place: placeOfKey(newConversation.place),
            repository: newConversation.repository,
          }),
        ),
      )
      .pipe(Atom.setIdleTTL(COMPOSER_LISTING_IDLE_TTL)),
    noCommands,
  ),
)

export const newConversationCommandsAtom = (
  harness: AgentHarness,
  place: string,
  repository: FollowedRepository,
) => newConversationCommandsFamily(new NewConversationOf({ harness, place, repository }))

const sandboxReachableAtom = Atom.family((conversationId: string) =>
  Atom.make((get) =>
    Option.match(AsyncResult.value(get(conversationsAtom)), {
      onNone: () => false,
      onSome: (conversations) =>
        conversations.find(({ id }) => id === conversationId)?.sandbox?.reach === "reachable",
    }),
  ),
)

const relistedOnReachAtom = <A>(
  conversationId: string,
  list: Effect.Effect<ReadonlyArray<A>, BackendError, Backend>,
  none: ReadonlyArray<A>,
) =>
  listedOr(
    backendRuntime
      .atom((get) => {
        get(sandboxReachableAtom(conversationId))

        return list
      })
      .pipe(Atom.setIdleTTL(COMPOSER_LISTING_IDLE_TTL)),
    none,
  )

export const conversationCommandsAtom = Atom.family((conversationId: string) =>
  relistedOnReachAtom(
    conversationId,
    Backend.use((backend) => backend.ListConversationCommands({ conversationId })),
    noCommands,
  ),
)

class NewConversationBranch extends Data.Class<{
  readonly place: string
  readonly repository: FollowedRepository
  readonly baseBranch: string
}> {}

const newConversationFilesFamily = Atom.family((branch: NewConversationBranch) =>
  listedOr(
    backendRuntime
      .atom(
        Backend.use((backend) =>
          backend.ListNewConversationFiles({
            place: placeOfKey(branch.place),
            repository: branch.repository,
            baseBranch: branch.baseBranch,
          }),
        ),
      )
      .pipe(Atom.setIdleTTL(COMPOSER_LISTING_IDLE_TTL)),
    noFiles,
  ),
)

export const newConversationFilesAtom = (
  place: string,
  repository: FollowedRepository,
  baseBranch: string,
) => newConversationFilesFamily(new NewConversationBranch({ place, repository, baseBranch }))

export const conversationFilesAtom = Atom.family((conversationId: string) =>
  relistedOnReachAtom(
    conversationId,
    Backend.use((backend) => backend.ListConversationFiles({ conversationId })),
    noFiles,
  ),
)

export const changeModelAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn((choice: ModelChoice) =>
    Backend.use((backend) => backend.ChangeConversationModel({ conversationId, ...choice })),
  ),
)

export const permissionModeNames: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  auto: "Auto",
  bypassPermissions: "Bypass",
}

export const changePermissionModeAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn((permissionMode: PermissionMode) =>
    Backend.use((backend) => backend.ChangePermissionMode({ conversationId, permissionMode })),
  ),
)

export class ConversationRequest extends Data.Class<{
  readonly conversationId: string
  readonly requestId: string
}> {}

export const answerRequestAtom = Atom.family((request: ConversationRequest) =>
  backendRuntime.fn((answer: RequestAnswer) =>
    Backend.use((backend) =>
      backend.AnswerRequest({
        conversationId: request.conversationId,
        requestId: request.requestId,
        answer,
      }),
    ),
  ),
)

export const createConversationAtom = backendRuntime.fn((input: NewConversation, get) =>
  Effect.gen(function* () {
    const created = yield* Backend.use((backend) => backend.CreateConversation(input))

    yield* Effect.all(
      [
        AtomRegistry.toStreamResult(get.registry, conversationsAtom).pipe(
          Stream.filter((conversations) => conversations.some(({ id }) => id === created.id)),
          Stream.runHead,
          Effect.ignore,
        ),
        AtomRegistry.getResult(get.registry, transcriptAtom(created.id)).pipe(Effect.ignore),
      ],
      { concurrency: "unbounded", discard: true },
    )

    return created
  }),
)

export const sendMessageAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn((sent: ConversationMessageInput) =>
    Backend.use((backend) => backend.SendMessage({ conversationId, ...sent })),
  ),
)

export const steerAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn((sent: MessageInput) =>
    Backend.use((backend) => backend.Steer({ conversationId, ...sent })),
  ),
)

export const stopTurnAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.StopTurn({ conversationId }))),
)

export const reachSandboxAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.ReachSandbox({ conversationId }))),
)

export const cancelQueuedAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn((queuedMessageId: string, get) =>
    Backend.use((backend) => backend.CancelQueuedMessage({ conversationId, queuedMessageId })).pipe(
      Effect.tap((unsent) =>
        Effect.sync(() => get.set(writtenFeedbackAtom(conversationId), unsent)),
      ),
      Effect.asVoid,
    ),
  ),
)

export const sendQueuedAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn((queuedMessageId: string) =>
    Backend.use((backend) => backend.SendQueuedMessage({ conversationId, queuedMessageId })),
  ),
)

export const writtenAtom = Atom.family((_key: string) =>
  Atom.make<SentMessage | null>(null).pipe(Atom.keepAlive),
)

export const newConversationWrittenAtom = writtenAtom("new")

export const unsentMessageAtom = Atom.family((conversationId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetUnsentMessage({ conversationId }))),
)

export const saveUnsent = (
  registry: AtomRegistry.AtomRegistry,
  conversationId: string,
  composed: SentMessage,
) =>
  void backendRuntimeOf(registry).runPromiseExit(
    Backend.use((backend) => backend.SaveUnsentMessage({ conversationId, ...composed })),
  )

export const removalWarningsAtom = Atom.family((conversationId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.GetRemovalWarnings({ conversationId }))),
)

export const removeConversation = async (
  registry: AtomRegistry.AtomRegistry,
  conversation: Conversation,
) => {
  const exit = await backendRuntimeOf(registry).runPromiseExit(
    Backend.use((backend) => backend.RemoveConversation({ conversationId: conversation.id })),
  )

  if (Exit.isFailure(exit))
    toast.add({
      type: "error",
      title: `Couldn't remove ${conversation.name}`,
      description: problemOf(exit.cause).detail,
    })
}

const groupOrder: ReadonlyArray<PlaceTag> = ["local", "sandbox"]

export const groupConversations = (conversations: ReadonlyArray<Conversation>) =>
  groupOrder.flatMap((machine) => {
    const onMachine = conversations.filter((conversation) =>
      Predicate.isTagged(conversation.place, machine),
    )

    if (onMachine.length === 0) return []

    const byRepository = Map.groupBy(onMachine, (conversation) =>
      repositoryKey(conversation.repository),
    )

    return [{ machine, conversations: [...byRepository.values()].flat() }]
  })
