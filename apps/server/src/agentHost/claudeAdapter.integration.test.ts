import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  DenyRequest,
  Image,
  isRequestPart,
  SteerPart,
  acceptedSuggestedDraftOf,
  TextPart,
  type Turn,
  TurnDone,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { join } from "node:path"
import {
  claudeSession,
  reviewBrief,
  run,
  writeGreeter,
  writeGreetSkill,
} from "../../test/adapterSessions"
import { settled } from "../../test/agentsFixture"

const conversation = "6f2c1b9e-3a4d-4e8f-9b7a-1c2d3e4f5a6b"

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

    yield* agent.send(run("Bash", "touch compatible.txt", "DONE"))
    const permission = yield* f.request
    assert.ok(Predicate.isTagged(permission, "PermissionRequest"))
    assert.equal(permission.toolName, "Bash")
    yield* agent.answer(permission.requestId, AllowRequest.make({}))
    const allowed = yield* f.until(settled(1))
    assert.deepStrictEqual(allowed[0]?.ended?.ending, TurnDone.make({}))

    yield* agent.send(
      "Use the AskUserQuestion tool once to ask me which files to read, offering exactly two options labelled Only the README and Everything. After I answer, reply with exactly the label I chose.",
    )

    const question = yield* f.request

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

it.live("lists the folder's skills among what Claude Code runs as `/name`", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-commands")
    yield* writeGreetSkill(join(f.folder, ".claude", "skills"))

    const commands = yield* f.adapter.commands(f.folder)

    assert.deepStrictEqual(
      commands.find(({ name }) => name === "greet"),
      // Claude Code names where the skill comes from; this folder is also the home.
      { name: "greet", description: "Greets the user by name. (user)" },
    )
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

    yield* agent.send(run("Bash", "touch steer.txt", "FIRST"))
    const request = yield* f.request
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

      yield* agent.send(run("Bash", "touch notes.txt", "DONE"))
      const request = yield* f.request

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

      yield* agent.send(run("Bash", "touch notes.txt", "DONE"))
      const request = yield* f.request
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

    yield* agent.send(run("Bash", "touch first.txt", "DONE"))
    const request = yield* f.request
    yield* agent.answer(request.requestId, AllowRequest.make({}))
    yield* f.until(settled(1))

    yield* agent.configure({ permissionMode: "bypassPermissions" })
    yield* agent.send(run("Bash", "touch second.txt", "DONE"))
    const [, second] = yield* f.until(settled(2))

    assert.deepStrictEqual(second?.ended?.ending, TurnDone.make({}))
    assert.isUndefined(second?.parts.find(isRequestPart))
  }).pipe(Effect.scoped),
)

it.live("reads its checkout and proposes Suggested drafts as an Agent review's Agent", () =>
  Effect.gen(function* () {
    const f = yield* claudeSession("claude-review")
    yield* writeGreeter(f.folder)
    const agent = yield* f.open(conversation, reviewBrief)

    yield* agent.send(
      'Read greet.ts with the Read tool. Then call the suggest_draft tool exactly twice, one call after the other: first with path greet.ts, side new, line 2, and body "Keep the name."; then with path greet.ts, side new, line 40, and body "Off the diff.". Then reply with exactly: DONE',
    )
    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.isFalse(turn!.parts.some(isRequestPart))

    const calls = turn!.parts.filter((part) => Predicate.isTagged(part, "ToolCall"))
    assert.includeMembers(
      ["Read", "Grep", "Glob", "suggest_draft"],
      [...new Set(calls.map(({ name }) => name))],
    )

    const suggestions = calls.filter(({ name }) => name === "suggest_draft")
    assert.deepStrictEqual(
      suggestions.map(({ status }) => status),
      ["done", "failed"],
    )
    assert.deepStrictEqual(acceptedSuggestedDraftOf(suggestions[0]!), {
      path: "greet.ts",
      side: "new",
      line: 2,
      body: "Keep the name.",
    })
    assert.include(suggestions[1]?.output, "not a line of the diff")
  }).pipe(Effect.scoped),
)
