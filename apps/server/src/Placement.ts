import type {
  Agent,
  AgentEngine,
  AgentError,
  AgentModels,
  FollowedRepository,
  InvalidLocalCheckout,
} from "@glass/contracts"
import { type Effect, type Option, Predicate, type Scope, type Stream } from "effect"
import type { RpcClient, RpcClientError } from "effect/rpc"
import type { AgentHostRpcs, HostAgentError } from "./agentHost/protocol"

export type HostClient = RpcClient.FromGroup<typeof AgentHostRpcs, RpcClientError.RpcClientError>

export const hostFailure = (error: RpcClientError.RpcClientError | HostAgentError | AgentError) =>
  Predicate.isTagged(error, "RpcClientError")
    ? "Glass lost the process that runs Agents. Try again."
    : error.message

export type LostAgentIds = ReadonlyArray<string>

export type SubscribeLost = Effect.Effect<Stream.Stream<LostAgentIds>, never, Scope.Scope>

export interface PlacedAgent {
  readonly agent: Agent
  readonly folder: string
}

export interface Placed {
  readonly name: string
  readonly folder: string
  readonly discard: Effect.Effect<void>
}

export interface Placement {
  readonly models: (engine: AgentEngine) => Effect.Effect<AgentModels, AgentError>
  readonly place: (
    repository: FollowedRepository,
    baseBranch: string,
  ) => Effect.Effect<Placed, InvalidLocalCheckout | AgentError>
  readonly host: (placed: PlacedAgent) => Effect.Effect<HostClient, AgentError>
  readonly runningHost: (placed: PlacedAgent) => Effect.Effect<Option.Option<HostClient>>
  readonly hostOnceMade: (
    placed: PlacedAgent,
  ) => Effect.Effect<Option.Option<HostClient>, AgentError>
  readonly baseRef: (placed: PlacedAgent) => Effect.Effect<string, AgentError>
  readonly remove: (placed: PlacedAgent) => Effect.Effect<void, AgentError>
}
