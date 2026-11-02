import { assert, it } from "@effect/vitest"
import { TextPart, ThinkingPart, toDoMention, TurnDone } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { agentsFixture, pixel, settled, userMessages } from "../test/agentsFixture"
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

it.live("gives pi a mentioned To-do's notes and keeps the message as the user wrote it", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "On it." })
    const [added] = yield* f.client.AddToDo({ title: "Fix the flaky test" })
    assert.isDefined(added)
    yield* f.client.EditToDo({ id: added.id, title: added.title, notes: "It times out on CI." })

    const message = `Look at ${toDoMention(added)} please`
    const agent = yield* f.start(message)
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.equal(turn?.message, message)

    const read = f.model.calls[0]?.messages
      .filter(({ role }) => role === "user")
      .flatMap(({ content }) =>
        Predicate.isString(content) ? [content] : (content ?? []).map(({ text }) => text ?? ""),
      )
      .join("\n")

    assert.include(read, `Look at To-do ${added.id} ("Fix the flaky test") please`)
    assert.include(read, "It times out on CI.")
  }),
)
