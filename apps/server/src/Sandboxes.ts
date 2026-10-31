import { AgentError, AgentModels, SandboxProviderInfo } from "@glass/contracts"
import type { SandboxProvider, SandboxRequest, SandboxState } from "@glass/plugin"
import {
  type Cause,
  Context,
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
} from "effect"
import { SqlClient } from "effect/sql"
import { Socket } from "effect/socket"
import { newHostToken } from "./agentHost/protocol"
import { uniqueAgentName } from "./agentNames"
import { followJournal } from "./hostJournal"
import type { HostClient, LostAgentIds, PlacedAgent, Placement, SubscribeLost } from "./Placement"
import { Plugins } from "./Plugins"
import { bundledEntry } from "./processes"
import { call, connectToHost, shutDownHost, waitForHost } from "./sandboxCalls"
import { Transcripts } from "./Transcripts"

const hostBundle = bundledEntry("agentHost", import.meta.url)

const hostPort = 7310

const SandboxRecord = Schema.Struct({
  state: Schema.Json,
  token: Schema.String,
  ready: Schema.Boolean,
})

type SandboxRecord = typeof SandboxRecord.Type

const RecordJson = Schema.fromJsonString(SandboxRecord)

const encodeRecord = Schema.encodeSync(RecordJson)

const decodeStored = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.String, provider: Schema.String, sandbox: RecordJson })),
)

const decodeModels = Schema.decodeUnknownEffect(AgentModels)

const unreachable = () =>
  new AgentError({ message: "Glass couldn't reach the Agent's Sandbox. Try again." })

const storageFailure = () =>
  new AgentError({ message: "Couldn't save the Agent's Sandbox. Try again." })

interface SandboxAgent {
  record: SandboxRecord | null
  connection: HostClient | null
  readonly connectLock: Semaphore.Semaphore
}

const fresh = (record: SandboxRecord | null): SandboxAgent => ({
  record,
  connection: null,
  connectLock: Semaphore.makeUnsafe(1),
})

const LOST_AFTER_MISSES = 4

const RECONNECT_SPACING = "500 millis"

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
        while: () => misses < LOST_AFTER_MISSES,
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
  shutDownHost(provider, state, token).pipe(
    Effect.andThen(call(provider, action, () => provider.remove(state))),
  )

const notInstalled = (providerId: string): Placement => {
  const failure = Effect.fail(
    new AgentError({
      message: `The Sandbox provider "${providerId}" isn't installed. Add its Plugin to Glass's plugins folder.`,
    }),
  )

  return {
    models: () => failure,
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
      const lost = yield* PubSub.unbounded<LostAgentIds>()

      const stored = yield* sql`
        SELECT id, sandbox_provider AS provider, sandbox FROM agent WHERE sandbox IS NOT NULL
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const agents = new Map<string, SandboxAgent>(
        stored.map(({ id, sandbox }) => [id, fresh(sandbox)]),
      )

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
          `
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

        const provisionAndFollow = (
          placed: PlacedAgent,
          sandbox: SandboxAgent,
          opened: Deferred.Deferred<HostClient, AgentError>,
        ) =>
          Effect.gen(function* () {
            if (sandbox.record?.ready !== true) yield* provision(placed)

            const record = sandbox.record

            if (record === null) return yield* unreachable()

            const position = { saved: 0 }

            return yield* reconnecting((resetMisses) =>
              Effect.gen(function* () {
                const client = yield* connectToHost(provider, record.state, record.token).pipe(
                  Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
                )

                // Effect's socket client connects in the background; a first call shows the host
                // answered.
                yield* client.Acknowledge({ through: position.saved })
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
                yield* Deferred.succeed(opened, client)
                yield* followJournal(transcripts, client, position)
              }).pipe(Effect.scoped),
            ).pipe(
              Effect.tapCause((cause) => Effect.logWarning("Lost a Sandbox's agent host", cause)),
            )
          }).pipe(
            Effect.catch((error) =>
              Deferred.fail(
                opened,
                Predicate.isTagged(error, "AgentError") ? error : unreachable(),
              ).pipe(
                Effect.flatMap((failedBeforeOpening) =>
                  failedBeforeOpening ? Effect.void : PubSub.publish(lost, [placed.agent.id]),
                ),
                Effect.ignore,
              ),
            ),
            Effect.ensuring(Deferred.fail(opened, unreachable())),
          )

        const host = (placed: PlacedAgent) => {
          const sandbox = sandboxOf(placed.agent.id)

          return sandbox.connectLock.withPermits(1)(
            Effect.gen(function* () {
              if (sandbox.connection !== null) return sandbox.connection

              const opened = yield* Deferred.make<HostClient, AgentError>()
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
          host,
          runningHost: ({ agent }) =>
            Effect.sync(() => Option.fromNullishOr(agents.get(agent.id)?.connection)),
          hostOnceMade: (placed) =>
            agents.get(placed.agent.id)?.record?.ready === true
              ? host(placed).pipe(Effect.map(Option.some))
              : Effect.succeedNone,
          baseRef: ({ agent }) => Effect.succeed(`refs/remotes/origin/${agent.baseBranch}`),
          remove: ({ agent }) =>
            Effect.gen(function* () {
              yield* FiberMap.remove(sandboxFibers, agent.id)

              const record = agents.get(agent.id)?.record ?? null

              if (record !== null) {
                yield* deleteSandbox(provider, record, "delete the Sandbox")
                yield* save(agent.id, null)
              }

              agents.delete(agent.id)
            }),
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
          ([id, { name }]) => new SandboxProviderInfo({ id, name }),
        ),
        placement: (providerId) => placements.get(providerId) ?? notInstalled(providerId),
        subscribeLost: PubSub.subscribe(lost).pipe(Effect.map(Stream.fromSubscription)),
      })
    }),
  )
}
