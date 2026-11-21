import { NodeHttpServer } from "@effect/platform-node"
import {
  Config,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { HttpServer } from "effect/http"
import { closeSync, writeSync } from "node:fs"
import { createServer } from "node:http"
import { Changes } from "../Changes"
import { FolderFiles } from "./FolderFiles"
import { forgottenByGlass } from "./forgotten"
import { HostConversations, type Harnesses } from "./HostConversations"
import { HostGlassTools } from "./HostGlassTools"
import { Journal } from "./Journal"
import { Git } from "../git"
import { HostReady } from "./protocol"
import { hostServer, portOf } from "./server"

const unattended = (journal: Journal["Service"], conversations: HostConversations["Service"]) => {
  const readAttendanceAndTurnsAtOnce = Effect.sync(
    () =>
      [
        SubscriptionRef.getUnsafe(journal.attendance),
        SubscriptionRef.getUnsafe(conversations.runningTurns),
      ] as const,
  )

  return Stream.merge(
    SubscriptionRef.changes(journal.attendance),
    SubscriptionRef.changes(conversations.runningTurns),
  ).pipe(
    Stream.mapEffect(() => readAttendanceAndTurnsAtOnce),
    Stream.dropWhile(([{ followers }]) => followers === 0),
    Stream.filter(
      ([{ followers, unacknowledged }, turns]) =>
        followers === 0 && turns.size === 0 && unacknowledged === 0,
    ),
    Stream.runHead,
  )
}

const reportReady = (address: HttpServer.HttpServer["Service"]["address"]) =>
  Effect.sync(() => {
    writeSync(3, Schema.encodeSync(HostReady)({ port: portOf(address) }))
    closeSync(3)
  })

export const serveAgentHost = <E, R>(harnesses: Effect.Effect<Harnesses, E, R>) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GLASS_HOST_TOKEN")

    const port = yield* Config.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
      "GLASS_HOST_PORT",
    ).pipe(Config.option)

    const standalone = Option.isSome(port)
    const address = yield* Config.String("GLASS_HOST_ADDRESS").pipe(Config.withDefault("127.0.0.1"))
    const record = yield* Config.String("GLASS_HOST_RECORD").pipe(Config.option)

    const adapters = yield* harnesses

    const shutDown = yield* Deferred.make<void>()

    const services = yield* Layer.build(
      hostServer({ token, shutDown }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, {
            port: Option.getOrElse(port, () => 0),
            host: address,
          }),
        ),
        Layer.provideMerge(HostConversations.make(adapters)),
        Layer.provideMerge(HostGlassTools.layer),
        Layer.provideMerge(Journal.layer),
        Layer.provide(Changes.layer),
        Layer.provide(FolderFiles.layer),
        Layer.provide(Git.layer),
      ),
    )

    if (!standalone || port.value === 0)
      yield* reportReady(Context.get(services, HttpServer.HttpServer).address)

    const journal = Context.get(services, Journal)

    yield* Effect.raceAll([
      Deferred.await(shutDown),
      standalone ? Effect.never : unattended(journal, Context.get(services, HostConversations)),
      Option.match(record, {
        onNone: () => Effect.never,
        onSome: (path) => forgottenByGlass(path, token, journal.attendance),
      }),
    ])
  })
