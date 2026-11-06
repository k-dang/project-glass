import {
  type Agent,
  type AgentCommand,
  type AgentEngine,
  type AgentPlace,
  applyTranscriptUpdate,
  emptyTranscript,
  type FollowedRepository,
  type MessageInput,
  type ModelChoice,
  type NewAgent,
  type PermissionMode,
  type PlaceTag,
  type RequestAnswer,
  SandboxPlace,
  type SentMessage,
  type Transcript,
  type TranscriptUpdate,
  repositoryKey,
  thisMac,
} from "@glass/contracts"
import { Data, Effect, Exit, Option, Predicate, Schema, Stream } from "effect"
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity"
import { Cloud, Laptop, type LucideIcon } from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import { problemOf } from "./problems"

export type AgentTab = "chat" | "changes"

export const agentsPanelOpenAtom = Atom.make(true)

export const AgentSearch = Schema.Struct({ view: Schema.optional(Schema.Literal("changes")) })

export const placeKey = (place: AgentPlace) =>
  Predicate.isTagged(place, "sandbox") ? `sandbox:${place.providerId}` : place._tag

export const placeOfKey = (key: string): AgentPlace =>
  key.startsWith("sandbox:")
    ? SandboxPlace.make({ providerId: key.slice("sandbox:".length) })
    : thisMac

export const placeNames: Record<PlaceTag, string> = { "this-mac": "Local", sandbox: "Sandbox" }

export const placeIcons: Record<PlaceTag, LucideIcon> = { "this-mac": Laptop, sandbox: Cloud }

export const TRANSCRIPT_IDLE_TTL = "5 minutes"

const FRAME = "16 millis"

export const agentsAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchAgents())))
  .pipe(Atom.keepAlive)

export const waitingAgentsAtom = backendRuntime
  .atom(
    Stream.unwrap(Backend.useSync((backend) => backend.WatchWaitingAgents())).pipe(
      Stream.map((ids): ReadonlySet<string> => new Set(ids)),
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

export const transcriptAtom = Atom.family((agentId: string) =>
  backendRuntime
    .atom(
      transcriptOf(
        Stream.unwrap(Backend.useSync((backend) => backend.WatchTranscript({ agentId }))),
      ),
    )
    .pipe(Atom.setIdleTTL(TRANSCRIPT_IDLE_TTL)),
)

export const agentChangesAtom = Atom.family((agentId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetAgentChanges({ agentId }))),
)

export const localCheckoutsAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListLocalCheckouts()))
  .pipe(Atom.keepAlive)

class PlaceRepository extends Data.Class<{
  readonly placeKey: string
  readonly repository: FollowedRepository
}> {}

/** A Sandbox's branches come from GitHub, so they're kept; a Local checkout's are reread. */
const keptInSandbox = <A>(at: PlaceRepository, atom: Atom.Atom<A>) =>
  Predicate.isTagged(placeOfKey(at.placeKey), "sandbox") ? atom.pipe(Atom.keepAlive) : atom

const newAgentDefaultBranchFamily = Atom.family((at: PlaceRepository) =>
  keptInSandbox(
    at,
    backendRuntime.atom(
      Backend.use((backend) =>
        backend.GetNewAgentDefaultBranch({
          place: placeOfKey(at.placeKey),
          repository: at.repository,
        }),
      ),
    ),
  ),
)

const newAgentBranchesFamily = Atom.family((at: PlaceRepository) =>
  keptInSandbox(
    at,
    backendRuntime.atom(
      Backend.use((backend) =>
        backend.ListNewAgentBranches({ place: placeOfKey(at.placeKey), repository: at.repository }),
      ),
    ),
  ),
)

export const newAgentDefaultBranchAtom = (key: string, repository: FollowedRepository) =>
  newAgentDefaultBranchFamily(new PlaceRepository({ placeKey: key, repository }))

export const newAgentBranchesAtom = (key: string, repository: FollowedRepository) =>
  newAgentBranchesFamily(new PlaceRepository({ placeKey: key, repository }))

export const sandboxProvidersAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListSandboxProviders()))
  .pipe(Atom.keepAlive)

export const linkCheckoutAtom = backendRuntime.fn((path: string, get) =>
  Backend.use((backend) => backend.LinkLocalCheckout({ path })).pipe(
    Effect.tap(() => Effect.sync(() => get.refresh(localCheckoutsAtom))),
  ),
)

class ProgramPlace extends Data.Class<{
  readonly engine: AgentEngine
  readonly placeKey: string
}> {}

const programModelsAtom = Atom.family((program: ProgramPlace) =>
  backendRuntime
    .atom(
      Backend.use((backend) =>
        backend.ListAgentModels({ engine: program.engine, place: placeOfKey(program.placeKey) }),
      ),
    )
    .pipe(Atom.keepAlive),
)

export const agentModelsAtom = (engine: AgentEngine, key: string) =>
  programModelsAtom(new ProgramPlace({ engine, placeKey: key }))

