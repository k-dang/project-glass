import { assert, it } from "@effect/vitest"
import {
  AnswerQuestion,
  type Image,
  isRequestPart,
  type RequestPart,
  acceptedSuggestedDraftOf,
  TextPart,
  type Turn,
  TurnDone,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Predicate, Schema } from "effect"
import { join } from "node:path"
import {
  writeGreetPack,
  piSession,
  reviewBrief,
  run,
  waiting,
  writeGreeter,
  writeGreetSkill,
  glassToolsBackend,
  lastTextOf,
  runningTool,
} from "../../test/adapterSessions"
import { settled } from "../../test/agentsFixture"
import {
  type FakeModelDelta,
  type FakeModelRequest,
  lastUserText,
} from "../../test/fakeModelProvider"
import { recordingSessions } from "../../test/sessionTape"
import { PI_MODEL_ID } from "../../test/piLogin"
import { ReviewRole } from "./protocol"

const conversation = "1d7e4b2a-9c3f-4a5e-8b6d-2f1e0a9c8b7d"

const pixel: Image = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
}

const shownParts = (turn: Turn | undefined) =>
  turn?.parts.map((part) =>
    Predicate.isTagged(part, "Steer")
      ? { steer: part.message }
      : Predicate.isTagged(part, "Text")
        ? { text: part.text }
        : part._tag,
  )

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

const confirmExtension = `export default (pi) => pi.on("tool_call", async (event, ctx) => {
  const sure = await ctx.ui.confirm("Run it?", event.toolName)
  return sure ? undefined : { block: true, reason: "Declined" }
})`

const yes = AnswerQuestion.make({ answers: [{ chosen: ["Yes"], text: null }] })

it.live("streams thinking, tool calls, and text into a Turn that ends done once pi settles", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-streams")
    const agent = yield* f.open(conversation)
    yield* agent.configure({ effort: "high" })

    yield* agent.send(
      `Think it through step by step first. ${run("bash", "echo hi", "It says hi.")}`,
    )
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    const thinking = turn?.parts[0]
    assert.ok(Predicate.isTagged(thinking, "Thinking"))
    assert.isNotEmpty(thinking.text)
    assert.deepInclude(
      turn?.parts.map((part) =>
        Predicate.isTagged(part, "ToolCall")
          ? {
              name: part.name,
              summary: part.inputSummary,
              output: part.output?.trim(),
              status: part.status,
            }
          : part._tag,
      ) ?? [],
      { name: "bash", summary: "echo hi", output: "hi", status: "done" },
    )
    assert.deepStrictEqual(lastText(turn), TextPart.make({ text: "It says hi." }))
    const textIndex = turn?.parts.findLastIndex((part) => Predicate.isTagged(part, "Text"))

    for (const index of [0, textIndex])
      assert.ok(
        f.events.some(
          (event) => Predicate.isTagged(event, "PartAppended") && event.index === index,
        ),
      )
  }).pipe(Effect.scoped),
)

it.live("ends a Turn when pi settles after retrying, not at the first agent_end", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-retry", {
      fake: { output: "Recovered.", failFirst: 1 },
      piSettings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 50 } },
    })

    const agent = yield* f.open(conversation)

    yield* agent.send("Say hello")
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepInclude(turn?.parts ?? [], TextPart.make({ text: "Recovered." }))
  }).pipe(Effect.scoped),
)

it.live("fails a Turn with a reason that leaves out the provider's own words", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-rejected", { apiKey: "glass-rejected-key" })
    const agent = yield* f.open(conversation)

    yield* agent.send("Say hello")
    const [turn] = yield* f.until(settled(1))

    const ending = turn?.ended?.ending
    assert.ok(Predicate.isTagged(ending, "Failed"))
    assert.include(ending.reason, "sign in")
    assert.notInclude(ending.reason, "Authentication failed")
  }).pipe(Effect.scoped),
)

it.live("continues the same conversation in later Turns", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-conversation")
    const agent = yield* f.open(conversation)

    yield* agent.send("Remember the word lantern. Reply with exactly: Noted.")
    yield* f.until(settled(1))
    yield* agent.send(
      "Which word did I ask you to remember? Reply with only that word, in lowercase.",
    )
    const turns = yield* f.until(settled(2))

    assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "lantern" }))
  }).pipe(Effect.scoped),
)

