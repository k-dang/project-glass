import { assert, it } from "@effect/vitest"
import { AnswerQuestion, localPlace, type NeedsYou, type Turn } from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import {
  conversationsFixture,
  glassCalls,
  globalTurns,
  holding,
  lastSettled,
  outcomesInGlobalConversationUpdates,
  conversationOutcomesInGlobalConversationUpdates,
  repository,
  sendGlobal,
  settled,
} from "../test/conversationsFixture"

const hiddenFromScriptedAskUser = (json: string) => json.replaceAll("ask", "\\u0061sk")

const createConversation = (message: string) =>
  `call:create_conversation ${hiddenFromScriptedAskUser(
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

const globalConversationUpdates = (turns: ReadonlyArray<Turn>) =>
  turns.filter(({ context }) => Predicate.isTagged(context, "GlobalConversationUpdate"))

it.live(
  "sends one Global conversation update for Conversations that finished during its own Turn, marking them seen",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      yield* sendGlobal(f.client, createConversation("hold:first"))
      yield* sendGlobal(f.client, createConversation("hold:second"))
      yield* sendGlobal(f.client, "hold:global")
      yield* globalTurns(f.client, holding)

      const started = yield* f.conversations
      assert.lengthOf(started, 2)

      yield* f.release("first")
      yield* f.release("second")

      const asked = yield* Effect.forEach(started, (conversation) =>
        f
          .transcript(conversation.id, settled(1))
          .pipe(
            Effect.map(([turn]) => [
              conversation.id,
              "finished",
              createConversation(turn!.message),
            ]),
          ),
      )

      yield* f.release("global")
      const turns = yield* globalTurns(f.client, settled(4))

      assert.lengthOf(globalConversationUpdates(turns), 1)
      assert.strictEqual(turns[3]?.message, "")
      assert.sameDeepMembers(
        outcomesInGlobalConversationUpdates(turns).map((work) => [
          Predicate.isTagged(work, "Conversation") && work.conversationId,
          work.outcome,
          work.askedWith,
        ]),
        asked,
      )

      yield* f.client.WatchNeedsYou().pipe(
        Stream.filter((items: NeedsYou) =>
          items.every(
            (item) =>
              !Predicate.isTagged(item, "Conversation") ||
              !started.some(({ id }) => id === item.conversation.id),
          ),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )
    }),
)

it.live(
  "sends a Global conversation update for a Conversation waiting on a Question, and another when it ends",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      yield* sendGlobal(f.client, createConversation("Please ask a question"))
      yield* globalTurns(f.client, settled(1))
      const [conversation] = yield* f.conversations
      assert.isDefined(conversation)

      const waiting = yield* globalTurns(
        f.client,
        (all) =>
          conversationOutcomesInGlobalConversationUpdates(all).length === 1 &&
          all.every(({ ended }) => ended !== null),
      )

      assert.deepStrictEqual(conversationOutcomesInGlobalConversationUpdates(waiting), [
        [conversation.id, "waiting"],
      ])

      yield* f.answering(conversation.id, settled(1), () =>
        AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
      )

      const turns = yield* globalTurns(
        f.client,
        (all) => conversationOutcomesInGlobalConversationUpdates(all).length === 2,
      )

      assert.deepStrictEqual(conversationOutcomesInGlobalConversationUpdates(turns), [
        [conversation.id, "waiting"],
        [conversation.id, "finished"],
      ])
    }),
)

it.live("leaves out a Conversation it started that the user stopped", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

    yield* sendGlobal(f.client, createConversation("hold:never"))
    yield* globalTurns(f.client, settled(1))
    const [conversation] = yield* f.conversations
    assert.isDefined(conversation)
    yield* f.transcript(conversation.id, holding)
    yield* f.client.StopTurn({ conversationId: conversation.id })
    yield* f.transcript(conversation.id, settled(1))

    yield* sendGlobal(f.client, "After")

    const turns = yield* globalTurns(f.client, lastSettled("After"))

    assert.deepStrictEqual(outcomesInGlobalConversationUpdates(turns), [])
  }),
)

it.live(
  "keeps a sent Global conversation update after restart without repeating the same outcome",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })
      yield* sendGlobal(f.client, createConversation("Finish this"))

      const before = yield* globalTurns(
        f.client,
        (all) =>
          globalConversationUpdates(all).length === 1 && all.every(({ ended }) => ended !== null),
      )

      const globalConversationUpdateId = globalConversationUpdates(before)[0]?.id
      const restarted = yield* f.restart
      yield* sendGlobal(restarted, "After restart")
      const after = yield* globalTurns(restarted, lastSettled("After restart"))

      assert.deepStrictEqual(
        globalConversationUpdates(after).map(({ id }) => id),
        [globalConversationUpdateId],
      )
      assert.deepStrictEqual(
        conversationOutcomesInGlobalConversationUpdates(after),
        conversationOutcomesInGlobalConversationUpdates(before),
      )
    }),
)

it.live(
  "sends a Global conversation update in the new conversation for work started before Start fresh",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      const asked = createConversation("hold:first")
      yield* sendGlobal(f.client, asked)
      yield* globalTurns(f.client, settled(1))
      const [conversation] = yield* f.conversations
      assert.isDefined(conversation)

      yield* f.client.StartGlobalConversationFresh()
      yield* f.release("first")

      const [globalConversationUpdate] = yield* globalTurns(f.client, settled(1))

      assert.deepStrictEqual(
        outcomesInGlobalConversationUpdates(
          globalConversationUpdate === undefined ? [] : [globalConversationUpdate],
        ).map((work) => [
          Predicate.isTagged(work, "Conversation") && work.conversationId,
          work.outcome,
          work.askedWith,
        ]),
        [[conversation.id, "finished", asked]],
      )

      yield* sendGlobal(f.client, "call:list_started_work")
      const [, listed] = yield* globalTurns(f.client, settled(2))

      assert.include(glassCalls(listed)?.[0]?.output, conversation.id)
    }),
)
