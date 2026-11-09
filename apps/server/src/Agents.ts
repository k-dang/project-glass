import {
  Agent,
  AgentBusy,
  type AgentSkillPack,
  type AgentEngine,
  AgentError,
  type AgentCommand,
  AgentModels,
  type ConnectionError,
  AgentNotFound,
  type AgentPlace,
  asksPermission,
  AgentStarted,
  type ChangedFile,
  FollowedRepository,
  type InvalidLocalCheckout,
  type MessageDelivery,
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
  localPlace,
  type Transcript,
  type TranscriptUpdate,
  TurnCutOff,
  TurnInterrupted,
  type SentMessage,
} from "@glass/contracts"
import {
  Context,
  Data,
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
import { SqlClient, type SqlError } from "effect/sql"
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
import { type AgentRole, ReviewBrief, ReviewRole, WorkRole } from "./agentHost/protocol"
import { SkillPacks } from "./SkillPacks"
import { Transcripts } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

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

const toRow = (
  { owner, repo, folder, sandboxProvider, forReview, ...agent }: typeof StoredAgent.Type,
  skillPacks: ReadonlyArray<AgentSkillPack>,
): PlacedAgent => ({
  agent: new Agent({
    ...agent,
    skillPacks,
    place:
      sandboxProvider === null ? localPlace : SandboxPlace.make({ providerId: sandboxProvider }),
    repository: new FollowedRepository({ owner, repo }),
    sandbox: null,
  }),
  folder,
  forReview,
})

const agentWith = (agent: Agent, change: Partial<typeof Agent.Type>) =>
  // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into Agent.
  new Agent({ ...agent, ...change })

const sandboxProviderOf = (place: AgentPlace) =>
  Predicate.isTagged(place, "sandbox") ? place.providerId : null

const annotateAgent = ({ id, engine, model, place }: Agent) =>
  annotateUnit({ agent_id: id, engine, model, sandbox_provider: sandboxProviderOf(place) })

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save your Agents. Try again." })

const couldNotSave = (cause: SqlError.SqlError) =>
  Effect.logWarning("Couldn't save an Agent", cause).pipe(
    Effect.andThen(Effect.fail(storageFailure())),
  )

type Purpose = Data.TaggedEnum<{
  Work: { readonly packs: ReadonlyArray<string> }
  Review: { readonly brief: ReviewBrief }
}>

const Purpose = Data.taggedEnum<Purpose>()

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
    readonly readTranscript: (
      agentId: string,
    ) => Effect.Effect<Transcript, AgentNotFound | AgentError>
    readonly transcript: (
      agentId: string,
    ) => Stream.Stream<TranscriptUpdate, AgentNotFound | AgentError>
    readonly engines: (place: AgentPlace) => ReadonlyArray<AgentEngine>
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
    readonly newAgentDefaultBranch: (
      place: AgentPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<string | null, InvalidLocalCheckout | ConnectionError | AgentError>
    readonly newAgentBranches: (
      place: AgentPlace,
      repository: FollowedRepository,
    ) => Effect.Effect<ReadonlyArray<string>, InvalidLocalCheckout | ConnectionError | AgentError>
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
    ) => Effect.Effect<MessageDelivery, AgentNotFound | RequestWaiting | AgentError>
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
      const skillPacks = yield* SkillPacks
      const fs = yield* FileSystem.FileSystem
      const lock = yield* Semaphore.make(1)
      const scope = yield* Scope.Scope

      const stored = yield* sql`
        SELECT id, name, sandbox_provider AS sandboxProvider, owner, repo, base_branch AS baseBranch,
          engine, model, effort, permission_mode AS permissionMode, folder, created_at AS createdAt,
          review_brief IS NOT NULL AS forReview
        FROM agent ORDER BY created_at
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const packsOfAgents = yield* skillPacks.agentPacks.pipe(Effect.orDie)

      const rows = yield* SubscriptionRef.make<ReadonlyArray<PlacedAgent>>(
        stored.map((agent) => toRow(agent, packsOfAgents.get(agent.id) ?? [])),
      )

      const find = Effect.fnUntraced(function* (agentId: string) {
        const found = (yield* SubscriptionRef.get(rows)).find(({ agent }) => agent.id === agentId)

        if (found === undefined) return yield* new AgentNotFound({ agentId })

        yield* annotateAgent(found.agent)

        return found
      })

      const placementFor = (place: AgentPlace): Placement =>
        Predicate.isTagged(place, "sandbox")
          ? sandboxes.placement(place.providerId)
          : localPlacement

      const placementRunning = (
        place: AgentPlace,
        engine: AgentEngine,
      ): Effect.Effect<Placement, AgentError> => {
        const placement = placementFor(place)

        return placement.engines.includes(engine)
          ? Effect.succeed(placement)
          : Effect.fail(
              new AgentError({
                message: "This place doesn't run that Agent program. Pick another.",
              }),
            )
      }

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

      const withSandbox = (agent: Agent) =>
        sandboxes.status(agent.id).pipe(Effect.map((sandbox) => agentWith(agent, { sandbox })))

      const reviewBrief = (row: PlacedAgent) =>
        sql`SELECT review_brief AS brief FROM agent WHERE id = ${row.agent.id}`.pipe(
          Effect.flatMap(decodeBrief),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read a review brief", cause)),
          Effect.mapError(storageFailure),
          Effect.flatMap(([found]) =>
            found === undefined
              ? Effect.fail(new AgentError({ message: "This Agent was removed." }))
              : Effect.succeed(found.brief),
          ),
        )

      const skillsOf = (agentId: string) =>
        skillPacks
          .agentSkills(agentId)
          .pipe(Effect.mapError(({ message }) => new AgentError({ message })))

      const conversationOf = (row: PlacedAgent): Conversation => {
        const placement = placementOf(row)
        const { id, engine, model, effort, permissionMode } = row.agent

        const role: Effect.Effect<AgentRole, AgentError> = row.forReview
          ? reviewBrief(row).pipe(Effect.map((brief) => ReviewRole.make({ brief })))
          : Effect.succeed(WorkRole.make({}))

        return {
          id,
          start: (client) =>
            Effect.all([role, skillsOf(id)], { concurrency: "unbounded" }).pipe(
              Effect.flatMap(([started, skills]) =>
                client.StartAgent({
                  agentId: id,
                  engine,
                  folder: row.folder,
                  role: started,
                  skills,
                }),
              ),
              Effect.asVoid,
            ),
          settings: { model, effort, permissionMode },
          host: placement.host(row),
          runningHost: placement.runningHost(row),
        }
      }

      yield* turns.deliverTurnsOf((agentId) =>
        find(agentId).pipe(
          Effect.map((row) => Option.some(conversationOf(row))),
          Effect.catchTag("AgentNotFound", () => Effect.succeedNone),
        ),
      )

      const outlivedGlass = yield* sandboxes.resume
      yield* transcripts
        .endRunning(
          TurnInterrupted.make({}),
          stored.flatMap(({ id }) => (outlivedGlass.has(id) ? [] : [id])),
        )
        .pipe(Effect.orDie)

      const insert = (placed: PlacedAgent, first: MessageInput, purpose: Purpose) => {
        const { id, place, repository } = placed.agent

        const forget = SubscriptionRef.update(rows, (current) =>
          current.filter((kept) => kept.agent.id !== id),
        )

        return lock
          .withPermits(1)(
            Effect.gen(function* () {
              const agent = agentWith(placed.agent, {
                skillPacks: yield* skillPacks.pinForAgent(
                  id,
                  Purpose.$match(purpose, { Work: ({ packs }) => packs, Review: () => [] }),
                ),
              })

              yield* annotateAgent(agent)
              yield* sql`INSERT INTO agent ${sql.insert({
                id,
                name: agent.name,
                sandbox_provider: sandboxProviderOf(place),
                owner: repository.owner,
                repo: repository.repo,
                base_branch: agent.baseBranch,
                engine: agent.engine,
                model: agent.model,
                effort: agent.effort,
                permission_mode: agent.permissionMode,
                folder: placed.folder,
                created_at: DateTime.formatIso(agent.createdAt),
                review_brief: Purpose.$match(purpose, {
                  Work: () => null,
                  Review: ({ brief }) => encodeBrief(brief),
                }),
              })}`

              yield* SubscriptionRef.update(rows, (current) => [...current, { ...placed, agent }])
              yield* transcripts.startOrQueue(id, { ...first, context: null })

              return agent
            }).pipe(sql.withTransaction),
          )
          .pipe(
            Effect.catchTags({
              SkillPackNotFound: ({ name }) =>
                Effect.fail(
                  new AgentError({
                    message: `The Skill pack ${name} was removed. Choose the Agent's Skill packs again.`,
                  }),
                ),
              SkillPackError: ({ message }) => Effect.fail(new AgentError({ message })),
              SqlError: couldNotSave,
            }),
            Effect.onError(() => forget),
          )
      }

      const createForReview = Effect.fn("Agents.createForReview")(function* (
        input: NewReviewAgent,
      ) {
        const agent = new Agent({
          id: randomUUID(),
          name: input.name,
          place: localPlace,
          repository: input.repository,
          baseBranch: input.revision.base,
          engine: input.engine,
          model: input.model,
          effort: null,
          permissionMode: null,
          skillPacks: [],
          createdAt: yield* DateTime.now,
          sandbox: null,
        })

        return yield* insert(
          { agent, folder: input.checkout, forReview: true },
          { message: input.message, images: [] },
          Purpose.Review({ brief: input.review }),
        )
      })

      const create = Effect.fn("Agents.create")(function* (input: NewAgent) {
        const { repository, baseBranch, engine, model, effort, place } = input
        const { message, images } = input
        const placement = yield* placementRunning(place, engine)

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
          skillPacks: [],
          createdAt: yield* DateTime.now,
          sandbox: null,
        })

        const created = yield* insert(
          { agent, folder, forReview: false },
          { message, images },
          Purpose.Work({ packs: input.skillPacks }),
        ).pipe(Effect.onError(() => discard))

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

        return yield* withSandbox(created)
      })

      const findWritable = (agentId: string) =>
        find(agentId).pipe(Effect.tap(() => sandboxes.refuseIfGone(agentId)))

      const send = Effect.fn("Agents.send")(function* (agentId: string, input: MessageInput) {
        yield* findWritable(agentId)

        return yield* turns.send(agentId, { ...input, context: null })
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
        yield* turns.sendQueued(agentId, queuedId)
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
          skillsOf(row.agent.id).pipe(
            Effect.flatMap((skills) =>
              host.ListCommands({ engine: row.agent.engine, folder: row.folder, skills }),
            ),
          ),
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
            yield* skillPacks.releaseAgent(agentId)
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
        readTranscript: (agentId) => find(agentId).pipe(Effect.andThen(transcripts.read(agentId))),
        engines: (place) => placementFor(place).engines,
        models: (engine, place) =>
          placementRunning(place, engine).pipe(
            Effect.flatMap((placement) => placement.models(engine)),
          ),
        newAgentCommands: (engine, place, repository) =>
          placementRunning(place, engine).pipe(
            Effect.flatMap((placement) => placement.commands(engine, repository)),
          ),
        newAgentDefaultBranch: (place, repository) => placementFor(place).defaultBranch(repository),
        newAgentBranches: (place, repository) => placementFor(place).branches(repository),
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
