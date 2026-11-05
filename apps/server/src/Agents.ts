import {
  Agent,
  AgentBusy,
  type AgentEngine,
  AgentError,
  type AgentCommand,
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
  type RequestWaiting,
  type Revision,
  SandboxPlace,
  thisMac as thisMacPlace,
  type TranscriptUpdate,
  TurnCutOff,
  TurnInterrupted,
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
import { type Conversation, ConversationTurns } from "./ConversationTurns"
import {
  asAgentError,
  type HostCallError,
  type HostClient,
  type PlacedAgent,
  type Placement,
} from "./Placement"
import { Sandboxes } from "./Sandboxes"
import { LocalPlacement } from "./LocalPlacement"
import { ReviewBrief, ReviewRole, WorkRole } from "./agentHost/protocol"
import { Transcripts } from "./Transcripts"

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

const decodeBrief = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ brief: BriefJson })))

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredAgent))

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

const agentWith = (agent: Agent, change: Partial<typeof Agent.Type>) =>
  // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into Agent.
  new Agent({ ...agent, ...change })

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save your Agents. Try again." })

export interface NewReviewAgent {
  readonly name: string
  readonly repository: FollowedRepository
  readonly revision: Revision
  readonly engine: AgentEngine
  readonly model: string | null
  readonly checkout: string
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
    readonly newAgentCommands: (
      engine: AgentEngine,
      place: AgentPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, InvalidLocalCheckout | AgentError>
    readonly commands: (
      agentId: string,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, AgentNotFound | AgentError>
    readonly newAgentFiles: (
      place: AgentPlace,
      repository: FollowedRepository,
      baseBranch: string,
    ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | AgentError>
    readonly files: (
      agentId: string,
    ) => Effect.Effect<ReadonlyArray<string>, AgentNotFound | AgentError>
    readonly create: (input: NewAgent) => Effect.Effect<Agent, InvalidLocalCheckout | AgentError>
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
      const turns = yield* ConversationTurns
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
        sandboxes.status(agent.id).pipe(Effect.map((sandbox) => agentWith(agent, { sandbox })))

      const reviewBrief = (row: PlacedAgent) =>
        sql`SELECT review_brief AS brief FROM agent WHERE id = ${row.agent.id}`.pipe(
          Effect.flatMap(decodeBrief),
          Effect.flatMap(([found]) =>
            found === undefined
              ? Effect.fail("An Agent review's Agent is gone")
              : Effect.succeed(found.brief),
          ),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read a review brief", cause)),
          Effect.mapError(storageFailure),
        )

      const conversationOf = (row: PlacedAgent): Conversation => {
        const placement = placementOf(row)
        const { id, engine, model, effort, permissionMode } = row.agent

        return {
          id,
          engine,
          folder: row.folder,
          role: row.forReview
            ? reviewBrief(row).pipe(Effect.map((brief) => ReviewRole.make({ brief })))
            : Effect.succeed(WorkRole.make({})),
          settings: { model, effort, permissionMode },
          host: placement.host(row),
          runningHost: placement.runningHost(row),
        }
      }

      const startedTurns = yield* transcripts.subscribeStarted

      // Turns of conversations that aren't Agents, such as the Global conversation, are left to
      // their own services.
      yield* startedTurns.pipe(
        Stream.runForEach(({ agentId, turnId, message, images, context }) =>
          find(agentId).pipe(
            Effect.flatMap((row) =>
              turns
                .deliver(conversationOf(row), turnId, { message, images, context })
                .pipe(Effect.forkIn(scope)),
            ),
            Effect.catchTag("AgentNotFound", () => Effect.void),
          ),
        ),
        Effect.forkIn(scope),
      )

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
              yield* transcripts.startOrQueue(agent.id, { ...first, context: null })
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
          baseBranch: input.revision.base,
          engine: input.engine,
          model: input.model,
          effort: null,
          permissionMode: null,
          createdAt: yield* DateTime.now,
          sandbox: null,
        })

        yield* insert(
          { agent, folder: input.checkout, forReview: true },
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

      const findWritable = (agentId: string) =>
        find(agentId).pipe(Effect.tap(() => sandboxes.refuseIfGone(agentId)))

      const send = Effect.fn("Agents.send")(function* (agentId: string, input: MessageInput) {
        yield* findWritable(agentId)
        yield* turns.send(agentId, { ...input, context: null })
      })

      const steer = Effect.fn("Agents.steer")(function* (agentId: string, input: MessageInput) {
        const row = yield* findWritable(agentId)
        yield* turns.steer(conversationOf(row), { ...input, context: null })
      })

      const sendQueued = Effect.fn("Agents.sendQueued")(function* (
        agentId: string,
        queuedId: string,
      ) {
        yield* findWritable(agentId)
        yield* transcripts.startQueued(agentId, queuedId)
      })

      const stop = Effect.fn("Agents.stop")(function* (agentId: string) {
        yield* turns.stop(conversationOf(yield* find(agentId)))
      })

      const unsent = Effect.fn("Agents.unsent")(function* (agentId: string) {
        yield* find(agentId)

        return yield* turns.unsent(agentId)
      })

      const saveUnsent = Effect.fn("Agents.saveUnsent")(function* (
        agentId: string,
        unsentMessage: SentMessage,
      ) {
        yield* find(agentId)
        yield* turns.saveUnsent(agentId, unsentMessage)
      })

      const changes = Effect.fn("Agents.changes")(function* (agentId: string) {
        const row = yield* find(agentId)
        const placement = placementOf(row)

        const host = yield* placement.hostOnceMade(row)

        if (Option.isNone(host)) return []

        const baseRef = yield* placement.baseRef(row)

        return yield* host.value
          .GetChanges({ folder: row.folder, baseRef })
          .pipe(Effect.mapError(asAgentError))
      })

      const listedByHost = Effect.fnUntraced(function* <A>(
        agentId: string,
        list: (
          host: HostClient,
          row: PlacedAgent,
        ) => Effect.Effect<ReadonlyArray<A>, HostCallError>,
      ) {
        const row = yield* find(agentId)
        const host = yield* placementOf(row).hostOnceMade(row)

        if (Option.isNone(host)) return []

        return yield* list(host.value, row).pipe(Effect.mapError(asAgentError))
      })

      const commands = (agentId: string) =>
        listedByHost(agentId, (host, row) =>
          host.ListCommands({ engine: row.agent.engine, folder: row.folder }),
        ).pipe(Effect.withSpan("Agents.commands"))

      const files = (agentId: string) =>
        listedByHost(agentId, (host, row) => host.ListFiles({ folder: row.folder })).pipe(
          Effect.withSpan("Agents.files"),
        )

      const update = Effect.fn("Agents.update")(function* (
        agentId: string,
        change: Partial<Pick<Agent, "model" | "effort" | "permissionMode">>,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const found = yield* find(agentId)
            const agent = agentWith(found.agent, change)

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
        return yield* turns.answer(conversationOf(yield* find(agentId)), requestId, given)
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
            yield* turns.removeUnsent(agentId)
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
                forReview ? [] : [agentWith(agent, { sandbox: statuses.get(agent.id) ?? null })],
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
        newAgentCommands: (engine, place, repository) => {
          const placement = placementFor(place)

          return placement.engines.includes(engine)
            ? placement.commands(engine, repository)
            : Effect.succeed([])
        },
        commands,
        newAgentFiles: (place, repository, baseBranch) =>
          placementFor(place).files(repository, baseBranch),
        files,
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
