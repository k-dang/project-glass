import { assert, it } from "@effect/vitest"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { NodeFileSystem } from "@effect/platform-node"
import {
  AgentContext,
  AnswerQuestion,
  PullRequestContext,
  PullRequestRef,
  Revision,
  TextPart,
  localPlace,
  TurnDone,
  TurnFailed,
  TurnInterrupted,
  TurnStopped,
  type Turn,
} from "@glass/contracts"
import {
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchDeadlines } from "../test/deadlines"
import type { HostClient } from "./Placement"
import { ConversationTurns } from "./ConversationTurns"
import { GlobalConversation } from "./GlobalConversation"
import { HOST_CONTROL_DEADLINE, HOST_DIDNT_ANSWER } from "./hostControl"
import { LocalAgentHost } from "./LocalAgentHost"
import { McpCredentials } from "./mcp/McpCredentials"
import { migrationLoader } from "./Migrations"
import { ServerConfig } from "./ServerConfig"
import { ToDos } from "./ToDos"
import { Transcripts } from "./Transcripts"
import {
  agentsFixture,
  glassCalls,
  globalTurns,
  holding,
  lastText,
  repository,
  sendGlobal,
  settled,
  watchGlobal,
} from "../test/agentsFixture"
import { childProcesses, startedHost } from "../test/agentHostProcesses"

const onPullRequest = PullRequestContext.make({
  pullRequest: new PullRequestRef({ owner: "glass-demo", repo: "greeter", number: 7 }),
  revision: new Revision({ base: "b0", head: "h1" }),
})

it.live("answers a message with no Local checkout, making no worktree or branch", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture

    yield* sendGlobal(f.client, "Say hello")
    const turns = yield* globalTurns(f.client, settled(1))

    assert.deepStrictEqual(turns[0]?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(lastText(turns[0]), TextPart.make({ text: "Reply to: Say hello" }))
    assert.isFalse(existsSync(join(f.home, ".project-glass", "worktrees")))
    assert.deepStrictEqual(yield* f.agents, [])
  }),
)

it.live("keeps each message's captured context with its Turn, including once it was queued", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const onAgent = AgentContext.make({ agentId: "agent-1", name: "agent/swift-otter" })

    yield* sendGlobal(f.client, "hold:first", onPullRequest)
    yield* globalTurns(f.client, holding)
    yield* sendGlobal(f.client, "Next", onAgent)
    const { queued } = yield* watchGlobal(f.client, (transcript) => transcript.queued.length === 1)

    assert.deepStrictEqual(queued[0]?.context, onAgent)

    yield* f.release("first")
    const turns = yield* globalTurns(f.client, settled(2))

    assert.deepStrictEqual(
      turns.map(({ context }) => context),
      [onPullRequest, onAgent],
    )
  }),
)

it.live(
  "restores the transcript, Unsent message, and model after a relaunch, with the running Turn interrupted",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const model = { model: "scripted", effort: null }
      const unsent = { message: "Still writing", images: [] }

      yield* f.client.ChangeGlobalConversationModel(model)
      yield* sendGlobal(f.client, "hold:never", onPullRequest)
      yield* globalTurns(f.client, holding)
      yield* f.client.SaveGlobalUnsentMessage(unsent)

      const restarted = yield* f.restart

      assert.deepStrictEqual(yield* restarted.GetGlobalConversationModel(), model)
      assert.deepStrictEqual(yield* restarted.GetGlobalUnsentMessage(), unsent)

      yield* sendGlobal(restarted, "After")
      const turns = yield* globalTurns(restarted, settled(2))

      assert.deepStrictEqual(
        turns.map(({ ended }) => ended?.ending),
        [TurnInterrupted.make({}), TurnDone.make({})],
      )
      assert.deepStrictEqual(turns[0]?.context, onPullRequest)
      assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "Reply to: After" }))
    }),
)

it.live(
  "gives each start of pi a fresh credential, revoking the last when the agent host stops",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const earlierHosts = childProcesses(process.pid, "scriptedAgentHost.mjs")
      yield* f.client.AddToDo({ title: "Reply to Sam", notes: "" })

      yield* sendGlobal(f.client, "hold:never")
      yield* globalTurns(f.client, holding)

      const host = startedHost(earlierHosts)
      assert.isDefined(host, "the backend has no agent host running")
      process.kill(host, "SIGKILL")
      yield* globalTurns(f.client, settled(1))

      yield* sendGlobal(f.client, "call-ended:list_to_dos")
      yield* sendGlobal(f.client, "call:list_to_dos")
      const [, ended, restarted] = yield* globalTurns(f.client, settled(3))

      assert.deepStrictEqual(glassCalls(ended), [{ status: "failed", output: "Refused with 401" }])
      assert.deepStrictEqual(
        glassCalls(restarted)?.map(({ status }) => status),
        ["done"],
      )
      assert.include(glassCalls(restarted)?.[0]?.output, "Reply to Sam")
    }),
)

