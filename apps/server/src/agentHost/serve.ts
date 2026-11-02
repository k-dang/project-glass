import { NodeHttpServer } from "@effect/platform-node"
import { Config, Context, Deferred, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { closeSync, writeSync } from "node:fs"
import { createServer } from "node:http"
import { Changes } from "./Changes"
import { HostAgents } from "./HostAgents"
import { Journal } from "./Journal"
import type { AgentAdapter } from "./adapter"
import { AgentHostHandlers } from "./handlers"
import { type AgentEngine, RPC_PATH } from "@glass/contracts"
import { isToken } from "../access"
import { Git } from "../git"
import { AgentHostRpcs, HEALTH_PATH, HOST_TOKEN_HEADER, HostReady, SHUTDOWN_PATH } from "./protocol"

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

export const serveAgentHost = <E, R>(
  programs: Effect.Effect<Record<AgentEngine, AgentAdapter>, E, R>,
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GLASS_HOST_TOKEN")
    const port = yield* Config.Port("GLASS_HOST_PORT").pipe(Config.option)
    const standalone = Option.isSome(port)
    const address = yield* Config.String("GLASS_HOST_ADDRESS").pipe(Config.withDefault("127.0.0.1"))

    const adapters = yield* programs

    const shutDown = yield* Deferred.make<void>()

    const services = yield* Layer.build(
      HttpRouter.serve(
        Layer.mergeAll(
          RpcServer.layerHttp({ group: AgentHostRpcs, path: RPC_PATH, protocol: "websocket" }),
          HttpRouter.add("GET", HEALTH_PATH, HttpServerResponse.text("ok")),
          HttpRouter.add(
            "POST",
            SHUTDOWN_PATH,
            Deferred.succeed(shutDown, undefined).pipe(
              // This request is still open when the server starts closing, so Node won't close its
              // connection as idle.
              Effect.as(HttpServerResponse.empty({ headers: { connection: "close" } })),
            ),
          ),
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
        Layer.provide(AgentHostHandlers),
        Layer.provide(HostAgents.make(adapters)),
        Layer.provide(Journal.layer),
        Layer.provide(Changes.layer),
        Layer.provide(Git.layer),
        Layer.provide(RpcSerialization.layerJson),
      ),
    )

    yield* Effect.race(
      Deferred.await(shutDown),
      standalone
        ? Effect.never
        : servingBackend(Context.get(services, HttpServer.HttpServer).address),
    )
  })
