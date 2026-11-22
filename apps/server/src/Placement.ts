import {
  type Thread,
  type AgentCommand,
  type AgentHarness,
  ThreadError,
  AgentModels,
  type ConnectionError,
  FollowedRepository,
  InvalidLocalCheckout,
} from "@glass/contracts"
import { type Effect, type Option, Predicate, type Scope, type Stream } from "effect"
import type { RpcClient, RpcClientError } from "effect/rpc"
import type { AgentHostRpcs, HostThreadError } from "./agentHost/protocol"

export type HostClient = RpcClient.FromGroup<typeof AgentHostRpcs, RpcClientError.RpcClientError>

export const hostFailure = (
  error: RpcClientError.RpcClientError | HostThreadError | ThreadError,
) =>
  Predicate.isTagged(error, "RpcClientError")
    ? "Glass lost the process that runs Threads. Try again."
    : error.message

export type HostCallError = RpcClientError.RpcClientError | HostThreadError | ThreadError

export const asThreadError = (error: HostCallError) =>
  new ThreadError({ message: hostFailure(error) })

export type LostThreadIds = ReadonlyArray<string>

export type SubscribeLost = Effect.Effect<Stream.Stream<LostThreadIds>, never, Scope.Scope>

export interface PlacedThread {
  readonly thread: Thread
  readonly folder: string
  readonly forReview: boolean
}

interface Placed {
  readonly branch: string
  readonly folder: string
  readonly discard: Effect.Effect<void>
}

export interface ThreadHosting {
  readonly prepareHost: (placed: PlacedThread) => Effect.Effect<HostClient, ThreadError>
  readonly hostIfPrepared: (
    placed: PlacedThread,
  ) => Effect.Effect<Option.Option<HostClient>, ThreadError>
  readonly connectedHost: (placed: PlacedThread) => Effect.Effect<Option.Option<HostClient>>
  readonly baseRef: (placed: PlacedThread) => Effect.Effect<string, ThreadError>
  readonly remove: (placed: PlacedThread) => Effect.Effect<void, ThreadError>
}

export interface Placement extends ThreadHosting {
  readonly harnesses: ReadonlyArray<AgentHarness>
  readonly models: (harness: AgentHarness) => Effect.Effect<AgentModels, ThreadError>
  readonly commands: (
    harness: AgentHarness,
    repository: FollowedRepository,
  ) => Effect.Effect<ReadonlyArray<AgentCommand>, InvalidLocalCheckout | ThreadError>
  readonly defaultBranch: (
    repository: FollowedRepository,
  ) => Effect.Effect<string | null, InvalidLocalCheckout | ConnectionError | ThreadError>
  readonly branches: (
    repository: FollowedRepository,
  ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | ConnectionError | ThreadError>
  readonly files: (
    repository: FollowedRepository,
    baseBranch: string,
  ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | ThreadError>
  readonly place: (
    repository: FollowedRepository,
    baseBranch: string,
  ) => Effect.Effect<Placed, InvalidLocalCheckout | ThreadError>
  readonly takenBranches: (
    repository: FollowedRepository,
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>, ThreadError>
  readonly useBranch: (placed: PlacedThread, branch: string) => Effect.Effect<void, ThreadError>
}
