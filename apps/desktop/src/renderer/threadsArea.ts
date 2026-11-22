import { useAtomSet } from "@effect/atom-react"
import {
  type Thread,
  type ThreadPullRequest,
  type AgentCommand,
  type AgentHarness,
  type ThreadMessageInput,
  type ThreadPlace,
  applyTranscriptUpdate,
  emptyTranscript,
  type FollowedRepository,
  type MessageInput,
  type ModelChoice,
  type NewThread,
  type PermissionMode,
  type PlaceTag,
  type RequestAnswer,
  SandboxPlace,
  type SentMessage,
  type Transcript,
  type TranscriptUpdate,
  type UnsentFeedback,
  repositoryKey,
  localPlace,
  nothingUnsent,
} from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { Data, Effect, Exit, Option, Predicate, Schema, Stream } from "effect"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import { Cloud, Laptop, type LucideIcon } from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Backend, type BackendError, backendRuntime, backendRuntimeOf } from "./backend"
import { problemOf } from "./problems"

export type ThreadTab = "chat" | "changes"

export const threadsPanelOpenAtom = Atom.make(true)

export const threadDetailsPinnedAtom = Atom.make(true).pipe(Atom.keepAlive)

export const settledOpenAtom = Atom.make(false).pipe(Atom.keepAlive)

export const ThreadSearch = Schema.Struct({
  view: Schema.optional(Schema.Literal("changes")),
})

export const placeKey = (place: ThreadPlace) =>
  Predicate.isTagged(place, "sandbox") ? `sandbox:${place.providerId}` : place._tag

export const placeOfKey = (key: string): ThreadPlace =>
  key.startsWith("sandbox:")
    ? SandboxPlace.make({ providerId: key.slice("sandbox:".length) })
    : localPlace

export const placeNames: Record<PlaceTag, string> = { local: "Local", sandbox: "Sandbox" }

export const placeIcons: Record<PlaceTag, LucideIcon> = { local: Laptop, sandbox: Cloud }

export const TRANSCRIPT_IDLE_TTL = "5 minutes"

const FRAME = "16 millis"

export const threadsAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchThreads())))
  .pipe(Atom.keepAlive)

export const workingThreadsAtom = backendRuntime
  .atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchWorkingThreads())).pipe(
      Stream.map((ids): ReadonlySet<string> => new Set(ids)),
    ),
  )
  .pipe(Atom.keepAlive)

export const settledThreadsAtom = backendRuntime
  .atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchSettledThreads())).pipe(
      Stream.map((ids): ReadonlySet<string> => new Set(ids)),
    ),
  )
  .pipe(Atom.keepAlive)

export const bringBackThreadAtom = backendRuntime.fn((threadId: string) =>
  Backend.use((backend) => backend.BringBackThread({ threadId })),
)

export const threadPullRequestsAtom = backendRuntime
  .atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchThreadPullRequests())).pipe(
      Stream.map(
        (listed): ReadonlyMap<string, ThreadPullRequest> =>
          new Map(listed.map((pullRequest) => [pullRequest.threadId, pullRequest])),
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

export const transcriptAtom = Atom.family((threadId: string) =>
  backendRuntime
    .atom(
      transcriptOf(
        Stream.unwrap(Backend.useSync((backend) => backend.WatchTranscript({ threadId }))),
      ),
    )
    .pipe(Atom.setIdleTTL(TRANSCRIPT_IDLE_TTL)),
)

export const loadEarlierTurnsAtom = Atom.family((threadId: string) =>
  backendRuntime.fn((before: string) =>
    Backend.use((backend) => backend.LoadEarlierTurns({ threadId, before })),
  ),
)

export const threadChangesAtom = Atom.family((threadId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetThreadChanges({ threadId }))),
)

export const feedbackNotesAtom = Atom.family((threadId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.ListFeedbackNotes({ threadId }))),
)

export const writtenFeedbackAtom = Atom.family((_threadId: string) =>
  Atom.make<UnsentFeedback | null>(null),
)

