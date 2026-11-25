import { assert, describe, it } from "@effect/vitest"
import {
  ChoiceAnswer,
  type InboxItems,
  inboxGroupOf,
  InboxGlobalChat,
  InboxThread,
  localPlace,
  StartFreshRefused,
  type OpenQuestion,
  TextAnswer,
  type Turn,
} from "@glass/contracts"
import { Effect, Predicate, Schema } from "effect"
import { inboxWhen } from "../test/inboxWhen"
import {
  glassCall,
  globalTurns,
  holding,
  repository,
  sendGlobal,
  settled,
  threadOutcomesInStartedWorkUpdates,
  threadsFixture,
} from "../test/threadsFixture"

type Client = Effect.Success<typeof threadsFixture>["client"]

const ask = (question: string, choices: ReadonlyArray<string> = []) =>
  glassCall(
    "ask_user",
    choices.length === 0
      ? { question }
      : { question, choices: choices.map((label) => ({ label })) },
  )

const openQuestionsOf = (items: InboxItems, threadId: string): ReadonlyArray<OpenQuestion> =>
  items
    .filter(Schema.is(InboxThread))
    .filter(({ thread }) => thread.id === threadId)
    .flatMap(({ reasons }) =>
      reasons.flatMap((reason) =>
        Predicate.isTagged(reason, "OpenQuestions") ? reason.questions : [],
      ),
    )

const asking = (client: Client, threadId: string, count: number) =>
  inboxWhen(client, (items) => openQuestionsOf(items, threadId).length === count).pipe(
    Effect.map((items) => ({ items, questions: openQuestionsOf(items, threadId) })),
  )

const answersIn = (turn: Turn | undefined) =>
  Predicate.isTagged(turn?.context, "QuestionsAnswered")
    ? turn.context.answers.map(({ question, answer }) => [question, answer])
    : []

const echoed = (turn: Turn | undefined) =>
  turn?.parts.flatMap((part) => (Predicate.isTagged(part, "Text") ? [part.text] : [])).join("\n") ??
  ""

describe("Questions from a Thread", () => {
  it.live("asks without waiting: the Turn ends and the Question waits in Stopped on you", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start(ask("Which branch?", ["main", "release"]))

      yield* f.transcript(thread.id, settled(1))

      const { items, questions } = yield* asking(f.client, thread.id, 1)

      const item = items
        .filter(Schema.is(InboxThread))
        .find((shown) => shown.thread.id === thread.id)

      assert.deepStrictEqual(
        questions.map(({ question, choices }) => [question, choices.map(({ label }) => label)]),
        [["Which branch?", ["main", "release"]]],
      )
      assert.ok(item !== undefined)
      assert.equal(inboxGroupOf(item), "stopped")
    }),
  )

  it.live("starts a new Turn with the answer once the Thread's Turn has ended", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start(ask("Which branch?", ["main", "release"]))

      yield* f.transcript(thread.id, settled(1))

      const [question] = (yield* asking(f.client, thread.id, 1)).questions

      yield* f.client.AnswerQuestions({
        answers: [{ questionId: question!.id, answer: ChoiceAnswer.make({ choice: "release" }) }],
      })

      const turns = yield* f.transcript(thread.id, settled(2))

      assert.deepStrictEqual(answersIn(turns[1]), [["Which branch?", "release"]])
      assert.include(echoed(turns[1]), `<glass_answer question_id="${question!.id}">`)
      assert.include(echoed(turns[1]), "Answer: release")
      assert.notInclude(echoed(turns[1]), "glass_questions_set_aside")
      yield* asking(f.client, thread.id, 0)
    }),
  )

  it.live("steers the answer into the Turn while the agent keeps working", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start(`${ask("Rename the module too?")}\nhold:after-asking`)

      yield* f.transcript(thread.id, holding)

      const [question] = (yield* asking(f.client, thread.id, 1)).questions

      yield* f.client.AnswerQuestions({
        answers: [{ questionId: question!.id, answer: TextAnswer.make({ text: "Yes, both" }) }],
      })
      yield* f.release("after-asking")

      const [turn] = yield* f.transcript(thread.id, settled(1))
      const steer = turn?.parts.find((part) => Predicate.isTagged(part, "Steer"))

      assert.ok(Predicate.isTagged(steer, "Steer"))
      assert.deepStrictEqual(
        Predicate.isTagged(steer.context, "QuestionsAnswered")
          ? steer.context.answers.map(({ answer }) => answer)
          : [],
        ["Yes, both"],
      )
    }),
  )

  it.live("sends answers given together as one message, leaving the rest open", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start(ask("First?"))

      yield* f.transcript(thread.id, settled(1))
      yield* f.send(thread.id, ask("Second?"))
      yield* f.transcript(thread.id, settled(2))
      yield* f.send(thread.id, ask("Third?"))
      yield* f.transcript(thread.id, settled(3))

      const { questions } = yield* asking(f.client, thread.id, 3)
      const [first, second, third] = questions

      yield* f.client.AnswerQuestions({
        answers: [
          { questionId: first!.id, answer: TextAnswer.make({ text: "One" }) },
          { questionId: third!.id, answer: TextAnswer.make({ text: "Three" }) },
        ],
      })

      const turns = yield* f.transcript(thread.id, settled(4))

      assert.deepStrictEqual(answersIn(turns[3]), [
        ["First?", "One"],
        ["Third?", "Three"],
      ])
      assert.deepStrictEqual(
        (yield* asking(f.client, thread.id, 1)).questions.map(({ id }) => id),
        [second!.id],
      )
    }),
  )

  it.live("sets a Question aside without a Turn, telling the agent in its next message only", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start(ask("Rename the module too?"))

      yield* f.transcript(thread.id, settled(1))

      const [question] = (yield* asking(f.client, thread.id, 1)).questions

      yield* f.client.SetQuestionAside({ questionId: question!.id })
      yield* asking(f.client, thread.id, 0)
      yield* f.send(thread.id, "Carry on")

      const told = yield* f.transcript(thread.id, settled(2))

      assert.include(echoed(told[1]), "<glass_questions_set_aside>")
      assert.include(echoed(told[1]), `question_id="${question!.id}"`)

      yield* f.send(thread.id, "And again")

      const after = yield* f.transcript(thread.id, settled(3))

      assert.equal(told.length, 2)
      assert.notInclude(echoed(after[2]), "glass_questions_set_aside")
    }),
  )

  it.live("leaves a Question open when the user sends the Thread a message of their own", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start(ask("Rename the module too?"))

      yield* f.transcript(thread.id, settled(1))
      yield* f.send(thread.id, "Something else first")
      yield* f.transcript(thread.id, settled(2))

      assert.equal((yield* asking(f.client, thread.id, 1)).questions.length, 1)
    }),
  )

  it.live("delivers an answer given after Glass restarts", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start(ask("Which branch?"))

      yield* f.transcript(thread.id, settled(1))

      const client = yield* f.restart
      const [question] = (yield* asking(client, thread.id, 1)).questions

      yield* client.AnswerQuestions({
        answers: [{ questionId: question!.id, answer: TextAnswer.make({ text: "main" }) }],
      })

      const turns = yield* f.transcript(thread.id, settled(2), client)

      assert.deepStrictEqual(answersIn(turns[1]), [["Which branch?", "main"]])
    }),
  )

  it.live("refuses answers to two agents' Questions sent together", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const one = yield* f.start(ask("First?"))
      const two = yield* f.start(ask("Second?"))

      yield* f.transcript(one.id, settled(1))
      yield* f.transcript(two.id, settled(1))

      const [first] = (yield* asking(f.client, one.id, 1)).questions
      const [second] = (yield* asking(f.client, two.id, 1)).questions

      const refused = yield* f.client
        .AnswerQuestions({
          answers: [
            { questionId: first!.id, answer: TextAnswer.make({ text: "One" }) },
            { questionId: second!.id, answer: TextAnswer.make({ text: "Two" }) },
          ],
        })
        .pipe(Effect.flip)

      assert.equal(refused._tag, "QuestionNotOpen")
      assert.equal((yield* asking(f.client, one.id, 1)).questions.length, 1)
    }),
  )
})

