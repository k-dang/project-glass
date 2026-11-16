import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  DenyRequest,
  isRequestPart,
  isWaiting,
  PartSet,
  PermissionRequestPart,
  QuestionPart,
  RequestNotWaiting,
  TurnDone,
  TurnEnded,
  TurnInterrupted,
  TurnStopped,
  type Transcript,
} from "@glass/contracts"
import { DateTime, Effect, Option, Predicate, Stream } from "effect"
import { conversationServicesFixture } from "../test/conversationServicesFixture"
import { HostConversationError } from "./agentHost/protocol"

const permission = PermissionRequestPart.make({
  requestId: "request-1",
  toolName: "Bash",
  inputSummary: "A tool request",
  input: "{}",
  status: "waiting",
  reason: null,
})

const question = QuestionPart.make({
  requestId: "question-1",
  status: "waiting",
  answers: null,
  questions: [
    {
      header: "Scope",
      question: "Which files?",
      detail: null,
      options: [{ label: "README", description: null }],
      multiSelect: false,
      freeText: true,
    },
  ],
})

type Fixture = Effect.Success<typeof conversationServicesFixture>

const waitingOn = ({ turns }: Transcript) => turns.some(({ parts }) => parts.some(isWaiting))

const finish = Effect.fnUntraced(function* (f: Fixture, turn: Effect.Success<Fixture["started"]>) {
  yield* turn.emit(
    TurnEnded.make({
      turnId: turn.turnId,
      ended: { at: yield* DateTime.now, ending: TurnDone.make({}) },
    }),
  )
  yield* f.transcript(turn.conversationId, ({ turns }) => Predicate.isNotNullish(turns[0]?.ended))
})

it.live("keeps a supplied request waiting, refuses messages, and forwards the user's answer", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    const conversation = yield* f.create()
    const turn = yield* f.started
    yield* turn.emit(PartSet.make({ turnId: turn.turnId, index: 0, part: permission }))

    const before = yield* f.transcript(conversation.id, waitingOn)
    assert.isTrue(before.turns[0]?.parts.some(isWaiting))

    const marked = yield* f.conversations.watchWaiting().pipe(
      Stream.filter((waiting) =>
        waiting.some(({ conversation: found }) => found.id === conversation.id),
      ),
      Stream.runHead,
    )

    assert.isTrue(Option.isSome(marked))

    for (const send of [f.conversations.send, f.conversations.steer]) {
      const refused = yield* send(conversation.id, { message: "More", images: [] }).pipe(
        Effect.flip,
      )

      assert.equal(refused._tag, "RequestWaiting")
    }

    assert.deepStrictEqual(before.queued, [])
    assert.deepStrictEqual((yield* f.transcript(conversation.id, waitingOn)).turns, before.turns)

    const answer = DenyRequest.make({ reason: "Leave the checkout alone" })
    yield* f.conversations.answer(conversation.id, permission.requestId, answer)
    assert.deepStrictEqual(f.answers, [{ requestId: permission.requestId, answer }])

    yield* turn.emit(
      PartSet.make({
        turnId: turn.turnId,
        index: 0,
        part: PermissionRequestPart.make({
          ...permission,
          status: "denied",
          reason: answer.reason,
        }),
      }),
    )
    yield* f.conversations.watchWaiting().pipe(
      Stream.filter(
        (waiting) => !waiting.some(({ conversation: found }) => found.id === conversation.id),
      ),
      Stream.runHead,
    )

    yield* f.failAnswers(new RequestNotWaiting())
    assert.equal(
      (yield* f.conversations
        .answer(conversation.id, permission.requestId, answer)
        .pipe(Effect.flip))._tag,
      "RequestNotWaiting",
    )
  }),
)

it.live("persists a supplied Question and forwards a free-text answer", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    const conversation = yield* f.create()
    const turn = yield* f.started
    yield* turn.emit(PartSet.make({ turnId: turn.turnId, index: 0, part: question }))
    const waiting = yield* f.transcript(conversation.id, waitingOn)
    assert.deepStrictEqual(waiting.turns[0]?.parts, [question])

    const answer = AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] })
    yield* f.conversations.answer(conversation.id, question.requestId, answer)
    assert.deepStrictEqual(f.answers, [{ requestId: question.requestId, answer }])
    yield* turn.emit(
      PartSet.make({
        turnId: turn.turnId,
        index: 0,
        part: QuestionPart.make({ ...question, status: "answered", answers: answer.answers }),
      }),
    )

    const settled = yield* f.transcript(
      conversation.id,
      ({ turns }) =>
        turns[0]?.parts.some(
          (part) => Predicate.isTagged(part, "Question") && part.status === "answered",
        ) === true,
    )

    assert.deepStrictEqual(settled.turns[0]?.parts, [
      QuestionPart.make({ ...question, status: "answered", answers: answer.answers }),
    ])
  }),
)

