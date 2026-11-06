import {
  AgentEngine,
  AgentError,
  AgentModels,
  GoneReach,
  goneExplanation,
  isGone,
  isOutOfReach,
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
import { GitHubClient } from "./github/GitHubClient"
import { followJournal, type JournalPosition } from "./hostJournal"
import type { HostClient, LostAgentIds, PlacedAgent, Placement, SubscribeLost } from "./Placement"
import { Plugins } from "./Plugins"
import {
  call,
  connectToHost,
  extendSandbox,
  removeSandbox,
  shutDownHost,
  waitForHost,
} from "./sandboxCalls"
import { reconnecting } from "./reconnecting"
import { isSandboxGone, SandboxGone } from "./sandboxFailures"
import { ServerConfig } from "./ServerConfig"
import { Transcripts } from "./Transcripts"

const hostPort = 7310

const SandboxRecord = Schema.Struct({
  state: Schema.Json,
  token: Schema.String,
  ready: Schema.Boolean,
  expiresAt: Schema.optional(Schema.DateTimeUtcFromString),
  gone: Schema.optional(GoneReach),
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

const goneFailure = (reach: GoneReach) => new AgentError({ message: goneExplanation(reach) })

const storageFailure = () =>
  new AgentError({ message: "Couldn't save the Agent's Sandbox. Try again." })

interface KnownSandbox {
  readonly record: SandboxRecord | null
  readonly reach: SandboxReach
}

const unknown: KnownSandbox = { record: null, reach: "connecting" }

const statusOf = ({ record, reach }: KnownSandbox) =>
  new SandboxStatus({ expiresAt: record?.expiresAt ?? null, reach })

const expiredBy = (record: SandboxRecord | null, now: DateTime.Utc) =>
  record?.expiresAt !== undefined && DateTime.isLessThanOrEqualTo(record.expiresAt, now)

const goneReason = (record: SandboxRecord | null, now: DateTime.Utc): GoneReach =>
  expiredBy(record, now) ? "expired" : "deleted"

interface HostLink {
  connection: HostClient | null
  readonly position: JournalPosition
  readonly connectLock: Semaphore.Semaphore
}

const newLink = (saved: number): HostLink => ({
  connection: null,
  position: { saved },
  connectLock: Semaphore.makeUnsafe(1),
})

const EXTEND_RETRY_SPACING = "1 minute"

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
    models: () => failure,
    commands: () => Effect.succeed([]),
    defaultBranch: () => failure,
    branches: () => failure,
    files: () => Effect.succeed([]),
    place: () => failure,
    host: () => failure,
    runningHost: () => Effect.succeedNone,
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
    readonly statuses: Stream.Stream<ReadonlyMap<string, SandboxStatus>>
    readonly status: (agentId: string) => Effect.Effect<SandboxStatus | null>
    readonly refuseIfGone: (agentId: string) => Effect.Effect<void, AgentError>
    readonly resume: Effect.Effect<ReadonlySet<string>>
  }
>()("@glass/server/Sandboxes") {
  static readonly layer = Layer.effect(
    Sandboxes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const config = yield* ServerConfig
      const webSocketConstructor = yield* Socket.WebSocketConstructor
      const { sandboxProviders } = yield* Plugins
      const github = yield* GitHubClient
      const scope = yield* Scope.Scope
      const sandboxFibers = yield* FiberMap.make<string>()
      const lost = yield* PubSub.unbounded<LostAgentIds>()

      const stored = yield* sql`
        SELECT id, sandbox_provider AS provider, sandbox, journal_saved AS journalSaved
        FROM agent WHERE sandbox IS NOT NULL
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const launchedAt = yield* DateTime.now

      const known = yield* SubscriptionRef.make<ReadonlyMap<string, KnownSandbox>>(
        new Map(
          stored.map(({ id, sandbox }) => {
            const gone = sandbox.gone ?? (expiredBy(sandbox, launchedAt) ? "expired" : undefined)

            return [id, { record: sandbox, reach: gone ?? "connecting" }]
          }),
        ),
      )

      const links = new Map(stored.map(({ id, journalSaved }) => [id, newLink(journalSaved)]))

      const linkOf = (agentId: string) => {
        const found = links.get(agentId)

        if (found !== undefined) return found

        const link = newLink(0)
        links.set(agentId, link)

        return link
      }

      const knownOf = (agentId: string) =>
        SubscriptionRef.get(known).pipe(Effect.map((all) => all.get(agentId) ?? unknown))

      const change = (agentId: string, update: (before: KnownSandbox) => KnownSandbox) =>
        SubscriptionRef.modifySome(known, (all) => {
          const before = all.get(agentId) ?? unknown
          const after = update(before)

          return [
            [before, after] as const,
            after === before ? Option.none() : Option.some(new Map(all).set(agentId, after)),
          ]
        })

      const setReach = (agentId: string, reach: SandboxReach) =>
        change(agentId, (before) =>
          isGone(before.reach) || before.reach === reach ? before : { ...before, reach },
        ).pipe(
          Effect.flatMap(([before, after]) =>
            before.reach !== after.reach && isOutOfReach(after.reach)
              ? PubSub.publish(lost, [agentId])
              : Effect.void,
          ),
        )

      const save = (agentId: string, record: SandboxRecord | null) =>
        sql`
          UPDATE agent SET sandbox = ${record === null ? null : encodeRecord(record)}
          WHERE id = ${agentId}
        `.pipe(
          Effect.andThen(change(agentId, (before) => ({ ...before, record }))),
          Effect.asVoid,
          Effect.tapError((cause) => Effect.logWarning("Couldn't save a Sandbox", cause)),
          Effect.mapError(storageFailure),
        )

      const becomeGone = (agentId: string) =>
        Effect.gen(function* () {
          const { record } = yield* knownOf(agentId)
          const gone = goneReason(record, yield* DateTime.now)

          yield* Effect.logWarning(`An Agent's Sandbox was ${gone}`, agentId)

          if (record !== null) yield* save(agentId, { ...record, gone }).pipe(Effect.ignore)

          yield* setReach(agentId, gone)
        })

      const refuseIfGone = (agentId: string) =>
        knownOf(agentId).pipe(
          Effect.flatMap(({ reach }) =>
            isGone(reach) ? Effect.fail(goneFailure(reach)) : Effect.void,
          ),
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

      const makePlacement = (provider: SandboxProvider) => {
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
                bundle: config.agentHostBundle,
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

        const extendAhead = (agentId: string, extend: (state: SandboxState) => Promise<Date>) =>
          Effect.gen(function* () {
            let last = (yield* knownOf(agentId)).record?.expiresAt

            for (;;) {
              const { record, reach } = yield* knownOf(agentId)

              if (record === null || isGone(reach)) return

              const expiresAt = yield* extendSandbox(provider, extend, record.state)

              if (last !== undefined && !DateTime.isGreaterThan(expiresAt, last)) return

              const { record: current } = yield* knownOf(agentId)

              if (current !== null) yield* save(agentId, { ...current, expiresAt })

              last = expiresAt

              const left =
                DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(yield* DateTime.now)

              yield* Effect.sleep(Math.max(0, left / 2))
            }
          }).pipe(
            Effect.retry({
              while: (error) => !isSandboxGone(error),
              schedule: Schedule.spaced(EXTEND_RETRY_SPACING),
            }),
            Effect.catchTag("SandboxGone", () => becomeGone(agentId)),
            Effect.ignore,
          )

        const follow = (
          agentId: string,
          placed: PlacedAgent | null,
          opened: Deferred.Deferred<HostClient, AgentError | SandboxGone>,
        ) =>
          Effect.gen(function* () {
            if ((yield* knownOf(agentId)).record?.ready !== true && placed !== null)
              yield* provision(placed)

            const { record } = yield* knownOf(agentId)

            if (record?.ready !== true) return yield* unreachable()

            const link = linkOf(agentId)

            if (provider.extend !== undefined)
              yield* extendAhead(agentId, provider.extend).pipe(Effect.forkChild)

            return yield* reconnecting(
              (connected) =>
                Effect.gen(function* () {
                  const client = yield* connectToHost(provider, record.state, record.token).pipe(
                    Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
                  )

                  // Effect's socket client connects in the background; a first call shows the host
                  // answered.
                  yield* client.Acknowledge({ through: link.position.saved })
                  yield* connected

                  yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      link.connection = client
                    }),
                    () =>
                      Effect.sync(() => {
                        if (link.connection === client) link.connection = null
                      }),
                  )
                  yield* setReach(agentId, "reachable")
                  yield* Deferred.succeed(opened, client)
                  yield* followJournal(transcripts.save, client, link.position)
                }).pipe(Effect.scoped),
              (error) =>
                Effect.logWarning("Lost a Sandbox's agent host", error).pipe(
                  Effect.andThen(Deferred.fail(opened, unreachable())),
                  Effect.andThen(setReach(agentId, "unreachable")),
                ),
            )
          }).pipe(
            Effect.catch((error) =>
              isSandboxGone(error)
                ? becomeGone(agentId).pipe(Effect.andThen(Deferred.fail(opened, error)))
                : Deferred.fail(
                    opened,
                    Predicate.isTagged(error, "AgentError") ? error : unreachable(),
                  ),
            ),
            Effect.ensuring(Deferred.fail(opened, unreachable())),
          )

        const connect = (agentId: string, placed: PlacedAgent | null) => {
          const link = linkOf(agentId)

          return link.connectLock.withPermits(1)(
            Effect.gen(function* () {
              if (link.connection !== null) return link.connection

              if (isGone((yield* knownOf(agentId)).reach)) return yield* new SandboxGone()

              const opened = yield* Deferred.make<HostClient, AgentError | SandboxGone>()
              yield* FiberMap.run(sandboxFibers, agentId, follow(agentId, placed, opened))

              return yield* Deferred.await(opened)
            }),
          )
        }

        const placement: Placement = {
          engines: provider.engines,
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
          commands: () => Effect.succeed([]),
          defaultBranch: github.repositoryDefaultBranch,
          branches: github.repositoryBranches,
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
                () => new AgentError({ message: `Couldn't list the files on ${baseBranch}.` }),
              ),
            ),
          place: (repository) =>
            Effect.succeed({
              name: uniqueAgentName(),
              folder: repository.repo,
              discard: Effect.void,
            }),
          host: (placed) =>
            connect(placed.agent.id, placed).pipe(
              Effect.catchTag("SandboxGone", () =>
                knownOf(placed.agent.id).pipe(
                  Effect.flatMap(({ reach }) =>
                    Effect.fail(isGone(reach) ? goneFailure(reach) : unreachable()),
                  ),
                ),
              ),
            ),
          runningHost: ({ agent }) =>
            Effect.sync(() => Option.fromNullishOr(links.get(agent.id)?.connection)),
          hostOnceMade: ({ agent }) =>
            knownOf(agent.id).pipe(
              Effect.flatMap(({ record }) =>
                record?.ready === true
                  ? connect(agent.id, null).pipe(
                      Effect.map(Option.some),
                      Effect.catchTag("SandboxGone", () => Effect.succeedNone),
                    )
                  : Effect.succeedNone,
              ),
            ),
          baseRef: ({ agent }) => Effect.succeed(`refs/remotes/origin/${agent.baseBranch}`),
          remove: ({ agent }) =>
            Effect.gen(function* () {
              yield* FiberMap.remove(sandboxFibers, agent.id)

              const { record, reach } = yield* knownOf(agent.id)

              if (record !== null) {
                if (!isGone(reach)) yield* deleteSandbox(provider, record, "delete the Sandbox")

                yield* save(agent.id, null)
              }

              links.delete(agent.id)
              yield* SubscriptionRef.update(known, (all) => {
                const left = new Map(all)
                left.delete(agent.id)

                return left
              })
            }),
        }

        return { placement, resume: (agentId: string) => connect(agentId, null) }
      }

      const placed = new Map(
        Array.from(sandboxProviders, ([id, provider]) => [id, makePlacement(provider)]),
      )

      for (const { id, provider: providerId, sandbox } of stored) {
        const provider = sandboxProviders.get(providerId)

        if (!sandbox.ready && provider !== undefined)
          yield* discard(provider, id, sandbox).pipe(Effect.forkIn(scope))
      }

      const resume = Effect.gen(function* () {
        const resumed = new Set<string>()

        for (const { id, provider } of stored) {
          const found = placed.get(provider)
          const { record, reach } = yield* knownOf(id)

          if (found === undefined || record?.ready !== true || isGone(reach)) continue

          resumed.add(id)
          yield* found.resume(id).pipe(Effect.ignore, Effect.forkIn(scope))
        }

        return resumed
      })

      return Sandboxes.of({
        providers: Array.from(
          sandboxProviders,
          ([id, { name, engines }]) => new SandboxProviderInfo({ id, name, engines }),
        ),
        placement: (providerId) => placed.get(providerId)?.placement ?? notInstalled(providerId),
        subscribeLost: PubSub.subscribe(lost).pipe(Effect.map(Stream.fromSubscription)),
        statuses: SubscriptionRef.changes(known).pipe(
          Stream.map(
            (all) => new Map(Array.from(all, ([agentId, found]) => [agentId, statusOf(found)])),
          ),
        ),
        status: (agentId) =>
          SubscriptionRef.get(known).pipe(
            Effect.map((all) => {
              const found = all.get(agentId)

              return found === undefined ? null : statusOf(found)
            }),
          ),
        refuseIfGone,
        resume,
      })
    }),
  )
}
