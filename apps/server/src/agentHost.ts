import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { closeSync, writeSync } from "node:fs"
import { createServer } from "node:http"
import { Changes } from "./agentHost/Changes"
import { HostAgents } from "./agentHost/HostAgents"
import { Journal } from "./agentHost/Journal"
import { claudeAdapter } from "./agentHost/claudeAdapter"
import { piAdapter } from "./agentHost/piAdapter"
import { RPC_PATH } from "@glass/contracts"
import { isToken } from "./access"
import { Git } from "./git"
import { AgentHostRpcs, HEALTH_PATH, HOST_TOKEN_HEADER, HostReady } from "./agentHost/protocol"

const Handlers = AgentHostRpcs.toLayer(
  Effect.gen(function* () {
    const agents = yield* HostAgents
    const journal = yield* Journal
    const changes = yield* Changes

    return AgentHostRpcs.of({
      ListModels: ({ engine }) => agents.models(engine),
      StartAgent: ({ agentId, engine, folder }) => agents.start(agentId, engine, folder),
      StartTurn: ({ agentId, turnId, message, images, ...settings }) =>
        agents.startTurn(agentId, turnId, { message, images }, settings),
      Steer: ({ agentId, message, images }) => agents.steer(agentId, { message, images }),
      StopTurn: ({ agentId }) => agents.stopTurn(agentId),
      AnswerRequest: ({ agentId, requestId, answer }) => agents.answer(agentId, requestId, answer),
      StopAgent: ({ agentId }) => agents.stop(agentId),
      GetChanges: ({ folder, baseRef }) => changes.since(folder, baseRef),
      HasUncommittedChanges: ({ folder }) => changes.uncommitted(folder),
      WatchJournal: ({ after }) => journal.watch(after),
      Acknowledge: ({ through }) => journal.acknowledge(through),
    })
  }),
)

const RequireToken = (token: Redacted.Redacted) =>
  HttpRouter.middleware(
    Effect.sync(() => {
      const matches = isToken(token)

      return (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://127.0.0.1")

          return url.pathname === HEALTH_PATH || matches(request.headers[HOST_TOKEN_HEADER])
            ? yield* httpEffect
            : HttpServerResponse.text("Unauthorized", { status: 401 })
        })
    }),
    { global: true },
  )

const backendExited = Effect.callback<void>((resume) => {
  process.stdin.once("close", () => resume(Effect.void))
  process.stdin.resume()
})

const servingBackend = (address: Parameters<typeof HttpServer.formatAddress>[0]) =>
  Effect.gen(function* () {
    const listening = new URL(HttpServer.formatAddress(address))

    writeSync(3, Schema.encodeSync(HostReady)({ port: Number(listening.port) }))
    closeSync(3)

    yield* backendExited
  })

const main = Effect.gen(function* () {
  const token = yield* Config.Redacted("GLASS_HOST_TOKEN")
  const port = yield* Config.Port("GLASS_HOST_PORT").pipe(Config.option)
  const standalone = Option.isSome(port)
  const address = yield* Config.String("GLASS_HOST_ADDRESS").pipe(Config.withDefault("127.0.0.1"))

  const piCommand = yield* Config.String("GLASS_PI_COMMAND").pipe(Config.withDefault("pi"))

  const claudeCommand = yield* Config.String("GLASS_CLAUDE_COMMAND").pipe(
    Config.withDefault("claude"),
  )

  const adapters = {
    "claude-code": claudeAdapter(claudeCommand),
    "pi-cli": yield* piAdapter(piCommand),
  }

  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        RpcServer.layerHttp({ group: AgentHostRpcs, path: RPC_PATH, protocol: "websocket" }),
        HttpRouter.add("GET", HEALTH_PATH, HttpServerResponse.text("ok")),
        RequireToken(token),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, {
          port: Option.getOrElse(port, () => 0),
          host: address,
        }),
      ),
      Layer.provide(Handlers),
      Layer.provide(HostAgents.make(adapters)),
      Layer.provide(Journal.layer),
      Layer.provide(Changes.layer),
      Layer.provide(Git.layer),
      Layer.provide(RpcSerialization.layerJson),
    ),
  )

  yield* standalone
    ? Effect.never
    : servingBackend(Context.get(services, HttpServer.HttpServer).address)
})

main.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
