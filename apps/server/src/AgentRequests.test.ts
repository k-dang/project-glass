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
import { agentServicesFixture } from "../test/agentServicesFixture"
import { HostAgentError } from "./agentHost/protocol"

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

type Fixture = Effect.Success<typeof agentServicesFixture>

const waitingOn = ({ turns }: Transcript) => turns.some(({ parts }) => parts.some(isWaiting))

const finish = Effect.fnUntraced(function* (f: Fixture, turn: Effect.Success<Fixture["started"]>) {
  yield* turn.emit(
    TurnEnded.make({
      turnId: turn.turnId,
      ended: { at: yield* DateTime.now, ending: TurnDone.make({}) },
    }),
  )
  yield* f.transcript(turn.agentId, ({ turns }) => Predicate.isNotNullish(turns[0]?.ended))
})

it.live("keeps a supplied request waiting, refuses messages, and forwards the user's answer", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    const turn = yield* f.started
    yield* turn.emit(PartSet.make({ turnId: turn.turnId, index: 0, part: permission }))

    const before = yield* f.transcript(agent.id, waitingOn)
    assert.isTrue(before.turns[0]?.parts.some(isWaiting))

    const marked = yield* f.agents.watchWaiting().pipe(
      Stream.filter((ids) => ids.includes(agent.id)),
      Stream.runHead,
    )

    assert.isTrue(Option.isSome(marked))

    for (const send of [f.agents.send, f.agents.steer]) {
      const refused = yield* send(agent.id, { message: "More", images: [] }).pipe(Effect.flip)
      assert.equal(refused._tag, "RequestWaiting")
    }

    assert.deepStrictEqual(before.queued, [])
    assert.deepStrictEqual((yield* f.transcript(agent.id, waitingOn)).turns, before.turns)

    const answer = DenyRequest.make({ reason: "Leave the checkout alone" })
    yield* f.agents.answer(agent.id, permission.requestId, answer)
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
    yield* f.agents.watchWaiting().pipe(
      Stream.filter((ids) => !ids.includes(agent.id)),
      Stream.runHead,
    )

    yield* f.failAnswers(new RequestNotWaiting())
    assert.equal(
      (yield* f.agents.answer(agent.id, permission.requestId, answer).pipe(Effect.flip))._tag,
      "RequestNotWaiting",
    )
  }),
)

it.live("persists a supplied Question and forwards a free-text answer", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    const turn = yield* f.started
    yield* turn.emit(PartSet.make({ turnId: turn.turnId, index: 0, part: question }))
    const waiting = yield* f.transcript(agent.id, waitingOn)
    assert.deepStrictEqual(waiting.turns[0]?.parts, [question])

    const answer = AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] })
    yield* f.agents.answer(agent.id, question.requestId, answer)
    assert.deepStrictEqual(f.answers, [{ requestId: question.requestId, answer }])
    yield* turn.emit(
      PartSet.make({
        turnId: turn.turnId,
        index: 0,
        part: QuestionPart.make({ ...question, status: "answered", answers: answer.answers }),
      }),
    )

    const settled = yield* f.transcript(
      agent.id,
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
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    const turn = yield* f.started
    yield* turn.emit(PartSet.make({ turnId: turn.turnId, index: 0, part: permission }))
    yield* f.transcript(agent.id, waitingOn)

    const restarted = yield* f.restart

    const snapshot = yield* restarted.agents
      .transcript(agent.id)
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.ok(Predicate.isTagged(snapshot, "Snapshot"))
    assert.deepStrictEqual(snapshot.turns[0]?.ended?.ending, TurnInterrupted.make({}))
    assert.equal(snapshot.turns[0]?.parts.find(isRequestPart)?.status, "expired")
    assert.deepStrictEqual(
      yield* restarted.agents.watchWaiting().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
      [],
    )
    assert.equal(
      (yield* restarted.agents
        .answer(agent.id, permission.requestId, AllowRequest.make({}))
        .pipe(Effect.flip))._tag,
      "RequestNotWaiting",
    )
  }),
)

it.live("forwards Stop and waits for the host to expire its request before the next message", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    const turn = yield* f.started
    yield* turn.emit(PartSet.make({ turnId: turn.turnId, index: 0, part: question }))
    yield* f.transcript(agent.id, waitingOn)
    yield* f.agents.stop(agent.id)
    assert.deepStrictEqual(f.stops, [agent.id])
    assert.equal(
      (yield* f.agents.send(agent.id, { message: "Too early", images: [] }).pipe(Effect.flip))._tag,
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

    const stopped = yield* f.transcript(agent.id, ({ turns }) =>
      Predicate.isNotNullish(turns[0]?.ended),
    )

    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
    assert.equal(stopped.turns[0]?.parts.find(isRequestPart)?.status, "expired")

    yield* f.agents.send(agent.id, { message: "Continue", images: [] })
    assert.equal((yield* f.started).input.message, "Continue")
  }),
)

it.live("starts queued messages when the host reports a completed Turn", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    const first = yield* f.started
    yield* f.agents.send(agent.id, { message: "Next", images: [] })
    const waiting = yield* f.transcript(agent.id, ({ queued }) => queued.length === 1)
    assert.equal(waiting.queued[0]?.message, "Next")
    yield* finish(f, first)
    assert.equal((yield* f.started).input.message, "Next")
  }),
)

it.live("passes default and changed Permission modes to the host, and refuses modes for pi", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    const first = yield* f.started
    assert.equal(first.settings.permissionMode, "default")
    yield* finish(f, first)
    yield* f.agents.changePermissionMode(agent.id, "acceptEdits")
    yield* f.agents.send(agent.id, { message: "Next", images: [] })
    assert.equal((yield* f.started).settings.permissionMode, "acceptEdits")

    const pi = yield* f.create(null, "pi-cli")
    assert.isNull((yield* f.started).settings.permissionMode)
    assert.equal(
      (yield* f.agents.changePermissionMode(pi.id, "auto").pipe(Effect.flip))._tag,
      "NoPermissionModes",
    )
  }),
)

it.live("maps a host failure while forwarding an answer to an Agent error", () =>
  Effect.gen(function* () {
    const f = yield* agentServicesFixture
    const agent = yield* f.create()
    yield* f.started
    yield* f.failAnswers(new HostAgentError({ message: "The host refused the answer" }))

    const refused = yield* f.agents
      .answer(agent.id, "request-1", AllowRequest.make({}))
      .pipe(Effect.flip)

    assert.equal(refused._tag, "AgentError")
    assert.equal(refused.message, "The host refused the answer")
  }),
)
