import {
  Agent,
  AgentBusy,
  type AgentEngine,
  AgentError,
  AgentModels,
  AgentNotFound,
  type AgentPlace,
  asksPermission,
  AgentStarted,
  type ChangedFile,
  FollowedRepository,
  type InvalidLocalCheckout,
  type MessageInput,
  type ModelChoice,
  defaultPermissionMode,
  engineCapabilities,
  type NewAgent,
  type PermissionMode,
  RemovalWarnings,
  type RequestAnswer,
  NoPermissionModes,
  type RequestNotWaiting,
  RequestWaiting,
  SandboxPlace,
  thisMac as thisMacPlace,
  type TranscriptUpdate,
  TurnCutOff,
  TurnEnded,
  TurnFailed,
  TurnStopped,
  isNothingUnsent,
  nothingUnsent,
  type SentMessage,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { ActivityLog } from "./ActivityLog"
import { hostFailure, type PlacedAgent, type Placement } from "./Placement"
import { Sandboxes } from "./Sandboxes"
import { LocalPlacement } from "./LocalPlacement"
import { encodeImages, StoredMessage, Transcripts } from "./Transcripts"

const StoredAgent = Schema.Struct({
  id: Agent.fields.id,
  name: Agent.fields.name,
  sandboxProvider: Schema.NullOr(Schema.String),
  owner: FollowedRepository.fields.owner,
  repo: FollowedRepository.fields.repo,
  baseBranch: Agent.fields.baseBranch,
  engine: Agent.fields.engine,
  model: Agent.fields.model,
  effort: Agent.fields.effort,
  permissionMode: Agent.fields.permissionMode,
  folder: Schema.String,
  createdAt: Agent.fields.createdAt,
})

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredAgent))

const decodeUnsent = Schema.decodeUnknownEffect(Schema.Array(StoredMessage))

const toRow = ({
  owner,
  repo,
  folder,
  sandboxProvider,
  ...agent
}: typeof StoredAgent.Type): PlacedAgent => ({
  agent: new Agent({
    ...agent,
    place:
      sandboxProvider === null ? thisMacPlace : SandboxPlace.make({ providerId: sandboxProvider }),
    repository: new FollowedRepository({ owner, repo }),
  }),
  folder,
})

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save your Agents. Try again." })

export class Agents extends Context.Service<
  Agents,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<Agent>, AgentError>
    readonly watchWaiting: () => Stream.Stream<ReadonlyArray<string>>
    readonly transcript: (
      agentId: string,
    ) => Stream.Stream<TranscriptUpdate, AgentNotFound | AgentError>
    readonly models: (
      engine: AgentEngine,
      place: AgentPlace,
    ) => Effect.Effect<AgentModels, AgentError>
    readonly create: (input: NewAgent) => Effect.Effect<Agent, InvalidLocalCheckout | AgentError>
    readonly send: (
      agentId: string,
      input: MessageInput,
    ) => Effect.Effect<void, AgentNotFound | RequestWaiting | AgentError>
    readonly steer: (
      agentId: string,
      input: MessageInput,
    ) => Effect.Effect<void, AgentNotFound | RequestWaiting | AgentError>
    readonly cancelQueued: (
      agentId: string,
      queuedId: string,
    ) => Effect.Effect<void, AgentNotFound | AgentError>
    readonly sendQueued: (
      agentId: string,
      queuedId: string,
    ) => Effect.Effect<void, AgentNotFound | AgentBusy | AgentError>
    readonly changes: (
      agentId: string,
    ) => Effect.Effect<ReadonlyArray<ChangedFile>, AgentNotFound | AgentError>
    readonly stop: (agentId: string) => Effect.Effect<void, AgentNotFound | AgentError>
    readonly unsent: (agentId: string) => Effect.Effect<SentMessage, AgentNotFound | AgentError>
    readonly saveUnsent: (
      agentId: string,
      unsent: SentMessage,
    ) => Effect.Effect<void, AgentNotFound | AgentError>
    readonly changeModel: (
      agentId: string,
      choice: ModelChoice,
    ) => Effect.Effect<Agent, AgentNotFound | AgentError>
    readonly changePermissionMode: (
      agentId: string,
      permissionMode: PermissionMode,
    ) => Effect.Effect<Agent, AgentNotFound | NoPermissionModes | AgentError>
    readonly answer: (
      agentId: string,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, AgentNotFound | RequestNotWaiting | AgentError>
    readonly removalWarnings: (
      agentId: string,
    ) => Effect.Effect<RemovalWarnings, AgentNotFound | AgentError>
    readonly remove: (agentId: string) => Effect.Effect<void, AgentNotFound | AgentError>
  }