it.live("Steers a pi Turn, which takes the message in before it ends", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-steer")
    yield* f.extension("confirm.js", confirmExtension)
    const agent = yield* f.open(conversation)
    const steer = "Change course: reply with exactly STEERED instead."

    yield* agent.send(run("bash", "echo hi", "FIRST"))
    const request = yield* f.request
    yield* agent.steer(steer)
    yield* agent.answer(request.requestId, yes)

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(shownParts(turn)?.slice(-2), [{ steer }, { text: "STEERED" }])
  }).pipe(Effect.scoped),
)

it.live("stops a pi Turn, handing back a Steer pi hadn't taken in", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-stop")
    yield* f.extension("confirm.js", confirmExtension)
    const agent = yield* f.open(conversation)

    yield* agent.send(run("bash", "echo hi", "DONE"))
    yield* f.request
    yield* agent.steer("Now, please")
    const handedBack = yield* agent.session.stopTurn

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnStopped.make({}))
    assert.deepStrictEqual(handedBack, [{ message: "Now, please", images: [], context: null }])
  }).pipe(Effect.scoped),
)

it.live("shows a Steer a pi extension handles itself", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-handled-steer")
    yield* f.extension("input.js", inputExtension)
    yield* f.extension("confirm.js", confirmExtension)
    const agent = yield* f.open(conversation)

    yield* agent.send(run("bash", "echo hi", "DONE"))
    const request = yield* f.request
    yield* agent.steer("ping")
    yield* agent.answer(request.requestId, yes)

    const [turn] = yield* f.until(settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepInclude(shownParts(turn) ?? [], { steer: "ping" })
  }).pipe(Effect.scoped),
)

it.live("hands back what pi held when the Turn stops: Steers as written, then pi's own", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-held-steers")
    yield* f.extension("input.js", inputExtension)
    yield* f.extension("confirm.js", confirmExtension)
    const agent = yield* f.open(conversation)

    yield* agent.send(run("bash", "echo hi", "DONE"))
    yield* f.request
    yield* agent.steer("?quick tabs or spaces?", [pixel])
    yield* agent.steer("remind me")
    const handedBack = yield* agent.session.stopTurn

    assert.deepStrictEqual(handedBack, [
      { message: "?quick tabs or spaces?", images: [pixel], context: null },
      { message: "Check the tests", images: [], context: null },
    ])
  }).pipe(Effect.scoped),
)

it.live("sends a message's images to pi", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-image")
    const agent = yield* f.open(conversation)

    yield* agent.send(
      "What's in this image? Answer in one short sentence without using any tools.",
      [pixel],
    )
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
  }).pipe(Effect.scoped),
)

it.live("lists the models and efforts pi offers, with its default", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-models")
    const pi = yield* f.adapter.models

    assert.equal(pi.defaultModel?.id, PI_MODEL_ID)
    const offered = pi.models.find(({ id }) => id === PI_MODEL_ID)
    assert.isNotEmpty(offered?.name)
    assert.includeMembers([...(offered?.efforts ?? [])], ["off", "high"])
  }).pipe(Effect.scoped),
)

it.live("lists the user's skills among what pi runs as `/name`, named as pi takes them", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-commands")
    yield* writeGreetSkill(join(f.home, ".pi", "agent", "skills"))

    const commands = yield* f.adapter.commands(f.folder, [])

    assert.deepStrictEqual(
      commands.find(({ name }) => name === "skill:greet"),
      { name: "skill:greet", description: "Greets the user by name." },
    )
  }).pipe(Effect.scoped),
)

it.live("lists a sent Skill pack's skills, keeping the user's own skill of the same name", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-skill-pack")

    const sentOnly = yield* f.adapter.commands(f.folder, yield* writeGreetPack(f.folder))
    yield* writeGreetSkill(join(f.home, ".pi", "agent", "skills"))
    const clashing = yield* f.adapter.commands(f.folder, yield* writeGreetPack(f.folder))

    assert.deepStrictEqual(
      [sentOnly, clashing].map((commands) => commands.find(({ name }) => name === "skill:greet")),
      [
        { name: "skill:greet", description: "Greets the team by name." },
        { name: "skill:greet", description: "Greets the user by name." },
      ],
    )
  }).pipe(Effect.scoped),
)

