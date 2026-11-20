import type { AgentCommand, AgentModels, RequestAnswer, RequestNotWaiting } from "@glass/contracts"
import type { Effect, Scope } from "effect"
import type { DeliveredMessage, DeliveredTurn } from "./deliveredMessage"
import type {
  ConversationRole,
  GlassToolsAccess,
  HostConversationError,
  HostEvent,
  SteersNotTakenIn,
  TurnSettings,
} from "./protocol"
import type { WrittenSkills } from "./sentSkills"
import type { StopEnding } from "./turnLoop"

export interface HarnessSession {
  readonly configure: (settings: TurnSettings) => Effect.Effect<void, HostConversationError>
  readonly startTurn: (
    turnId: string,
    message: DeliveredTurn,
  ) => Effect.Effect<void, HostConversationError>
  readonly steer: (message: DeliveredMessage) => Effect.Effect<void, HostConversationError>
  readonly stopTurn: (turnId: string, ending: StopEnding) => Effect.Effect<SteersNotTakenIn | null>
  readonly answer: (
    requestId: string,
    answer: RequestAnswer,
  ) => Effect.Effect<void, RequestNotWaiting | HostConversationError>
  readonly closed: Effect.Effect<void>
  readonly stopped: Effect.Effect<boolean>
}

export interface HarnessAdapter<Role extends ConversationRole = ConversationRole> {
  readonly models: Effect.Effect<AgentModels, HostConversationError>
  readonly commands: (
    folder: string,
    skills: ReadonlyArray<WrittenSkills>,
  ) => Effect.Effect<ReadonlyArray<AgentCommand>, HostConversationError>
  readonly start: (options: {
    readonly folder: string
    readonly conversation: string
    readonly role: Role
    readonly glassTools: GlassToolsAccess | undefined
    readonly skills: ReadonlyArray<WrittenSkills>
    readonly report: (event: HostEvent) => Effect.Effect<void>
  }) => Effect.Effect<HarnessSession, HostConversationError, Scope.Scope>
}
