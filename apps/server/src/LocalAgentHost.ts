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
import { RPC_PATH } from "@glass/contracts"
import { AgentHostRpcs, HOST_TOKEN_HEADER, HostReady, newHostToken } from "./agentHost/protocol"
import { followJournal } from "./hostJournal"
import type { HostClient } from "./Placement"
import { bundledEntry, launchCommand } from "./processes"
import { connectRpcClient } from "./rpcSocket"
import { ServerConfig } from "./ServerConfig"
import { Transcripts } from "./Transcripts"

const hostEntry = bundledEntry("agentHost", import.meta.url)

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
    readonly subscribeStopped: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  }
>()("@glass/server/LocalAgentHost") {
  static readonly layer = Layer.effect(
    LocalAgentHost,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const transcripts = yield* Transcripts
      const backendScope = yield* Scope.Scope
      const lock = yield* Semaphore.make(1)
      const stopped = yield* PubSub.unbounded<void>()
      let current: { readonly client: HostClient; readonly scope: Scope.Closeable } | null = null

      const start = Effect.gen(function* () {
        const scope = yield* Scope.fork(backendScope)
        const token = newHostToken()

        return yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(
            launchCommand(hostEntry, [], {
              env: {
                GLASS_HOST_TOKEN: token,
                GLASS_PI_COMMAND: config.piCommand,
                GLASS_CLAUDE_COMMAND: config.claudeCommand,
              },
              extendEnv: true,
              stdout: "inherit",
              stderr: "inherit",
              additionalFds: { fd3: { type: "output" } },
              forceKillAfter: "2 seconds",
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

          const client = yield* connectRpcClient(
            AgentHostRpcs,
            `ws://127.0.0.1:${port}${RPC_PATH}`,
            { [HOST_TOKEN_HEADER]: token },
          )

          yield* followJournal(transcripts, client, { saved: 0 }).pipe(
            Effect.tapCause((cause) => Effect.logWarning("Lost the agent host's journal", cause)),
            Effect.retry({
              while: lostConnection,
              schedule: Schedule.spaced("1 second"),
            }),
            Effect.catch(() => child.kill().pipe(Effect.ignore)),
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
        subscribeStopped: PubSub.subscribe(stopped).pipe(Effect.map(Stream.fromSubscription)),
      })
    }),
  )
}
