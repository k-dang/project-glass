import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { GlassRpcs, RPC_PATH, TOKEN_PARAM } from "@glass/contracts"
import { Effect, type FileSystem, Layer } from "effect"
import { HttpRouter, HttpServerResponse, UrlParams } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { createServer } from "node:http"
import { RendererAccess } from "./access"
import { ActivityLog } from "./ActivityLog"
import { AgentReviews } from "./AgentReviews"
import { Asks } from "./Asks"
import { CheckoutRuns } from "./CheckoutRuns"
import { Checkouts } from "./Checkouts"
import { CompleteToDosOnMerge } from "./CompleteToDosOnMerge"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { ThreadFileRoutes } from "./threadFilesHttp"
import { Threads } from "./Threads"
import { ThreadTurns } from "./ThreadTurns"
import { FeedbackNotes } from "./FeedbackNotes"
import { DatabaseLive } from "./Database"
import { Changes } from "./Changes"
import { CheckIns } from "./CheckIns"
import { Git } from "./git"
import { GitHubAuth } from "./github/GitHubAuth"
import { GitHubClient } from "./github/GitHubClient"
import { GlassRpcHandlers } from "./handlers"
import { GlobalChat } from "./GlobalChat"
import { LocalAgentHost } from "./LocalAgentHost"
import { LocalCheckouts } from "./LocalCheckouts"
import { Plugins } from "./Plugins"
import { Sandboxes } from "./Sandboxes"
import { ServerConfig } from "./ServerConfig"
import { LocalPlacement } from "./LocalPlacement"
import { GlassToolRelay } from "./mcp/GlassToolRelay"
import { McpCredentials } from "./mcp/McpCredentials"
import { McpOAuth } from "./mcp/McpOAuth"
import { OAuthRoutes } from "./mcp/oauthHttp"
import { GlassMcpTools, McpRoutes } from "./mcp/server"
import { OutsideAgents } from "./OutsideAgents"
import { NeedsYou } from "./NeedsYou"
import { OutsideQuestions } from "./OutsideQuestions"
import { FollowedRepositories } from "./FollowedRepositories"
import { PullRequestLists } from "./PullRequestLists"
import { PullRequestMirror } from "./PullRequestMirror"
import { PullRequestWorkspaces } from "./PullRequestWorkspaces"
import { Queue } from "./Queue"
import { AgentCommands, SettingsStore } from "./SettingsStore"
import { SavedPlaces } from "./SavedPlaces"
import { SettledThreads } from "./SettledThreads"
import { LocalSkills } from "./LocalSkills"
import { SkillPacks } from "./SkillPacks"
import { StartedWork } from "./StartedWork"
import { Storage } from "./Storage"
import { ToDos } from "./ToDos"
import { AgentRunners } from "./agentRunners"
import { Tours } from "./Tours"
import { Transcripts } from "./Transcripts"
import { ThreadNames } from "./threadNames"
import { StartedWorkUpdates } from "./StartedWorkUpdates"

const RendererRoutes = Layer.mergeAll(
  RpcServer.layerHttp({ group: GlassRpcs, path: RPC_PATH, protocol: "websocket" }),
  HttpRouter.add("GET", "/health", HttpServerResponse.empty()),
  ThreadFileRoutes,
).pipe(Layer.provide(RendererAccess.layer))

// WARNING: server.close only drops the connections idle when it is called. One still answering stays open until its client lets go, so drop each as its response ends.
const closingAnsweredConnections = () => {
  const server = createServer()

  server.on("request", (request, response) =>
    response.once("close", () => {
      if (!server.listening) request.socket.destroy()
    }),
  )

  return server
}

const NodeServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig

    return NodeHttpServer.layer(closingAnsweredConnections, {
      port: config.port,
      host: "127.0.0.1",
    })
  }),
)

type AgentRunnersLayer = Layer.Layer<
  AgentRunners,
  never,
  SettingsStore | AgentCommands | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
>

const followReattachedHost = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Threads
    yield* GlobalChat
    yield* (yield* LocalAgentHost).followReattached
  }),
)

