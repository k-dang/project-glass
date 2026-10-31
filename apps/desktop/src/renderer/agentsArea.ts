import {
  type Agent,
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
  repositoryKey,
  thisMac,
} from "@glass/contracts"
import { Data, Effect, Exit, Predicate, Schema, Stream } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { Cloud, Laptop, type LucideIcon } from "lucide-react"
import { toast } from "@/components/ui/toast"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import { problemOf } from "./problems"

export type AgentTab = "chat" | "changes"

export const AgentSearch = Schema.Struct({ view: Schema.optional(Schema.Literal("changes")) })

export const placeKey = (place: AgentPlace) =>
  Predicate.isTagged(place, "sandbox") ? `sandbox:${place.providerId}` : place._tag

export const placeOfKey = (key: string): AgentPlace =>
  key.startsWith("sandbox:")
    ? SandboxPlace.make({ providerId: key.slice("sandbox:".length) })
    : thisMac

export const placeNames: Record<PlaceTag, string> = { "this-mac": "Local", sandbox: "Sandbox" }

export const placeIcons: Record<PlaceTag, LucideIcon> = { "this-mac": Laptop, sandbox: Cloud }

export const engineGlyphs: Record<AgentEngine, string> = { "claude-code": "✻", "pi-cli": "π" }

const TRANSCRIPT_IDLE_TTL = "5 minutes"

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

export const transcriptAtom = Atom.family((agentId: string) =>
  backendRuntime
    .atom(
      Stream.unwrap(Backend.useSync((backend) => backend.WatchTranscript({ agentId }))).pipe(
        Stream.groupedWithin(Number.POSITIVE_INFINITY, FRAME),
        Stream.mapAccum(
          (): Transcript => emptyTranscript,
          (transcript, updates) => {
            const next = updates.reduce(applyTranscriptUpdate, transcript)

            return [next, [next]] as const
          },
        ),
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

export const branchesAtom = Atom.family((repository: FollowedRepository) =>
  backendRuntime.atom(Backend.use((backend) => backend.ListBranches({ repository }))),
)

export const gitHubBranchesAtom = Atom.family((repository: FollowedRepository) =>
  backendRuntime
    .atom(Backend.use((backend) => backend.ListGitHubBranches({ repository })))
    .pipe(Atom.keepAlive),
)

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

/** One per request, so a failed answer shows only on its own card. */
export const answerRequestAtom = Atom.family((requestId: string) =>
  backendRuntime.fn((answered: { readonly agentId: string; readonly answer: RequestAnswer }) =>
    Backend.use((backend) => backend.AnswerRequest({ requestId, ...answered })),
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
