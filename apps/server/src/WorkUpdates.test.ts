import { assert, it } from "@effect/vitest"
import { AnswerQuestion, localPlace, type NeedsYou, type Turn } from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import {
  agentsFixture,
  glassCalls,
  globalTurns,
  holding,
  lastSettled,
  outcomesInUpdates,
  agentOutcomesInUpdates,
  repository,
  sendGlobal,
  settled,
} from "../test/agentsFixture"

const hiddenFromScriptedAskUser = (json: string) => json.replaceAll("ask", "\\u0061sk")

const createAgent = (message: string) =>
  `call:create_agent ${hiddenFromScriptedAskUser(
    JSON.stringify({
      repository: { owner: repository.owner, repo: repository.repo },
      baseBranch: "main",
      place: localPlace,
      engine: "pi",
      model: null,
      effort: null,
      message,
    }),
  )}`

const workUpdates = (turns: ReadonlyArray<Turn>) =>
  turns.filter(({ context }) => Predicate.isTagged(context, "WorkUpdate"))

it.live(
  "sends one Work update for Agents that finished during its own Turn, marking them seen",
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

      assert.lengthOf(workUpdates(turns), 1)
      assert.strictEqual(turns[3]?.message, "")
      assert.sameDeepMembers(
        outcomesInUpdates(turns).map((work) => [
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

it.live("sends a Work update for an Agent waiting on a Question, and another when it ends", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

    yield* sendGlobal(f.client, createAgent("Please ask a question"))
    yield* globalTurns(f.client, settled(1))
    const [agent] = yield* f.agents
    assert.isDefined(agent)

    const waiting = yield* globalTurns(
      f.client,
      (all) => agentOutcomesInUpdates(all).length === 1 && all.every(({ ended }) => ended !== null),
    )

    assert.deepStrictEqual(agentOutcomesInUpdates(waiting), [[agent.id, "waiting"]])

    yield* f.answering(agent.id, settled(1), () =>
      AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
    )

    const turns = yield* globalTurns(f.client, (all) => agentOutcomesInUpdates(all).length === 2)
    assert.deepStrictEqual(agentOutcomesInUpdates(turns), [
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

    assert.deepStrictEqual(outcomesInUpdates(turns), [])
  }),
)

it.live("keeps a sent Work update after restart without repeating the same outcome", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })
    yield* sendGlobal(f.client, createAgent("Finish this"))

    const before = yield* globalTurns(
      f.client,
      (all) => workUpdates(all).length === 1 && all.every(({ ended }) => ended !== null),
    )

    const workUpdateId = workUpdates(before)[0]?.id
    const restarted = yield* f.restart
    yield* sendGlobal(restarted, "After restart")
    const after = yield* globalTurns(restarted, lastSettled("After restart"))

    assert.deepStrictEqual(
      workUpdates(after).map(({ id }) => id),
      [workUpdateId],
    )
    assert.deepStrictEqual(agentOutcomesInUpdates(after), agentOutcomesInUpdates(before))
  }),
)

it.live("sends a Work update in the new conversation for work started before Start fresh", () =>
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

    const [workUpdate] = yield* globalTurns(f.client, settled(1))

    assert.deepStrictEqual(
      outcomesInUpdates(workUpdate === undefined ? [] : [workUpdate]).map((work) => [
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
