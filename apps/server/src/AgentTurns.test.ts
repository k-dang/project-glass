import { assert, it } from "@effect/vitest"
import { TextPart, ThinkingPart, TurnDone, type TurnPart } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { realpathSync } from "node:fs"
import {
  agentsFixture,
  claudeCode,
  lastText,
  pixel,
  settled,
  userMessages,
} from "../test/agentsFixture"
import { vi } from "vite-plus/test"

vi.stubEnv("PI_OFFLINE", "1")

it.live("streams thinking, tool calls, and text into a Turn that ends done once pi settles", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({
      reply: ({ messages }) =>
        messages.some(({ role }) => role === "tool")
          ? [{ text: "It says " }, { text: "hi." }]
          : [
              { thinking: "I should run echo." },
              { toolCall: { id: "call-1", name: "bash", arguments: { command: "echo hi" } } },
            ],
    })

    const agent = yield* f.start("Run echo")
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.equal(turn?.message, "Run echo")
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(
      turn?.parts.map((part) =>
        Predicate.isTagged(part, "ToolCall")
          ? {
              name: part.name,
              summary: part.inputSummary,
              output: part.output?.trim(),
              status: part.status,
            }
          : part,
      ),
      [
        ThinkingPart.make({ text: "I should run echo." }),
        { name: "bash", summary: "echo hi", output: "hi", status: "done" },
        TextPart.make({ text: "It says hi." }),
      ],
    )
  }),
)

it.live("ends a Turn when pi settles after retrying, not at the first agent_end", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture(
      { output: "Recovered.", failFirst: 1 },
      { retry: { enabled: true, maxRetries: 1, baseDelayMs: 50 } },
    )

    const agent = yield* f.start()
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepInclude(turn?.parts ?? [], TextPart.make({ text: "Recovered." }))
    assert.lengthOf(f.model.calls, 2)
  }),
)

it.live("fails a Turn with a reason that leaves out the provider's own words", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "secret-key-123 is not a valid API key", status: 401 })
    const agent = yield* f.start()
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.equal(turn?.ended?.ending._tag, "Failed")
    const ending = turn?.ended?.ending
    const reason = Predicate.isTagged(ending, "Failed") ? ending.reason : ""
    assert.include(reason, "sign in")
    assert.notInclude(reason, "secret-key-123")
  }),
)

it.live("continues the same conversation in later Turns", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Noted." })
    const agent = yield* f.start("Remember the word lantern")
    yield* f.transcript(agent.id, settled(1))

    yield* f.send(agent.id, "What was the word?")
    const turns = yield* f.transcript(agent.id, settled(2))

    assert.deepStrictEqual(
      turns.map(({ message, ended }) => ({ message, ending: ended?.ending })),
      [
        { message: "Remember the word lantern", ending: TurnDone.make({}) },
        { message: "What was the word?", ending: TurnDone.make({}) },
      ],
    )
    const asked = userMessages(f.model.calls.at(-1)!)
    assert.isTrue(asked.some((content) => content.includes("lantern")))
  }),
)

it.live("sends a message's images to pi and keeps them in the transcript", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "A pixel." })
    const agent = yield* f.start("What's this?", undefined, [pixel])
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.deepStrictEqual(turn?.images, [pixel])
    assert.include(
      JSON.stringify(f.model.calls[0]?.messages),
      `data:image/png;base64,${pixel.data}`,
    )
  }),
)

it.live("sends a message's images to Claude Code", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const agent = yield* f.start("What's this?", claudeCode, [pixel])
    yield* f.transcript(agent.id, settled(1))

    const prompts = (yield* f.claude.log).filter(({ kind }) => kind === "prompt")
    assert.deepStrictEqual(
      prompts.map((entry) => entry.kind === "prompt" && entry.images),
      [["image/png"]],
    )
  }),
)

const shown = (part: TurnPart) =>
  Predicate.isTagged(part, "ToolCall")
    ? {
        name: part.name,
        summary: part.inputSummary,
        output: part.output,
        status: part.status,
        parent: part.parentToolCallId,
      }
    : part

it.live(
  "streams a Claude Code Agent's thinking, text, and tool calls, nesting a subagent's under its parent",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({}, undefined, {
        reply: [
          { thinking: "I'll delegate the listing." },
          {
            toolCall: {
              id: "task-1",
              name: "Agent",
              input: { description: "List files", prompt: "Run ls" },
              output: "README.md",
            },
          },
          {
            toolCall: {
              id: "bash-1",
              name: "Bash",
              input: { command: "ls" },
              output: "README.md",
              parentToolCallId: "task-1",
            },
          },
          {
            toolCall: {
              id: "bash-2",
              name: "Bash",
              input: { command: "false" },
              output: "exit 1",
              isError: true,
            },
          },
          { text: "There's a **README**." },
        ],
      })

      const agent = yield* f.start("What's here?", claudeCode)
      const [turn] = yield* f.transcript(agent.id, settled(1))

      assert.equal(agent.engine, "claude-code")
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(turn?.parts.map(shown), [
        ThinkingPart.make({ text: "I'll delegate the listing." }),
        { name: "Agent", summary: "List files", output: "README.md", status: "done", parent: null },
        { name: "Bash", summary: "ls", output: "README.md", status: "done", parent: "task-1" },
        { name: "Bash", summary: "false", output: "exit 1", status: "failed", parent: null },
        TextPart.make({ text: "There's a **README**." }),
      ])

      const launched = (yield* f.claude.log).flatMap((line) =>
        line.kind === "launched" ? [line.cwd] : [],
      )

      assert.deepStrictEqual(launched, [realpathSync(f.worktree(agent.name))])
    }),
)

it.live("fails a Claude Code Turn with a reason that leaves out Claude Code's own words", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, {
      error: { status: 401, message: "sk-ant-secret is not a valid API key" },
    })

    const agent = yield* f.start("Say hello", claudeCode)
    const [turn] = yield* f.transcript(agent.id, settled(1))

    const ending = turn?.ended?.ending
    const reason = Predicate.isTagged(ending, "Failed") ? ending.reason : ""
    assert.include(reason, "sign in")
    assert.notInclude(reason, "sk-ant-secret")
  }),
)

it.live(
  "fails the running Turn when Claude Code exits, and starts it again for the next message",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({}, undefined, { exit: true })
      const agent = yield* f.start("Say hello", claudeCode)

      const [failed] = yield* f.transcript(agent.id, settled(1))
      const ending = failed?.ended?.ending
      assert.include(Predicate.isTagged(ending, "Failed") ? ending.reason : "", "stopped")

      yield* f.claude.configure({ reply: [{ text: "Back again." }] })
      yield* f.send(agent.id, "Try again")
      const [, retried] = yield* f.transcript(agent.id, settled(2))

      assert.deepStrictEqual(retried?.ended?.ending, TurnDone.make({}))
      assert.deepInclude(retried?.parts ?? [], TextPart.make({ text: "Back again." }))
    }),
)

it.live("streams a long Claude Code reply, a fast burst of events, to its end", () =>
  Effect.gen(function* () {
    const long = "Every word of this reply streams in its own small piece. ".repeat(8).trim()
    const f = yield* agentsFixture({}, undefined, { reply: [{ text: long }] })
    const agent = yield* f.start("Say a lot", claudeCode)
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(lastText(turn), TextPart.make({ text: long }))
  }),
)
