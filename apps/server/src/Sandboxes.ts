import {
  AgentEngine,
  AgentError,
  AgentModels,
  goneExplanation,
  isGone,
  SandboxProviderInfo,
  type SandboxReach,
  SandboxStatus,
} from "@glass/contracts"
import type { SandboxProvider, SandboxRequest, SandboxState } from "@glass/plugin"
import {
  type Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Predicate,
  PubSub,
  Queue,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { Socket } from "effect/socket"
import { newHostToken } from "./agentHost/protocol"
import { uniqueAgentName } from "./agentNames"
import { followJournal, type JournalPosition } from "./hostJournal"
import type { HostClient, LostAgentIds, PlacedAgent, Placement, SubscribeLost } from "./Placement"
import { Plugins } from "./Plugins"
import { bundledEntry } from "./processes"
import {
  call,
  connectToHost,
  extendSandbox,
  removeSandbox,
  shutDownHost,
  waitForHost,
} from "./sandboxCalls"
import { SandboxGone } from "./sandboxFailures"
import { Transcripts } from "./Transcripts"

const hostBundle = bundledEntry("agentHost", import.meta.url)

const hostPort = 7310

const SandboxRecord = Schema.Struct({
  state: Schema.Json,
  token: Schema.String,
  ready: Schema.Boolean,
  /** When the Sandbox expires, as its provider last said. */
  expiresAt: Schema.optional(Schema.DateTimeUtcFromString),
})

type SandboxRecord = typeof SandboxRecord.Type

const RecordJson = Schema.fromJsonString(SandboxRecord)

const encodeRecord = Schema.encodeSync(RecordJson)

const decodeStored = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      sandbox: RecordJson,
      journalSaved: Schema.Int,
    }),
  ),
)

const decodeModels = Schema.decodeUnknownEffect(AgentModels)

const unreachable = () =>
  new AgentError({ message: "Glass couldn't reach the Agent's Sandbox. Try again." })

const goneFailure = (reach: "expired" | "deleted") =>
  new AgentError({ message: goneExplanation(reach) })

const isSandboxGone = Predicate.isTagged("SandboxGone")

const storageFailure = () =>
  new AgentError({ message: "Couldn't save the Agent's Sandbox. Try again." })

interface SandboxAgent {
  record: SandboxRecord | null
  connection: HostClient | null
  reach: SandboxReach
  readonly position: JournalPosition
  readonly connectLock: Semaphore.Semaphore
}

const fresh = (record: SandboxRecord | null, journalSaved = 0): SandboxAgent => ({
  record,
  connection: null,
  reach: "reachable",
  position: { saved: journalSaved, kept: true },
  connectLock: Semaphore.makeUnsafe(1),
})

const LOST_AFTER_MISSES = 4

const RECONNECT_SPACING = "500 millis"

/** How long Glass waits to extend a Sandbox again after its provider failed to. */
const EXTEND_RETRY_SPACING = "1 minute"

/** How long Glass waits between tries to reach a Sandbox it lost. */
const UNREACHABLE_SPACING = "5 seconds"

const reconnecting = <E, R>(
  connection: (resetMisses: Effect.Effect<void>) => Effect.Effect<void, E, R>,
) =>
  Effect.suspend(() => {
    let misses = 0

    return connection(
      Effect.sync(() => {
        misses = 0
      }),
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          misses += 1
        }),
      ),
      Effect.retry({
        while: (error) => !isSandboxGone(error) && misses < LOST_AFTER_MISSES,
        schedule: Schedule.spaced(RECONNECT_SPACING),
      }),
    )
  })

const orderedReports = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void, AgentError>, Cause.Done>()

  const applying = yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach(Effect.ignore),
    Effect.forkChild,
  )

  return {
    offer: (report: Effect.Effect<void, AgentError>) => void Queue.offerUnsafe(queue, report),
    caughtUp: Queue.end(queue).pipe(Effect.andThen(Fiber.join(applying))),
  }
})

const deleteSandbox = (
  provider: SandboxProvider,
  { state, token }: Pick<SandboxRecord, "state" | "token">,
  action: string,
) =>
  shutDownHost(provider, state, token).pipe(Effect.andThen(removeSandbox(provider, state, action)))

