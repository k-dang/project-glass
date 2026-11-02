import { Deferred, Effect, Layer, type Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { RPC_PATH } from "@glass/contracts"
import { isToken } from "../access"
import { AgentHostHandlers } from "./handlers"
import { AgentHostRpcs, HEALTH_PATH, HOST_TOKEN_HEADER, SHUTDOWN_PATH } from "./protocol"

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

/** The agent host's routes on an HTTP server: its RPCs over WebSocket, health check, and shutdown. */
export const hostServer = (options: {
  readonly token: Redacted.Redacted
  readonly shutDown: Deferred.Deferred<void>
}) =>
  HttpRouter.serve(
    Layer.mergeAll(
      RpcServer.layerHttp({ group: AgentHostRpcs, path: RPC_PATH, protocol: "websocket" }),
      HttpRouter.add("GET", HEALTH_PATH, HttpServerResponse.text("ok")),
      HttpRouter.add(
        "POST",
        SHUTDOWN_PATH,
        Deferred.succeed(options.shutDown, undefined).pipe(
          // This request is still open when the server starts closing, so Node won't close its
          // connection as idle.
          Effect.as(HttpServerResponse.empty({ headers: { connection: "close" } })),
        ),
      ),
      RequireToken(options.token),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provide(AgentHostHandlers), Layer.provide(RpcSerialization.layerJson))