>()("@glass/server/Agents") {
  static readonly layer = Layer.effect(
    Agents,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const localPlacement = yield* LocalPlacement
      const sandboxes = yield* Sandboxes
      const activityLog = yield* ActivityLog
      const lock = yield* Semaphore.make(1)
      const scope = yield* Scope.Scope

      const stored = yield* sql`
        SELECT id, name, sandbox_provider AS sandboxProvider, owner, repo, base_branch AS baseBranch,
          engine, model, effort, permission_mode AS permissionMode, folder, created_at AS createdAt
        FROM agent ORDER BY created_at
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const rows = yield* SubscriptionRef.make<ReadonlyArray<PlacedAgent>>(stored.map(toRow))

      const find = Effect.fnUntraced(function* (agentId: string) {
        const found = (yield* SubscriptionRef.get(rows)).find(({ agent }) => agent.id === agentId)

        if (found === undefined) return yield* new AgentNotFound({ agentId })

        return found
      })

      const placementFor = (place: AgentPlace): Placement =>
        Predicate.isTagged(place, "sandbox")
          ? sandboxes.placement(place.providerId)
          : localPlacement

      const placementOf = (row: PlacedAgent) => placementFor(row.agent.place)

      yield* Stream.merge(yield* localPlacement.subscribeLost, yield* sandboxes.subscribeLost).pipe(
        Stream.runForEach((agentIds) =>
          transcripts
            .endRunning(TurnCutOff.make({}), agentIds)
            .pipe(Effect.catch((cause) => Effect.logWarning("Couldn't cut off Turns", cause))),
        ),
        Effect.forkIn(scope),
      )

      const deliver = (row: PlacedAgent, turnId: string, input: MessageInput) =>
        Effect.gen(function* () {
          const client = yield* placementOf(row).host(row)
          const { id: agentId, engine, model, effort, permissionMode } = row.agent

          yield* client.StartAgent({ agentId, engine, folder: row.folder })

          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* transcripts.runningTurn(agentId)) !== turnId) return

              yield* client.StartTurn({ agentId, turnId, ...input, model, effort, permissionMode })
            }),
          )
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const reason = hostFailure(error)
              const ended = { at: yield* DateTime.now, ending: TurnFailed.make({ reason }) }

              yield* transcripts.save(row.agent.id, [TurnEnded.make({ turnId, ended })])
            }),
          ),
        )

      const startedTurns = yield* transcripts.subscribeStarted

      yield* startedTurns.pipe(
        Stream.runForEach(({ agentId, turnId, message, images }) =>
          find(agentId).pipe(
            Effect.flatMap((row) =>
              deliver(row, turnId, { message, images }).pipe(Effect.forkIn(scope)),
            ),
            Effect.catch((cause) => Effect.logWarning("Couldn't deliver a Turn", cause)),
          ),
        ),
        Effect.forkIn(scope),
      )

      const create = Effect.fn("Agents.create")(function* (input: NewAgent) {
        const { repository, baseBranch, engine, model, effort, place } = input
        const { message, images } = input
        const placement = placementFor(place)

        if (!placement.engines.includes(engine))
          return yield* new AgentError({
            message: "That kind of Sandbox doesn't run this Agent program. Pick another.",
          })

        const permissionMode =
          engineCapabilities[engine].permissionModes.length === 0
            ? null
            : asksPermission(place)
              ? (input.permissionMode ?? defaultPermissionMode)
              : "bypassPermissions"

        const { name, folder, discard } = yield* placement.place(repository, baseBranch)

        const agent = new Agent({
          id: randomUUID(),
          name,
          place,
          repository,
          baseBranch,
          engine,
          model,
          effort,
          permissionMode,
          createdAt: yield* DateTime.now,
        })

        const row: PlacedAgent = { agent, folder }

        const forget = SubscriptionRef.update(rows, (current) =>
          current.filter((kept) => kept !== row),
        )

        yield* lock
          .withPermits(1)(
            Effect.gen(function* () {
              yield* sql`INSERT INTO agent ${sql.insert({
                id: agent.id,
                name: agent.name,
                sandbox_provider: Predicate.isTagged(place, "sandbox") ? place.providerId : null,
                owner: repository.owner,
                repo: repository.repo,
                base_branch: agent.baseBranch,
                engine: agent.engine,
                model: agent.model,
                effort: agent.effort,
                permission_mode: agent.permissionMode,
                folder,
                created_at: DateTime.formatIso(agent.createdAt),
              })}`
              yield* SubscriptionRef.update(rows, (current) => [...current, row])
              yield* transcripts.startOrQueue(agent.id, { message, images })
            }).pipe(sql.withTransaction),
          )
          .pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't save an Agent", cause)),
            Effect.mapError(storageFailure),
            Effect.onError(() => forget.pipe(Effect.andThen(discard))),
          )

        yield* activityLog.record(
          AgentStarted.make({
            agentId: agent.id,
            name,
            repository,
            machine: place._tag,
            engine: agent.engine,
            message,
          }),
        )

        return agent
      })

      const trySteer = (row: PlacedAgent, input: MessageInput) =>
        Effect.gen(function* () {
          const agentId = row.agent.id

          if ((yield* transcripts.runningTurn(agentId)) === null) return false

          const running = yield* placementOf(row).runningHost(row)

          if (Option.isNone(running)) return false

          return yield* running.value.Steer({ agentId, ...input }).pipe(
            Effect.as(true),
            Effect.tapError((cause) => Effect.logWarning("Couldn't Steer a Turn", cause)),
            Effect.orElseSucceed(() => false),
          )
        })

      // The Agent can't take a message in while it waits on the user's answer.
      const refuseWhileWaiting = (agentId: string) =>
        transcripts
          .isWaiting(agentId)
          .pipe(Effect.flatMap((waiting) => (waiting ? new RequestWaiting() : Effect.void)))

      const send = Effect.fn("Agents.send")(function* (agentId: string, input: MessageInput) {
        yield* find(agentId)
        yield* refuseWhileWaiting(agentId)
        yield* transcripts.startOrQueue(agentId, input)
      })

      const steer = Effect.fn("Agents.steer")(function* (agentId: string, input: MessageInput) {
        const row = yield* find(agentId)
        yield* refuseWhileWaiting(agentId)

        if (!(yield* trySteer(row, input))) yield* send(agentId, input)
      })

      const sendQueued = Effect.fn("Agents.sendQueued")(function* (
        agentId: string,
        queuedId: string,
      ) {
        yield* find(agentId)
        yield* transcripts.startQueued(agentId, queuedId)
      })

      const stop = Effect.fn("Agents.stop")(function* (agentId: string) {
        const row = yield* find(agentId)

        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* transcripts.runningTurn(agentId)) === null) return

            const running = yield* placementOf(row).runningHost(row)

            const left = Option.isNone(running)
              ? null
              : yield* running.value.StopTurn({ agentId }).pipe(
                  Effect.tapError((cause) => Effect.logWarning("Couldn't stop a Turn", cause)),
                  Effect.orElseSucceed(() => null),
                )

            if (left === null) yield* transcripts.endRunning(TurnStopped.make({}), [agentId])
            else if (left.length > 0) yield* transcripts.prependQueued(agentId, left)
          }),
        )
      })

      const unsent = Effect.fn("Agents.unsent")(function* (agentId: string) {
        yield* find(agentId)

        const [saved] = yield* sql`
          SELECT message, images FROM agent_unsent_message WHERE agent_id = ${agentId}
        `.pipe(
          Effect.flatMap(decodeUnsent),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read an unsent message", cause)),
          Effect.mapError(storageFailure),
        )

        return saved ?? nothingUnsent
      })

      const saveUnsent = Effect.fn("Agents.saveUnsent")(function* (
        agentId: string,
        { message, images }: SentMessage,
      ) {
        yield* find(agentId)

        yield* (
          isNothingUnsent({ message, images })
            ? sql`DELETE FROM agent_unsent_message WHERE agent_id = ${agentId}`
            : sql`
                INSERT INTO agent_unsent_message ${sql.insert({
                  agent_id: agentId,
                  message,
                  images: encodeImages(images),
                })}
                ON CONFLICT (agent_id) DO UPDATE SET message = excluded.message, images = excluded.images
              `
        ).pipe(
          Effect.tapError((cause) => Effect.logWarning("Couldn't save an unsent message", cause)),
          Effect.mapError(storageFailure),
        )
      })

      const changes = Effect.fn("Agents.changes")(function* (agentId: string) {
        const row = yield* find(agentId)
        const placement = placementOf(row)

        const host = yield* placement.hostOnceMade(row)

        if (Option.isNone(host)) return []

        const baseRef = yield* placement.baseRef(row)

        return yield* host.value
          .GetChanges({ folder: row.folder, baseRef })
          .pipe(Effect.mapError((error) => new AgentError({ message: hostFailure(error) })))
      })

      const update = Effect.fn("Agents.update")(function* (
        agentId: string,
        change: Partial<Pick<Agent, "model" | "effort" | "permissionMode">>,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const found = yield* find(agentId)
            // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into Agent.
            const agent = new Agent({ ...found.agent, ...change })

            yield* sql`
              UPDATE agent SET model = ${agent.model}, effort = ${agent.effort},
                permission_mode = ${agent.permissionMode}
              WHERE id = ${agentId}
            `.pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Couldn't save an Agent's settings", cause),
              ),
              Effect.mapError(storageFailure),
            )
            yield* SubscriptionRef.update(rows, (current) =>
              current.map((row) => (row.agent.id === agentId ? { ...row, agent } : row)),
            )

            return agent
          }),
        )
      })

      const changePermissionMode = Effect.fn("Agents.changePermissionMode")(function* (
        agentId: string,
        permissionMode: PermissionMode,
      ) {
        const { agent } = yield* find(agentId)

        if (agent.permissionMode === null || !asksPermission(agent.place))
          return yield* new NoPermissionModes()

        return yield* update(agentId, { permissionMode })
      })

      const answer = Effect.fn("Agents.answer")(function* (
        agentId: string,
        requestId: string,
        given: RequestAnswer,
      ) {
        const row = yield* find(agentId)

        // The host holds what waits, so it says when a request no longer does.
        return yield* placementOf(row)
          .host(row)
          .pipe(
            Effect.flatMap((client) => client.AnswerRequest({ agentId, requestId, answer: given })),
            Effect.mapError((error) =>
              Predicate.isTagged(error, "RequestNotWaiting")
                ? error
                : new AgentError({ message: hostFailure(error) }),
            ),
          )
      })

      const removalWarnings = Effect.fn("Agents.removalWarnings")(function* (agentId: string) {
        const row = yield* find(agentId)

        return yield* placementOf(row)
          .hostOnceMade(row)
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(false),
                onSome: (host) => host.HasUncommittedChanges({ folder: row.folder }),
              }),
            ),
            Effect.timeout("10 seconds"),
            Effect.map(
              (some) => new RemovalWarnings({ uncommittedChanges: some ? "some" : "none" }),
            ),
            // A connection to a host that just died ends interrupted, not failed.
            Effect.catchCause((cause) =>
              Effect.logWarning("Couldn't check an Agent for uncommitted work", cause).pipe(
                Effect.as(new RemovalWarnings({ uncommittedChanges: "unchecked" })),
              ),
            ),
          )
      })

      const remove = Effect.fn("Agents.remove")(function* (agentId: string) {
        const row = yield* lock.withPermits(1)(
          find(agentId).pipe(
            Effect.tap(() =>
              SubscriptionRef.update(rows, (current) =>
                current.filter(({ agent }) => agent.id !== agentId),
              ),
            ),
          ),
        )

        yield* Effect.gen(function* () {
          const placement = placementOf(row)
          const running = yield* placement.runningHost(row)

          if (Option.isSome(running))
            yield* running.value.StopAgent({ agentId }).pipe(
              Effect.tapError((cause) => Effect.logWarning("Couldn't stop an Agent", cause)),
              Effect.ignore,
            )

          yield* placement.remove(row)

          yield* Effect.gen(function* () {
            yield* transcripts.remove(agentId)
            yield* sql`DELETE FROM agent_unsent_message WHERE agent_id = ${agentId}`
            yield* sql`DELETE FROM agent WHERE id = ${agentId}`
          }).pipe(sql.withTransaction, Effect.mapError(storageFailure))
        }).pipe(
          Effect.tapError(() =>
            SubscriptionRef.update(rows, (current) =>
              [...current, row].toSorted((a, b) =>
                DateTime.Order(a.agent.createdAt, b.agent.createdAt),
              ),
            ),
          ),
        )
      })

      return Agents.of({
        watch: () =>
          SubscriptionRef.changes(rows).pipe(
            Stream.map((current) => current.map(({ agent }) => agent)),
          ),
        transcript: (agentId) =>
          Stream.unwrap(find(agentId).pipe(Effect.as(transcripts.watch(agentId)))),
        models: (engine, place) => {
          const placement = placementFor(place)

          return placement.engines.includes(engine)
            ? placement.models(engine)
            : Effect.succeed(new AgentModels({ defaultModel: null, models: [] }))
        },
        create,
        send,
        changes,
        steer,
        cancelQueued: (agentId, queuedId) =>
          find(agentId).pipe(Effect.andThen(transcripts.cancelQueued(agentId, queuedId))),
        sendQueued,
        stop,
        unsent,
        saveUnsent,
        watchWaiting: () =>
          transcripts.waiting.pipe(Stream.map((waiting) => Array.from(waiting).toSorted())),
        changeModel: update,
        changePermissionMode,
        answer,
        removalWarnings,
        remove,
      })
    }),
  )
}