export const pageNoteEditingAtom = Atom.family((_threadId: string) =>
  Atom.make<string | null>(null),
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

const newThreadDefaultBranchFamily = Atom.family((at: PlaceRepository) =>
  keptWhenFromGitHub(
    at,
    backendRuntime.atom(
      Backend.use((backend) =>
        backend.GetNewThreadDefaultBranch({
          place: placeOfKey(at.placeKey),
          repository: at.repository,
        }),
      ),
    ),
  ),
)

const newThreadBranchesFamily = Atom.family((at: PlaceRepository) =>
  keptWhenFromGitHub(
    at,
    backendRuntime.atom(
      Backend.use((backend) =>
        backend.ListNewThreadBranches({
          place: placeOfKey(at.placeKey),
          repository: at.repository,
        }),
      ),
    ),
  ),
)

export const newThreadDefaultBranchAtom = (key: string, repository: FollowedRepository) =>
  newThreadDefaultBranchFamily(new PlaceRepository({ placeKey: key, repository }))

export const newThreadBranchesAtom = (key: string, repository: FollowedRepository) =>
  newThreadBranchesFamily(new PlaceRepository({ placeKey: key, repository }))

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

class NewThreadOf extends Data.Class<{
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

const newThreadCommandsFamily = Atom.family((newThread: NewThreadOf) =>
  listedOr(
    backendRuntime
      .atom(
        Backend.use((backend) =>
          backend.ListNewThreadCommands({
            harness: newThread.harness,
            place: placeOfKey(newThread.place),
            repository: newThread.repository,
          }),
        ),
      )
      .pipe(Atom.setIdleTTL(COMPOSER_LISTING_IDLE_TTL)),
    noCommands,
  ),
)

export const newThreadCommandsAtom = (
  harness: AgentHarness,
  place: string,
  repository: FollowedRepository,
) => newThreadCommandsFamily(new NewThreadOf({ harness, place, repository }))

const sandboxReachableAtom = Atom.family((threadId: string) =>
  Atom.make((get) =>
    Option.match(AsyncResult.value(get(threadsAtom)), {
      onNone: () => false,
      onSome: (threads) =>
        threads.find(({ id }) => id === threadId)?.sandbox?.reach === "reachable",
    }),
  ),
)

const relistedOnReachAtom = <A>(
  threadId: string,
  list: Effect.Effect<ReadonlyArray<A>, BackendError, Backend>,
  none: ReadonlyArray<A>,
) =>
  listedOr(
    backendRuntime
      .atom((get) => {
        get(sandboxReachableAtom(threadId))

        return list
      })
      .pipe(Atom.setIdleTTL(COMPOSER_LISTING_IDLE_TTL)),
    none,
  )

export const threadCommandsAtom = Atom.family((threadId: string) =>
  relistedOnReachAtom(
    threadId,
    Backend.use((backend) => backend.ListThreadCommands({ threadId })),
    noCommands,
  ),
)

class NewThreadBranch extends Data.Class<{
  readonly place: string
  readonly repository: FollowedRepository
  readonly baseBranch: string
}> {}

const newThreadFilesFamily = Atom.family((branch: NewThreadBranch) =>
  listedOr(
    backendRuntime
      .atom(
        Backend.use((backend) =>
          backend.ListNewThreadFiles({
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

export const newThreadFilesAtom = (
  place: string,
  repository: FollowedRepository,
  baseBranch: string,
) => newThreadFilesFamily(new NewThreadBranch({ place, repository, baseBranch }))

export const threadFilesAtom = Atom.family((threadId: string) =>
  relistedOnReachAtom(
    threadId,
    Backend.use((backend) => backend.ListThreadFiles({ threadId })),
    noFiles,
  ),
)

export const changeModelAtom = Atom.family((threadId: string) =>
  backendRuntime.fn((choice: ModelChoice) =>
    Backend.use((backend) => backend.ChangeThreadModel({ threadId, ...choice })),
  ),
)

export const permissionModeNames: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  auto: "Auto",
  bypassPermissions: "Bypass",
}

export const changePermissionModeAtom = Atom.family((threadId: string) =>
  backendRuntime.fn((permissionMode: PermissionMode) =>
    Backend.use((backend) => backend.ChangePermissionMode({ threadId, permissionMode })),
  ),
)

export class ThreadRequest extends Data.Class<{
  readonly threadId: string
  readonly requestId: string
}> {}

export const answerRequestAtom = Atom.family((request: ThreadRequest) =>
  backendRuntime.fn((answer: RequestAnswer) =>
    Backend.use((backend) =>
      backend.AnswerRequest({
        threadId: request.threadId,
        requestId: request.requestId,
        answer,
      }),
    ),
  ),
)

export const createThreadAtom = backendRuntime.fn((input: NewThread, get) =>
  Effect.gen(function* () {
    const created = yield* Backend.use((backend) => backend.CreateThread(input))

    yield* Effect.all(
      [
        AtomRegistry.toStreamResult(get.registry, threadsAtom).pipe(
          Stream.filter((threads) => threads.some(({ id }) => id === created.id)),
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

export const sendMessageAtom = Atom.family((threadId: string) =>
  backendRuntime.fn((sent: ThreadMessageInput) =>
    Backend.use((backend) => backend.SendMessage({ threadId, ...sent })),
  ),
)

export const steerAtom = Atom.family((threadId: string) =>
  backendRuntime.fn((sent: MessageInput) =>
    Backend.use((backend) => backend.Steer({ threadId, ...sent })),
  ),
)

export const stopTurnAtom = Atom.family((threadId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.StopTurn({ threadId }))),
)

export const reachSandboxAtom = Atom.family((threadId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.ReachSandbox({ threadId }))),
)

export const cancelQueuedAtom = Atom.family((threadId: string) =>
  backendRuntime.fn((queuedMessageId: string, get) =>
    Backend.use((backend) => backend.CancelQueuedMessage({ threadId, queuedMessageId })).pipe(
      Effect.tap((unsent) => Effect.sync(() => get.set(writtenFeedbackAtom(threadId), unsent))),
      Effect.asVoid,
    ),
  ),
)

export const sendQueuedAtom = Atom.family((threadId: string) =>
  backendRuntime.fn((queuedMessageId: string) =>
    Backend.use((backend) => backend.SendQueuedMessage({ threadId, queuedMessageId })),
  ),
)

export const writtenAtom = Atom.family((_key: string) =>
  Atom.make<SentMessage | null>(null).pipe(Atom.keepAlive),
)

export const newThreadWrittenAtom = writtenAtom("new")

export function useStartThread() {
  const navigate = useNavigate()
  const setWritten = useAtomSet(newThreadWrittenAtom)

  return (text: string | undefined, repository?: string) => {
    if (text !== undefined)
      setWritten((written) => {
        const composed = written ?? nothingUnsent
        const before = composed.message.trimEnd()

        return { ...composed, message: before === "" ? `${text} ` : `${before} ${text} ` }
      })
    void navigate({
      to: "/threads/new",
      search: repository === undefined ? {} : { repository },
    })
  }
}

export const unsentMessageAtom = Atom.family((threadId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetUnsentMessage({ threadId }))),
)

export const saveUnsent = (
  registry: AtomRegistry.AtomRegistry,
  threadId: string,
  composed: SentMessage,
) =>
  void backendRuntimeOf(registry).runPromiseExit(
    Backend.use((backend) => backend.SaveUnsentMessage({ threadId, ...composed })),
  )

export const removalWarningsAtom = Atom.family((threadId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.GetRemovalWarnings({ threadId }))),
)

export const removeThread = async (registry: AtomRegistry.AtomRegistry, thread: Thread) => {
  const exit = await backendRuntimeOf(registry).runPromiseExit(
    Backend.use((backend) => backend.RemoveThread({ threadId: thread.id })),
  )

  if (Exit.isFailure(exit))
    toast.add({
      type: "error",
      title: `Couldn't remove ${thread.name}`,
      description: problemOf(exit.cause).detail,
    })
}

export const removeSettledThreads = async (
  registry: AtomRegistry.AtomRegistry,
  settled: ReadonlyArray<Thread>,
  beforeRemoving: (thread: Thread) => void,
) => {
  let kept = 0

  for (const thread of settled) {
    const warnings = await backendRuntimeOf(registry).runPromiseExit(
      Backend.use((backend) => backend.GetRemovalWarnings({ threadId: thread.id })),
    )

    if (Exit.isSuccess(warnings) && warnings.value.uncommittedChanges === "none") {
      beforeRemoving(thread)
      await removeThread(registry, thread)
    } else kept++
  }

  if (kept > 0)
    toast.add({
      type: "info",
      title: kept === 1 ? "Kept 1 Settled Thread" : `Kept ${kept} Settled Threads`,
      description:
        "They have uncommitted changes, or Glass couldn't check. Remove each one to see what it discards.",
    })
}

const groupOrder: ReadonlyArray<PlaceTag> = ["local", "sandbox"]

export const groupThreads = (threads: ReadonlyArray<Thread>) =>
  groupOrder.flatMap((machine) => {
    const onMachine = threads.filter((thread) => Predicate.isTagged(thread.place, machine))

    if (onMachine.length === 0) return []

    const byRepository = Map.groupBy(onMachine, (thread) => repositoryKey(thread.repository))

    return [{ machine, threads: [...byRepository.values()].flat() }]
  })
