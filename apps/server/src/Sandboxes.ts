import {
  AgentHarness,
  ConversationError,
  AgentModels,
  GoneReach,
  goneExplanation,
  incompatibleExplanation,
  isOutOfReach,
  SandboxProviderInfo,
  type SandboxReach,
  SandboxStatus,
  TurnCutOff,
} from "@glass/contracts"
import type { SandboxProvider, SandboxRequest, SandboxState } from "@glass/plugin"
import {
  type Cause,
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
import { newHostToken } from "./agentHost/protocol"
import { uniqueConversationName } from "./conversationNames"
import { GitHubClient } from "./github/GitHubClient"
import { followJournal, greet, type JournalPosition } from "./hostJournal"
import type {
  HostClient,
  LostConversationIds,
  PlacedConversation,
  Placement,
  SubscribeLost,
} from "./Placement"
import { Plugins } from "./Plugins"
import {
  connectToHost,
  createSandbox,
  deleteSandbox,
  extendSandbox,
  listModels,
  waitForHost,
} from "./sandboxCalls"
import { missedConnection, type Recovery, recoveryReach } from "./reconnecting"
import { isSandboxGone, SandboxGone } from "./sandboxFailures"
import { ServerConfig } from "./ServerConfig"
import { Transcripts } from "./Transcripts"

const hostPort = 7310

const sandboxFields = { state: Schema.Json, token: Schema.String }

const leaseFields = { ...sandboxFields, expiresAt: Schema.optional(Schema.DateTimeUtcFromString) }

const Building = Schema.TaggedStruct("Building", sandboxFields)

const Ready = Schema.TaggedStruct("Ready", leaseFields)

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
    }),
  ),
)

const decodeModels = Schema.decodeUnknownEffect(AgentModels)

const incompatible = () => new ConversationError({ message: incompatibleExplanation })

const unreachable = () =>
  new ConversationError({ message: "Glass couldn't reach the Conversation's Sandbox. Try again." })

const goneFailure = (reach: GoneReach) => new ConversationError({ message: goneExplanation(reach) })

const storageFailure = () =>
  new ConversationError({ message: "Couldn't save the Conversation's Sandbox. Try again." })

interface Following {
  readonly recovery: Recovery<HostClient>
  readonly opened: Deferred.Deferred<HostClient, ConversationError | SandboxGone>
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
  readonly connectLock: Semaphore.Semaphore
  readonly recordLock: Semaphore.Semaphore
}

const newLink = (position: JournalPosition | null, turnOnLostHost: string | null): HostLink => ({
  position,
  turnOnLostHost,
  connectLock: Semaphore.makeUnsafe(1),
  recordLock: Semaphore.makeUnsafe(1),
})

const EXTEND_RETRY_SPACING = "1 minute"

const orderedReports = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Effect.Effect<void, ConversationError>, Cause.Done>()

  const applying = yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach(Effect.ignore),
    Effect.forkChild,
  )

  return {
    offer: (report: Effect.Effect<void, ConversationError>) =>
      void Queue.offerUnsafe(queue, report),
    caughtUp: Queue.end(queue).pipe(Effect.andThen(Fiber.join(applying))),
  }
})