it.live(
  "lists only the models pi is scoped to, including an extension's, in its order, starting on one of them",
  () =>
    Effect.gen(function* () {
      const f = yield* piSession("pi-scoped-models", {
        piSettings: {
          defaultModel: "outside-the-scope",
          enabledModels: ["glass-extension/extension-model", PI_MODEL_ID],
        },
      })

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
        ["glass-extension/extension-model", PI_MODEL_ID],
      )
    }).pipe(Effect.scoped),
)

it.live(
  "starts a pi Agent on the chosen model and effort, and clears the effort for the next Turn",
  () =>
    Effect.gen(function* () {
      const f = yield* piSession("pi-model-change")
      const agent = yield* f.open(conversation)

      yield* agent.configure({ model: PI_MODEL_ID, effort: "high" })
      yield* agent.send("Reply with exactly: FIRST")
      yield* f.until(settled(1))
      yield* agent.configure({})
      yield* agent.send("Reply with exactly: SECOND")
      const turns = yield* f.until(settled(2))

      assert.deepStrictEqual(
        turns.map(({ ended }) => ended?.ending),
        [TurnDone.make({}), TurnDone.make({})],
      )
    }).pipe(Effect.scoped),
)

it.live("runs a pi Agent's next Turn on pi's own thinking level once its effort is cleared", () =>
  Effect.gen(function* () {
    const f = yield* piSession("pi-thinking-level")
    const agent = yield* f.open(conversation)

    yield* agent.configure({ model: PI_MODEL_ID, effort: "high" })
    yield* agent.send("Reply with exactly: FIRST")
    yield* f.until(settled(1))
    yield* agent.configure({ model: PI_MODEL_ID })
    yield* agent.send("Reply with exactly: SECOND")
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
    const f = yield* piSession("pi-dialogs")

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

    yield* agent.send(
      "Use the bash tool to run exactly `echo hi` once. If it is blocked, don't try again; reply with exactly: Blocked.",
    )

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
    const f = yield* piSession("pi-stop-in-dialog")
    yield* f.extension("confirm.js", confirmExtension)
    const agent = yield* f.open(conversation)

    yield* agent.send(run("bash", "echo hi", "DONE"))
    const request = yield* f.request
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

const draftOn = (line: number, body: string) => ({
  toolCall: {
    id: `suggest-${line}`,
    name: "suggest_draft",
    arguments: { path: "greet.ts", side: "new", line, body },
  },
})

const reviewReplies = [
  { toolCall: { id: "cat-greet", name: "bash", arguments: { command: "cat greet.ts" } } },
  draftOn(2, "Keep the name."),
  draftOn(40, "Off the diff."),
  { text: "DONE" },
]

it.live(
  "runs commands in its checkout and proposes Suggested drafts as an Agent review's Agent",
  () =>
    Effect.gen(function* () {
      const f = yield* piSession("pi-review", {
        fake: {
          reply: ({ messages }) => [
            reviewReplies[messages.filter(({ role }) => role === "tool").length] ?? {
              text: "DONE",
            },
          ],
        },
      })

      yield* writeGreeter(f.folder)
      const agent = yield* f.open(conversation, ReviewRole.make({ brief: reviewBrief }))

      yield* agent.send("Draft comments on greet.ts.")
      const [turn] = yield* f.until(settled(1))
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))

      const calls = turn!.parts.filter((part) => Predicate.isTagged(part, "ToolCall"))
      assert.deepStrictEqual(
        calls.map(({ name, status }) => [name, status]),
        [
          ["bash", "done"],
          ["suggest_draft", "done"],
          ["suggest_draft", "failed"],
        ],
      )
      assert.include(calls[0]?.output, "hello name")
      assert.deepStrictEqual(acceptedSuggestedDraftOf(calls[1]!), {
        path: "greet.ts",
        side: "new",
        line: 2,
        body: "Keep the name.",
      })
      assert.include(calls[2]?.output, "not a line of the diff")
    }).pipe(Effect.scoped),
)

const toolContent = ({ content }: FakeModelRequest["messages"][number]) =>
  Predicate.isString(content) ? content : (content ?? []).map(({ text }) => text ?? "").join("")

/** Calls the tool a message names, then repeats what the tool returned. */
const globalReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> => {
  const last = input.messages.at(-1)

  if (last?.role === "tool") return [{ text: `The tool said: ${toolContent(last)}` }]

  const words = lastUserText(input)

  const call = (name: string, args: Schema.JsonObject = {}): ReadonlyArray<FakeModelDelta> => [
    { toolCall: { id: `call-${input.messages.length}`, name, arguments: args } },
  ]

  if (words.includes("greeting"))
    return call("ask_user", { question: "Which greeting?", options: ["Hi", "Hello"] })

  if (words.includes("To-dos")) return call("mcp__glass__list_to_dos")

  if (words.includes("stale"))
    return call("mcp__glass__read_pull_request", {
      pullRequest: { owner: "acme", repo: "api", number: 42 },
      revision: { base: "b0", head: "h0" },
    })

  return call("mcp__glass__wait_for_release")
}

it.live("asks a Question as the Global conversation", () =>
  Effect.gen(function* () {
    const glass = yield* glassToolsBackend(conversation)
    const f = yield* piSession("pi-global", { fake: { reply: globalReply }, places: glass.places })

    const agent = yield* f.open(conversation, glass.role)

    yield* agent.send("Ask me which greeting I prefer.")
    const question = yield* f.request
    assert.ok(Predicate.isTagged(question, "Question"))
    assert.deepStrictEqual(question.questions[0]?.question, "Which greeting?")
    assert.deepStrictEqual(
      question.questions[0]?.options.map(({ label }) => label),
      ["Hi", "Hello"],
    )

    yield* agent.answer(
      question.requestId,
      AnswerQuestion.make({ answers: [{ chosen: ["Hello"], text: null }] }),
    )
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.include(lastTextOf(turn), "Hello")
  }).pipe(Effect.scoped),
)

it.live("reads Glass through its tools as the Global conversation, explaining a failed read", () =>
  Effect.gen(function* () {
    const glass = yield* glassToolsBackend(conversation)

    const f = yield* piSession("pi-global-tools", {
      fake: { reply: globalReply },
      places: glass.places,
    })

    const agent = yield* f.open(conversation, glass.role)

    yield* agent.send("What are my To-dos?")
    const [read] = yield* f.until(settled(1))
    const listed = read?.parts.find((part) => Predicate.isTagged(part, "ToolCall"))

    assert.deepStrictEqual(read?.ended?.ending, TurnDone.make({}))
    assert.deepInclude(listed, { name: "list_to_dos", status: "done" })
    assert.include(listed?.output, "Reply to Sam")
    assert.include(lastTextOf(read), "Reply to Sam")

    yield* agent.send("Read acme/api#42 at a stale Revision.")
    const [, failed] = yield* f.until(settled(2))
    const stale = failed?.parts.find((part) => Predicate.isTagged(part, "ToolCall"))

    assert.deepInclude(stale, { name: "read_pull_request", status: "failed" })
    assert.include(stale?.output, "changed since that Revision")
  }).pipe(Effect.scoped),
)

it.live("stops the Global conversation's Turn while a Glass tool runs, cancelling the call", () =>
  Effect.gen(function* () {
    const glass = yield* glassToolsBackend(conversation)

    const f = yield* piSession("pi-global-tool-stop", {
      fake: { reply: globalReply },
      places: glass.places,
    })

    const agent = yield* f.open(conversation, glass.role)

    yield* agent.send("Wait for release.")

    // Replayed, pi calls no endpoint, so only its own report shows the call.
    if (recordingSessions) yield* glass.waitStarted
    else yield* f.until(runningTool("wait_for_release"))

    yield* agent.session.stopTurn
    const [turn] = yield* f.until(settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnStopped.make({}))

    if (recordingSessions) yield* glass.waitInterrupted
  }).pipe(Effect.scoped),
)
