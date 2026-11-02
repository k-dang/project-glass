import { assert, it } from "@effect/vitest"
import {
  AnswerQuestion,
  type Image,
  isRequestPart,
  isWaiting,
  type RequestPart,
  TextPart,
  ThinkingPart,
  type Turn,
  TurnDone,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { piSession, settled } from "../../test/adapterSessions"
import { lastUserText } from "../../test/fakeModelProvider"

const conversation = "1d7e4b2a-9c3f-4a5e-8b6d-2f1e0a9c8b7d"

const pixel: Image = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
}

const holding = { output: "Done.", hang: true }

const shownParts = (turn: Turn | undefined) =>
  turn?.parts.map((part) =>
    Predicate.isTagged(part, "Steer")
      ? { steer: part.message }
      : Predicate.isTagged(part, "Text")
        ? { text: part.text }
        : part._tag,
  )

const waiting = (turns: ReadonlyArray<Turn>) =>
  turns.at(-1)?.parts.findLast((part): part is RequestPart => isWaiting(part))

const lastText = (turn: Turn | undefined) =>
  turn?.parts.findLast((part) => Predicate.isTagged(part, "Text"))

const inputExtension = `export default (pi) => pi.on("input", async (event) => {
  if (event.text === "ping") return { action: "handled" }
  if (event.text === "remind me") {
    pi.sendUserMessage("Check the tests", { deliverAs: "followUp" })
    return { action: "handled" }
  }
  if (event.text.startsWith("?quick ")) return { action: "transform", text: "Briefly: " + event.text.slice(7) }
  return { action: "continue" }
})`

it.live("streams thinking, tool calls, and text into a Turn that ends done once pi settles", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-streams", {
      reply: ({ messages }) =>
        messages.some(({ role }) => role === "tool")
          ? [{ text: "It says " }, { text: "hi." }]
          : [
              { thinking: "I should run echo." },
              { toolCall: { id: "call-1", name: "bash", arguments: { command: "echo hi" } } },
            ],
    })

    const agent = yield* f.open(conversation)

    yield* agent.send("Run echo")
    const [turn] = yield* f.until(settled(1))

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
  }).pipe(Effect.scoped),
)

it.live("ends a Turn when pi settles after retrying, not at the first agent_end", () =>
  Effect.gen(function* () {
    const f = yield* piSession(
      "pi-retry",
      { output: "Recovered.", failFirst: 1 },
      { retry: { enabled: true, maxRetries: 1, baseDelayMs: 50 } },
    )

    const agent = yield* f.open(conversation)

    yield* agent.send("Say hello")
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepInclude(turn?.parts ?? [], TextPart.make({ text: "Recovered." }))
  }).pipe(Effect.scoped),
)

it.live("fails a Turn with a reason that leaves out the provider's own words", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-rejected", {
      output: "secret-key-123 is not a valid API key",
      status: 401,
    })

    const agent = yield* f.open(conversation)

    yield* agent.send("Say hello")
    const [turn] = yield* f.until(settled(1))

    const ending = turn?.ended?.ending
    assert.ok(Predicate.isTagged(ending, "Failed"))
    assert.include(ending.reason, "sign in")
    assert.notInclude(ending.reason, "secret-key-123")
  }).pipe(Effect.scoped),
)

it.live("continues the same conversation in later Turns", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-conversation", {
      output: (input) =>
        JSON.stringify(input.messages).includes("lantern") && lastUserText(input).includes("word?")
          ? "It was lantern."
          : "Noted.",
    })

    const agent = yield* f.open(conversation)

    yield* agent.send("Remember the word lantern")
    yield* f.until(settled(1))
    yield* agent.send("What was the word?")
    const turns = yield* f.until(settled(2))

    assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "It was lantern." }))
  }).pipe(Effect.scoped),
)

it.live("Steers a pi Turn, which takes the message in before it ends", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-steer", holding)
    const agent = yield* f.open(conversation)

    yield* agent.send("Start")
    yield* f.model.received(1)
    yield* agent.steer("Change course")
    yield* f.model.release({
      output: ({ messages }) =>
        JSON.stringify(messages).includes("Change course") ? "Changed." : "Started.",
    })

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(shownParts(turn), [
      { text: "Started." },
      { steer: "Change course" },
      { text: "Changed." },
    ])
  }).pipe(Effect.scoped),
)

