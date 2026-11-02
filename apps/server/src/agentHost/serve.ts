import { NodeHttpServer } from "@effect/platform-node"
import { Config, Context, Deferred, Effect, Layer, Option, Schema } from "effect"
import { HttpServer } from "effect/http"
import { closeSync, writeSync } from "node:fs"
import { createServer } from "node:http"
import type { AgentEngine } from "@glass/contracts"
import { Changes } from "./Changes"
import { HostAgents } from "./HostAgents"
import { Journal } from "./Journal"
import type { AgentAdapter } from "./adapter"
import { Git } from "../git"
import { HostReady } from "./protocol"
import { hostServer } from "./server"

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
      hostServer({ token, shutDown }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, {
            port: Option.getOrElse(port, () => 0),
            host: address,
          }),
        ),
        Layer.provide(HostAgents.make(adapters)),
        Layer.provide(Journal.layer),
        Layer.provide(Changes.layer),
        Layer.provide(Git.layer),
      ),
    )

    yield* Effect.race(
      Deferred.await(shutDown),
      standalone
        ? Effect.never
        : servingBackend(Context.get(services, HttpServer.HttpServer).address),
    )
  })
