import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  DenyRequest,
  Image,
  isRequestPart,
  isWaiting,
  type RequestPart,
  SteerPart,
  TextPart,
  type Turn,
  TurnDone,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { claudeSession } from "../../test/adapterSessions"
import { settled } from "../../test/agentsFixture"

const conversation = "6f2c1b9e-3a4d-4e8f-9b7a-1c2d3e4f5a6b"

const waiting = (turns: ReadonlyArray<Turn>) =>
  turns.at(-1)?.parts.find((part): part is RequestPart => isWaiting(part))

const lastText = (turn: Turn | undefined) =>
  turn?.parts.findLast((part) => Predicate.isTagged(part, "Text"))

const pixel = Image.make({
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
})

it.live("answers Claude Code's Permission requests and Questions through Glass", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-requests")
    const agent = yield* f.open(conversation)
    yield* agent.configure({ permissionMode: "default" })

    yield* agent.send("Please run `touch compatible.txt`")
    const permission = waiting(yield* f.until((turns) => waiting(turns) !== undefined))
    assert.ok(Predicate.isTagged(permission, "PermissionRequest"))
    assert.equal(permission.toolName, "Bash")
    yield* agent.answer(permission.requestId, AllowRequest.make({}))
    const allowed = yield* f.until(settled(1))
    assert.deepStrictEqual(allowed[0]?.ended?.ending, TurnDone.make({}))

    yield* agent.send("Please ask which files to read")

    const question = waiting(
      yield* f.until((turns) => turns.length === 2 && waiting(turns) !== undefined),
    )

    assert.ok(Predicate.isTagged(question, "Question"))
    yield* agent.answer(
      question.requestId,
      AnswerQuestion.make({ answers: [{ chosen: ["Only the README"], text: null }] }),
    )
    const answered = yield* f.until(settled(2))
    assert.deepStrictEqual(answered[1]?.ended?.ending, TurnDone.make({}))
    assert.include(
      Predicate.isTagged(lastText(answered[1]), "Text") ? lastText(answered[1])!.text : "",
      "Only the README",
    )
  }).pipe(Effect.scoped),
)

it.live("streams a long reply in small pieces to its end", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-long-reply")
    const agent = yield* f.open(conversation)
    const long = "Every word of this reply streams in its own small piece. ".repeat(8).trim()

    yield* agent.send(long)
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(lastText(turn), TextPart.make({ text: `Fake reply to: ${long}` }))
    assert.isAbove(f.events.filter((event) => Predicate.isTagged(event, "PartAppended")).length, 1)
  }).pipe(Effect.scoped),
)

it.live("sends a message's images to Claude Code", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-image")
    const agent = yield* f.open(conversation)

    yield* agent.send("What's this?", [pixel])
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
  }).pipe(Effect.scoped),
)

it.live("lists Claude Code's models and efforts, naming its default after the model it runs", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-models")
    const listed = yield* f.adapter.models
    const efforts = ["low", "medium", "high", "xhigh", "max"]

    assert.deepStrictEqual(listed.defaultModel, { id: "default", name: "Opus", efforts })
    assert.deepStrictEqual(listed.models, [
      { id: "opus", name: "Opus", efforts },
      { id: "fable", name: "Fable", efforts },
      { id: "sonnet", name: "Sonnet", efforts },
      { id: "haiku", name: "Haiku", efforts },
    ])
  }).pipe(Effect.scoped),
)

it.live("starts on the chosen model and effort, and changes them for the next Turn", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-model-change")
    const agent = yield* f.open(conversation)

    yield* agent.configure({ model: "sonnet", effort: "high" })
    yield* agent.send("Which model?")
    yield* f.until(settled(1))

    yield* agent.configure({})
    yield* agent.send("And now?")
    const turns = yield* f.until(settled(2))

    assert.deepStrictEqual(
      turns.map(({ ended }) => ended?.ending),
      [TurnDone.make({}), TurnDone.make({})],
    )
  }).pipe(Effect.scoped),
)

