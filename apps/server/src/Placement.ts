import {
  type Agent,
  type AgentCommand,
  type AgentEngine,
  AgentError,
  AgentModels,
  type ConnectionError,
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

export type HostCallError = RpcClientError.RpcClientError | HostAgentError | AgentError

export const asAgentError = (error: HostCallError) =>
  new AgentError({ message: hostFailure(error) })

export type LostAgentIds = ReadonlyArray<string>

export type SubscribeLost = Effect.Effect<Stream.Stream<LostAgentIds>, never, Scope.Scope>

export interface PlacedAgent {
  readonly agent: Agent
  readonly folder: string
  readonly forReview: boolean
}

export interface Placed {
  readonly name: string
  readonly folder: string
  readonly discard: Effect.Effect<void>
}

export interface Placement {
  readonly engines: ReadonlyArray<AgentEngine>
  readonly models: (engine: AgentEngine) => Effect.Effect<AgentModels, AgentError>
  readonly commands: (
    engine: AgentEngine,
    repository: FollowedRepository,
  ) => Effect.Effect<ReadonlyArray<AgentCommand>, InvalidLocalCheckout | AgentError>
  readonly defaultBranch: (
    repository: FollowedRepository,
  ) => Effect.Effect<string | null, InvalidLocalCheckout | ConnectionError | AgentError>
  readonly branches: (
    repository: FollowedRepository,
  ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | ConnectionError | AgentError>
  readonly files: (
    repository: FollowedRepository,
    baseBranch: string,
  ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | AgentError>
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
