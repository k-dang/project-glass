import {
  type Conversation,
  type AgentCommand,
  type AgentHarness,
  ConversationError,
  AgentModels,
  type ConnectionError,
  FollowedRepository,
  InvalidLocalCheckout,
} from "@glass/contracts"
import { type Effect, type Option, Predicate, type Scope, type Stream } from "effect"
import type { RpcClient, RpcClientError } from "effect/rpc"
import type { AgentHostRpcs, HostConversationError } from "./agentHost/protocol"

export type HostClient = RpcClient.FromGroup<typeof AgentHostRpcs, RpcClientError.RpcClientError>

export const hostFailure = (
  error: RpcClientError.RpcClientError | HostConversationError | ConversationError,
) =>
  Predicate.isTagged(error, "RpcClientError")
    ? "Glass lost the process that runs Conversations. Try again."
    : error.message

export type HostCallError =
  | RpcClientError.RpcClientError
  | HostConversationError
  | ConversationError

export const asConversationError = (error: HostCallError) =>
  new ConversationError({ message: hostFailure(error) })

export type LostConversationIds = ReadonlyArray<string>

export type SubscribeLost = Effect.Effect<Stream.Stream<LostConversationIds>, never, Scope.Scope>

export interface PlacedConversation {
  readonly conversation: Conversation
  readonly folder: string
  readonly forReview: boolean
}

export interface Placed {
  readonly name: string
  readonly branch: string
  readonly folder: string
  readonly discard: Effect.Effect<void>
}

export interface Placement {
  readonly harnesses: ReadonlyArray<AgentHarness>
  readonly models: (harness: AgentHarness) => Effect.Effect<AgentModels, ConversationError>
  readonly commands: (
    harness: AgentHarness,
    repository: FollowedRepository,
  ) => Effect.Effect<ReadonlyArray<AgentCommand>, InvalidLocalCheckout | ConversationError>
  readonly defaultBranch: (
    repository: FollowedRepository,
  ) => Effect.Effect<string | null, InvalidLocalCheckout | ConnectionError | ConversationError>
  readonly branches: (
    repository: FollowedRepository,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    InvalidLocalCheckout | ConnectionError | ConversationError
  >
  readonly files: (
    repository: FollowedRepository,
    baseBranch: string,
  ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | ConversationError>
  readonly place: (
    repository: FollowedRepository,
    baseBranch: string,
  ) => Effect.Effect<Placed, InvalidLocalCheckout | ConversationError>
  readonly host: (placed: PlacedConversation) => Effect.Effect<HostClient, ConversationError>
  readonly runningHost: (placed: PlacedConversation) => Effect.Effect<Option.Option<HostClient>>
  readonly hostOnceMade: (
    placed: PlacedConversation,
  ) => Effect.Effect<Option.Option<HostClient>, ConversationError>
  readonly baseRef: (placed: PlacedConversation) => Effect.Effect<string, ConversationError>
  readonly remove: (placed: PlacedConversation) => Effect.Effect<void, ConversationError>
}
