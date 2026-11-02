import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  DenyRequest,
  Image,
  isRequestPart,
  isWaiting,
  SteerPart,
  TextPart,
  thisMac,
  type Turn,
  TurnDone,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { agentsFixture, claudeCode, lastText, settled } from "../test/agentsFixture"
import type { FakeAnthropicRequest } from "../test/fakeAnthropic"

it.live("connects the real Claude CLI's permission and Question callbacks to Glass", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})

    const agent = yield* f.start("Please run `touch compatible.txt`", {
      engine: "claude-code",
      model: null,
      effort: null,
      permissionMode: "default",
    })

    const waiting = yield* f.transcript(agent.id, (turns) =>
      turns.some(({ parts }) => parts.some(isWaiting)),
    )

    const permission = waiting[0]?.parts.find(isWaiting)
    assert.ok(Predicate.isTagged(permission, "PermissionRequest"))
    assert.equal(permission.toolName, "Bash")
    yield* f.client.AnswerRequest({
      agentId: agent.id,
      requestId: permission.requestId,
      answer: AllowRequest.make({}),
    })
    const allowed = yield* f.transcript(agent.id, settled(1))
    assert.equal(allowed[0]?.ended?.ending._tag, "Done")
    assert.equal(
      yield* Effect.promise(() => readFile(join(f.worktree(agent.name), "compatible.txt"), "utf8")),
      "",
    )

    yield* f.send(agent.id, "Please ask which files to read")

    const asking = yield* f.transcript(
      agent.id,
      (turns) => turns[1]?.parts.some(isWaiting) === true,
    )

    const question = asking[1]?.parts.find(isWaiting)
    assert.ok(Predicate.isTagged(question, "Question"))
    yield* f.client.AnswerRequest({
      agentId: agent.id,
      requestId: question.requestId,
      answer: AnswerQuestion.make({ answers: [{ chosen: ["Only the README"], text: null }] }),
    })
    const answered = yield* f.transcript(agent.id, settled(2))
    assert.equal(answered[1]?.ended?.ending._tag, "Done")
    assert.isTrue(
      answered[1]?.parts.some(
        (part) => Predicate.isTagged(part, "Text") && part.text.includes("Only the README"),
      ),
    )
  }),
)

const sent = (call: FakeAnthropicRequest | undefined) => JSON.stringify(call?.messages ?? [])

const hasImage = (call: FakeAnthropicRequest | undefined) =>
  (call?.messages ?? []).some(
    ({ content }) => !Predicate.isString(content) && content.some(({ type }) => type === "image"),
  )

const pixel = Image.make({
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
})

it.live("streams a long reply in small pieces to its end", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const long = "Every word of this reply streams in its own small piece. ".repeat(8).trim()
    const agent = yield* f.start(long, claudeCode)
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(lastText(turn), TextPart.make({ text: `Fake reply to: ${long}` }))
  }),
)

it.live("sends a message's images to the model", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const agent = yield* f.start("What's this?", claudeCode, [pixel])
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.deepStrictEqual(turn?.images, [pixel])
    assert.isTrue(hasImage(f.claude.calls[0]))
  }),
)

it.live("lists Claude Code's models and efforts, naming its default after the model it runs", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const listed = yield* f.client.ListAgentModels({ engine: "claude-code", place: thisMac })
    const efforts = ["low", "medium", "high", "xhigh", "max"]

    assert.deepStrictEqual(listed.defaultModel, { id: "default", name: "Opus", efforts })
    assert.deepStrictEqual(listed.models, [
      { id: "opus", name: "Opus", efforts },
      { id: "fable", name: "Fable", efforts },
      { id: "sonnet", name: "Sonnet", efforts },
      { id: "haiku", name: "Haiku", efforts },
    ])
  }),
)

it.live("starts on the chosen model and effort, and changes them for the next Turn", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const agent = yield* f.start("Which model?", { ...claudeCode, model: "sonnet", effort: "high" })
    yield* f.transcript(agent.id, settled(1))

    yield* f.client.ChangeAgentModel({ agentId: agent.id, model: null, effort: null })
    yield* f.send(agent.id, "And now?")
    yield* f.transcript(agent.id, settled(2))

    assert.deepStrictEqual(
      f.claude.calls.map(({ model, output_config }) => ({ model, effort: output_config?.effort })),
      [
        { model: "claude-sonnet-5-5", effort: "high" },
        { model: "claude-opus-5-5", effort: "medium" },
      ],
    )
  }),
)