it.live("stops a pi Turn, handing back a Steer pi hadn't taken in", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-stop", holding)
    const agent = yield* f.open(conversation)

    yield* agent.send("Start")
    yield* f.model.received(1)
    yield* agent.steer("Now, please")
    const handedBack = yield* agent.session.stopTurn

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnStopped.make({}))
    assert.deepStrictEqual(handedBack, [{ message: "Now, please", images: [] }])
    yield* f.model.cancelled(1)
  }).pipe(Effect.scoped),
)

it.live("shows a Steer a pi extension handles itself", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-handled-steer", holding)
    yield* f.extension("input.js", inputExtension)
    const agent = yield* f.open(conversation)

    yield* agent.send("Start")
    yield* f.model.received(1)
    yield* agent.steer("ping")
    yield* f.model.release({ output: "Done." })

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(shownParts(turn), [{ steer: "ping" }, { text: "Done." }])
  }).pipe(Effect.scoped),
)

it.live("hands back what pi held when the Turn stops: Steers as written, then pi's own", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-held-steers", holding)
    yield* f.extension("input.js", inputExtension)
    const agent = yield* f.open(conversation)

    yield* agent.send("Start")
    yield* f.model.received(1)
    yield* agent.steer("?quick tabs or spaces?", [pixel])
    yield* agent.steer("remind me")
    const handedBack = yield* agent.session.stopTurn

    assert.deepStrictEqual(handedBack, [
      { message: "?quick tabs or spaces?", images: [pixel] },
      { message: "Check the tests", images: [] },
    ])
  }).pipe(Effect.scoped),
)

it.live("sends a message's images to pi", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-image", { output: "A pixel." })
    const agent = yield* f.open(conversation)

    yield* agent.send("What's this?", [pixel])
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
  }).pipe(Effect.scoped),
)

it.live("lists the models and efforts pi offers, with its default", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-models")
    const pi = yield* f.adapter.models

    assert.equal(pi.defaultModel?.id, "glass-test/gpt-test")
    assert.deepStrictEqual(
      pi.models.filter(({ id }) => id.startsWith("glass-test/")),
      [
        { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] },
        {
          id: "glass-test/gpt-test-thinking",
          name: "GPT Test Thinking",
          efforts: ["off", "minimal", "low", "medium", "high"],
        },
      ],
    )
  }).pipe(Effect.scoped),
)

it.live(
  "lists only the models pi is scoped to, including an extension's, in its order, starting on one of them",
  () =>
    Effect.gen(function* () {
      const f = yield* piSession(
        "pi-scoped-models",
        {},
        { enabledModels: ["glass-extension/extension-model", "glass-test/*thinking"] },
      )

      yield* f.extension(
        "provider.js",
        `export default (pi) => pi.registerProvider("glass-extension", {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test-extension-key",
          api: "openai-completions",
          models: [{
            id: "extension-model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          }],
        })`,
      )

      const pi = yield* f.adapter.models
      assert.equal(pi.defaultModel?.id, "glass-extension/extension-model")
      assert.deepStrictEqual(
        pi.models.map(({ id }) => id),
        ["glass-extension/extension-model", "glass-test/gpt-test-thinking"],
      )
    }).pipe(Effect.scoped),
)

it.live(
  "starts a pi Agent on the chosen model and effort, and changes them for the next Turn",
  () =>
    Effect.gen(function* () {
      const f = yield* piSession("pi-model-change", { output: "Hi." })
      const agent = yield* f.open(conversation)

      yield* agent.configure({ model: "glass-test/gpt-test-thinking", effort: "high" })
      yield* agent.send("Say hello")
      yield* f.until(settled(1))
      yield* agent.configure({})
      yield* agent.send("Again")
      const turns = yield* f.until(settled(2))

      assert.deepStrictEqual(
        turns.map(({ ended }) => ended?.ending),
        [TurnDone.make({}), TurnDone.make({})],
      )
    }).pipe(Effect.scoped),
)

