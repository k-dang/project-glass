import { assert, it } from "@effect/vitest"
import {
  AgentContext,
  AnswerQuestion,
  PullRequestContext,
  PullRequestRef,
  Revision,
  TextPart,
  localPlace,
  TurnDone,
  TurnInterrupted,
  TurnStopped,
  type Turn,
} from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
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
      yield* f.client.AddToDo({ title: "Reply to Sam" })

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
