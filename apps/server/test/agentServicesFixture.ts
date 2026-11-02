import { NodeSocket } from "@effect/platform-node"
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
  type SentMessage,
  type Transcript,
  type RequestNotWaiting,
  thisMac,
} from "@glass/contracts"
import { Context, Deferred, Effect, Exit, Layer, Option, Queue, Scope, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { RpcTest } from "effect/rpc"
import type { AgentAdapter, AgentSession } from "../src/agentHost/adapter"
import { Changes } from "../src/agentHost/Changes"
import { AgentHostHandlers } from "../src/agentHost/handlers"
import { HostAgents } from "../src/agentHost/HostAgents"
import { Journal } from "../src/agentHost/Journal"
import { AgentHostRpcs, type HostAgentError, type TurnSettings } from "../src/agentHost/protocol"
import { ActivityLog } from "../src/ActivityLog"
import { Agents } from "../src/Agents"
import { followJournal } from "../src/hostJournal"
import { migrationLoader } from "../src/Migrations"
import { Plugins } from "../src/Plugins"
import { Sandboxes } from "../src/Sandboxes"
import { LocalPlacement } from "../src/LocalPlacement"
import { Transcripts } from "../src/Transcripts"
import { inProcessSandboxes } from "./inProcessSandboxes"

interface Started {
  readonly agentId: string
  readonly turnId: string
  readonly input: SentMessage
  readonly settings: TurnSettings
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
}

/**
 * Real business services and host handlers, with execution replaced at AgentAdapter and Changes. A
 * Sandbox's host runs in this process too, behind the real Sandboxes service and its HTTP protocol.
 */
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
  let leftOnStop: ReadonlyArray<SentMessage> = []
  let nextAnswer: Effect.Effect<void, HostAgentError | RequestNotWaiting> = Effect.void
  let nextName = 0
  const models = Effect.succeed(new AgentModels({ defaultModel: null, models: [] }))

  const adapter: AgentAdapter = {
    models,
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
  })

  const hostServices = () =>
    Layer.mergeAll(
      HostAgents.make({ "claude-code": adapter, pi: adapter }).pipe(
        Layer.provideMerge(Journal.layer),
      ),
      Layer.succeed(Changes, changes),
    )

  const sandboxes = inProcessSandboxes(hostServices)
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
            ),
          ),
          Layer.provideMerge(Transcripts.layer),
          Layer.provide(Layer.succeed(LocalPlacement, placement)),
          Layer.provide(Layer.mock(ActivityLog)({ record: () => Effect.void })),
        ),
      )

      const transcripts = Context.get(services, Transcripts)
      yield* followJournal(transcripts, client, { saved: 0 }).pipe(Effect.forkScoped)

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
    sql: Context.get(database, SqlClient.SqlClient),
    answers,
    stops,
    starts,
    steers,
    sandboxes,
    changesAsked,
    /** What the host's Changes report: `files` since the base, and whether any are uncommitted. */
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
    /** Later program starts wait until `releaseStart`. */
    holdStart: Deferred.make<void>().pipe(
      Effect.map((gate) => {
        starting = gate
      }),
    ),
    releaseStart: Effect.suspend(() =>
      starting === null ? Effect.void : Deferred.succeed(starting, undefined).pipe(Effect.asVoid),
    ),
    /** Ends the Agent's program, as a crash would. */
    exit: (agentId: string) =>
      Effect.suspend(() => {
        const exited = exits.get(agentId)

        return exited === undefined ? Effect.void : Deferred.succeed(exited, undefined)
      }).pipe(Effect.asVoid),
    /** What the program answers Stop with: the Steers it hadn't taken in. */
    leaveOnStop: (messages: ReadonlyArray<SentMessage>) =>
      Effect.sync(() => {
        leftOnStop = messages
      }),
    transcript,
    create: (
      permissionMode: TurnSettings["permissionMode"] = null,
      engine: "claude-code" | "pi" = "claude-code",
      place: AgentPlace = thisMac,
    ) =>
      running.agents.create({
        repository: new FollowedRepository({ owner: "glass-test", repo: "greeter" }),
        baseBranch: "main",
        message: "Start",
        images: [],
        engine,
        model: null,
        effort: null,
        permissionMode,
        place,
      }),
    restart: running.close.pipe(Effect.andThen(boot)),
  }
})
