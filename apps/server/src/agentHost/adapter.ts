import type { AgentCommand, AgentModels, RequestAnswer, RequestNotWaiting } from "@glass/contracts"
import type { Effect, Scope } from "effect"
import type { DeliveredMessage, DeliveredTurn } from "./deliveredMessage"
import type {
  ThreadRole,
  RepositoryRoleKind,
  GlassToolsAccess,
  HostThreadError,
  HostEvent,
  SteersNotTakenIn,
  TurnSettings,
} from "./protocol"
import type { WrittenSkills } from "./sentSkills"
import type { StopEnding } from "./turnLoop"

export interface HarnessSession {
  readonly configure: (settings: TurnSettings) => Effect.Effect<void, HostThreadError>
  readonly startTurn: (
    turnId: string,
    message: DeliveredTurn,
  ) => Effect.Effect<void, HostThreadError>
  readonly steer: (message: DeliveredMessage) => Effect.Effect<void, HostThreadError>
  readonly stopTurn: (turnId: string, ending: StopEnding) => Effect.Effect<SteersNotTakenIn | null>
  readonly stopBackgroundTask: (taskId: string) => Effect.Effect<void, HostThreadError>
  readonly answer: (
    requestId: string,
    answer: RequestAnswer,
  ) => Effect.Effect<void, RequestNotWaiting | HostThreadError>
  readonly closed: Effect.Effect<void>
  readonly stopped: Effect.Effect<boolean>
}

export interface HarnessAdapter<Role extends ThreadRole = ThreadRole> {
  readonly models: Effect.Effect<AgentModels, HostThreadError>
  readonly commands: (
    folder: string,
    role: RepositoryRoleKind,
    skills: ReadonlyArray<WrittenSkills>,
  ) => Effect.Effect<ReadonlyArray<AgentCommand>, HostThreadError>
  readonly start: (options: {
    readonly folder: string
    readonly thread: string
    readonly role: Role
    readonly glassTools: GlassToolsAccess | undefined
    readonly skills: ReadonlyArray<WrittenSkills>
    readonly report: (event: HostEvent) => Effect.Effect<void>
  }) => Effect.Effect<HarnessSession, HostThreadError, Scope.Scope>
}
