import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Context, Deferred, Effect, Layer, Option, Schema } from "effect"
import { HttpServer } from "effect/http"
import { closeSync, writeSync } from "node:fs"
import { createServer } from "node:http"
import { Changes } from "./agentHost/Changes"
import { HostAgents } from "./agentHost/HostAgents"
import { Journal } from "./agentHost/Journal"
import { claudeAdapter } from "./agentHost/claudeAdapter"
import { piAdapter } from "./agentHost/piAdapter"
import { HostReady } from "./agentHost/protocol"
import { hostServer } from "./agentHost/server"
import { Git } from "./git"

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
    pi: yield* piAdapter(piCommand),
  }

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

main.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
