import {
  AgentHarness,
  ThreadError,
  AgentModels,
  GoneReach,
  goneExplanation,
  isOutOfReach,
  SandboxProviderInfo,
  type SandboxReach,
  SandboxStatus,
  TurnCutOff,
  TurnInterrupted,
} from "@glass/contracts"
import type { SandboxHost, SandboxProvider, SandboxRequest, SandboxState } from "@glass/plugin"
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  PubSub,
  Queue,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { Socket } from "effect/socket"
import { RpcClientError } from "effect/rpc"
import { newHostToken } from "./agentHost/protocol"
import { placeholderBranch } from "./BranchNames"
import { GitHubClient } from "./github/GitHubClient"
import { followHost, greet, type JournalPosition } from "./hostJournal"
import { GlassToolRelay, ToolCallOrigin } from "./mcp/GlassToolRelay"
import type { HostClient, LostThreadIds, PlacedThread, Placement, SubscribeLost } from "./Placement"
import { Plugins } from "./Plugins"
import {
  connectToHost,
  createSandbox,
  deleteSandbox,
  extendSandbox,
  listModels,
  hostDidntStart,
  replaceHost,
  startHost,
} from "./sandboxCalls"
import { missedConnection, type Recovery, recoveryReach } from "./reconnecting"
import { isSandboxGone, SandboxGone } from "./sandboxFailures"
import { ServerConfig } from "./ServerConfig"
import { Transcripts } from "./Transcripts"

const hostPort = 7310

const sandboxFields = { state: Schema.Json, token: Schema.String }

const leaseFields = { ...sandboxFields, expiresAt: Schema.optional(Schema.DateTimeUtcFromString) }

const Building = Schema.TaggedStruct("Building", sandboxFields)

const Ready = Schema.TaggedStruct("Ready", {
  ...leaseFields,
  replacingHost: Schema.optional(Schema.Boolean),
})

const Gone = Schema.TaggedStruct("Gone", { ...leaseFields, reason: GoneReach })

const SandboxRecord = Schema.Union([Building, Ready, Gone])

type SandboxRecord = typeof SandboxRecord.Type

const RecordJson = Schema.fromJsonString(SandboxRecord)

const encodeRecord = Schema.encodeSync(RecordJson)

const decodeStored = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      sandbox: RecordJson,
      journalHost: Schema.NullOr(Schema.String),
      journalSaved: Schema.Int,
      journalTurn: Schema.NullOr(Schema.String),
    }),
  ),
)

const decodeModels = Schema.decodeUnknownEffect(AgentModels)

const unreachable = () =>
  new ThreadError({ message: "Glass couldn't reach the Thread's Sandbox. Try again." })

const closedConnection = () =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketCloseError({
      code: 1001,
      closeReason: "Glass let go of this connection to the agent host",
    }),
  })

const goneFailure = (reach: GoneReach) => new ThreadError({ message: goneExplanation(reach) })

const storageFailure = () =>
  new ThreadError({ message: "Couldn't save the Thread's Sandbox. Try again." })

interface Following {
  readonly recovery: Recovery<HostClient>
  readonly opened: Deferred.Deferred<HostClient, ThreadError | SandboxGone>
  readonly fiber: Fiber.Fiber<void>
}

interface KnownSandbox {
  readonly record: SandboxRecord | null
  readonly following: Following | null
}

const unknown: KnownSandbox = { record: null, following: null }

const reachOf = ({ record, following }: KnownSandbox): SandboxReach =>
  Predicate.isTagged(record, "Gone")
    ? record.reason
    : following === null
      ? "connecting"
      : recoveryReach(following.recovery)

const clientOf = ({ record, following }: KnownSandbox) =>
  !Predicate.isTagged(record, "Gone") && following?.recovery.phase === "reachable"
    ? Option.some(following.recovery.client)
    : Option.none()

const expiresAtOf = (record: SandboxRecord | null) =>
  record === null || Predicate.isTagged(record, "Building") ? undefined : record.expiresAt

const statusOf = (found: KnownSandbox) =>
  new SandboxStatus({ expiresAt: expiresAtOf(found.record) ?? null, reach: reachOf(found) })

