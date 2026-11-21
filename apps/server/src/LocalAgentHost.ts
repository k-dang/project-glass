import { ThreadError, RPC_PATH } from "@glass/contracts"
import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
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
import type { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import { SqlClient } from "effect/sql"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"
import {
  HEALTH_PATH,
  HOST_TOKEN_HEADER,
  hostRecordPath,
  readHostRecord,
  RecordedHost,
  SHUTDOWN_PATH,
} from "./agentHost/hostAddress"
import { AgentHostRpcs, hostPort, type HostReplaced, newHostToken } from "./agentHost/protocol"
import { writeDataFile } from "./dataFiles"
import { followHost, greet } from "./hostJournal"
import { GlassToolRelay, ToolCallOrigin } from "./mcp/GlassToolRelay"
import type { ThreadHost } from "./ThreadTurns"
import type { HostClient } from "./Placement"
import { nodeEntry } from "./processes"
import { connectRpcClient } from "./rpcSocket"
import { ServerConfig } from "./ServerConfig"
import { AgentCommands } from "./SettingsStore"
import { Transcripts } from "./Transcripts"

const REATTACH_DEADLINE = "10 seconds"

const HEALTH_DEADLINE = "5 seconds"

class HostGone extends Data.TaggedError("HostGone") {}

class ReattachTimedOut extends Data.TaggedError("ReattachTimedOut") {}

const lostConnection = (
  error: RpcClientError.RpcClientError | ThreadError | HostReplaced | HostGone,
) => Predicate.isTagged(error, "RpcClientError")

const unavailable = () =>
  new ThreadError({
    message:
      "Glass couldn't start the process that runs Threads. Try again; Glass's backend log has the details.",
  })

const hostUrl = (port: number, path: string) => `http://127.0.0.1:${port}${path}`

const glassStartedNoOtherTurn = (running: string | null, hostTurn: string) =>
  running === null || running === hostTurn

const busyWithItsTurns = Effect.succeed(false)

const gone = (port: number) =>
  Effect.tryPromise((signal) => fetch(hostUrl(port, HEALTH_PATH), { signal })).pipe(
    Effect.map((response) => !response.ok),
    Effect.timeoutOrElse({ duration: HEALTH_DEADLINE, orElse: () => busyWithItsTurns }),
    Effect.orElseSucceed(() => true),
  )

export const shutDownHost = ({ port, token }: Pick<RecordedHost, "port" | "token">) =>
  Effect.tryPromise((signal) =>
    fetch(hostUrl(port, SHUTDOWN_PATH), {
      method: "POST",
      headers: { [HOST_TOKEN_HEADER]: token },
      signal,
    }),
  ).pipe(
    Effect.timeoutOrElse({ duration: HEALTH_DEADLINE, orElse: () => Effect.void }),
    Effect.ignore,
  )

export type CarriedOn = ReadonlySet<string>

export interface Resumed {
  readonly reattached: boolean
  readonly carriedOn: CarriedOn
}

const notResumed: Resumed = { reattached: false, carriedOn: new Set() }

interface Attached {
  readonly client: HostClient
  readonly scope: Scope.Closeable
}

export class LocalAgentHost extends Context.Service<
  LocalAgentHost,
  {
    readonly client: Effect.Effect<HostClient, ThreadError>
    readonly running: Effect.Effect<Option.Option<HostClient>>
    readonly resume: Effect.Effect<Resumed>
    readonly followReattached: Effect.Effect<void>
    readonly lifetimeOf: (client: ThreadHost) => Effect.Effect<Option.Option<Scope.Scope>>
    readonly subscribeStopped: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  }
>()("@glass/server/LocalAgentHost") {
  static readonly layer = Layer.effect(
    LocalAgentHost,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const commands = yield* AgentCommands
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const relay = yield* GlassToolRelay
      const webSocketConstructor = yield* Socket.WebSocketConstructor
      const backendScope = yield* Scope.Scope
      const lock = yield* Semaphore.make(1)
      const stopped = yield* PubSub.unbounded<void>()
      const recordPath = hostRecordPath(config.dataDirectory)
      let current: Attached | null = null
      let pendingFollow: Effect.Effect<void> | null = null

      // WARNING: Don't cache: in dev the bundle can be missing or rebuilt under a running backend, and the fingerprint must match the file the host spawns from.
      const fingerprint = fs
        .readFile(config.agentHostBundle)
        .pipe(
          Effect.map((bundle) =>
            createHash("sha256")
              .update(bundle)
              .update(`\0${commands.piCommand}\0${commands.claudeCommand}`)
              .digest("base64url"),
          ),
        )

      const readRecord = readHostRecord(fs, recordPath).pipe(Effect.option)

      const forget = fs.remove(recordPath, { force: true }).pipe(Effect.ignore)

      const record = (recorded: RecordedHost) =>
        writeDataFile(fs, recordPath, Schema.encodeSync(RecordedHost)(recorded))

      const stop = (scope: Scope.Closeable) =>
        lock.withPermits(1)(
          Effect.suspend(() => {
            if (current?.scope !== scope) return Effect.void
            current = null

            return Effect.logWarning("The agent host stopped").pipe(
              Effect.andThen(forget),
              Effect.andThen(PubSub.publish(stopped, undefined)),
              Effect.andThen(Scope.close(scope, Exit.void)),
            )
          }),
        )

      const attach = (recorded: RecordedHost) =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(backendScope)

          return yield* Effect.gen(function* () {
            const connectionScope = yield* Scope.fork(scope)

            const client = yield* connectRpcClient(
              AgentHostRpcs,
              `ws://127.0.0.1:${recorded.port}${RPC_PATH}`,
              { [HOST_TOKEN_HEADER]: recorded.token },
            ).pipe(
              Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
              Scope.provide(connectionScope),
            )

            const host = yield* greet(client)

            const savedRows = yield* sql<{ readonly id: string; readonly saved: number }>`
              SELECT id, journal_saved AS saved FROM thread WHERE journal_host = ${host}
            `.pipe(Effect.orDie)

            const fromOldestKept = { host, saved: 0 }
            const alreadySaved = new Map(savedRows.map(({ id, saved }) => [id, saved]))

            const offered = yield* Deferred.make<void>()

            const follow = followHost(client, fromOldestKept, {
              save: transcripts.save,
              alreadySaved: (threadId) => alreadySaved.get(threadId) ?? 0,
              relay,
              origin: ToolCallOrigin.ThisDevice(),
              calls: backendScope,
            }).pipe(
              Effect.tap(() => Deferred.succeed(offered, undefined)),
              Effect.flatten,
              Effect.catchIf(lostConnection, (error) =>
                gone(recorded.port).pipe(
                  Effect.flatMap((isGone) => Effect.fail(isGone ? new HostGone() : error)),
                ),
              ),
              Effect.tapCause((cause) => Effect.logWarning("Lost the agent host's journal", cause)),
              Effect.retry({ while: lostConnection, schedule: Schedule.spaced("1 second") }),
              // WARNING: A fresh launch waits on the offer while holding the lock that stop takes.
              Effect.ensuring(Deferred.succeed(offered, undefined)),
              Effect.catch(() =>
                Scope.close(connectionScope, Exit.void).pipe(
                  Effect.andThen(shutDownHost(recorded)),
                  Effect.andThen(stop(scope)),
                ),
              ),
              Scope.provide(scope),
              Effect.forkIn(scope),
              Effect.asVoid,
            )

            return {
              attached: { client, scope } satisfies Attached,
              follow,
              offered: Deferred.await(offered),
            }
          }).pipe(
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          )
        })

      const carriedOn = (client: HostClient) =>
        client.UnacknowledgedTurns().pipe(
          Effect.flatMap((unacknowledged) =>
            Effect.filter(unacknowledged, ({ threadId, turnId }) =>
              transcripts.runningTurn(threadId).pipe(
                Effect.map((running) => glassStartedNoOtherTurn(running, turnId)),
                Effect.orElseSucceed(() => false),
              ),
            ),
          ),
          Effect.map((kept): CarriedOn => new Set(kept.map(({ threadId }) => threadId))),
        )

      const reattach = Effect.gen(function* () {
        const found = yield* readRecord

        if (Option.isNone(found)) return Option.none()

        const recorded = found.value

        const giveUp = shutDownHost(recorded).pipe(
          Effect.andThen(forget),
          Effect.as(
            Option.none<{
              readonly attached: Attached
              readonly follow: Effect.Effect<void>
              readonly carriedOn: CarriedOn
            }>(),
          ),
        )

        if (recorded.fingerprint !== (yield* fingerprint))
          return yield* Effect.logWarning(
            "The agent host an earlier launch left running is from another build",
          ).pipe(Effect.andThen(giveUp))

        if (yield* gone(recorded.port))
          return yield* Effect.logWarning(
            "The agent host an earlier launch left running doesn't answer",
          ).pipe(Effect.andThen(giveUp))

        return yield* attach(recorded).pipe(
          Effect.flatMap(({ attached, follow }) =>
            carriedOn(attached.client).pipe(
              Effect.map((carried) => Option.some({ attached, follow, carriedOn: carried })),
            ),
          ),
          Effect.timeoutOrElse({
            duration: REATTACH_DEADLINE,
            orElse: () => Effect.fail(new ReattachTimedOut()),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Couldn't reattach to the agent host", cause).pipe(
              Effect.andThen(giveUp),
            ),
          ),
        )
      })

      const launch = Effect.gen(function* () {
        const token = newHostToken()
        const known = yield* fingerprint

        const started = Effect.acquireRelease(
          Effect.sync(() => {
            mkdirSync(dirname(config.logFile), { recursive: true })
            const log = openSync(config.logFile, "a")

            // WARNING: Raw spawn: ChildProcessSpawner can't give a child a file as stdout/stderr, and inheriting would hand the host Electron's pipe, which closes at quit.
            const entry = nodeEntry(config.agentHostBundle)

            const child = spawn(entry.command, entry.args, {
              env: {
                ...process.env,
                ...entry.env,
                GLASS_HOST_TOKEN: token,
                GLASS_HOST_RECORD: recordPath,
                GLASS_PI_COMMAND: commands.piCommand,
                GLASS_CLAUDE_COMMAND: commands.claudeCommand,
              },
              detached: true,
              windowsHide: true,
              stdio: ["ignore", log, log, "pipe"],
            })

            closeSync(log)
            child.unref()

            return child
          }),
          (child, exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => child.kill())),
        )

        const startRecordedHost = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const child = yield* started
            const port = yield* restore(Effect.tryPromise(() => hostPort(child)))
            const made = { port, token, fingerprint: known }

            yield* record(made)

            return made
          }),
        ).pipe(Effect.scoped)

        const { attached, follow, offered } = yield* attach(yield* startRecordedHost)
        yield* follow
        yield* offered

        return attached
      })

      const resume = yield* lock
        .withPermits(1)(
          Effect.gen(function* () {
            const reattached = yield* reattach

            if (Option.isNone(reattached)) return notResumed

            current = reattached.value.attached
            pendingFollow = reattached.value.follow

            return { reattached: true, carriedOn: reattached.value.carriedOn }
          }),
        )
        .pipe(
          Effect.tapCause((cause) => Effect.logWarning("Couldn't resume the agent host", cause)),
          Effect.orElseSucceed(() => notResumed),
          Effect.cached,
        )

      return LocalAgentHost.of({
        client: resume
          .pipe(
            Effect.andThen(
              lock.withPermits(1)(
                Effect.gen(function* () {
                  current ??= yield* launch

                  return current.client
                }),
              ),
            ),
          )
          .pipe(
            Effect.tapCause((cause) => Effect.logWarning("Couldn't start the agent host", cause)),
            Effect.mapError(unavailable),
          ),
        running: Effect.sync(() => Option.fromNullishOr(current?.client)),
        resume,
        followReattached: resume.pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const follow = pendingFollow
              pendingFollow = null

              return follow ?? Effect.void
            }),
          ),
        ),
        lifetimeOf: (client) =>
          Effect.sync(() =>
            current?.client === client ? Option.some(current.scope) : Option.none(),
          ),
        subscribeStopped: PubSub.subscribe(stopped).pipe(Effect.map(Stream.fromSubscription)),
      })
    }),
  )
}