it.live("Steers a running Turn, showing the Steer where Claude Code takes it in", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-steer")
    const agent = yield* f.open(conversation)
    yield* f.api.hold

    yield* agent.send("Start")
    yield* f.api.received(1)
    yield* agent.steer("Change course")
    yield* f.api.release

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepInclude(turn?.parts ?? [], SteerPart.make({ message: "Change course", images: [] }))
  }).pipe(Effect.scoped),
)

it.live("continues a conversation when Claude Code starts again", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-resume", (request) => {
      const said = JSON.stringify(request.messages ?? [])

      return {
        type: "text",
        text:
          said.includes("lantern") && said.includes("What was the word")
            ? "You told me lantern."
            : "Noted.",
      }
    })

    yield* Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* f.open(conversation)
        yield* agent.send("Remember the word lantern")
        yield* f.until(settled(1))
      }),
    )

    const again = yield* f.open(conversation)
    yield* again.send("What was the word?")
    const turns = yield* f.until(settled(2))

    assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "You told me lantern." }))
  }).pipe(Effect.scoped),
)

it.live(
  "refuses an answer that doesn't fit a Permission request, then denies it with the reason",
  () =>
    Effect.gen(function* () {
      const f = yield* claudeSession("claude-deny")
      const agent = yield* f.open(conversation)
      yield* agent.configure({ permissionMode: "default" })

      yield* agent.send("Please run `touch notes.txt`")
      const request = waiting(yield* f.until((turns) => waiting(turns) !== undefined))!

      const refused = yield* agent
        .answer(
          request.requestId,
          AnswerQuestion.make({ answers: [{ chosen: ["README"], text: null }] }),
        )
        .pipe(Effect.flip)

      assert.equal(refused._tag, "HostAgentError")

      yield* agent.answer(
        request.requestId,
        DenyRequest.make({ reason: "Leave the checkout alone" }),
      )
      const [turn] = yield* f.until(settled(1))

      assert.equal(turn?.parts.find(isRequestPart)?.status, "denied")
      assert.include(lastText(turn)?.text, "Leave the checkout alone")

      const late = yield* agent.answer(request.requestId, AllowRequest.make({})).pipe(Effect.flip)

      assert.equal(late._tag, "RequestNotWaiting")
    }).pipe(Effect.scoped),
)

it.live(
  "stops a Turn while its Permission request waits, leaving the request no longer answerable",
  () =>
    Effect.gen(function* () {
      const f = yield* claudeSession("claude-stop-in-request")
      const agent = yield* f.open(conversation)
      yield* agent.configure({ permissionMode: "default" })

      yield* agent.send("Please run `touch notes.txt`")
      const request = waiting(yield* f.until((turns) => waiting(turns) !== undefined))!
      yield* agent.session.stopTurn

      const [turn] = yield* f.until(settled(1))
      assert.deepStrictEqual(turn?.ended?.ending, TurnStopped.make({}))
      assert.equal(turn?.parts.find(isRequestPart)?.status, "expired")

      const late = yield* agent.answer(request.requestId, AllowRequest.make({})).pipe(Effect.flip)

      assert.equal(late._tag, "RequestNotWaiting")
    }).pipe(Effect.scoped),
)

it.live("runs the next Turn in a newly chosen Permission mode", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-permission-mode-change")
    const agent = yield* f.open(conversation)
    yield* agent.configure({ permissionMode: "default" })

    yield* agent.send("Please run `touch first.txt`")
    const request = waiting(yield* f.until((turns) => waiting(turns) !== undefined))!
    yield* agent.answer(request.requestId, AllowRequest.make({}))
    yield* f.until(settled(1))

    yield* agent.configure({ permissionMode: "bypassPermissions" })
    yield* agent.send("Please run `touch second.txt`")
    const [, second] = yield* f.until(settled(2))

    assert.deepStrictEqual(second?.ended?.ending, TurnDone.make({}))
    assert.isUndefined(second?.parts.find(isRequestPart))
  }).pipe(Effect.scoped),
)