it.live("runs a pi Agent's next Turn on pi's own thinking level once its effort is cleared", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-thinking-level", { output: "Hi." })
    const agent = yield* f.open(conversation)
    const thinker = "glass-test/gpt-test-thinking"

    yield* agent.configure({ model: thinker, effort: "high" })
    yield* agent.send("Say hello")
    yield* f.until(settled(1))
    yield* agent.configure({ model: thinker })
    yield* agent.send("Again")
    const turns = yield* f.until(settled(2))

    assert.deepStrictEqual(
      turns.map(({ ended }) => ended?.ending),
      [TurnDone.make({}), TurnDone.make({})],
    )
  }).pipe(Effect.scoped),
)

const firstQuestion = (part: RequestPart) =>
  Predicate.isTagged(part, "Question") ? (part.questions[0]?.question ?? "") : ""

it.live("asks pi's extension dialogs as Questions, answered with an option or text", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-dialogs", {
      reply: ({ messages }) =>
        messages.some(({ role }) => role === "tool")
          ? [{ text: "Greeted." }]
          : [{ toolCall: { id: "call-1", name: "bash", arguments: { command: "echo hi" } } }],
    })

    yield* f.extension(
      "greet.js",
      `export default (pi) => pi.on("tool_call", async (event, ctx) => {
        const greeting = await ctx.ui.select("Which greeting?", ["Hi", "Hello"])
        const name = await ctx.ui.input("Who to greet?", "a name")
        const sure = await ctx.ui.confirm("Greet them?", "It prints to the terminal.")
        return { block: true, reason: greeting + " " + name + " " + sure }
      })`,
    )
    const agent = yield* f.open(conversation)

    const replies = new Map([
      ["Which greeting?", { chosen: ["Hello"], text: null }],
      ["Who to greet?", { chosen: [], text: "Ada" }],
      ["Greet them?", { chosen: ["Yes"], text: null }],
    ])

    yield* agent.send("Greet someone")

    for (const asked of replies.keys()) {
      const question = waiting(
        yield* f.until((turns) => {
          const part = waiting(turns)

          return part !== undefined && firstQuestion(part) === asked
        }),
      )!

      yield* agent.answer(
        question.requestId,
        AnswerQuestion.make({ answers: [replies.get(asked)!] }),
      )
    }

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(
      turn?.parts.flatMap((part) =>
        Predicate.isTagged(part, "Question")
          ? part.questions.map(({ question, detail, options, freeText }) => ({
              question,
              detail,
              options: options.map(({ label }) => label),
              freeText,
            }))
          : [],
      ),
      [
        { question: "Which greeting?", detail: null, options: ["Hi", "Hello"], freeText: false },
        { question: "Who to greet?", detail: null, options: [], freeText: true },
        {
          question: "Greet them?",
          detail: "It prints to the terminal.",
          options: ["Yes", "No"],
          freeText: false,
        },
      ],
    )
    const call = turn?.parts.find((part) => Predicate.isTagged(part, "ToolCall"))
    assert.include(
      Predicate.isTagged(call, "ToolCall") ? (call.output ?? "") : "",
      "Hello Ada true",
    )
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
  }).pipe(Effect.scoped),
)

it.live("stops a pi Turn while its extension's dialog waits", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-stop-in-dialog", {
      reply: () => [
        { toolCall: { id: "call-1", name: "bash", arguments: { command: "echo hi" } } },
      ],
    })

    yield* f.extension(
      "confirm.js",
      `export default (pi) => pi.on("tool_call", async (event, ctx) => {
        const sure = await ctx.ui.confirm("Run it?", event.toolName)
        return sure ? undefined : { block: true, reason: "Declined" }
      })`,
    )
    const agent = yield* f.open(conversation)

    yield* agent.send("Greet someone")
    const request = waiting(yield* f.until((turns) => waiting(turns) !== undefined))!
    yield* agent.session.stopTurn

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnStopped.make({}))
    assert.equal(turn?.parts.find(isRequestPart)?.status, "expired")

    const refused = yield* agent
      .answer(request.requestId, AnswerQuestion.make({ answers: [] }))
      .pipe(Effect.flip)

    assert.equal(refused._tag, "RequestNotWaiting")
  }).pipe(Effect.scoped),
)
