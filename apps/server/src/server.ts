import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { GlassRpcs, RPC_PATH } from "@glass/contracts"
import { Effect, type FileSystem, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { AccessControl } from "./access"
import { ActivityLog } from "./ActivityLog"
import { AgentReviews } from "./AgentReviews"
import { Asks } from "./Asks"
import { CheckoutRuns } from "./CheckoutRuns"
import { Checkouts } from "./Checkouts"
import { Agents } from "./Agents"
import { DatabaseLive } from "./Database"
import { Git } from "./git"
import { GitHubAuth } from "./github/GitHubAuth"
import { GitHubClient } from "./github/GitHubClient"
import { GlassRpcHandlers } from "./handlers"
import { LocalAgentHost } from "./LocalAgentHost"
import { LocalCheckouts } from "./LocalCheckouts"
import { Plugins } from "./Plugins"
import { Sandboxes } from "./Sandboxes"
import { ServerConfig } from "./ServerConfig"
import { LocalPlacement } from "./LocalPlacement"
import { FollowedRepositories } from "./FollowedRepositories"
import { PullRequestLists } from "./PullRequestLists"
import { PullRequestMirror } from "./PullRequestMirror"
import { Queue } from "./Queue"
import { SettingsStore } from "./SettingsStore"
import { SavedPlaces } from "./SavedPlaces"
import { ToDos } from "./ToDos"
import { AgentRunners } from "./agentRunners"
import { Tours } from "./Tours"
import { Transcripts } from "./Transcripts"

const Routes = Layer.mergeAll(
  RpcServer.layerHttp({ group: GlassRpcs, path: RPC_PATH, protocol: "websocket" }),
  HttpRouter.add("GET", "/health", HttpServerResponse.empty()),
  AccessControl,
)

const NodeServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig

    return NodeHttpServer.layer(createServer, { port: config.port, host: "127.0.0.1" })
  }),
)

type AgentRunnersLayer = Layer.Layer<
  AgentRunners,
  never,
  ServerConfig | SettingsStore | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
>

const AgentsLive = Agents.layer.pipe(
  Layer.provide(LocalPlacement.layer),
  Layer.provideMerge(Sandboxes.layer),
  Layer.provide(LocalAgentHost.layer),
  Layer.provide(Transcripts.layer),
  Layer.provideMerge(LocalCheckouts.layer),
)

const services = (agentRunners: AgentRunnersLayer) =>
  GlassRpcHandlers.pipe(
    Layer.provide(PullRequestLists.layer),
    Layer.provide(PullRequestMirror.layer),
    Layer.provide(ToDos.layer),
    Layer.provide(SavedPlaces.layer),
    Layer.provide(Queue.layer),
    Layer.provide(AgentsLive),
    Layer.provide(Plugins.layer),
    Layer.provide(Tours.layer),
    Layer.provide(AgentReviews.layer),
    Layer.provide(Asks.layer),
    Layer.provide(CheckoutRuns.layer),
    Layer.provide(Checkouts.layer),
    Layer.provide(Git.layer),
    Layer.provide(agentRunners),
    Layer.provide(ActivityLog.layer),
    Layer.provide(DatabaseLive),
    Layer.provide(FollowedRepositories.layer),
    Layer.provide(SettingsStore.layer),
    Layer.provide(GitHubClient.layer),
    Layer.provide(GitHubAuth.layer),
  )

export const serve = (agentRunners: AgentRunnersLayer) =>
  HttpRouter.serve(Routes, {
    disableLogger: true,
  }).pipe(
    // Provided first so it listens last: Effect's Node server leaves connections hanging until it serves.
    Layer.provideMerge(NodeServerLive),
    Layer.provide(services(agentRunners)),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(NodeServices.layer),
  )

export const ServerLive = serve(AgentRunners.layer)
