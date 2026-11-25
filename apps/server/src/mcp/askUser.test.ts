import { assert, describe, it } from "@effect/vitest"
import {
  AskedUser,
  ChoiceAnswer,
  type InboxItems,
  QuestionAnswered,
  QuestionSetAside,
  QuestionState,
  QuestionWaiting,
  TextAnswer,
} from "@glass/contracts"
import { Effect, Exit, Option, Predicate, Redacted, Schema, Scope, Stream } from "effect"
import { isolatedHome, startBackend } from "../../test/harness"
import { inboxWhen } from "../../test/inboxWhen"
import { connectMcp, mcpPost, toolText } from "../../test/mcpClient"

const outside = (items: InboxItems) =>
  items.filter((item) => Predicate.isTagged(item, "OutsideQuestion"))

const askedUser = Schema.decodeUnknownSync(AskedUser)

const questionState = Schema.decodeUnknownSync(QuestionState)

type Backend = Effect.Success<ReturnType<typeof startBackend>>

type Mcp = Effect.Success<ReturnType<typeof connectMcp>>

const start = Effect.gen(function* () {
  const backend = yield* startBackend({})
  const bearer = yield* backend.outsideAgents.issue("Claude Code")
  const mcp = yield* connectMcp(backend.baseUrl, bearer)

  return { ...backend, bearer, mcp }
})

const ask = (mcp: Mcp, args: Schema.JsonObject) =>
  mcp
    .call("ask_user", args)
    .pipe(Effect.map(({ structuredContent }) => askedUser(structuredContent)))

const readAnswer = (mcp: Mcp, id: string) =>
  mcp
    .call("read_answer", { id })
    .pipe(Effect.map(({ structuredContent }) => questionState(structuredContent)))

const shownQuestion = (client: Backend["client"], id: string) =>
  inboxWhen(client, (items) => outside(items).some((item) => item.id === id)).pipe(
    Effect.map((items) =>
      Option.getOrThrow(Option.fromNullishOr(outside(items).find((item) => item.id === id))),
    ),
  )