it.live("Steers a running Turn, showing the Steer where Claude Code takes it in", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    yield* f.claude.hold
    const agent = yield* f.start("Start", claudeCode)
    yield* f.claude.received(1)

    yield* f.steer(agent.id, "Change course")
    yield* f.claude.release

    const done = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
    assert.deepStrictEqual(done.turns[0]?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(done.queued, [])
    assert.deepInclude(
      done.turns[0]?.parts ?? [],
      SteerPart.make({ message: "Change course", images: [] }),
    )
    assert.include(sent(f.claude.calls.at(-1)), "Change course")
  }),
)

it.live("continues the conversation after a relaunch cuts a running Turn short", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const agent = yield* f.start("Remember the word lantern", claudeCode)
    yield* f.transcript(agent.id, settled(1))

    yield* f.claude.hold
    yield* f.send(agent.id, "Keep going")
    yield* f.claude.received(2)

    const restarted = yield* f.restart
    yield* f.claude.release
    yield* restarted.SendMessage({ agentId: agent.id, message: "What was the word?", images: [] })
    const turns = yield* f.transcript(agent.id, settled(3), restarted)

    assert.deepStrictEqual(
      turns.map(({ ended }) => ended?.ending._tag),
      ["Done", "Interrupted", "Done"],
    )
    assert.include(sent(f.claude.calls.at(-1)), "lantern")
  }),
)

const waitingRequest = (turns: ReadonlyArray<Turn>) =>
  turns.flatMap(({ parts }) => parts.filter(isWaiting)).at(0)

it.live(
  "refuses an answer that doesn't fit a Permission request, then denies it with the reason",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({})

      const agent = yield* f.start("Please run `touch notes.txt`", {
        ...claudeCode,
        permissionMode: "default",
      })

      const request = waitingRequest(
        yield* f.transcript(agent.id, (turns) => waitingRequest(turns) !== undefined),
      )

      const requestId = request?.requestId ?? ""

      const misfit = AnswerQuestion.make({ answers: [{ chosen: ["README"], text: null }] })

      const refused = yield* f.client
        .AnswerRequest({ agentId: agent.id, requestId, answer: misfit })
        .pipe(Effect.flip)

      assert.equal(refused._tag, "AgentError")

      const denial = DenyRequest.make({ reason: "Leave the checkout alone" })
      yield* f.client.AnswerRequest({ agentId: agent.id, requestId, answer: denial })
      const [turn] = yield* f.transcript(agent.id, settled(1))

      assert.equal(turn?.parts.find(isRequestPart)?.status, "denied")
      assert.include(lastText(turn)?.text, "Leave the checkout alone")
      assert.isFalse(existsSync(join(f.worktree(agent.name), "notes.txt")))

      const late = yield* f.client
        .AnswerRequest({ agentId: agent.id, requestId, answer: AllowRequest.make({}) })
        .pipe(Effect.flip)

      assert.equal(late._tag, "RequestNotWaiting")
    }),
)

it.live(
  "stops a Turn while its Permission request waits, leaving the request no longer answerable",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({})

      const agent = yield* f.start("Please run `touch notes.txt`", {
        ...claudeCode,
        permissionMode: "default",
      })

      const request = waitingRequest(
        yield* f.transcript(agent.id, (turns) => waitingRequest(turns) !== undefined),
      )

      yield* f.client.StopTurn({ agentId: agent.id })
      const [turn] = yield* f.transcript(agent.id, settled(1))

      assert.deepStrictEqual(turn?.ended?.ending, TurnStopped.make({}))
      assert.equal(turn?.parts.find(isRequestPart)?.status, "expired")

      const late = yield* f.client
        .AnswerRequest({
          agentId: agent.id,
          requestId: request?.requestId ?? "",
          answer: AllowRequest.make({}),
        })
        .pipe(Effect.flip)

      assert.equal(late._tag, "RequestNotWaiting")
    }),
)

it.live("runs the next Turn in a newly chosen Permission mode", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})

    const agent = yield* f.start("Please run `touch first.txt`", {
      ...claudeCode,
      permissionMode: "default",
    })

    yield* f.answering(agent.id, settled(1), () => AllowRequest.make({}))

    yield* f.client.ChangePermissionMode({ agentId: agent.id, permissionMode: "bypassPermissions" })
    yield* f.send(agent.id, "Please run `touch second.txt`")
    const [, second] = yield* f.transcript(agent.id, settled(2))

    assert.deepStrictEqual(second?.ended?.ending, TurnDone.make({}))
    assert.isUndefined(second?.parts.find(isRequestPart))
    assert.isTrue(existsSync(join(f.worktree(agent.name), "second.txt")))
  }),
)
