import type {
  AgentCommand,
  AgentEvent,
  AgentModels,
  RequestAnswer,
  RequestNotWaiting,
} from "@glass/contracts"
import type { Effect, Scope } from "effect"
import type { DeliveredMessage } from "./deliveredMessage"
import type { ConversationRole, HostAgentError, SteersNotTakenIn, TurnSettings } from "./protocol"

export interface AgentSession {
  readonly configure: (settings: TurnSettings) => Effect.Effect<void, HostAgentError>
  readonly startTurn: (
    turnId: string,
    message: DeliveredMessage,
  ) => Effect.Effect<void, HostAgentError>
  readonly steer: (message: DeliveredMessage) => Effect.Effect<void, HostAgentError>
  readonly stopTurn: Effect.Effect<SteersNotTakenIn | null>
  readonly answer: (
    requestId: string,
    answer: RequestAnswer,
  ) => Effect.Effect<void, RequestNotWaiting | HostAgentError>
  readonly closed: Effect.Effect<void>
  readonly stopped: Effect.Effect<boolean>
}

export interface AgentAdapter {
  readonly models: Effect.Effect<AgentModels, HostAgentError>
  readonly commands: (folder: string) => Effect.Effect<ReadonlyArray<AgentCommand>, HostAgentError>
  readonly start: (options: {
    readonly folder: string
    readonly conversation: string
    readonly role: ConversationRole
    readonly report: (event: AgentEvent) => Effect.Effect<void>
  }) => Effect.Effect<AgentSession, HostAgentError, Scope.Scope>
}