it.live("leaves an Agent it created running when its own Turn stops", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

    const newAgent = {
      repository: { owner: repository.owner, repo: repository.repo },
      baseBranch: "main",
      place: localPlace,
      engine: "pi",
      model: null,
      effort: null,
      message: "hold:agent",
    }

    yield* sendGlobal(f.client, `call:create_agent ${JSON.stringify(newAgent)}\nhold:never`)
    yield* globalTurns(f.client, holding)
    const [created] = yield* f.agents
    assert.isDefined(created)
    yield* f.transcript(created.id, holding)

    yield* f.client.StopGlobalTurn()
    const [stopped] = yield* globalTurns(f.client, settled(1))

    assert.deepStrictEqual(stopped?.ended?.ending, TurnStopped.make({}))
    assert.deepStrictEqual(
      glassCalls(stopped)?.map(({ status }) => status),
      ["done"],
    )

    yield* f.release("agent")
    const [worked] = yield* f.transcript(created.id, settled(1))

    assert.deepStrictEqual(worked?.ended?.ending, TurnDone.make({}))
  }),
)

const shownSession = (turn: Turn | undefined) => {
  const [shown] = turn?.parts ?? []

  return Predicate.isTagged(shown, "Text") ? shown.text : undefined
}

it.live(
  "starts fresh in a new pi session, carrying over the model and Unsent message and keeping the old transcript readable",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const model = { model: "scripted", effort: null }
      const unsent = { message: "Still writing", images: [] }

      yield* f.client.ChangeGlobalConversationModel(model)
      yield* sendGlobal(f.client, "show the session")
      const [before] = yield* globalTurns(f.client, settled(1))
      yield* f.client.SaveGlobalUnsentMessage(unsent)

      yield* f.client.StartGlobalConversationFresh()

      assert.deepStrictEqual(yield* globalTurns(f.client, () => true), [])
      assert.deepStrictEqual(yield* f.client.GetGlobalConversationModel(), model)
      assert.deepStrictEqual(yield* f.client.GetGlobalUnsentMessage(), unsent)

      yield* sendGlobal(f.client, "show the session")
      const [after] = yield* globalTurns(f.client, settled(1))
      const [past, ...earlier] = yield* f.client.ListPastGlobalConversations()

      assert.isDefined(past)
      assert.deepStrictEqual(earlier, [])
      assert.strictEqual(shownSession(before), past.id)
      assert.notStrictEqual(shownSession(after), past.id)

      const { turns } = yield* f.client.ReadPastGlobalConversation({ id: past.id })

      assert.deepStrictEqual(turns, before === undefined ? [] : [before])
    }),
)

it.live(
  "refuses to start fresh while it waits on the user, runs a Turn, or has a Queued message",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture

      const refusal = f.client.StartGlobalConversationFresh().pipe(
        Effect.flip,
        Effect.map((error) =>
          Predicate.isTagged(error, "StartFreshRefused") ? error.reason : error,
        ),
      )

      yield* sendGlobal(f.client, "Please ask a question")

      const [asking] = yield* globalTurns(f.client, (turns) =>
        turns.some(({ parts }) => parts.some((part) => Predicate.isTagged(part, "Question"))),
      )

      const question = asking?.parts.find((part) => Predicate.isTagged(part, "Question"))
      assert.strictEqual(yield* refusal, "waiting")
      yield* f.client.AnswerGlobalRequest({
        requestId: question?.requestId ?? "",
        answer: AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
      })
      yield* globalTurns(f.client, settled(1))

      yield* sendGlobal(f.client, "hold:never")
      yield* globalTurns(f.client, holding)
      assert.strictEqual(yield* refusal, "running")

      yield* sendGlobal(f.client, "Next")
      yield* watchGlobal(f.client, ({ queued }) => queued.length === 1)
      yield* f.client.StopGlobalTurn()
      yield* watchGlobal(
        f.client,
        ({ turns, queued }) => queued.length === 1 && turns.every(({ ended }) => ended !== null),
      )
      assert.strictEqual(yield* refusal, "queued")

      assert.deepStrictEqual(yield* f.client.ListPastGlobalConversations(), [])
    }),
)

const decodeSession = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ sessionId: Schema.String })),
)

const message = (text: string) => ({ message: text, images: [], context: null })

const holdHost = (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined)
    yield* Deferred.await(release)
  })