const expiredBy = (record: SandboxRecord, now: DateTime.Utc) => {
  const expiresAt = expiresAtOf(record)

  return expiresAt !== undefined && DateTime.isLessThanOrEqualTo(expiresAt, now)
}

const goneRecord = (record: typeof Building.Type | typeof Ready.Type, now: DateTime.Utc) =>
  Gone.make({
    state: record.state,
    token: record.token,
    expiresAt: expiresAtOf(record),
    reason: expiredBy(record, now) ? "expired" : "deleted",
  })

interface HostLink {
  position: JournalPosition | null
  turnOnLostHost: string | null
  takenTurn: string | null
  readonly connectLock: Semaphore.Semaphore
  readonly recordLock: Semaphore.Semaphore
}

const newLink = (
  position: JournalPosition | null,
  turnOnLostHost: string | null,
  takenTurn: string | null,
): HostLink => ({
  position,
  turnOnLostHost,
  takenTurn,
  connectLock: Semaphore.makeUnsafe(1),
  recordLock: Semaphore.makeUnsafe(1),
})

const EXTEND_RETRY_SPACING = "1 minute"

const orderedReports = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void, ThreadError>, Cause.Done>()

  const applying = yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach(Effect.ignore),
    Effect.forkChild,
  )

  return {
    offer: (report: Effect.Effect<void, ThreadError>) => void Queue.offerUnsafe(queue, report),
    caughtUp: Queue.end(queue).pipe(Effect.andThen(Fiber.join(applying))),
  }
})

const notInstalled = (providerId: string): Placement => {
  const failure = Effect.fail(
    new ThreadError({
      message: `The Sandbox provider "${providerId}" isn't installed. Add its Plugin to Glass's plugins folder.`,
    }),
  )

  return {
    harnesses: AgentHarness.literals,
    models: () => failure,
    commands: () => Effect.succeed([]),
    defaultBranch: () => failure,
    branches: () => failure,
    files: () => Effect.succeed([]),
    place: () => failure,
    takenBranches: () => failure,
    useBranch: () => failure,
    prepareHost: () => failure,
    hostIfPrepared: () => Effect.succeedNone,
    connectedHost: () => Effect.succeedNone,
    baseRef: () => failure,
    remove: ({ thread }) =>
      Effect.logWarning(
        "Removed a Thread whose Sandbox provider isn't installed, leaving its Sandbox",
        thread.id,
        providerId,
      ),
  }
}

export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    readonly providers: ReadonlyArray<SandboxProviderInfo>
    readonly placement: (providerId: string) => Placement
    readonly subscribeLost: SubscribeLost
    readonly statuses: Stream.Stream<ReadonlyMap<string, SandboxStatus>>
    readonly status: (threadId: string) => Effect.Effect<SandboxStatus | null>
    readonly refuseIfGone: (threadId: string) => Effect.Effect<void, ThreadError>
    readonly resume: Effect.Effect<ReadonlySet<string>>
  }