describe("ask_user", () => {
  it.live("returns at once, waits in the Inbox, and hands back the typed answer", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const { questionId } = yield* ask(mcp, { question: "Ship the retry change?" })
      const question = yield* shownQuestion(client, questionId)

      assert.equal(question.question, "Ship the retry change?")
      assert.deepStrictEqual(question.choices, [])
      assert.equal(question.askedBy, "Claude Code")
      assert.deepStrictEqual(yield* readAnswer(mcp, questionId), QuestionWaiting.make({}))

      yield* client.AnswerQuestions({
        answers: [{ questionId, answer: TextAnswer.make({ text: "Ship it" }) }],
      })

      assert.deepStrictEqual(
        yield* readAnswer(mcp, questionId),
        QuestionAnswered.make({ answer: "Ship it", by: "text" }),
      )
      yield* inboxWhen(client, (items) => outside(items).length === 0)
    }),
  )

  it.live("offers choices with their descriptions and hands back the one picked", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const { questionId } = yield* ask(mcp, {
        question: "Ship the retry change?",
        choices: [
          { label: "Ship it", description: "Merge once checks pass." },
          { label: "Hold it" },
        ],
      })

      const question = yield* shownQuestion(client, questionId)

      assert.deepStrictEqual(question.choices, [
        { label: "Ship it", description: "Merge once checks pass." },
        { label: "Hold it", description: null },
      ])

      const unoffered = yield* client
        .AnswerQuestions({
          answers: [{ questionId, answer: ChoiceAnswer.make({ choice: "Revert it" }) }],
        })
        .pipe(Effect.flip)

      assert.equal(unoffered._tag, "QuestionNotOpen")

      yield* client.AnswerQuestions({
        answers: [{ questionId, answer: ChoiceAnswer.make({ choice: "Hold it" }) }],
      })

      assert.deepStrictEqual(
        yield* readAnswer(mcp, questionId),
        QuestionAnswered.make({ answer: "Hold it", by: "choice" }),
      )
    }),
  )

  it.live("refuses two choices with one label", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const result = yield* mcp.call("ask_user", {
        question: "Ship it?",
        choices: [{ label: "Yes" }, { label: "Yes" }],
      })

      assert.isTrue(result.isError)
      assert.include(toolText(result), "its own label")
      assert.equal(outside(yield* inboxWhen(client, () => true)).length, 0)
    }),
  )

  it.live("tells the agent a question was set aside, and takes no answer after", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const { questionId } = yield* ask(mcp, { question: "Rename the module too?" })

      yield* shownQuestion(client, questionId)
      yield* client.SetQuestionAside({ questionId })

      assert.deepStrictEqual(yield* readAnswer(mcp, questionId), QuestionSetAside.make({}))
      yield* inboxWhen(client, (items) => outside(items).length === 0)

      const late = yield* client
        .AnswerQuestions({
          answers: [{ questionId, answer: TextAnswer.make({ text: "Yes" }) }],
        })
        .pipe(Effect.flip)

      assert.equal(late._tag, "QuestionNotOpen")
    }),
  )

  it.live("keeps several questions from one session open at once", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start

      const first = yield* ask(mcp, { question: "Ship the retry change?" })
      const second = yield* ask(mcp, { question: "And the follow-up?" })

      const shown = outside(yield* inboxWhen(client, (items) => outside(items).length === 2))

      assert.deepStrictEqual(
        shown.map(({ id }) => id),
        [first.questionId, second.questionId],
      )
    }),
  )

  it.live("reads an answer from another session of the same agent, never from another agent", () =>
    Effect.gen(function* () {
      const backend = yield* start
      const { questionId } = yield* ask(backend.mcp, { question: "Ship the retry change?" })

      yield* backend.client.AnswerQuestions({
        answers: [{ questionId, answer: TextAnswer.make({ text: "Ship it" }) }],
      })

      const sameAgent = yield* connectMcp(backend.baseUrl, backend.bearer)

      assert.deepStrictEqual(
        yield* readAnswer(sameAgent, questionId),
        QuestionAnswered.make({ answer: "Ship it", by: "text" }),
      )

      const otherAgent = yield* connectMcp(
        backend.baseUrl,
        yield* backend.outsideAgents.issue("Codex"),
      )

      const refused = yield* otherAgent.call("read_answer", { id: questionId })

      assert.isTrue(refused.isError)
      assert.include(toolText(refused), "You asked no question")
    }),
  )

  it.live("keeps an open question across a Glass restart", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const before = yield* Scope.make()
      const first = yield* startBackend({}, home).pipe(Scope.provide(before))
      const bearer = yield* first.outsideAgents.issue("Claude Code")

      const { questionId } = yield* ask(yield* connectMcp(first.baseUrl, bearer), {
        question: "Ship the retry change?",
      })

      yield* Scope.close(before, Exit.void)

      const second = yield* startBackend({}, home)

      yield* shownQuestion(second.client, questionId)
      yield* second.client.AnswerQuestions({
        answers: [{ questionId, answer: TextAnswer.make({ text: "Ship it" }) }],
      })

      assert.deepStrictEqual(
        yield* readAnswer(yield* connectMcp(second.baseUrl, bearer), questionId),
        QuestionAnswered.make({ answer: "Ship it", by: "text" }),
      )
    }),
  )

  it.live("drops an agent's open questions when it is disconnected", () =>
    Effect.gen(function* () {
      const { client, mcp } = yield* start
      const { questionId } = yield* ask(mcp, { question: "Ship the retry change?" })

      yield* shownQuestion(client, questionId)

      const [agent] = yield* client
        .WatchOutsideAgents()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      assert.ok(agent !== undefined)
      yield* client.RevokeOutsideAgent({ id: agent.id })

      yield* inboxWhen(client, (items) => outside(items).length === 0)
    }),
  )

  it.live("rejects an unauthorized caller and posts nothing", () =>
    Effect.gen(function* () {
      const { baseUrl, client } = yield* startBackend({})

      const call = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "tools/call",
        params: { name: "ask_user", arguments: { question: "Ship it?" } },
      }

      const statuses = yield* Effect.all(
        [
          mcpPost(baseUrl, call),
          mcpPost(baseUrl, call, { bearer: Redacted.make("not-a-credential") }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map((responses) => responses.map((response) => response.status)))

      assert.deepStrictEqual(statuses, [401, 401])
      assert.equal(outside(yield* inboxWhen(client, () => true)).length, 0)
    }),
  )
})
