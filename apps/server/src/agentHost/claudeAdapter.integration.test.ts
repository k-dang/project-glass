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

const run = (command: string, reply: string) =>
  `Use the Bash tool to run exactly \`${command}\` and nothing else, then reply with exactly: ${reply}`

const pixel = Image.make({
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
})

it.live("answers Claude Code's Permission requests and Questions through Glass", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-requests")
    const agent = yield* f.open(conversation)
    yield* agent.configure({ permissionMode: "default" })

    yield* agent.send(run("touch compatible.txt", "DONE"))
    const permission = waiting(yield* f.until((turns) => waiting(turns) !== undefined))
    assert.ok(Predicate.isTagged(permission, "PermissionRequest"))
    assert.equal(permission.toolName, "Bash")
    yield* agent.answer(permission.requestId, AllowRequest.make({}))
    const allowed = yield* f.until(settled(1))
    assert.deepStrictEqual(allowed[0]?.ended?.ending, TurnDone.make({}))

    yield* agent.send(
      "Use the AskUserQuestion tool once to ask me which files to read, offering exactly two options labelled Only the README and Everything. After I answer, reply with exactly the label I chose.",
    )

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

    yield* agent.send(`Reply with exactly this text and nothing else: ${long}`)
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(lastText(turn), TextPart.make({ text: long }))
    const textIndex = turn?.parts.findLastIndex((part) => Predicate.isTagged(part, "Text"))
    assert.isAbove(
      f.events.filter(
        (event) => Predicate.isTagged(event, "PartAppended") && event.index === textIndex,
      ).length,
      1,
    )
  }).pipe(Effect.scoped),
)

it.live("sends a message's images to Claude Code", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-image")
    const agent = yield* f.open(conversation)

    yield* agent.send(
      "What's in this image? Answer in one short sentence without using any tools.",
      [pixel],
    )
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
  }).pipe(Effect.scoped),
)

it.live("lists Claude Code's models and efforts, naming its default after the model it runs", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-models")
    const listed = yield* f.adapter.models
    const efforts = ["low", "medium", "high", "xhigh", "max"]

    assert.deepStrictEqual(listed.defaultModel, { id: "default", name: "Sonnet", efforts })
    assert.deepStrictEqual(listed.models, [
      { id: "sonnet", name: "Sonnet", efforts },
      { id: "fable", name: "Fable", efforts },
      { id: "opus", name: "Opus", efforts },
      { id: "haiku", name: "Haiku", efforts },
    ])
  }).pipe(Effect.scoped),
)

it.live("starts on the chosen model and effort, and changes the effort for the next Turn", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-model-change")
    const agent = yield* f.open(conversation)

    yield* agent.configure({ model: "haiku", effort: "high" })
    yield* agent.send("Reply with exactly: FIRST")
    yield* f.until(settled(1))

    yield* agent.configure({ effort: "low" })
    yield* agent.send("Reply with exactly: SECOND")
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
    yield* agent.configure({ permissionMode: "default" })

    yield* agent.send(run("touch steer.txt", "FIRST"))
    const request = waiting(yield* f.until((turns) => waiting(turns) !== undefined))!
    yield* agent.steer("Change course: reply with exactly STEERED instead.")
    yield* agent.answer(request.requestId, AllowRequest.make({}))

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepInclude(
      turn?.parts ?? [],
      SteerPart.make({ message: "Change course: reply with exactly STEERED instead.", images: [] }),
    )
    assert.deepStrictEqual(lastText(turn), TextPart.make({ text: "STEERED" }))
  }).pipe(Effect.scoped),
)

it.live("continues a conversation when Claude Code starts again", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-resume")

    yield* Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* f.open(conversation)
        yield* agent.send("Remember the word lantern. Reply with exactly: Noted.")
        yield* f.until(settled(1))
      }),
    )

    const again = yield* f.open(conversation)
    yield* again.send(
      "Which word did I ask you to remember? Reply with only that word, in lowercase.",
    )
    const turns = yield* f.until(settled(2))

    assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "lantern" }))
  }).pipe(Effect.scoped),
)

it.live(
  "refuses an answer that doesn't fit a Permission request, then denies it with the reason",
  () =>
    Effect.gen(function* () {
      const f = yield* claudeSession("claude-deny")
      const agent = yield* f.open(conversation)
      yield* agent.configure({ permissionMode: "default" })

      yield* agent.send(run("touch notes.txt", "DONE"))
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
      const toolCall = turn?.parts.find((part) => Predicate.isTagged(part, "ToolCall"))
      assert.include(toolCall?.output, "Leave the checkout alone")

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

      yield* agent.send(run("touch notes.txt", "DONE"))
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

    yield* agent.send(run("touch first.txt", "DONE"))
    const request = waiting(yield* f.until((turns) => waiting(turns) !== undefined))!
    yield* agent.answer(request.requestId, AllowRequest.make({}))
    yield* f.until(settled(1))

    yield* agent.configure({ permissionMode: "bypassPermissions" })
    yield* agent.send(run("touch second.txt", "DONE"))
    const [, second] = yield* f.until(settled(2))

    assert.deepStrictEqual(second?.ended?.ending, TurnDone.make({}))
    assert.isUndefined(second?.parts.find(isRequestPart))
  }).pipe(Effect.scoped),
)