it.live("expires a persisted request when business services restart", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    const conversation = yield* f.create()
    const turn = yield* f.started
    yield* turn.emit(PartSet.make({ turnId: turn.turnId, index: 0, part: permission }))
    yield* f.transcript(conversation.id, waitingOn)

    const restarted = yield* f.restart

    const snapshot = yield* restarted.conversations
      .transcript(conversation.id)
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.ok(Predicate.isTagged(snapshot, "Snapshot"))
    assert.deepStrictEqual(snapshot.turns[0]?.ended?.ending, TurnInterrupted.make({}))
    assert.equal(snapshot.turns[0]?.parts.find(isRequestPart)?.status, "expired")
    assert.deepStrictEqual(
      yield* restarted.conversations
        .watchWaiting()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
      [],
    )
    assert.equal(
      (yield* restarted.conversations
        .answer(conversation.id, permission.requestId, AllowRequest.make({}))
        .pipe(Effect.flip))._tag,
      "RequestNotWaiting",
    )
  }),
)

it.live("forwards Stop and waits for the host to expire its request before the next message", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    const conversation = yield* f.create()
    const turn = yield* f.started
    yield* turn.emit(PartSet.make({ turnId: turn.turnId, index: 0, part: question }))
    yield* f.transcript(conversation.id, waitingOn)
    yield* f.conversations.stop(conversation.id)
    assert.deepStrictEqual(f.stops, [conversation.id])
    assert.equal(
      (yield* f.conversations
        .send(conversation.id, { message: "Too early", images: [] })
        .pipe(Effect.flip))._tag,
      "RequestWaiting",
    )
    yield* turn.emit(
      PartSet.make({
        turnId: turn.turnId,
        index: 0,
        part: QuestionPart.make({ ...question, status: "expired" }),
      }),
    )
    yield* turn.emit(
      TurnEnded.make({
        turnId: turn.turnId,
        ended: { at: yield* DateTime.now, ending: TurnStopped.make({}) },
      }),
    )

    const stopped = yield* f.transcript(conversation.id, ({ turns }) =>
      Predicate.isNotNullish(turns[0]?.ended),
    )

    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
    assert.equal(stopped.turns[0]?.parts.find(isRequestPart)?.status, "expired")

    yield* f.conversations.send(conversation.id, { message: "Continue", images: [] })
    assert.equal((yield* f.started).input.message, "Continue")
  }),
)

it.live("passes default and changed Permission modes to the host, and refuses modes for pi", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    const conversation = yield* f.create()
    const first = yield* f.started
    assert.equal(first.settings.permissionMode, "auto")
    yield* finish(f, first)
    yield* f.conversations.changePermissionMode(conversation.id, "acceptEdits")
    yield* f.conversations.send(conversation.id, { message: "Next", images: [] })
    assert.equal((yield* f.started).settings.permissionMode, "acceptEdits")

    const pi = yield* f.create(null, "pi")
    assert.isNull((yield* f.started).settings.permissionMode)
    assert.equal(
      (yield* f.conversations.changePermissionMode(pi.id, "auto").pipe(Effect.flip))._tag,
      "NoPermissionModes",
    )
  }),
)

it.live("maps a host failure while forwarding an answer to a Conversation error", () =>
  Effect.gen(function* () {
    const f = yield* conversationServicesFixture
    const conversation = yield* f.create()
    yield* f.started
    yield* f.failAnswers(new HostConversationError({ message: "The host refused the answer" }))

    const refused = yield* f.conversations
      .answer(conversation.id, "request-1", AllowRequest.make({}))
      .pipe(Effect.flip)

    assert.equal(refused._tag, "ConversationError")
    assert.equal(refused.message, "The host refused the answer")
  }),
)