const openGlobal = (client: HostClient) => {
  const home = mkdtempSync(join(tmpdir(), "glass-host-"))

  const host = LocalAgentHost.of({
    client: Effect.succeed(client),
    running: Effect.succeed(Option.some(client)),
    lifetimeOf: () => Scope.Scope.pipe(Effect.map((scope) => Option.some(scope))),
    subscribeStopped: Effect.succeed(Stream.empty),
  })

  const layer = GlobalConversation.layer.pipe(
    Layer.provide(Layer.succeed(LocalAgentHost, host)),
    Layer.provide(
      Layer.succeed(
        McpCredentials,
        McpCredentials.of({
          issue: () => Effect.succeed(Redacted.make("bearer")),
          authenticate: () => Option.none(),
          endpoint: Effect.succeed("http://127.0.0.1:9"),
          listening: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(ServerConfig, {
        port: 0,
        token: Redacted.make("test-launch-token"),
        allowedOrigins: new Set<string>(),
        githubApiUrl: "http://127.0.0.1",
        agentHostBundle: "agentHost.mjs",
        gitRemote: "https://github.com",
        dataDirectory: home,
        homeDirectory: home,
      }),
    ),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(ConversationTurns.layer),
    Layer.provideMerge(Transcripts.layer),
    Layer.provideMerge(Layer.mock(ToDos)({})),
    Layer.provideMerge(SqliteMigrator.layer({ loader: migrationLoader })),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )

  return { home, layer }
}

it.effect(
  "lets Start fresh and mark-seen finish once a stalled StopTurn times out",
  () =>
    Effect.gen(function* () {
      const { watched, deadlineSet } = yield* watchDeadlines(
        Duration.toMillis(HOST_CONTROL_DEADLINE),
      )
      const started = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const client = {
        StartAgent: () => Effect.succeed("started" as const),
        StartTurn: () => Deferred.succeed(started, undefined),
        StopTurn: () => holdHost(entered, release).pipe(Effect.as(null)),
        StopAgent: () => Effect.void,
        AnswerRequest: () => Effect.die("This test does not call AnswerRequest"),
        Steer: () => Effect.die("This test does not call Steer"),
      } as HostClient

      const { layer } = openGlobal(client)

      yield* Effect.gen(function* () {
        const global = yield* GlobalConversation
        const transcripts = yield* Transcripts
        const sql = yield* SqlClient.SqlClient

        yield* Effect.forkChild(global.send(message("Hello")))
        yield* Deferred.await(started)

        const [session] = yield* sql`SELECT session_id AS sessionId FROM global_conversation`.pipe(
          Effect.flatMap(decodeSession),
          Effect.orDie,
        )
        assert.isDefined(session)

        const stopping = yield* Effect.forkChild(global.stop)
        yield* Deferred.await(entered)
        yield* deadlineSet
        assert.isUndefined(stopping.pollUnsafe())

        const seenAt = yield* DateTime.now
        const fresh = yield* Effect.forkChild(global.startFresh)
        const seen = yield* Effect.forkChild(global.markSeen(seenAt))
        assert.isUndefined(fresh.pollUnsafe())
        assert.isUndefined(seen.pollUnsafe())

        yield* TestClock.adjust(HOST_CONTROL_DEADLINE)
        assert.isDefined(fresh.pollUnsafe())
        assert.isDefined(seen.pollUnsafe())
        yield* Fiber.join(stopping)
        yield* Fiber.join(fresh)
        yield* Fiber.join(seen)

        const { turns } = yield* transcripts.read(session.sessionId)
        assert.deepStrictEqual(turns[0]?.ended?.ending, TurnStopped.make({}))
      }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, watched))
    }),
)

it.effect(
  "refuses Start fresh while StartTurn is stalled, then starts once that Turn has failed",
  () =>
    Effect.gen(function* () {
      const { watched, deadlineSet } = yield* watchDeadlines(
        Duration.toMillis(HOST_CONTROL_DEADLINE),
      )
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const client = {
        StartAgent: () => Effect.succeed("started" as const),
        StartTurn: () => holdHost(entered, release),
        StopTurn: () => Effect.succeed(null),
        StopAgent: () => Effect.void,
        AnswerRequest: () => Effect.die("This test does not call AnswerRequest"),
        Steer: () => Effect.die("This test does not call Steer"),
      } as HostClient

      const { layer } = openGlobal(client)

      yield* Effect.gen(function* () {
        const global = yield* GlobalConversation
        const transcripts = yield* Transcripts
        const sql = yield* SqlClient.SqlClient

        const sending = yield* Effect.forkChild(global.send(message("Hello")))
        yield* Deferred.await(entered)
        yield* deadlineSet

        const refused = yield* global.startFresh.pipe(
          Effect.flip,
          Effect.map((error) => (Predicate.isTagged(error, "StartFreshRefused") ? error.reason : error)),
        )
        assert.strictEqual(refused, "running")
        yield* global.markSeen(yield* DateTime.now)
        assert.equal(yield* Fiber.join(sending), undefined)

        yield* TestClock.adjust(HOST_CONTROL_DEADLINE)

        const [session] = yield* sql`SELECT session_id AS sessionId FROM global_conversation`.pipe(
          Effect.flatMap(decodeSession),
          Effect.orDie,
        )
        assert.isDefined(session)

        const { turns } = yield* transcripts.read(session.sessionId)
        assert.deepStrictEqual(turns[0]?.ended?.ending, TurnFailed.make({ reason: HOST_DIDNT_ANSWER }))

        yield* global.startFresh
        const [next] = yield* sql`SELECT session_id AS sessionId FROM global_conversation`.pipe(
          Effect.flatMap(decodeSession),
          Effect.orDie,
        )
        assert.isDefined(next)
        assert.notStrictEqual(next.sessionId, session.sessionId)
      }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, watched))
    }),
)
