import { assert, it } from "@effect/vitest"
import { AnswerQuestion, localPlace, type NeedsYou, type Turn } from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import {
  agentsFixture,
  glassCalls,
  globalTurns,
  holding,
  lastSettled,
  reported,
  reportedAgents,
  repository,
  sendGlobal,
  settled,
} from "../test/agentsFixture"

/** Escapes "ask" so the scripted Global conversation passes the Agent's request on, not acts on it. */
const createAgent = (message: string) =>
  `call:create_agent ${JSON.stringify({
    repository: { owner: repository.owner, repo: repository.repo },
    baseBranch: "main",
    place: localPlace,
    engine: "pi",
    model: null,
    effort: null,
    message,
  }).replaceAll("ask", "\\u0061sk")}`

const reports = (turns: ReadonlyArray<Turn>) =>
  turns.filter(({ context }) => Predicate.isTagged(context, "Report"))

it.live(
  "reports the Agents it started that finished during its own Turn in one Report Turn after it, marking them seen",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      yield* sendGlobal(f.client, createAgent("hold:first"))
      yield* sendGlobal(f.client, createAgent("hold:second"))
      yield* sendGlobal(f.client, "hold:global")
      yield* globalTurns(f.client, holding)

      const started = yield* f.agents
      assert.lengthOf(started, 2)

      yield* f.release("first")
      yield* f.release("second")

      const asked = yield* Effect.forEach(started, (agent) =>
        f
          .transcript(agent.id, settled(1))
          .pipe(Effect.map(([turn]) => [agent.id, "finished", createAgent(turn!.message)])),
      )

      yield* f.release("global")
      const turns = yield* globalTurns(f.client, settled(4))

      assert.lengthOf(reports(turns), 1)
      assert.strictEqual(turns[3]?.message, "")
      assert.sameDeepMembers(
        reported(turns).map((work) => [
          Predicate.isTagged(work, "Agent") && work.agentId,
          work.outcome,
          work.askedWith,
        ]),
        asked,
      )

      yield* f.client.WatchNeedsYou().pipe(
        Stream.filter((items: NeedsYou) =>
          items.every(
            (item) =>
              !Predicate.isTagged(item, "Agent") || !started.some(({ id }) => id === item.agent.id),
          ),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )
    }),
)

it.live("reports an Agent it started that waits on a Question, and not again until it ends", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

    yield* sendGlobal(f.client, createAgent("Please ask a question"))
    yield* globalTurns(f.client, settled(1))
    const [agent] = yield* f.agents
    assert.isDefined(agent)

    const waiting = yield* globalTurns(
      f.client,
      (all) => reportedAgents(all).length === 1 && all.every(({ ended }) => ended !== null),
    )

    assert.deepStrictEqual(reportedAgents(waiting), [[agent.id, "waiting"]])

    yield* f.answering(agent.id, settled(1), () =>
      AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
    )

    const turns = yield* globalTurns(f.client, (all) => reportedAgents(all).length === 2)
    assert.deepStrictEqual(reportedAgents(turns), [
      [agent.id, "waiting"],
      [agent.id, "finished"],
    ])
  }),
)

it.live("leaves out an Agent it started that the user stopped", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

    yield* sendGlobal(f.client, createAgent("hold:never"))
    yield* globalTurns(f.client, settled(1))
    const [agent] = yield* f.agents
    assert.isDefined(agent)
    yield* f.transcript(agent.id, holding)
    yield* f.client.StopTurn({ agentId: agent.id })
    yield* f.transcript(agent.id, settled(1))

    yield* sendGlobal(f.client, "After")

    const turns = yield* globalTurns(f.client, lastSettled("After"))

    assert.deepStrictEqual(reported(turns), [])
  }),
)

it.live("keeps a sent Report after restart without reporting the same outcome again", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })
    yield* sendGlobal(f.client, createAgent("Finish this"))

    const before = yield* globalTurns(
      f.client,
      (all) => reports(all).length === 1 && all.every(({ ended }) => ended !== null),
    )

    const reportId = reports(before)[0]?.id
    const restarted = yield* f.restart
    yield* sendGlobal(restarted, "After restart")
    const after = yield* globalTurns(restarted, lastSettled("After restart"))

    assert.deepStrictEqual(
      reports(after).map(({ id }) => id),
      [reportId],
    )
    assert.deepStrictEqual(reportedAgents(after), reportedAgents(before))
  }),
)

it.live(
  "reports work started before Start fresh into the new conversation, which still lists it as started",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const asked = createAgent("hold:first")
      yield* sendGlobal(f.client, asked)
      yield* globalTurns(f.client, settled(1))
      const [agent] = yield* f.agents
      assert.isDefined(agent)

      yield* f.client.StartGlobalConversationFresh()
      yield* f.release("first")

      const [report] = yield* globalTurns(f.client, settled(1))

      assert.deepStrictEqual(
        reported(report === undefined ? [] : [report]).map((work) => [
          Predicate.isTagged(work, "Agent") && work.agentId,
          work.outcome,
          work.askedWith,
        ]),
        [[agent.id, "finished", asked]],
      )

      yield* sendGlobal(f.client, "call:list_started_work")
      const [, listed] = yield* globalTurns(f.client, settled(2))

      assert.include(glassCalls(listed)?.[0]?.output, agent.id)
    }),
)