const notInstalled = (providerId: string): Placement => {
  const failure = Effect.fail(
    new ConversationError({
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
    host: () => failure,
    runningHost: () => Effect.succeedNone,
    hostOnceMade: () => Effect.succeedNone,
    baseRef: () => failure,
    remove: ({ conversation }) =>
      Effect.logWarning(
        "Removed a Conversation whose Sandbox provider isn't installed, leaving its Sandbox",
        conversation.id,
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
    readonly status: (conversationId: string) => Effect.Effect<SandboxStatus | null>
    readonly refuseIfGone: (conversationId: string) => Effect.Effect<void, ConversationError>
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
      const lost = yield* PubSub.unbounded<LostConversationIds>()

      const stored = yield* sql`
        SELECT id, sandbox_provider AS provider, sandbox, journal_host AS journalHost,
          journal_saved AS journalSaved
        FROM conversation WHERE sandbox IS NOT NULL
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const known = yield* SubscriptionRef.make<ReadonlyMap<string, KnownSandbox>>(
        new Map(stored.map(({ id, sandbox }) => [id, { record: sandbox, following: null }])),
      )

      const runningTurn = (conversationId: string) =>
        transcripts.runningTurn(conversationId).pipe(Effect.orElseSucceed(() => null))

      const links = new Map<string, HostLink>()

      for (const { id, journalHost, journalSaved } of stored)
        links.set(
          id,
          newLink(
            journalHost === null ? null : { host: journalHost, saved: journalSaved },
            yield* runningTurn(id),
          ),
        )

      const linkOf = (conversationId: string) => {
        const found = links.get(conversationId)

        if (found !== undefined) return found

        const link = newLink(null, null)
        links.set(conversationId, link)

        return link
      }

      const knownOf = (conversationId: string) =>
        SubscriptionRef.get(known).pipe(Effect.map((all) => all.get(conversationId) ?? unknown))

      const change = (conversationId: string, update: (before: KnownSandbox) => KnownSandbox) =>
        SubscriptionRef.modifySome(known, (all) => {
          const before = all.get(conversationId) ?? unknown
          const after = update(before)

          return [
            [before, after] as const,
            after === before ? Option.none() : Option.some(new Map(all).set(conversationId, after)),
          ]
        }).pipe(
          Effect.flatMap(([before, after]) =>
            reachOf(before) !== reachOf(after) && isOutOfReach(reachOf(after))
              ? PubSub.publish(lost, [conversationId])
              : Effect.void,
          ),
        )

      const recover = (
        conversationId: string,
        opened: Following["opened"],
        update: (before: Recovery<HostClient>) => Recovery<HostClient>,
      ) =>
        change(conversationId, (before) =>
          before.following?.opened === opened && !Predicate.isTagged(before.record, "Gone")
            ? {
                ...before,
                following: { ...before.following, recovery: update(before.following.recovery) },
              }
            : before,
        )

      const setRecord = (conversationId: string, record: SandboxRecord | null) =>
        change(conversationId, (before) => ({ ...before, record }))

      const persist = (conversationId: string, record: SandboxRecord | null) =>
        sql`
          UPDATE conversation SET sandbox = ${record === null ? null : encodeRecord(record)}
          WHERE id = ${conversationId}
        `.pipe(
          Effect.asVoid,
          Effect.tapError((cause) => Effect.logWarning("Couldn't save a Sandbox", cause)),
          Effect.mapError(storageFailure),
        )

      const save = (conversationId: string, record: SandboxRecord | null) =>
        linkOf(conversationId).recordLock.withPermits(1)(
          Effect.gen(function* () {
            if (
              record !== null &&
              Predicate.isTagged((yield* knownOf(conversationId)).record, "Gone")
            )
              return

            yield* persist(conversationId, record)
            yield* setRecord(conversationId, record)
          }).pipe(Effect.uninterruptible),
        )

      const becomeGone = (conversationId: string) =>
        Effect.gen(function* () {
          const { record } = yield* knownOf(conversationId)

          if (record === null || Predicate.isTagged(record, "Gone")) return

          const gone = goneRecord(record, yield* DateTime.now)

          yield* Effect.logWarning(`A Conversation's Sandbox was ${gone.reason}`, conversationId)
          yield* persist(conversationId, gone).pipe(Effect.ignore)
          yield* setRecord(conversationId, gone)
        }).pipe(linkOf(conversationId).recordLock.withPermits(1), Effect.uninterruptible)

      const followFrom = (conversationId: string, host: string) =>
        Effect.gen(function* () {
          const link = linkOf(conversationId)

          if (link.position?.host === host) return link.position

          if (link.position !== null && link.turnOnLostHost !== null) {
            yield* Effect.logWarning(
              "A Conversation's Sandbox has a new agent host",
              conversationId,
            )
            yield* transcripts.endTurn(TurnCutOff.make({}), conversationId, link.turnOnLostHost)
          }

          yield* sql`
            UPDATE conversation SET journal_host = ${host}, journal_saved = 0
            WHERE id = ${conversationId}
          `.pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't save a Sandbox", cause)),
            Effect.mapError(storageFailure),
          )
          link.position = { host, saved: 0 }

          return link.position
        }).pipe(Effect.uninterruptible)

      const refuseIfGone = (conversationId: string) =>
        knownOf(conversationId).pipe(
          Effect.flatMap(({ record }) =>
            Predicate.isTagged(record, "Gone")
              ? Effect.fail(goneFailure(record.reason))
              : Effect.void,
          ),
        )

      const discard = (
        provider: SandboxProvider,
        conversationId: string,
        record: Pick<SandboxRecord, "state" | "token">,
      ) =>
        deleteSandbox(provider, record, "delete the half-built Sandbox").pipe(
          Effect.andThen(save(conversationId, null)),
        )

      const makePlacement = (provider: SandboxProvider) => {
        const provision = ({ conversation, folder }: PlacedConversation) =>
          Effect.gen(function* () {
            const { record: left } = yield* knownOf(conversation.id)

            if (Predicate.isTagged(left, "Building"))
              yield* discard(provider, conversation.id, left)

            const token = newHostToken()
            let recorded: SandboxState | undefined
            const reports = yield* orderedReports

            const request: SandboxRequest = {
              conversationId: conversation.id,
              harness: conversation.harness,
              repository: {
                owner: conversation.repository.owner,
                repo: conversation.repository.repo,
              },
              branch: conversation.name,
              baseBranch: conversation.baseBranch,
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
              yield* createSandbox(provider, request, {
                progress: (step) => reports.offer(transcripts.setStatus(conversation.id, step)),
                record: (state) => {
                  recorded = state
                  reports.offer(save(conversation.id, Building.make({ state, token })))
                },
              }).pipe(Effect.ensuring(reports.caughtUp))

              if (recorded === undefined)
                return yield* Effect.logWarning(
                  `${provider.name} made a Sandbox without recording it`,
                ).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ConversationError({ message: "Couldn't create the Sandbox. Try again." }),
                    ),
                  ),
                )

              yield* waitForHost(provider, recorded)

              return yield* save(conversation.id, Ready.make({ state: recorded, token }))
            }).pipe(
              Effect.onError(() =>
                recorded === undefined
                  ? Effect.void
                  : discard(provider, conversation.id, { state: recorded, token }).pipe(
                      Effect.ignore,
                    ),
              ),
              Effect.ensuring(transcripts.setStatus(conversation.id, null)),
            )
          })

        const extendAhead = (
          conversationId: string,
          extend: NonNullable<SandboxProvider["extend"]>,
        ) =>
          Effect.gen(function* () {
            for (;;) {
              const { record } = yield* knownOf(conversationId)

              if (!Predicate.isTagged(record, "Ready")) return

              const expiresAt = yield* extendSandbox(provider, extend, record.state)

              if (
                record.expiresAt !== undefined &&
                !DateTime.isGreaterThan(expiresAt, record.expiresAt)
              )
                return

              const { record: current } = yield* knownOf(conversationId)

              if (!Predicate.isTagged(current, "Ready")) return

              yield* save(conversationId, { ...current, expiresAt })

              const left =
                DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(yield* DateTime.now)

              yield* Effect.sleep(Math.max(0, left / 2))
            }
          }).pipe(
            Effect.retry({
              while: (error) => !isSandboxGone(error),
              schedule: Schedule.spaced(EXTEND_RETRY_SPACING),
            }),
            Effect.catchTag("SandboxGone", () => becomeGone(conversationId)),
            Effect.ignore,
          )

        const follow = (
          conversationId: string,
          placed: PlacedConversation | null,
          opened: Deferred.Deferred<HostClient, ConversationError | SandboxGone>,
        ) =>
          Effect.gen(function* () {
            if (
              !Predicate.isTagged((yield* knownOf(conversationId)).record, "Ready") &&
              placed !== null
            )
              yield* provision(placed)

            const { record } = yield* knownOf(conversationId)

            if (!Predicate.isTagged(record, "Ready")) return yield* unreachable()

            const link = linkOf(conversationId)

            if (provider.extend !== undefined)
              yield* extendAhead(conversationId, provider.extend).pipe(Effect.forkChild)

            for (;;) {
              const ended = yield* Effect.gen(function* () {
                const client = yield* connectToHost(provider, record.state, record.token).pipe(
                  Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
                )

                // Effect's socket client connects in the background, and connects again to
                // whichever host answers, so the journal's calls name the host they mean.
                const host = yield* greet(client)
                yield* refuseIfGone(conversationId)
                const position = yield* followFrom(conversationId, host)
                yield* Effect.acquireRelease(
                  recover(conversationId, opened, () => ({ phase: "reachable", client })),
                  () =>
                    runningTurn(conversationId).pipe(
                      Effect.map((running) => {
                        link.turnOnLostHost = running
                      }),
                      Effect.andThen(
                        recover(conversationId, opened, (before) =>
                          before.phase === "reachable" && before.client === client
                            ? { phase: "connecting", reach: "reachable" }
                            : before,
                        ),
                      ),
                    ),
                )
                yield* Deferred.succeed(opened, client)
                yield* followJournal(transcripts.save, client, position)
              }).pipe(Effect.scoped, Effect.result)

              if (Result.isSuccess(ended)) return yield* Effect.void

              if (isSandboxGone(ended.failure)) return yield* Effect.fail(ended.failure)

              if (Predicate.isTagged(ended.failure, "IncompatibleHost")) {
                yield* Effect.logWarning(
                  "A Conversation's Sandbox runs another agent host protocol",
                  conversationId,
                  ended.failure.protocol,
                )
                yield* recover(conversationId, opened, () => ({ phase: "incompatible" }))

                return yield* Effect.fail(incompatible())
              }

              const following = (yield* knownOf(conversationId)).following

              if (following?.opened !== opened) return yield* Effect.fail(ended.failure)

              const next = missedConnection(following.recovery)

              if (next.phase === "unreachable" && following.recovery.phase !== "unreachable") {
                yield* Effect.logWarning("Lost a Sandbox's agent host", ended.failure)
                yield* Deferred.fail(opened, unreachable())
              }

              yield* recover(conversationId, opened, () => next)

              if (next.phase !== "retrying" && next.phase !== "unreachable")
                return yield* Effect.fail(ended.failure)

              yield* Effect.sleep(next.delay)
            }
          }).pipe(
            Effect.raceFirst(
              SubscriptionRef.changes(known).pipe(
                Stream.filter((all) => Predicate.isTagged(all.get(conversationId)?.record, "Gone")),
                Stream.runHead,
                Effect.andThen(Effect.fail(new SandboxGone())),
              ),
            ),
            Effect.catch((error) =>
              isSandboxGone(error)
                ? becomeGone(conversationId).pipe(Effect.andThen(Deferred.fail(opened, error)))
                : Deferred.fail(
                    opened,
                    Predicate.isTagged(error, "ConversationError") ? error : unreachable(),
                  ),
            ),
            Effect.ensuring(Deferred.fail(opened, unreachable())),
            Effect.asVoid,
          )

        const connect = (conversationId: string, placed: PlacedConversation | null) => {
          const link = linkOf(conversationId)

          return link.connectLock.withPermits(1)(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const found = yield* knownOf(conversationId)
                const client = clientOf(found)

                if (Option.isSome(client)) return client.value

                if (Predicate.isTagged(found.record, "Gone")) return yield* new SandboxGone()

                if (found.following !== null) yield* Fiber.interrupt(found.following.fiber)

                const opened = yield* Deferred.make<HostClient, ConversationError | SandboxGone>()
                const ready = yield* Deferred.make<void>()

                const fiber = yield* Deferred.await(ready).pipe(
                  Effect.andThen(follow(conversationId, placed, opened)),
                  Effect.forkIn(scope, { uninterruptible: false }),
                )

                yield* change(conversationId, (before) => ({
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
                      new ConversationError({
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
                () =>
                  new ConversationError({ message: `Couldn't list the files on ${baseBranch}.` }),
              ),
            ),
          place: (repository) =>
            Effect.sync(() => {
              const name = uniqueConversationName()

              return { name, branch: name, folder: repository.repo, discard: Effect.void }
            }),
          host: (placed) =>
            connect(placed.conversation.id, placed).pipe(
              Effect.catchTag("SandboxGone", () =>
                refuseIfGone(placed.conversation.id).pipe(
                  Effect.andThen(Effect.fail(unreachable())),
                ),
              ),
            ),
          runningHost: ({ conversation }) => knownOf(conversation.id).pipe(Effect.map(clientOf)),
          hostOnceMade: ({ conversation }) =>
            knownOf(conversation.id).pipe(
              Effect.flatMap(({ record }) =>
                Predicate.isTagged(record, "Ready")
                  ? connect(conversation.id, null).pipe(
                      Effect.map(Option.some),
                      Effect.catchTag("SandboxGone", () => Effect.succeedNone),
                    )
                  : Effect.succeedNone,
              ),
            ),
          baseRef: ({ conversation }) =>
            Effect.succeed(`refs/remotes/origin/${conversation.baseBranch}`),
          remove: ({ conversation }) =>
            Effect.gen(function* () {
              const { following } = yield* knownOf(conversation.id)

              if (following !== null) yield* Fiber.interrupt(following.fiber)

              const { record } = yield* knownOf(conversation.id)

              if (record !== null) {
                if (!Predicate.isTagged(record, "Gone"))
                  yield* deleteSandbox(provider, record, "delete the Sandbox")

                yield* save(conversation.id, null)
              }

              links.delete(conversation.id)
              yield* SubscriptionRef.update(known, (all) => {
                const left = new Map(all)
                left.delete(conversation.id)

                return left
              })
            }),
        }

        return { placement, resume: (conversationId: string) => connect(conversationId, null) }
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
            (all) =>
              new Map(
                Array.from(all, ([conversationId, found]) => [conversationId, statusOf(found)]),
              ),
          ),
        ),
        status: (conversationId) =>
          SubscriptionRef.get(known).pipe(
            Effect.map((all) => {
              const found = all.get(conversationId)

              return found === undefined ? null : statusOf(found)
            }),
          ),
        refuseIfGone,
        resume,
      })
    }),
  )
}
