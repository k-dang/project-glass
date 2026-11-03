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
  mentionedToDoIds,
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
  type SandboxStatus,
  thisMac as thisMacPlace,
  type TranscriptUpdate,
  TurnCutOff,
  TurnEnded,
  TurnFailed,
  TurnInterrupted,
  TurnStopped,
  isNothingUnsent,
  nothingUnsent,
  type SentMessage,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
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
import type { DeliveredMessage } from "./agentHost/deliveredMessage"
import { ReviewBrief } from "./agentHost/protocol"
import { encodeImages, StoredMessage, Transcripts } from "./Transcripts"
import { prompt } from "./prompt"
import { ToDos } from "./ToDos"

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
  forReview: Schema.BooleanFromBit,
})

const BriefJson = Schema.fromJsonString(ReviewBrief)

const encodeBrief = Schema.encodeSync(BriefJson)

const decodeBrief = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ brief: Schema.NullOr(BriefJson) })),
)

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredAgent))

const decodeUnsent = Schema.decodeUnknownEffect(Schema.Array(StoredMessage))

const toRow = ({
  owner,
  repo,
  folder,
  sandboxProvider,
  forReview,
  ...agent
}: typeof StoredAgent.Type): PlacedAgent => ({
  agent: new Agent({
    ...agent,
    place:
      sandboxProvider === null ? thisMacPlace : SandboxPlace.make({ providerId: sandboxProvider }),
    repository: new FollowedRepository({ owner, repo }),
    sandbox: null,
  }),
  folder,
  forReview,
})

const withStatus = (agent: Agent, sandbox: SandboxStatus | null) =>
  // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into Agent.
  new Agent({ ...agent, sandbox })

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save your Agents. Try again." })

