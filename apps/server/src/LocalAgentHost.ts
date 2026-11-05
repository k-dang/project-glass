import { AgentError } from "@glass/contracts"
import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  PubSub,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import { RPC_PATH } from "@glass/contracts"
import { AgentHostRpcs, HOST_TOKEN_HEADER, HostReady, newHostToken } from "./agentHost/protocol"
import { followJournal } from "./hostJournal"
import type { HostClient } from "./Placement"
import { launchCommand } from "./processes"
import { connectRpcClient } from "./rpcSocket"
import { ServerConfig } from "./ServerConfig"
import { Transcripts } from "./Transcripts"

const FORCE_KILL_AFTER = "2 seconds"

const lostConnection = (error: RpcClientError.RpcClientError | AgentError) =>
  Predicate.isTagged(error, "RpcClientError")

const unavailable = () =>
  new AgentError({
    message:
      "Glass couldn't start the process that runs Agents. Try again; Glass's backend log has the details.",
  })

export class LocalAgentHost extends Context.Service<
  LocalAgentHost,
  {
    readonly client: Effect.Effect<HostClient, AgentError>
    readonly running: Effect.Effect<Option.Option<HostClient>>
    /** A scope that closes when `client`'s host stops, or none once it has. */
    readonly lifetimeOf: (client: HostClient) => Effect.Effect<Option.Option<Scope.Scope>>
    readonly subscribeStopped: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  }
>()("@glass/server/LocalAgentHost") {
  static readonly layer = Layer.effect(
    LocalAgentHost,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const transcripts = yield* Transcripts
      const webSocketConstructor = yield* Socket.WebSocketConstructor
      const backendScope = yield* Scope.Scope
      const lock = yield* Semaphore.make(1)
      const stopped = yield* PubSub.unbounded<void>()
      let current: { readonly client: HostClient; readonly scope: Scope.Closeable } | null = null

      const start = Effect.gen(function* () {
        const scope = yield* Scope.fork(backendScope)
        const token = newHostToken()

        return yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(
            launchCommand(config.agentHostBundle, [], {
              env: {
                GLASS_HOST_TOKEN: token,
                GLASS_PI_COMMAND: config.piCommand,
                GLASS_CLAUDE_COMMAND: config.claudeCommand,
              },
              extendEnv: true,
              stdout: "inherit",
              stderr: "inherit",
              additionalFds: { fd3: { type: "output" } },
              forceKillAfter: FORCE_KILL_AFTER,
              // Signal only the host, so it closes its programs itself: killing its process group
              // would end them under it, which it logs as crashes.
              detached: false,
            }),
          )

          const { port } = yield* child
            .getOutputFd(3)
            .pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.flatMap(Schema.decodeUnknownEffect(HostReady)),
            )

          const connectionScope = yield* Scope.fork(scope)

          const client = yield* connectRpcClient(
            AgentHostRpcs,
            `ws://127.0.0.1:${port}${RPC_PATH}`,
            { [HOST_TOKEN_HEADER]: token },
          ).pipe(
            Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
            Scope.provide(connectionScope),
          )

          yield* followJournal((agentId, events) => transcripts.save(agentId, events), client, {
            saved: 0,
          }).pipe(
            Effect.tapCause((cause) => Effect.logWarning("Lost the agent host's journal", cause)),
            Effect.retry({
              while: lostConnection,
              schedule: Schedule.spaced("1 second"),
            }),
            Effect.catch(() =>
              Scope.close(connectionScope, Exit.void).pipe(
                Effect.andThen(child.kill({ forceKillAfter: FORCE_KILL_AFTER })),
                Effect.ignore,
              ),
            ),
            Effect.forkIn(scope),
          )

          yield* child.exitCode.pipe(
            Effect.ignore,
            Effect.andThen(
              lock.withPermits(1)(
                Effect.suspend(() => {
                  if (current?.scope !== scope) return Effect.void
                  current = null

                  return Effect.logWarning("The agent host stopped").pipe(
                    Effect.andThen(PubSub.publish(stopped, undefined)),
                    Effect.andThen(Scope.close(scope, Exit.void)),
                  )
                }),
              ),
            ),
            Effect.forkIn(scope),
          )

          return { client, scope }
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
      })

      return LocalAgentHost.of({
        client: lock
          .withPermits(1)(
            Effect.gen(function* () {
              current ??= yield* start

              return current.client
            }),
          )
          .pipe(
            Effect.tapCause((cause) => Effect.logWarning("Couldn't start the agent host", cause)),
            Effect.mapError(unavailable),
          ),
        running: Effect.sync(() => Option.fromNullishOr(current?.client)),
        lifetimeOf: (client) =>
          Effect.sync(() =>
            current?.client === client ? Option.some(current.scope) : Option.none(),
          ),
        subscribeStopped: PubSub.subscribe(stopped).pipe(Effect.map(Stream.fromSubscription)),
      })
    }),
  )
}