const ThreadsLive = followReattachedHost.pipe(
  Layer.provideMerge(Layer.merge(Threads.layer, GlobalChat.layer)),
  Layer.provide(LocalPlacement.layer),
  Layer.provideMerge(Sandboxes.layer),
  Layer.provide(ThreadTurns.layer),
  Layer.provide(FeedbackNotes.layer),
  Layer.provide(LocalAgentHost.layer),
  Layer.provideMerge(Transcripts.layer),
  Layer.provide(ToDos.layer),
  Layer.provideMerge(LocalCheckouts.layer),
)

type McpToolsLayer = Layer.Layer<never, never, Layer.Services<typeof GlassMcpTools>>

type AgentCommandsLayer = Layer.Layer<AgentCommands, never, SettingsStore>

const services = (
  agentRunners: AgentRunnersLayer,
  mcpTools: McpToolsLayer,
  agentCommands: AgentCommandsLayer,
) =>
  Layer.mergeAll(GlassRpcHandlers, mcpTools, StartedWorkUpdates, CompleteToDosOnMerge)
    .pipe(
      Layer.provide(NeedsYou.layer),
      Layer.provide(SettledThreads.layer.pipe(Layer.provideMerge(ThreadPullRequests.layer))),
      Layer.provide(StartedWork.layer),
      Layer.provide(PullRequestLists.layer),
      Layer.provide(PullRequestMirror.layer),
      Layer.provide(ToDos.layer),
      Layer.provide(SavedPlaces.layer),
      Layer.provide(Queue.layer),
      Layer.provide(PullRequestWorkspaces.layer),
      Layer.provide(Tours.layer),
      Layer.provide(AgentReviews.layer),
      Layer.provide(Asks.layer),
      Layer.provideMerge(ThreadsLive),
      Layer.provideMerge(SkillPacks.layer),
      Layer.provideMerge(LocalSkills.layer),
      Layer.provide(Plugins.layer),
      Layer.provide(CheckoutRuns.layer),
      Layer.provide(Checkouts.layer),
      Layer.provideMerge(
        CheckIns.layer.pipe(Layer.provide(Changes.layer), Layer.provide(FeedbackNotes.layer)),
      ),
      Layer.provide(Git.layer),
    )
    .pipe(
      Layer.provide(agentRunners),
      Layer.provide(agentCommands),
      Layer.provide(Layer.merge(ActivityLog.layer, Storage.layer)),
      Layer.provideMerge(OutsideAgents.layer),
      Layer.provideMerge(McpOAuth.layer),
      Layer.provide(GlassToolRelay.layer),
      Layer.provide(DatabaseLive),
      Layer.provide(FollowedRepositories.layer),
      Layer.provide(SettingsStore.layer),
      Layer.provide(GitHubClient.layer),
      Layer.provide(GitHubAuth.layer),
      Layer.provideMerge(McpCredentials.layer),
      Layer.provideMerge(OutsideQuestions.layer),
    )

const releaseAskers = Layer.effectDiscard(
  Effect.gen(function* () {
    const questions = yield* OutsideQuestions
    const checkIns = yield* CheckIns

    // WARNING: Acquired after the listener so this runs before server.close waits on open responses.
    yield* Effect.addFinalizer(() =>
      Effect.all([questions.cancelAll(), checkIns.cancelAll()], { concurrency: "unbounded" }),
    )
  }),
)

export const serve = (
  agentRunners: AgentRunnersLayer,
  mcpTools: McpToolsLayer,
  agentCommands: AgentCommandsLayer = AgentCommands.layer,
) =>
  releaseAskers.pipe(
    Layer.provideMerge(
      HttpRouter.serve(Layer.mergeAll(RendererRoutes, McpRoutes, OAuthRoutes), {
        disableLogger: true,
      }).pipe(
        // WARNING: Provided first so it listens last: Effect's Node server leaves connections hanging until it serves.
        Layer.provideMerge(NodeServerLive),
        Layer.provideMerge(services(agentRunners, mcpTools, agentCommands)),
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(UrlParams.CurrentRedactedNames)([TOKEN_PARAM])),
      ),
    ),
  )

export const ServerLive = serve(AgentRunners.layer, GlassMcpTools).pipe(
  Layer.provide(ThreadNames.layer),
)