/** An Agent review's Agent, reading a checkout Glass already wrote to `folder`. */
export interface NewReviewAgent {
  readonly name: string
  readonly repository: FollowedRepository
  readonly baseBranch: string
  readonly engine: AgentEngine
  readonly model: string | null
  readonly folder: string
  readonly review: ReviewBrief
  readonly message: string
}

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
    /** Starts the Agent on its first Turn. It stays out of the Agents list, and owns its folder. */
    readonly createForReview: (input: NewReviewAgent) => Effect.Effect<Agent, AgentError>
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
    readonly reachSandbox: (agentId: string) => Effect.Effect<void, AgentNotFound | AgentError>
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
      const toDos = yield* ToDos
      const fs = yield* FileSystem.FileSystem
      const lock = yield* Semaphore.make(1)
      const scope = yield* Scope.Scope

      const stored = yield* sql`
        SELECT id, name, sandbox_provider AS sandboxProvider, owner, repo, base_branch AS baseBranch,
          engine, model, effort, permission_mode AS permissionMode, folder, created_at AS createdAt,
          review_brief IS NOT NULL AS forReview
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

      /**
       * An Agent review's Agent runs on this device in a checkout Glass wrote: it has no worktree
       * whose changes to show or keep, and removing it deletes the checkout.
       */
      const reviewPlacement: Placement = {
        ...localPlacement,
        hostOnceMade: () => Effect.succeedNone,
        remove: ({ folder }) =>
          fs.remove(folder, { recursive: true, force: true }).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Couldn't remove an Agent review's checkout", cause),
            ),
            Effect.mapError(storageFailure),
          ),
      }

      const placementOf = (row: PlacedAgent) =>
        row.forReview ? reviewPlacement : placementFor(row.agent.place)

      yield* Stream.merge(yield* localPlacement.subscribeLost, yield* sandboxes.subscribeLost).pipe(
        Stream.runForEach((agentIds) =>
          transcripts
            .endRunning(TurnCutOff.make({}), agentIds)
            .pipe(Effect.catch((cause) => Effect.logWarning("Couldn't cut off Turns", cause))),
        ),
        Effect.forkIn(scope),
      )

      const outlivedGlass = yield* sandboxes.resume
      yield* transcripts
        .endRunning(
          TurnInterrupted.make({}),
          stored.flatMap(({ id }) => (outlivedGlass.has(id) ? [] : [id])),
        )
        .pipe(Effect.orDie)

      const withSandbox = (agent: Agent) =>
        sandboxes.status(agent.id).pipe(Effect.map((sandbox) => withStatus(agent, sandbox)))

      const delivered = Effect.fnUntraced(function* ({ message, images }: MessageInput) {
        const ids = mentionedToDoIds(message)

        const listed =
          ids.length === 0
            ? []
            : yield* toDos.list().pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("Couldn't read mentioned To-dos", cause),
                ),
                Effect.orElseSucceed(() => []),
              )

        const mentioned = ids.flatMap((id) => listed.find((toDo) => toDo.id === id) ?? [])

        return { message, images, prompt: prompt(message, mentioned) } satisfies DeliveredMessage
      })

      /** Read only when a Turn starts, since it holds the whole PR. */
      const reviewBrief = (row: PlacedAgent) =>
        row.forReview
          ? sql`SELECT review_brief AS brief FROM agent WHERE id = ${row.agent.id}`.pipe(
              Effect.flatMap(decodeBrief),
              Effect.map(([found]) => found?.brief ?? null),
              Effect.tapError((cause) => Effect.logWarning("Couldn't read a review brief", cause)),
              Effect.mapError(storageFailure),
            )
          : Effect.succeed(null)

      const deliver = (row: PlacedAgent, turnId: string, input: MessageInput) =>
        Effect.gen(function* () {
          const client = yield* placementOf(row).host(row)
          const { id: agentId, engine, model, effort, permissionMode } = row.agent

          const [, message] = yield* Effect.all(
            [
              reviewBrief(row).pipe(
                Effect.flatMap((review) =>
                  client.StartAgent({ agentId, engine, folder: row.folder, review }),
                ),
              ),
              delivered(input),
            ],
            { concurrency: "unbounded" },
          )

          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* transcripts.runningTurn(agentId)) !== turnId) return

              yield* client.StartTurn({
                agentId,
                turnId,
                ...message,
                model,
                effort,
                permissionMode,
              })
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

      /** Saves the Agent and starts its first Turn. */
      const insert = (row: PlacedAgent, first: MessageInput, review: ReviewBrief | null) => {
        const { agent, folder } = row
        const { place, repository } = agent

        const forget = SubscriptionRef.update(rows, (current) =>
          current.filter((kept) => kept !== row),
        )

        return lock
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
                review_brief: review === null ? null : encodeBrief(review),
              })}`

              yield* SubscriptionRef.update(rows, (current) => [...current, row])
              yield* transcripts.startOrQueue(agent.id, first)
            }).pipe(sql.withTransaction),
          )
          .pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't save an Agent", cause)),
            Effect.mapError(storageFailure),
            Effect.onError(() => forget),
          )
      }

      const createForReview = Effect.fn("Agents.createForReview")(function* (
        input: NewReviewAgent,
      ) {
        const agent = new Agent({
          id: randomUUID(),
          name: input.name,
          place: thisMacPlace,
          repository: input.repository,
          baseBranch: input.baseBranch,
          engine: input.engine,
          model: input.model,
          effort: null,
          // It only reads, with tools allowed up front, so there's nothing to choose.
          permissionMode: null,
          createdAt: yield* DateTime.now,
          sandbox: null,
        })

        yield* insert(
          { agent, folder: input.folder, forReview: true },
          { message: input.message, images: [] },
          input.review,
        )

        return agent
      })

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
          sandbox: null,
        })

        yield* insert({ agent, folder, forReview: false }, { message, images }, null).pipe(
          Effect.onError(() => discard),
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

        return yield* withSandbox(agent)
      })

      const trySteer = (row: PlacedAgent, input: MessageInput) =>
        Effect.gen(function* () {
          const agentId = row.agent.id

          if ((yield* transcripts.runningTurn(agentId)) === null) return false

          const running = yield* placementOf(row).runningHost(row)

          if (Option.isNone(running)) return false

          const message = yield* delivered(input)

          return yield* running.value.Steer({ agentId, ...message }).pipe(
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

      const findWritable = (agentId: string) =>
        find(agentId).pipe(Effect.tap(() => sandboxes.refuseIfGone(agentId)))

      const send = Effect.fn("Agents.send")(function* (agentId: string, input: MessageInput) {
        yield* findWritable(agentId)
        yield* refuseWhileWaiting(agentId)
        yield* transcripts.startOrQueue(agentId, input)
      })

      const steer = Effect.fn("Agents.steer")(function* (agentId: string, input: MessageInput) {
        const row = yield* findWritable(agentId)
        yield* refuseWhileWaiting(agentId)

        if (!(yield* trySteer(row, input))) yield* transcripts.startOrQueue(agentId, input)
      })

      const sendQueued = Effect.fn("Agents.sendQueued")(function* (
        agentId: string,
        queuedId: string,
      ) {
        yield* findWritable(agentId)
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

            return yield* withSandbox(agent)
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
          Stream.zipLatest(SubscriptionRef.changes(rows), sandboxes.statuses).pipe(
            Stream.map(([current, statuses]) =>
              current.flatMap(({ agent, forReview }) =>
                forReview ? [] : [withStatus(agent, statuses.get(agent.id) ?? null)],
              ),
            ),
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
        createForReview,
        send,
        changes,
        steer,
        cancelQueued: (agentId, queuedId) =>
          find(agentId).pipe(Effect.andThen(transcripts.cancelQueued(agentId, queuedId))),
        sendQueued,
        stop,
        reachSandbox: (agentId) =>
          find(agentId).pipe(
            Effect.flatMap((row) => placementOf(row).host(row)),
            Effect.asVoid,
          ),
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