class NewAgentOf extends Data.Class<{
  readonly engine: AgentEngine
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

const newAgentCommandsFamily = Atom.family((program: NewAgentOf) =>
  listedOr(
    backendRuntime
      .atom(
        Backend.use((backend) =>
          backend.ListNewAgentCommands({
            engine: program.engine,
            place: placeOfKey(program.place),
            repository: program.repository,
          }),
        ),
      )
      .pipe(Atom.setIdleTTL(COMPOSER_LISTING_IDLE_TTL)),
    noCommands,
  ),
)

export const newAgentCommandsAtom = (
  engine: AgentEngine,
  place: string,
  repository: FollowedRepository,
) => newAgentCommandsFamily(new NewAgentOf({ engine, place, repository }))

export const agentCommandsAtom = Atom.family((agentId: string) =>
  listedOr(
    backendRuntime
      .atom(Backend.use((backend) => backend.ListAgentCommands({ agentId })))
      .pipe(Atom.setIdleTTL(COMPOSER_LISTING_IDLE_TTL)),
    noCommands,
  ),
)

class NewAgentBranch extends Data.Class<{
  readonly place: string
  readonly repository: FollowedRepository
  readonly baseBranch: string
}> {}

const newAgentFilesFamily = Atom.family((branch: NewAgentBranch) =>
  listedOr(
    backendRuntime
      .atom(
        Backend.use((backend) =>
          backend.ListNewAgentFiles({
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

export const newAgentFilesAtom = (
  place: string,
  repository: FollowedRepository,
  baseBranch: string,
) => newAgentFilesFamily(new NewAgentBranch({ place, repository, baseBranch }))

export const agentFilesAtom = Atom.family((agentId: string) =>
  listedOr(
    backendRuntime
      .atom(Backend.use((backend) => backend.ListAgentFiles({ agentId })))
      .pipe(Atom.setIdleTTL(COMPOSER_LISTING_IDLE_TTL)),
    noFiles,
  ),
)

export const changeModelAtom = Atom.family((agentId: string) =>
  backendRuntime.fn((choice: ModelChoice) =>
    Backend.use((backend) => backend.ChangeAgentModel({ agentId, ...choice })),
  ),
)

export const permissionModeNames: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  auto: "Auto",
  bypassPermissions: "Bypass",
}

export const changePermissionModeAtom = Atom.family((agentId: string) =>
  backendRuntime.fn((permissionMode: PermissionMode) =>
    Backend.use((backend) => backend.ChangePermissionMode({ agentId, permissionMode })),
  ),
)

export class AgentRequest extends Data.Class<{
  readonly agentId: string
  readonly requestId: string
}> {}

export const answerRequestAtom = Atom.family((request: AgentRequest) =>
  backendRuntime.fn((answer: RequestAnswer) =>
    Backend.use((backend) =>
      backend.AnswerRequest({ agentId: request.agentId, requestId: request.requestId, answer }),
    ),
  ),
)

export const createAgentAtom = backendRuntime.fn((input: NewAgent) =>
  Backend.use((backend) => backend.CreateAgent(input)),
)

export const sendMessageAtom = Atom.family((agentId: string) =>
  backendRuntime.fn((sent: MessageInput) =>
    Backend.use((backend) => backend.SendMessage({ agentId, ...sent })),
  ),
)

export const steerAtom = Atom.family((agentId: string) =>
  backendRuntime.fn((sent: MessageInput) =>
    Backend.use((backend) => backend.Steer({ agentId, ...sent })),
  ),
)

export const stopTurnAtom = Atom.family((agentId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.StopTurn({ agentId }))),
)

export const reachSandboxAtom = Atom.family((agentId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.ReachSandbox({ agentId }))),
)

export const cancelQueuedAtom = Atom.family((agentId: string) =>
  backendRuntime.fn((queuedMessageId: string) =>
    Backend.use((backend) => backend.CancelQueuedMessage({ agentId, queuedMessageId })),
  ),
)

export const sendQueuedAtom = Atom.family((agentId: string) =>
  backendRuntime.fn((queuedMessageId: string) =>
    Backend.use((backend) => backend.SendQueuedMessage({ agentId, queuedMessageId })),
  ),
)

export const writtenAtom = Atom.family((_key: string) =>
  Atom.make<SentMessage | null>(null).pipe(Atom.keepAlive),
)

export const unsentMessageAtom = Atom.family((agentId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetUnsentMessage({ agentId }))),
)

export const saveUnsent = (
  registry: AtomRegistry.AtomRegistry,
  agentId: string,
  composed: SentMessage,
) =>
  void backendRuntimeOf(registry).runPromiseExit(
    Backend.use((backend) => backend.SaveUnsentMessage({ agentId, ...composed })),
  )

export const removalWarningsAtom = Atom.family((agentId: string) =>
  backendRuntime.fn(() => Backend.use((backend) => backend.GetRemovalWarnings({ agentId }))),
)

export const removeAgent = async (registry: AtomRegistry.AtomRegistry, agent: Agent) => {
  const exit = await backendRuntimeOf(registry).runPromiseExit(
    Backend.use((backend) => backend.RemoveAgent({ agentId: agent.id })),
  )

  if (Exit.isFailure(exit))
    toast.add({
      type: "error",
      title: `Couldn't remove ${agent.name}`,
      description: problemOf(exit.cause).detail,
    })
}

const groupOrder: ReadonlyArray<PlaceTag> = ["this-mac", "sandbox"]

export const groupAgents = (agents: ReadonlyArray<Agent>) =>
  groupOrder.flatMap((machine) => {
    const onMachine = agents.filter((agent) => Predicate.isTagged(agent.place, machine))

    if (onMachine.length === 0) return []

    const byRepository = Map.groupBy(onMachine, (agent) => repositoryKey(agent.repository))

    return [{ machine, agents: [...byRepository.values()].flat() }]
  })