>()("@glass/server/Sandboxes") {
  static readonly layer = Layer.effect(
    Sandboxes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const relay = yield* GlassToolRelay
      const config = yield* ServerConfig
      const webSocketConstructor = yield* Socket.WebSocketConstructor
      const { sandboxProviders } = yield* Plugins
      const github = yield* GitHubClient
      const scope = yield* Scope.Scope
      const lost = yield* PubSub.unbounded<LostThreadIds>()

      const stored = yield* sql`
        SELECT id, sandbox_provider AS provider, sandbox, journal_host AS journalHost,
          journal_saved AS journalSaved, journal_turn AS journalTurn
        FROM thread WHERE sandbox IS NOT NULL
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const known = yield* SubscriptionRef.make<ReadonlyMap<string, KnownSandbox>>(
        new Map(stored.map(({ id, sandbox }) => [id, { record: sandbox, following: null }])),
      )

      const runningTurn = (threadId: string) =>
        transcripts.runningTurn(threadId).pipe(Effect.orElseSucceed(() => null))

      const links = new Map<string, HostLink>()

      for (const { id, journalHost, journalSaved, journalTurn } of stored)
        links.set(
          id,
          newLink(
            journalHost === null ? null : { host: journalHost, saved: journalSaved },
            yield* runningTurn(id),
            journalTurn,
          ),
        )

      const linkOf = (threadId: string) => {
        const found = links.get(threadId)

        if (found !== undefined) return found

        const link = newLink(null, null, null)
        links.set(threadId, link)

        return link
      }

      const knownOf = (threadId: string) =>
        SubscriptionRef.get(known).pipe(Effect.map((all) => all.get(threadId) ?? unknown))

      const change = (threadId: string, update: (before: KnownSandbox) => KnownSandbox) =>
        SubscriptionRef.modifySome(known, (all) => {
          const before = all.get(threadId) ?? unknown
          const after = update(before)

          return [
            [before, after] as const,
            after === before ? Option.none() : Option.some(new Map(all).set(threadId, after)),
          ]
        }).pipe(
          Effect.flatMap(([before, after]) =>
            reachOf(before) !== reachOf(after) && isOutOfReach(reachOf(after))
              ? PubSub.publish(lost, [threadId])
              : Effect.void,
          ),
        )

      const recover = (
        threadId: string,
        opened: Following["opened"],
        update: (before: Recovery<HostClient>) => Recovery<HostClient>,
      ) =>
        change(threadId, (before) =>
          before.following?.opened === opened && !Predicate.isTagged(before.record, "Gone")
            ? {
                ...before,
                following: { ...before.following, recovery: update(before.following.recovery) },
              }
            : before,
        )

      const setRecord = (threadId: string, record: SandboxRecord | null) =>
        change(threadId, (before) => ({ ...before, record }))

      const persist = (threadId: string, record: SandboxRecord | null) =>
        sql`
          UPDATE thread SET sandbox = ${record === null ? null : encodeRecord(record)}
          WHERE id = ${threadId}
        `.pipe(
          Effect.asVoid,
          Effect.tapError((cause) => Effect.logWarning("Couldn't save a Sandbox", cause)),
          Effect.mapError(storageFailure),
        )

      const save = (threadId: string, record: SandboxRecord | null) =>
        linkOf(threadId).recordLock.withPermits(1)(
          Effect.gen(function* () {
            if (record !== null && Predicate.isTagged((yield* knownOf(threadId)).record, "Gone"))
              return

            yield* persist(threadId, record)
            yield* setRecord(threadId, record)
          }).pipe(Effect.uninterruptible),
        )

      const updateReady = (
        threadId: string,
        update: (ready: typeof Ready.Type) => typeof Ready.Type,
      ) =>
        Effect.gen(function* () {
          const { record } = yield* knownOf(threadId)

          if (!Predicate.isTagged(record, "Ready")) return

          const next = update(record)

          yield* persist(threadId, next)
          yield* setRecord(threadId, next)
        }).pipe(linkOf(threadId).recordLock.withPermits(1), Effect.uninterruptible)

      const becomeGone = (threadId: string) =>
        Effect.gen(function* () {
          const { record } = yield* knownOf(threadId)

          if (record === null || Predicate.isTagged(record, "Gone")) return

          const gone = goneRecord(record, yield* DateTime.now)

          yield* Effect.logWarning(`A Thread's Sandbox was ${gone.reason}`, threadId)
          yield* persist(threadId, gone).pipe(Effect.ignore)
          yield* setRecord(threadId, gone)
        }).pipe(linkOf(threadId).recordLock.withPermits(1), Effect.uninterruptible)

      const followFrom = (threadId: string, host: string) =>
        Effect.gen(function* () {
          const link = linkOf(threadId)

          if (link.position?.host === host) return link.position

          yield* sql`
            UPDATE thread SET journal_host = ${host}, journal_saved = 0
            WHERE id = ${threadId}
          `.pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't save a Sandbox", cause)),
            Effect.mapError(storageFailure),
          )
          link.position = { host, saved: 0 }

          return link.position
        }).pipe(Effect.uninterruptible)

      const takeTurn = (threadId: string, turnId: string) =>
        Effect.suspend(() => {
          const link = linkOf(threadId)

          if (link.takenTurn === turnId) return Effect.void

          link.takenTurn = turnId

          return sql`UPDATE thread SET journal_turn = ${turnId} WHERE id = ${threadId}`.pipe(
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.logWarning("Couldn't save which Turn a Sandbox's agent host took", cause),
            ),
          )
        })

      const placeLostTurn = (threadId: string, client: HostClient) =>
        Effect.gen(function* () {
          const link = linkOf(threadId)
          const lostTurn = link.turnOnLostHost

          if (lostTurn === null) return

          const carried = yield* client.UnacknowledgedTurns()

          if (carried.some((turn) => turn.threadId === threadId && turn.turnId === lostTurn)) {
            yield* takeTurn(threadId, lostTurn)

            return
          }

          yield* Effect.logWarning("A Thread's Sandbox agent host doesn't have its Turn", threadId)
          yield* transcripts.endTurn(
            lostTurn === link.takenTurn ? TurnCutOff.make({}) : TurnInterrupted.make({}),
            threadId,
            lostTurn,
          )
          link.turnOnLostHost = null
        })

      const refuseIfGone = (threadId: string) =>
        knownOf(threadId).pipe(
          Effect.flatMap(({ record }) =>
            Predicate.isTagged(record, "Gone")
              ? Effect.fail(goneFailure(record.reason))
              : Effect.void,
          ),
        )

      const discard = (
        provider: SandboxProvider,
        threadId: string,
        record: Pick<SandboxRecord, "state" | "token">,
      ) =>
        deleteSandbox(provider, record, "delete the half-built Sandbox").pipe(
          Effect.andThen(save(threadId, null)),
        )

      const hostWith = (token: string): SandboxHost => ({
        bundle: config.agentHostBundle,
        environment: {
          GLASS_HOST_TOKEN: token,
          GLASS_HOST_PORT: String(hostPort),
          GLASS_HOST_ADDRESS: "0.0.0.0",
        },
      })

      const makePlacement = (provider: SandboxProvider) => {
        const provision = ({ thread, folder }: PlacedThread) =>
          Effect.gen(function* () {
            const { record: left } = yield* knownOf(thread.id)

            if (Predicate.isTagged(left, "Building")) yield* discard(provider, thread.id, left)

            const branch =
              thread.branch ??
              (yield* new ThreadError({ message: "This Thread has no branch to work on." }))

            const token = newHostToken()
            let recorded: SandboxState | undefined
            const reports = yield* orderedReports

            const request: SandboxRequest = {
              threadId: thread.id,
              harness: thread.harness,
              repository: {
                owner: thread.repository.owner,
                repo: thread.repository.repo,
              },
              branch,
              baseBranch: thread.baseBranch,
              folder,
              hostPort,
            }

            yield* Effect.gen(function* () {
              yield* createSandbox(provider, request, {
                progress: (step) => reports.offer(transcripts.setStatus(thread.id, step)),
                record: (state) => {
                  recorded = state
                  reports.offer(save(thread.id, Building.make({ state, token })))
                },
              }).pipe(Effect.ensuring(reports.caughtUp))

              if (recorded === undefined)
                return yield* Effect.logWarning(
                  `${provider.name} made a Sandbox without recording it`,
                ).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ThreadError({ message: "Couldn't create the Sandbox. Try again." }),
                    ),
                  ),
                )

              yield* transcripts.setStatus(thread.id, "Starting the agent")
              yield* startHost(provider, recorded, hostWith(token)).pipe(
                Effect.catchTag("SandboxGone", () => Effect.fail(hostDidntStart())),
              )

              return yield* save(thread.id, Ready.make({ state: recorded, token }))
            }).pipe(
              Effect.onError(() =>
                recorded === undefined
                  ? Effect.void
                  : discard(provider, thread.id, { state: recorded, token }).pipe(Effect.ignore),
              ),
              Effect.ensuring(transcripts.setStatus(thread.id, null)),
            )
          })

        const extendAhead = (threadId: string, extend: NonNullable<SandboxProvider["extend"]>) =>
          Effect.gen(function* () {
            for (;;) {
              const { record } = yield* knownOf(threadId)

              if (!Predicate.isTagged(record, "Ready")) return

              const expiresAt = yield* extendSandbox(provider, extend, record.state)

              if (
                record.expiresAt !== undefined &&
                !DateTime.isGreaterThan(expiresAt, record.expiresAt)
              )
                return

              if (!Predicate.isTagged((yield* knownOf(threadId)).record, "Ready")) return

              yield* updateReady(threadId, (ready) => ({ ...ready, expiresAt }))

              const left =
                DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(yield* DateTime.now)

              yield* Effect.sleep(Math.max(0, left / 2))
            }
          }).pipe(
            Effect.retry({
              while: (error) => !isSandboxGone(error),
              schedule: Schedule.spaced(EXTEND_RETRY_SPACING),
            }),
            Effect.catchTag("SandboxGone", () => becomeGone(threadId)),
            Effect.ignore,
          )

        const follow = (
          threadId: string,
          placed: PlacedThread | null,
          opened: Deferred.Deferred<HostClient, ThreadError | SandboxGone>,
        ) =>
          Effect.gen(function* () {
            if (!Predicate.isTagged((yield* knownOf(threadId)).record, "Ready") && placed !== null)
              yield* provision(placed)

            const { record } = yield* knownOf(threadId)

            if (!Predicate.isTagged(record, "Ready")) return yield* unreachable()

            const link = linkOf(threadId)

            if (provider.extend !== undefined)
              yield* extendAhead(threadId, provider.extend).pipe(Effect.forkChild)

            const replacingHost = knownOf(threadId).pipe(
              Effect.map(
                (found) =>
                  Predicate.isTagged(found.record, "Ready") && found.record.replacingHost === true,
              ),
            )

            const connection = Effect.gen(function* () {
              const client = yield* connectToHost(provider, record.state, record.token).pipe(
                Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
              )

              // WARNING: Effect's socket client reconnects in the background to whichever host answers, so journal calls name their host.
              const host = yield* greet(client)
              yield* refuseIfGone(threadId)

              if (yield* replacingHost)
                yield* updateReady(threadId, (ready) => ({ ...ready, replacingHost: false }))

              yield* placeLostTurn(threadId, client)
              const position = yield* followFrom(threadId, host)

              const following = yield* followHost(client, position, {
                save: transcripts.save,
                alreadySaved: () => position.saved,
                relay,
                origin: ToolCallOrigin.Sandbox({ threadId }),
                calls: scope,
              })

              let open = true

              const whileOpen = <A, E, R>(
                call: Effect.Effect<A, E, R>,
              ): Effect.Effect<A, E | RpcClientError.RpcClientError, R> =>
                open
                  ? call.pipe(
                      Effect.catchCause(
                        (cause): Effect.Effect<never, E | RpcClientError.RpcClientError> =>
                          !open && Cause.hasInterruptsOnly(cause)
                            ? Effect.fail(closedConnection())
                            : Effect.failCause(cause),
                      ),
                    )
                  : Effect.fail(closedConnection())

              const connected: HostClient = {
                ...client,
                StartThread: (input, options) => whileOpen(client.StartThread(input, options)),
                StartTurn: (input, options) =>
                  whileOpen(client.StartTurn(input, options)).pipe(
                    Effect.flatMap((started) =>
                      open
                        ? takeTurn(threadId, input.turnId).pipe(Effect.as(started))
                        : Effect.fail(closedConnection()),
                    ),
                  ),
              }

              yield* Effect.acquireRelease(
                recover(threadId, opened, () => ({ phase: "reachable", client: connected })),
                () =>
                  Effect.sync(() => {
                    open = false
                  }).pipe(
                    Effect.andThen(runningTurn(threadId)),
                    Effect.map((running) => {
                      link.turnOnLostHost = running === link.takenTurn ? running : null
                    }),
                    Effect.andThen(
                      recover(threadId, opened, (before) =>
                        before.phase === "reachable" && before.client === connected
                          ? { phase: "connecting", reach: "reachable" }
                          : before,
                      ),
                    ),
                  ),
              )
              yield* Deferred.succeed(opened, connected)
              yield* following
            }).pipe(Effect.scoped)

            const afterReplacing = transcripts.setStatus(threadId, "Updating the agent").pipe(
              Effect.andThen(replaceHost(provider, record, hostWith(record.token))),
              Effect.ensuring(transcripts.setStatus(threadId, null)),
              Effect.tapErrorTag("ThreadError", (failure) => Deferred.fail(opened, failure)),
              Effect.andThen(connection),
            )

            const replacingIfIncompatible = connection.pipe(
              Effect.catchTag("IncompatibleHost", ({ protocol }) =>
                Effect.logWarning(
                  "Replacing a Sandbox's agent host, which speaks another protocol",
                  threadId,
                  protocol,
                ).pipe(
                  Effect.andThen(
                    updateReady(threadId, (ready) => ({ ...ready, replacingHost: true })),
                  ),
                  Effect.andThen(afterReplacing),
                ),
              ),
            )

            for (;;) {
              const ended = yield* (
                (yield* replacingHost) ? afterReplacing : replacingIfIncompatible
              ).pipe(Effect.result)

              if (Result.isSuccess(ended)) return yield* Effect.void

              if (isSandboxGone(ended.failure)) return yield* Effect.fail(ended.failure)

              const following = (yield* knownOf(threadId)).following

              if (following?.opened !== opened) return yield* Effect.fail(ended.failure)

              const next = missedConnection(following.recovery)

              if (next.phase === "unreachable" && following.recovery.phase !== "unreachable") {
                yield* Effect.logWarning("Lost a Sandbox's agent host", ended.failure)
                yield* Deferred.fail(opened, unreachable())
              }

              yield* recover(threadId, opened, () => next)

              if (next.phase !== "retrying" && next.phase !== "unreachable")
                return yield* Effect.fail(ended.failure)

              yield* Effect.sleep(next.delay)
            }
          }).pipe(
            Effect.raceFirst(
              SubscriptionRef.changes(known).pipe(
                Stream.filter((all) => Predicate.isTagged(all.get(threadId)?.record, "Gone")),
                Stream.runHead,
                Effect.andThen(Effect.fail(new SandboxGone())),
              ),
            ),
            Effect.catch((error) =>
              isSandboxGone(error)
                ? becomeGone(threadId).pipe(Effect.andThen(Deferred.fail(opened, error)))
                : Deferred.fail(
                    opened,
                    Predicate.isTagged(error, "ThreadError") ? error : unreachable(),
                  ),
            ),
            Effect.ensuring(Deferred.fail(opened, unreachable())),
            Effect.asVoid,
          )

        const connect = (threadId: string, placed: PlacedThread | null) => {
          const link = linkOf(threadId)

          return link.connectLock.withPermits(1)(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const found = yield* knownOf(threadId)
                const client = clientOf(found)

                if (Option.isSome(client)) return client.value

                if (Predicate.isTagged(found.record, "Gone")) return yield* new SandboxGone()

                if (found.following !== null) yield* Fiber.interrupt(found.following.fiber)

                const opened = yield* Deferred.make<HostClient, ThreadError | SandboxGone>()
                const ready = yield* Deferred.make<void>()

                const fiber = yield* Deferred.await(ready).pipe(
                  Effect.andThen(follow(threadId, placed, opened)),
                  Effect.forkIn(scope, { uninterruptible: false }),
                )

                yield* change(threadId, (before) => ({
                  ...before,
                  following: {
                    recovery: {
                      phase: "connecting",
                      reach:
                        before.following === null
                          ? "connecting"
                          : recoveryReach(before.following.recovery),
                    },
                    opened,
                    fiber,
                  },
                }))
                yield* Deferred.succeed(ready, undefined)

                return yield* restore(Deferred.await(opened))
              }),
            ),
          )
        }

        const placement: Placement = {
          harnesses: provider.harnesses,
          models: (harness) =>
            listModels(provider, harness).pipe(
              Effect.flatMap((models) =>
                decodeModels(models).pipe(
                  Effect.tapError((cause) =>
                    Effect.logWarning(`${provider.name} listed models Glass can't read`, cause),
                  ),
                  Effect.mapError(
                    () =>
                      new ThreadError({
                        message: `Couldn't list what ${provider.name} offer. Try again.`,
                      }),
                  ),
                ),
              ),
            ),
          commands: () => Effect.succeed([]),
          defaultBranch: github.repositoryDefaultBranch,
          branches: (repository) => github.repositoryBranches(repository, ""),
          files: (repository, baseBranch) =>
            github.repositoryFiles(repository, baseBranch).pipe(
              Effect.tap(({ truncated }) =>
                truncated
                  ? Effect.logWarning("GitHub listed only some of a branch's files", baseBranch)
                  : Effect.void,
              ),
              Effect.map(({ paths }) => paths),
              Effect.tapError((cause) =>
                Effect.logWarning("Couldn't list a branch's files", cause),
              ),
              Effect.mapError(
                () => new ThreadError({ message: `Couldn't list the files on ${baseBranch}.` }),
              ),
            ),
          place: (repository) =>
            Effect.sync(() => {
              return { branch: placeholderBranch(), folder: repository.repo, discard: Effect.void }
            }),
          takenBranches: (repository, prefix) =>
            github.repositoryBranches(repository, prefix).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Couldn't list a repository's branches", cause),
              ),
              Effect.mapError(
                () => new ThreadError({ message: `Couldn't check whether ${prefix} is taken.` }),
              ),
            ),
          useBranch: () => Effect.void,
          prepareHost: (placed) =>
            connect(placed.thread.id, placed).pipe(
              Effect.catchTag("SandboxGone", () =>
                refuseIfGone(placed.thread.id).pipe(Effect.andThen(Effect.fail(unreachable()))),
              ),
            ),
          connectedHost: ({ thread }) => knownOf(thread.id).pipe(Effect.map(clientOf)),
          hostIfPrepared: ({ thread }) =>
            knownOf(thread.id).pipe(
              Effect.flatMap(({ record }) =>
                Predicate.isTagged(record, "Ready")
                  ? connect(thread.id, null).pipe(
                      Effect.map(Option.some),
                      Effect.catchTag("SandboxGone", () => Effect.succeedNone),
                    )
                  : Effect.succeedNone,
              ),
            ),
          baseRef: ({ thread }) => Effect.succeed(`refs/remotes/origin/${thread.baseBranch}`),
          remove: ({ thread }) =>
            Effect.gen(function* () {
              const { following } = yield* knownOf(thread.id)

              if (following !== null) yield* Fiber.interrupt(following.fiber)

              const { record } = yield* knownOf(thread.id)

              if (record !== null) {
                if (!Predicate.isTagged(record, "Gone"))
                  yield* deleteSandbox(provider, record, "delete the Sandbox")

                yield* save(thread.id, null)
              }

              links.delete(thread.id)
              yield* SubscriptionRef.update(known, (all) => {
                const left = new Map(all)
                left.delete(thread.id)

                return left
              })
            }),
        }

        return { placement, resume: (threadId: string) => connect(threadId, null) }
      }

      const placed = new Map(
        Array.from(sandboxProviders, ([id, provider]) => [id, makePlacement(provider)]),
      )

      const launchedAt = yield* DateTime.now

      for (const { id, provider: providerId, sandbox } of stored) {
        const provider = sandboxProviders.get(providerId)

        if (Predicate.isTagged(sandbox, "Building") && provider !== undefined)
          yield* discard(provider, id, sandbox).pipe(Effect.ignore, Effect.forkIn(scope))

        if (Predicate.isTagged(sandbox, "Ready") && expiredBy(sandbox, launchedAt))
          yield* becomeGone(id)
      }

      const resume = Effect.gen(function* () {
        const resumed = new Set<string>()

        for (const { id, provider } of stored) {
          const found = placed.get(provider)
          const { record } = yield* knownOf(id)

          if (found === undefined || !Predicate.isTagged(record, "Ready")) continue

          resumed.add(id)
          yield* found.resume(id).pipe(Effect.ignore, Effect.forkIn(scope))
        }

        return resumed
      })

      return Sandboxes.of({
        providers: Array.from(
          sandboxProviders,
          ([id, { name, harnesses }]) => new SandboxProviderInfo({ id, name, harnesses }),
        ),
        placement: (providerId) => placed.get(providerId)?.placement ?? notInstalled(providerId),
        subscribeLost: PubSub.subscribe(lost).pipe(Effect.map(Stream.fromSubscription)),
        statuses: SubscriptionRef.changes(known).pipe(
          Stream.map(
            (all) => new Map(Array.from(all, ([threadId, found]) => [threadId, statusOf(found)])),
          ),
        ),
        status: (threadId) =>
          SubscriptionRef.get(known).pipe(
            Effect.map((all) => {
              const found = all.get(threadId)

              return found === undefined ? null : statusOf(found)
            }),
          ),
        refuseIfGone,
        resume,
      })
    }),
  )
}
