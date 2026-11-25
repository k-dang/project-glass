import { NodeFileSystem, NodeSocket } from "@effect/platform-node"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import {
  AgentHarness,
  AgentModels,
  type ThreadPlace,
  applyTranscriptUpdate,
  type ChangedFile,
  emptyTranscript,
  FollowedRepository,
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
import type { HarnessAdapter, HarnessSession } from "../src/agentHost/adapter"
import type { DeliveredTurn } from "../src/agentHost/deliveredMessage"
import { Changes } from "../src/Changes"
import { FolderFiles } from "../src/agentHost/FolderFiles"
import { AgentHostHandlers } from "../src/agentHost/handlers"
import { HostThreads } from "../src/agentHost/HostThreads"
import { HostGlassTools } from "../src/agentHost/HostGlassTools"
import { Journal } from "../src/agentHost/Journal"
import {
  AgentHostRpcs,
  type HostThreadError,
  type HostEvent,
  type TurnSettings,
} from "../src/agentHost/protocol"
import { ActivityLog } from "../src/ActivityLog"
import { BranchNames } from "../src/BranchNames"
import { Threads } from "../src/Threads"
import { ThreadTurns } from "../src/ThreadTurns"
import { FeedbackNotes } from "../src/FeedbackNotes"
import { followJournal, greet } from "../src/hostJournal"
import { migrationLoader } from "../src/Migrations"
import { Plugins } from "../src/Plugins"
import { Sandboxes } from "../src/Sandboxes"
import { GlassToolRelay } from "../src/mcp/GlassToolRelay"
import { LocalSkills } from "../src/LocalSkills"
import { SkillPacks } from "../src/SkillPacks"
import { ServerConfig } from "../src/ServerConfig"
import { GitHubClient } from "../src/github/GitHubClient"
import { LocalPlacement } from "../src/LocalPlacement"
import { ToDos } from "../src/ToDos"
import { Transcripts } from "../src/Transcripts"
import { isolatedHome } from "./harness"
import { inProcessSandboxes } from "./inProcessSandboxes"

interface Started {
  readonly threadId: string
  readonly turnId: string
  readonly input: DeliveredTurn
  readonly settings: TurnSettings
  readonly emit: (event: HostEvent) => Effect.Effect<void>
}

export const threadServicesFixture = Effect.gen(function* () {
  const home = yield* isolatedHome

  const database = yield* Layer.build(
    SqliteMigrator.layer({ loader: migrationLoader }).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
    ),
  )

  const started = yield* Queue.unbounded<Started>()
  const answers: Array<{ readonly requestId: string; readonly answer: RequestAnswer }> = []
  const stops: Array<string> = []
  const taskStops: Array<{ readonly threadId: string; readonly taskId: string }> = []
  const steers: Array<{ readonly threadId: string; readonly message: string }> = []
  const changesAsked: Array<{ readonly folder: string; readonly baseRef: string }> = []
  let changed: ReadonlyArray<ChangedFile> = []
  let uncommitted = false
  const starts: Array<string> = []
  const exits = new Map<string, Deferred.Deferred<void>>()
  let starting: Deferred.Deferred<void> | null = null

  let readingSkills: {
    readonly reached: Deferred.Deferred<void>
    readonly done: Deferred.Deferred<void>
  } | null = null

  let leftOnStop: ReadonlyArray<MessageWithContext> = []
  let nextAnswer: Effect.Effect<void, HostThreadError | RequestNotWaiting> = Effect.void
  let nextName = 0
  let suggestion: Effect.Effect<Option.Option<string>> = Effect.succeedNone
  let takenBranches: ReadonlyArray<string> = []
  const models = Effect.succeed(new AgentModels({ defaultModel: null, models: [] }))

  const adapter: HarnessAdapter = {
    models,
    commands: (folder) => Effect.succeed([{ name: "greet", description: folder }]),
    start: ({ thread, report }) =>
      Effect.gen(function* () {
        starts.push(thread)

        if (starting !== null) yield* Deferred.await(starting)

        const exited = yield* Deferred.make<void>()
        exits.set(thread, exited)
        let settings: TurnSettings = { model: null, effort: null, permissionMode: null }

        return {
          configure: (next) =>
            Effect.sync(() => {
              settings = next
            }),
          startTurn: (turnId, input) =>
            Queue.offer(started, {
              threadId: thread,
              turnId,
              input,
              settings,
              emit: report,
            }).pipe(Effect.asVoid),
          steer: ({ message }) =>
            Effect.sync(() => {
              steers.push({ threadId: thread, message })
            }),
          stopBackgroundTask: (taskId) =>
            Effect.sync(() => {
              taskStops.push({ threadId: thread, taskId })
            }),
          stopTurn: () =>
            Effect.sync(() => {
              stops.push(thread)

              return leftOnStop
            }),
          answer: (requestId, answer) =>
            Effect.suspend(() => {
              answers.push({ requestId, answer })

              return nextAnswer
            }),
          closed: Deferred.await(exited),
          stopped: Deferred.isDone(exited),
        } satisfies HarnessSession
      }),
  }

  const changes = Changes.of({
    since: (folder, baseRef) =>
      Effect.sync(() => {
        changesAsked.push({ folder, baseRef })

        return changed
      }),
    uncommitted: () => Effect.sync(() => uncommitted),
    branch: (folder) => Effect.succeed(folder),
    files: () => Effect.succeed([]),
  })

  const hostServices = () =>
    Layer.mergeAll(
      HostThreads.make({ "claude-code": adapter, pi: adapter }).pipe(
        Layer.provideMerge(HostGlassTools.layer),
        Layer.provideMerge(Journal.layer),
        Layer.provide(NodeFileSystem.layer),
      ),
      Layer.succeed(Changes, changes),
      FolderFiles.layer.pipe(Layer.provide(NodeFileSystem.layer)),
    )

  const sandboxes = yield* inProcessSandboxes(hostServices)
  yield* Effect.addFinalizer(() => sandboxes.closeAll)

  const boot = Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))

    const build = Effect.gen(function* () {
      const hostContext = yield* Layer.build(hostServices())
      yield* Context.get(hostContext, HostGlassTools).listening(0)

      const client = yield* RpcTest.makeClient(AgentHostRpcs).pipe(
        Effect.provide(AgentHostHandlers),
        Effect.provideContext(hostContext),
      )

      const placement = LocalPlacement.of({
        harnesses: AgentHarness.literals,
        models: () => models,
        commands: (harness) =>
          client
            .ListCommands({ harness, folder: "checkout", role: "Work", skills: [] })
            .pipe(Effect.orDie),
        defaultBranch: () => Effect.succeed(null),
        branches: () => Effect.succeed([]),
        files: () => Effect.succeed([]),
        place: () =>
          Effect.sync(() => {
            const name = `agent/test-${++nextName}`

            return { branch: name, folder: name, discard: Effect.void }
          }),
        takenBranches: () => Effect.succeed([]),
        useBranch: () => Effect.void,
        prepareHost: () => Effect.succeed(client),
        hostIfPrepared: () => Effect.succeedSome(client),
        connectedHost: () => Effect.succeedSome(client),
        baseRef: () => Effect.succeed("main"),
        remove: () => Effect.void,
        subscribeLost: Effect.succeed(Stream.never),
        resume: Effect.succeed(new Set()),
      })

      const services = yield* Layer.build(
        Threads.layer.pipe(
          Layer.provideMerge(
            Sandboxes.layer.pipe(
              Layer.provide(Layer.mock(GlassToolRelay)({ toolsFor: () => Effect.succeed([]) })),
              Layer.provide(
                Layer.succeed(
                  Plugins,
                  Plugins.of({ sandboxProviders: new Map([["fake", sandboxes.provider]]) }),
                ),
              ),
              Layer.provide(NodeSocket.layerWebSocketConstructor),
              Layer.provide(
                Layer.mock(GitHubClient)({
                  repositoryBranches: () => Effect.sync(() => takenBranches),
                }),
              ),
              Layer.provide(
                ServerConfig.layer.pipe(
                  Layer.provide(
                    ConfigProvider.layer(
                      ConfigProvider.fromEnvRecord({
                        GLASS_PORT: "0",
                        GLASS_TOKEN: "unused",
                        GLASS_HOME: home,
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Layer.provide(SkillPacks.layer.pipe(Layer.provide(Layer.mock(GitHubClient)({})))),
          Layer.provide(
            Layer.mock(LocalSkills)({
              source: () =>
                Effect.suspend(() =>
                  readingSkills === null
                    ? Effect.void
                    : Deferred.succeed(readingSkills.reached, undefined).pipe(
                        Effect.andThen(Deferred.await(readingSkills.done)),
                      ),
                ).pipe(Effect.as(Option.none())),
            }),
          ),
          Layer.provide(ThreadTurns.layer),
          Layer.provide(FeedbackNotes.layer),
          Layer.provideMerge(Transcripts.layer),
          Layer.provide(Layer.succeed(LocalPlacement, placement)),
          Layer.provideMerge(ToDos.layer),
          Layer.provide(
            ServerConfig.layer.pipe(
              Layer.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromEnvRecord({
                    GLASS_PORT: "0",
                    GLASS_TOKEN: "unused",
                    GLASS_HOME: home,
                  }),
                ),
              ),
            ),
          ),
          Layer.provide(Layer.mock(ActivityLog)({ record: () => Effect.void })),
          Layer.provide(Layer.succeed(BranchNames, BranchNames.of({ suggest: () => suggestion }))),
          Layer.provide(NodeFileSystem.layer),
        ),
      )

      const transcripts = Context.get(services, Transcripts)
      const host = yield* greet(client)
      yield* followJournal(
        (threadId, events) => transcripts.save(threadId, events),
        client,
        { host, saved: 0 },
        () => 0,
      ).pipe(Effect.forkScoped)

      return {
        threads: Context.get(services, Threads),
        sandboxes: Context.get(services, Sandboxes),
        toDos: Context.get(services, ToDos),
      }
    }).pipe(Effect.provideContext(database), Scope.provide(scope))

    const built = yield* build

    return {
      threads: built.threads,
      sandboxProviders: built.sandboxes.providers,
      toDos: built.toDos,
      close: Scope.close(scope, Exit.void),
    }
  })

  const running = yield* boot

  const transcript = (
    threadId: string,
    until: (value: Transcript) => boolean,
    threads = running.threads,
  ) =>
    threads.transcript(threadId).pipe(
      Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
      Stream.filter(until),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

  return {
    ...running,
    answers,
    stops,
    taskStops,
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
    suggestBranch: (next: Effect.Effect<Option.Option<string>>) =>
      Effect.sync(() => {
        suggestion = next
      }),
    takeBranches: (taken: ReadonlyArray<string>) =>
      Effect.sync(() => {
        takenBranches = taken
      }),
    failAnswers: (error: HostThreadError | RequestNotWaiting) =>
      Effect.sync(() => {
        nextAnswer = Effect.fail(error)
      }),
    holdStart: Deferred.make<void>().pipe(
      Effect.map((gate) => {
        starting = gate
      }),
    ),
    holdLocalSkills: Effect.gen(function* () {
      const held = { reached: yield* Deferred.make<void>(), done: yield* Deferred.make<void>() }
      readingSkills = held

      return {
        reached: Deferred.await(held.reached),
        release: Deferred.succeed(held.done, undefined).pipe(Effect.asVoid),
      }
    }),
    releaseStart: Effect.suspend(() =>
      starting === null ? Effect.void : Deferred.succeed(starting, undefined).pipe(Effect.asVoid),
    ),
    exit: (threadId: string) =>
      Effect.suspend(() => {
        const exited = exits.get(threadId)

        return exited === undefined ? Effect.void : Deferred.succeed(exited, undefined)
      }).pipe(Effect.asVoid),
    leaveOnStop: (messages: ReadonlyArray<MessageWithContext>) =>
      Effect.sync(() => {
        leftOnStop = messages
      }),
    transcript,
    create: (
      permissionMode: TurnSettings["permissionMode"] = null,
      harness: "claude-code" | "pi" = "claude-code",
      place: ThreadPlace = localPlace,
      localSkills = false,
    ) =>
      running.threads.create({
        repository: new FollowedRepository({ owner: "glass-test", repo: "greeter" }),
        baseBranch: "main",
        message: "Start",
        images: [],
        skillPacks: [],
        localSkills,
        harness,
        model: null,
        effort: null,
        permissionMode,
        place,
      }),
    restart: running.close.pipe(Effect.andThen(boot)),
    restartAfter: <E>(whileClosed: Effect.Effect<void, E>) =>
      running.close.pipe(Effect.andThen(whileClosed), Effect.andThen(boot)),
  }
})
