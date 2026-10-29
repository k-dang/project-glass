import type {
  AgentEvent,
  AgentModels,
  RequestAnswer,
  RequestNotWaiting,
  SentMessage,
} from "@glass/contracts"
import type { Effect, Scope } from "effect"
import type { HostAgentError, TurnSettings } from "./protocol"

export interface AgentSession {
  /**
   * Sets what later Turns run with: ids and efforts the adapter's `models` offered, and a mode from
   * `engineCapabilities`. The program refuses anything else. A fresh session runs its defaults.
   */
  readonly configure: (settings: TurnSettings) => Effect.Effect<void, HostAgentError>
  readonly startTurn: (turnId: string, message: SentMessage) => Effect.Effect<void, HostAgentError>
  /** Fails when no Turn runs. The Turn shows the Steer once the program takes it in. */
  readonly steer: (message: SentMessage) => Effect.Effect<void, HostAgentError>
  /** Answers with the Steers not taken in, which the program drops, or `null` when no Turn ran. */
  readonly stopTurn: Effect.Effect<ReadonlyArray<SentMessage> | null>
  /** Fails when the request no longer waits, or the answer doesn't fit it. */
  readonly answer: (
    requestId: string,
    answer: RequestAnswer,
  ) => Effect.Effect<void, RequestNotWaiting | HostAgentError>
  readonly closed: Effect.Effect<void>
  readonly stopped: Effect.Effect<boolean>
}

export interface AgentAdapter {
  readonly models: Effect.Effect<AgentModels, HostAgentError>
  /**
   * Starts the program in `folder` on the conversation named `conversation`, a UUID, continuing it
   * when the program has already saved it and starting it otherwise.
   */
  readonly start: (options: {
    readonly folder: string
    readonly conversation: string
    readonly report: (event: AgentEvent) => Effect.Effect<void>
  }) => Effect.Effect<AgentSession, HostAgentError, Scope.Scope>
}
