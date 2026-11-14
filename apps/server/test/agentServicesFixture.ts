import { NodeFileSystem, NodeSocket } from "@effect/platform-node"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import {
  AgentEngine,
  AgentModels,
  type AgentPlace,
  applyTranscriptUpdate,
  type ChangedFile,
  emptyTranscript,
  FollowedRepository,
  type AgentEvent,
  type RequestAnswer,
  type MessageWithContext,
  type Transcript,
  type RequestNotWaiting,
  localPlace,
} from "@glass/contracts"
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect"
import { RpcTest } from "effect/rpc"
import type { AgentAdapter, AgentSession } from "../src/agentHost/adapter"
import type { DeliveredTurn } from "../src/agentHost/deliveredMessage"
import { Changes } from "../src/agentHost/Changes"
import { AgentHostHandlers } from "../src/agentHost/handlers"
import { HostAgents } from "../src/agentHost/HostAgents"
import { Journal } from "../src/agentHost/Journal"
import { AgentHostRpcs, type HostAgentError, type TurnSettings } from "../src/agentHost/protocol"
import { ActivityLog } from "../src/ActivityLog"
import { Agents } from "../src/Agents"
import { ConversationTurns } from "../src/ConversationTurns"
import { FeedbackNotes } from "../src/FeedbackNotes"
import { followJournal } from "../src/hostJournal"
import { migrationLoader } from "../src/Migrations"
import { Plugins } from "../src/Plugins"
import { Sandboxes } from "../src/Sandboxes"
import { LocalSkills } from "../src/LocalSkills"
import { SkillPacks } from "../src/SkillPacks"
import { ServerConfig } from "../src/ServerConfig"
import { GitHubClient } from "../src/github/GitHubClient"
import { LocalPlacement } from "../src/LocalPlacement"
import { ToDos } from "../src/ToDos"
import { Transcripts } from "../src/Transcripts"
import { inProcessSandboxes } from "./inProcessSandboxes"

interface Started {
  readonly agentId: string
  readonly turnId: string
  readonly input: DeliveredTurn
  readonly settings: TurnSettings
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
}