const hiddenFromScriptedAskUser = (json: string) => json.replaceAll("ask", "\\u0061sk")

const createThread = (message: string) =>
  `call:create_thread ${hiddenFromScriptedAskUser(
    JSON.stringify({
      repository: { owner: repository.owner, repo: repository.repo },
      baseBranch: "main",
      place: localPlace,
      harness: "pi",
      model: null,
      effort: null,
      message,
    }),
  )}`

describe("Questions from the Global chat", () => {
  it.live("lists the Global chat's Question in the Inbox and answers it with a new Turn", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture

      yield* sendGlobal(f.client, ask("Which repository?", ["acme/api", "acme/web"]))
      yield* globalTurns(f.client, settled(1))

      const shown = yield* inboxWhen(f.client, (items) =>
        items.filter(Schema.is(InboxGlobalChat)).some(({ questions }) => questions.length === 1),
      )

      const [item] = shown.filter(Schema.is(InboxGlobalChat))
      const [question] = item!.questions

      assert.equal(question?.question, "Which repository?")
      assert.equal(inboxGroupOf(item!), "stopped")

      yield* f.client.AnswerQuestions({
        answers: [{ questionId: question!.id, answer: ChoiceAnswer.make({ choice: "acme/web" }) }],
      })

      const turns = yield* globalTurns(f.client, settled(2))

      assert.deepStrictEqual(answersIn(turns[1]), [["Which repository?", "acme/web"]])
    }),
  )

  it.live("won't start fresh while one of its Questions is open", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture

      yield* sendGlobal(f.client, ask("Which repository?"))
      yield* globalTurns(f.client, settled(1))
      yield* inboxWhen(f.client, (items) =>
        items.filter(Schema.is(InboxGlobalChat)).some(({ questions }) => questions.length === 1),
      )

      const refused = yield* f.client.StartGlobalChatFresh().pipe(Effect.flip)

      assert.ok(Schema.is(StartFreshRefused)(refused))
      assert.equal(refused.reason, "waiting")
    }),
  )

  it.live("hears once that a Thread it started waits on the user, then that it finished", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture

      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })
      yield* sendGlobal(f.client, createThread(ask("Which branch?")))
      yield* globalTurns(f.client, settled(1))

      const [thread] = yield* f.threads

      assert.isDefined(thread)

      const waiting = yield* globalTurns(
        f.client,
        (all) =>
          threadOutcomesInStartedWorkUpdates(all).length === 1 &&
          all.every(({ ended }) => ended !== null),
      )

      assert.deepStrictEqual(threadOutcomesInStartedWorkUpdates(waiting), [[thread.id, "waiting"]])

      const [question] = (yield* asking(f.client, thread.id, 1)).questions

      yield* f.client.AnswerQuestions({
        answers: [{ questionId: question!.id, answer: TextAnswer.make({ text: "main" }) }],
      })

      const turns = yield* globalTurns(
        f.client,
        (all) => threadOutcomesInStartedWorkUpdates(all).length === 2,
      )

      assert.deepStrictEqual(threadOutcomesInStartedWorkUpdates(turns), [
        [thread.id, "waiting"],
        [thread.id, "finished"],
      ])
    }),
  )
})
