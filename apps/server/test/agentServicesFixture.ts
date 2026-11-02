import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import {
  AgentEngine,
  AgentModels,
  applyTranscriptUpdate,
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
import { Sandboxes } from "../src/Sandboxes"
import { LocalPlacement } from "../src/LocalPlacement"
import { Transcripts } from "../src/Transcripts"

interface Started {
  readonly agentId: string
  readonly turnId: string
  readonly input: SentMessage
  readonly settings: TurnSettings
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
}

/** Real business services and host handlers, with execution replaced at AgentAdapter. */
export const agentServicesFixture = Effect.gen(function* () {
  const database = yield* Layer.build(
    SqliteMigrator.layer({ loader: migrationLoader }).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
    ),
  )

  const started = yield* Queue.unbounded<Started>()
  const answers: Array<{ readonly requestId: string; readonly answer: RequestAnswer }> = []
  const stops: Array<string> = []
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
          steer: () => Effect.void,
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

  const boot = Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))

    const build = Effect.gen(function* () {
      const hostContext = yield* Layer.build(
        HostAgents.make({ "claude-code": adapter, pi: adapter }).pipe(
          Layer.provideMerge(Journal.layer),
        ),
      )

      const client = yield* RpcTest.makeClient(AgentHostRpcs).pipe(
        Effect.provide(AgentHostHandlers),
        Effect.provide(Layer.mock(Changes)({})),
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
          Layer.provideMerge(Transcripts.layer),
          Layer.provide(Layer.succeed(LocalPlacement, placement)),
          Layer.provide(
            Layer.succeed(
              Sandboxes,
              Sandboxes.of({
                providers: [],
                placement: () => placement,
                subscribeLost: Effect.succeed(Stream.never),
              }),
            ),
          ),
          Layer.provide(Layer.mock(ActivityLog)({ record: () => Effect.void })),
        ),
      )

      const transcripts = Context.get(services, Transcripts)
      yield* followJournal(transcripts, client, { saved: 0 }).pipe(Effect.forkScoped)

      return Context.get(services, Agents)
    }).pipe(Effect.provideContext(database), Scope.provide(scope))

    return { agents: yield* build, close: Scope.close(scope, Exit.void) }
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
        place: thisMac,
      }),
    restart: running.close.pipe(Effect.andThen(boot)),
  }
})