export const agentServicesFixture = Effect.gen(function* () {
  const database = yield* Layer.build(
    SqliteMigrator.layer({ loader: migrationLoader }).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
    ),
  )

  const started = yield* Queue.unbounded<Started>()
  const answers: Array<{ readonly requestId: string; readonly answer: RequestAnswer }> = []
  const stops: Array<string> = []
  const steers: Array<{ readonly agentId: string; readonly message: string }> = []
  const changesAsked: Array<{ readonly folder: string; readonly baseRef: string }> = []
  let changed: ReadonlyArray<ChangedFile> = []
  let uncommitted = false
  const starts: Array<string> = []
  const exits = new Map<string, Deferred.Deferred<void>>()
  let starting: Deferred.Deferred<void> | null = null
  let leftOnStop: ReadonlyArray<MessageWithContext> = []
  let nextAnswer: Effect.Effect<void, HostAgentError | RequestNotWaiting> = Effect.void
  let nextName = 0
  const models = Effect.succeed(new AgentModels({ defaultModel: null, models: [] }))

  const adapter: AgentAdapter = {
    models,
    commands: (folder) => Effect.succeed([{ name: "greet", description: folder }]),
    start: ({ conversation, report }) =>
      Effect.gen(function* () {
        starts.push(conversation)

        if (starting !== null) yield* Deferred.await(starting)

        const exited = yield* Deferred.make<void>()
        exits.set(conversation, exited)
        let settings: TurnSettings = { model: null, effort: null, permissionMode: null }

        return {
          configure: (next) =>
            Effect.sync(() => {
              settings = next
            }),
          startTurn: (turnId, input) =>
            Queue.offer(started, {
              agentId: conversation,
              turnId,
              input,
              settings,
              emit: report,
            }).pipe(Effect.asVoid),
          steer: ({ message }) =>
            Effect.sync(() => {
              steers.push({ agentId: conversation, message })
            }),
          stopTurn: Effect.sync(() => {
            stops.push(conversation)

            return leftOnStop
          }),
          answer: (requestId, answer) =>
            Effect.suspend(() => {
              answers.push({ requestId, answer })

              return nextAnswer
            }),
          closed: Deferred.await(exited),
          stopped: Deferred.isDone(exited),
        } satisfies AgentSession
      }),
  }

  const changes = Changes.of({
    since: (folder, baseRef) =>
      Effect.sync(() => {
        changesAsked.push({ folder, baseRef })

        return changed
      }),
    uncommitted: () => Effect.sync(() => uncommitted),
    files: () => Effect.succeed([]),
  })

  const hostServices = () =>
    Layer.mergeAll(
      HostAgents.make({ "claude-code": adapter, pi: adapter, opencode: adapter }).pipe(
        Layer.provideMerge(Journal.layer),
        Layer.provide(NodeFileSystem.layer),
      ),
      Layer.succeed(Changes, changes),
    )

  const sandboxes = yield* inProcessSandboxes(hostServices)
  yield* Effect.addFinalizer(() => sandboxes.closeAll)

  const boot = Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))

    const build = Effect.gen(function* () {
      const hostContext = yield* Layer.build(hostServices())

      const client = yield* RpcTest.makeClient(AgentHostRpcs).pipe(
        Effect.provide(AgentHostHandlers),
        Effect.provideContext(hostContext),
      )

      const placement = LocalPlacement.of({
        engines: AgentEngine.literals,
        models: () => models,
        commands: (engine) =>
          client.ListCommands({ engine, folder: "checkout", skills: [] }).pipe(Effect.orDie),
        defaultBranch: () => Effect.succeed(null),
        branches: () => Effect.succeed([]),
        files: () => Effect.succeed([]),
        place: () =>
          Effect.sync(() => {
            const name = `agent/test-${++nextName}`

            return { name, folder: name, discard: Effect.void }
          }),
        host: () => Effect.succeed(client),
        runningHost: () => Effect.succeedSome(client),
        hostOnceMade: () => Effect.succeedSome(client),
        baseRef: () => Effect.succeed("main"),
        remove: () => Effect.void,
        subscribeLost: Effect.succeed(Stream.never),
      })

      const services = yield* Layer.build(
        Agents.layer.pipe(
          Layer.provideMerge(
            Sandboxes.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  Plugins,
                  Plugins.of({ sandboxProviders: new Map([["fake", sandboxes.provider]]) }),
                ),
              ),
              Layer.provide(NodeSocket.layerWebSocketConstructor),
              Layer.provide(Layer.mock(GitHubClient)({})),
              Layer.provide(
                ServerConfig.layer.pipe(
                  Layer.provide(
                    ConfigProvider.layer(
                      ConfigProvider.fromEnvRecord({ GLASS_PORT: "0", GLASS_TOKEN: "unused" }),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Layer.provide(SkillPacks.layer.pipe(Layer.provide(Layer.mock(GitHubClient)({})))),
          Layer.provide(Layer.mock(LocalSkills)({})),
          Layer.provide(ConversationTurns.layer),
          Layer.provide(FeedbackNotes.layer),
          Layer.provideMerge(Transcripts.layer),
          Layer.provide(Layer.succeed(LocalPlacement, placement)),
          Layer.provide(ToDos.layer),
          Layer.provide(Layer.mock(ActivityLog)({ record: () => Effect.void })),
          Layer.provide(NodeFileSystem.layer),
        ),
      )

      const transcripts = Context.get(services, Transcripts)
      yield* followJournal((agentId, events) => transcripts.save(agentId, events), client, {
        saved: 0,
      }).pipe(Effect.forkScoped)

      return { agents: Context.get(services, Agents), sandboxes: Context.get(services, Sandboxes) }
    }).pipe(Effect.provideContext(database), Scope.provide(scope))

    const built = yield* build

    return {
      agents: built.agents,
      sandboxProviders: built.sandboxes.providers,
      close: Scope.close(scope, Exit.void),
    }
  })

  const running = yield* boot

  const transcript = (
    agentId: string,
    until: (value: Transcript) => boolean,
    agents = running.agents,
  ) =>
    agents.transcript(agentId).pipe(
      Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
      Stream.filter(until),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

  return {
    ...running,
    answers,
    stops,
    starts,
    steers,
    sandboxes,
    changesAsked,
    setChanges: (next: {
      readonly files: ReadonlyArray<ChangedFile>
      readonly uncommitted: boolean
    }) =>
      Effect.sync(() => {
        changed = next.files
        uncommitted = next.uncommitted
      }),
    started: Queue.take(started),
    failAnswers: (error: HostAgentError | RequestNotWaiting) =>
      Effect.sync(() => {
        nextAnswer = Effect.fail(error)
      }),
    holdStart: Deferred.make<void>().pipe(
      Effect.map((gate) => {
        starting = gate
      }),
    ),
    releaseStart: Effect.suspend(() =>
      starting === null ? Effect.void : Deferred.succeed(starting, undefined).pipe(Effect.asVoid),
    ),
    exit: (agentId: string) =>
      Effect.suspend(() => {
        const exited = exits.get(agentId)

        return exited === undefined ? Effect.void : Deferred.succeed(exited, undefined)
      }).pipe(Effect.asVoid),
    leaveOnStop: (messages: ReadonlyArray<MessageWithContext>) =>
      Effect.sync(() => {
        leftOnStop = messages
      }),
    transcript,
    create: (
      permissionMode: TurnSettings["permissionMode"] = null,
      engine: "claude-code" | "pi" = "claude-code",
      place: AgentPlace = localPlace,
    ) =>
      running.agents.create({
        repository: new FollowedRepository({ owner: "glass-test", repo: "greeter" }),
        baseBranch: "main",
        message: "Start",
        images: [],
        skillPacks: [],
        localSkills: false,
        engine,
        model: null,
        effort: null,
        permissionMode,
        place,
      }),
    restart: running.close.pipe(Effect.andThen(boot)),
  }
})