const notInstalled = (providerId: string): Placement => {
  const failure = Effect.fail(
    new AgentError({
      message: `The Sandbox provider "${providerId}" isn't installed. Add its Plugin to Glass's plugins folder.`,
    }),
  )

  return {
    engines: AgentEngine.literals,
    keepsBranch: false,
    models: () => failure,
    place: () => failure,
    host: () => failure,
    runningHost: () => Effect.succeedNone,
    writable: () => Effect.void,
    reopen: () => Effect.succeed(false),
    hostOnceMade: () => Effect.succeedNone,
    baseRef: () => failure,
    remove: ({ agent }) =>
      Effect.logWarning(
        "Removed an Agent whose Sandbox provider isn't installed, leaving its Sandbox",
        agent.id,
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
    readonly statuses: Stream.Stream<ReadonlyArray<SandboxStatus>>
  }
>()("@glass/server/Sandboxes") {
  static readonly layer = Layer.effect(
    Sandboxes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const webSocketConstructor = yield* Socket.WebSocketConstructor
      const { sandboxProviders } = yield* Plugins
      const scope = yield* Scope.Scope
      const sandboxFibers = yield* FiberMap.make<string>()
      const extenders = yield* FiberMap.make<string>()
      const lost = yield* PubSub.unbounded<LostAgentIds>()

      const stored = yield* sql`
        SELECT id, sandbox_provider AS provider, sandbox, journal_saved AS journalSaved
        FROM agent WHERE sandbox IS NOT NULL
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const launchedAt = yield* DateTime.now

      const agents = new Map<string, SandboxAgent>(
        stored.map(({ id, sandbox, journalSaved }) => {
          const known = fresh(sandbox, journalSaved)

          // One past its expiry while Glass was closed is gone without asking.
          if (
            sandbox.expiresAt !== undefined &&
            DateTime.isLessThanOrEqualTo(sandbox.expiresAt, launchedAt)
          )
            known.reach = "expired"

          return [id, known]
        }),
      )

      const statusesOf = () =>
        Array.from(
          agents,
          ([agentId, { record, reach }]) =>
            new SandboxStatus({ agentId, expiresAt: record?.expiresAt ?? null, reach }),
        )

      const statuses = yield* SubscriptionRef.make<ReadonlyArray<SandboxStatus>>(statusesOf())

      const publishStatuses = Effect.suspend(() => SubscriptionRef.set(statuses, statusesOf()))

      const setReach = (sandbox: SandboxAgent, reach: SandboxReach) =>
        Effect.suspend(() => {
          if (sandbox.reach === reach) return Effect.void

          sandbox.reach = reach

          return publishStatuses
        })

      // Providers don't say why a Sandbox is gone; one gone before it was due was deleted.
      const goneReach = (sandbox: SandboxAgent) =>
        DateTime.now.pipe(
          Effect.map((now): SandboxReach => {
            const expiresAt = sandbox.record?.expiresAt

            return expiresAt !== undefined && DateTime.isLessThanOrEqualTo(expiresAt, now)
              ? "expired"
              : "deleted"
          }),
        )

      /**
       * Fails whoever waits on the connection or, once one was open, cuts off the running Turn the
       * first time the Sandbox is lost.
       */
      const lose = (
        agentId: string,
        sandbox: SandboxAgent,
        opened: Deferred.Deferred<HostClient, AgentError | SandboxGone>,
        failure: AgentError | SandboxGone,
        reach: SandboxReach,
      ) =>
        Effect.gen(function* () {
          const failedBeforeOpening = yield* Deferred.fail(opened, failure)
          const wasReachable = sandbox.reach === "reachable"

          yield* setReach(sandbox, reach)

          if (!failedBeforeOpening && wasReachable) yield* PubSub.publish(lost, [agentId])
        })

      const sandboxOf = (agentId: string) => {
        const known = agents.get(agentId)

        if (known !== undefined) return known

        const sandbox = fresh(null)
        agents.set(agentId, sandbox)

        return sandbox
      }

      const save = (agentId: string, record: SandboxRecord | null) =>
        Effect.suspend(() => {
          sandboxOf(agentId).record = record

          return sql`
            UPDATE agent SET sandbox = ${record === null ? null : encodeRecord(record)}
            WHERE id = ${agentId}
          `.pipe(Effect.andThen(publishStatuses))
        }).pipe(
          Effect.tapError((cause) => Effect.logWarning("Couldn't save a Sandbox", cause)),
          Effect.mapError(storageFailure),
        )

      const discard = (
        provider: SandboxProvider,
        agentId: string,
        record: Pick<SandboxRecord, "state" | "token">,
      ) =>
        deleteSandbox(provider, record, "delete the half-built Sandbox").pipe(
          Effect.andThen(save(agentId, null)),
          Effect.ignore,
        )

      const makePlacement = (provider: SandboxProvider): Placement => {
        const provision = ({ agent, folder }: PlacedAgent) =>
          Effect.gen(function* () {
            const token = newHostToken()
            let recorded: SandboxState | undefined
            const reports = yield* orderedReports

            const request: SandboxRequest = {
              agentId: agent.id,
              engine: agent.engine,
              repository: { owner: agent.repository.owner, repo: agent.repository.repo },
              branch: agent.name,
              baseBranch: agent.baseBranch,
              folder,
              host: {
                bundle: hostBundle,
                port: hostPort,
                environment: {
                  GLASS_HOST_TOKEN: token,
                  GLASS_HOST_PORT: String(hostPort),
                  GLASS_HOST_ADDRESS: "0.0.0.0",
                },
              },
            }

            yield* Effect.gen(function* () {
              yield* call(provider, "create the Sandbox", (signal) =>
                provider.create(request, {
                  progress: (step) => reports.offer(transcripts.setStatus(agent.id, step)),
                  record: (state) => {
                    recorded = state
                    reports.offer(save(agent.id, { state, token, ready: false }))
                  },
                  signal,
                }),
              ).pipe(Effect.ensuring(reports.caughtUp))

              if (recorded === undefined)
                return yield* Effect.logWarning(
                  `${provider.name} made a Sandbox without recording it`,
                ).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new AgentError({ message: "Couldn't create the Sandbox. Try again." }),
                    ),
                  ),
                )

              yield* waitForHost(provider, recorded)

              return yield* save(agent.id, { state: recorded, token, ready: true })
            }).pipe(
              Effect.onError(() =>
                recorded === undefined
                  ? Effect.void
                  : discard(provider, agent.id, { state: recorded, token }),
              ),
              Effect.ensuring(transcripts.setStatus(agent.id, null)),
            )
          })

        /**
         * Extends the Sandbox now and again halfway to each expiry, until its provider can't move
         * the expiry any later.
         */
        const extendAhead = (agentId: string, sandbox: SandboxAgent) =>
          Effect.gen(function* () {
            for (;;) {
              const record = sandbox.record

              if (record === null) return

              const expiresAt = yield* extendSandbox(provider, record.state)

              if (sandbox.record !== null) yield* save(agentId, { ...sandbox.record, expiresAt })

              if (
                record.expiresAt !== undefined &&
                !DateTime.isGreaterThan(expiresAt, record.expiresAt)
              )
                return

              const left =
                DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(yield* DateTime.now)

              yield* Effect.sleep(Math.max(0, left / 2))
            }
          }).pipe(
            Effect.retry({
              while: (error) => !isSandboxGone(error),
              schedule: Schedule.spaced(EXTEND_RETRY_SPACING),
            }),
            // Reaching the host finds a gone Sandbox too, and says so.
            Effect.ignore,
          )

        const keepExtending = (agentId: string, sandbox: SandboxAgent) =>
          FiberMap.run(extenders, agentId, extendAhead(agentId, sandbox), { onlyIfMissing: true })

        const provisionAndFollow = (
          placed: PlacedAgent,
          sandbox: SandboxAgent,
          opened: Deferred.Deferred<HostClient, AgentError | SandboxGone>,
        ) =>
          Effect.gen(function* () {
            const agentId = placed.agent.id

            if (sandbox.record?.ready !== true) yield* provision(placed)

            const record = sandbox.record

            if (record === null) return yield* unreachable()

            yield* keepExtending(agentId, sandbox)

            return yield* reconnecting((resetMisses) =>
              Effect.gen(function* () {
                const client = yield* connectToHost(provider, record.state, record.token).pipe(
                  Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
                )

                // Effect's socket client connects in the background; a first call shows the host
                // answered.
                yield* client.Acknowledge({ through: sandbox.position.saved })
                yield* resetMisses

                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    sandbox.connection = client
                  }),
                  () =>
                    Effect.sync(() => {
                      if (sandbox.connection === client) sandbox.connection = null
                    }),
                )
                yield* setReach(sandbox, "reachable")
                yield* Deferred.succeed(opened, client)
                yield* followJournal(transcripts, client, sandbox.position)
              }).pipe(Effect.scoped),
            ).pipe(
              Effect.tapError((error) =>
                isSandboxGone(error)
                  ? Effect.void
                  : Effect.logWarning("Lost a Sandbox's agent host", error).pipe(
                      Effect.andThen(lose(agentId, sandbox, opened, unreachable(), "unreachable")),
                    ),
              ),
              // Keeps trying while the Agent exists, so the Sandbox's work fills in once it answers.
              Effect.retry({
                while: (error) => !isSandboxGone(error),
                schedule: Schedule.spaced(UNREACHABLE_SPACING),
              }),
            )
          }).pipe(
            Effect.catch((error) =>
              isSandboxGone(error)
                ? Effect.logWarning("An Agent's Sandbox no longer exists", placed.agent.id).pipe(
                    Effect.andThen(goneReach(sandbox)),
                    Effect.flatMap((reach) => lose(placed.agent.id, sandbox, opened, error, reach)),
                  )
                : Deferred.fail(
                    opened,
                    Predicate.isTagged(error, "AgentError") ? error : unreachable(),
                  ),
            ),
            Effect.ensuring(Deferred.fail(opened, unreachable())),
          )

        const host = (placed: PlacedAgent) => {
          const sandbox = sandboxOf(placed.agent.id)

          return sandbox.connectLock.withPermits(1)(
            Effect.gen(function* () {
              if (sandbox.connection !== null) return sandbox.connection

              if (isGone(sandbox.reach)) return yield* new SandboxGone()

              const opened = yield* Deferred.make<HostClient, AgentError | SandboxGone>()
              yield* FiberMap.run(
                sandboxFibers,
                placed.agent.id,
                provisionAndFollow(placed, sandbox, opened),
              )

              return yield* Deferred.await(opened)
            }),
          )
        }

        return {
          engines: provider.engines,
          keepsBranch: false,
          models: (engine) =>
            call(provider, "list what its Sandboxes offer", () => provider.models(engine)).pipe(
              Effect.flatMap((models) =>
                decodeModels(models).pipe(
                  Effect.tapError((cause) =>
                    Effect.logWarning(`${provider.name} listed models Glass can't read`, cause),
                  ),
                  Effect.mapError(
                    () =>
                      new AgentError({
                        message: `Couldn't list what ${provider.name} offer. Try again.`,
                      }),
                  ),
                ),
              ),
            ),
          place: (repository) =>
            Effect.succeed({
              name: uniqueAgentName(),
              folder: repository.repo,
              discard: Effect.void,
            }),
          host: (placed) =>
            host(placed).pipe(
              Effect.catchTag("SandboxGone", () =>
                Effect.suspend(() => {
                  const { reach } = sandboxOf(placed.agent.id)

                  return Effect.fail(isGone(reach) ? goneFailure(reach) : unreachable())
                }),
              ),
            ),
          writable: ({ agent }) =>
            Effect.suspend(() => {
              const reach = agents.get(agent.id)?.reach

              return reach !== undefined && isGone(reach)
                ? Effect.fail(goneFailure(reach))
                : Effect.void
            }),
          runningHost: ({ agent }) =>
            Effect.sync(() => Option.fromNullishOr(agents.get(agent.id)?.connection)),
          // A gone Sandbox took everything in it, so like one never made, it holds nothing to lose.
          hostOnceMade: (placed) =>
            agents.get(placed.agent.id)?.record?.ready === true &&
            !isGone(sandboxOf(placed.agent.id).reach)
              ? host(placed).pipe(
                  Effect.map(Option.some),
                  Effect.catchTag("SandboxGone", () => Effect.succeedNone),
                )
              : Effect.succeedNone,
          baseRef: ({ agent }) => Effect.succeed(`refs/remotes/origin/${agent.baseBranch}`),
          remove: ({ agent }) =>
            Effect.gen(function* () {
              yield* FiberMap.remove(sandboxFibers, agent.id)
              yield* FiberMap.remove(extenders, agent.id)

              const sandbox = agents.get(agent.id)

              if (sandbox?.record != null) {
                // A gone Sandbox leaves its provider nothing to delete.
                if (!isGone(sandbox.reach))
                  yield* deleteSandbox(provider, sandbox.record, "delete the Sandbox")

                yield* save(agent.id, null)
              }

              agents.delete(agent.id)
              yield* publishStatuses
            }),
          reopen: (placed) =>
            agents.get(placed.agent.id)?.record?.ready === true
              ? host(placed).pipe(
                  // The running Turn can't be followed for now; reaching the host later replays
                  // how it really ended.
                  Effect.catch(() => PubSub.publish(lost, [placed.agent.id])),
                  Effect.forkIn(scope),
                  Effect.as(true),
                )
              : Effect.succeed(false),
        }
      }

      const placements = new Map(
        Array.from(sandboxProviders, ([id, provider]) => [id, makePlacement(provider)]),
      )

      for (const { id, provider: providerId, sandbox } of stored) {
        const provider = sandboxProviders.get(providerId)

        if (!sandbox.ready && provider !== undefined)
          yield* discard(provider, id, sandbox).pipe(Effect.forkIn(scope))
      }

      return Sandboxes.of({
        providers: Array.from(
          sandboxProviders,
          ([id, { name, engines }]) => new SandboxProviderInfo({ id, name, engines }),
        ),
        placement: (providerId) => placements.get(providerId) ?? notInstalled(providerId),
        subscribeLost: PubSub.subscribe(lost).pipe(Effect.map(Stream.fromSubscription)),
        statuses: SubscriptionRef.changes(statuses),
      })
    }),
  )
}
