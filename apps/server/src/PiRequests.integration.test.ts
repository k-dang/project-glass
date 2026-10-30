import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  isRequestPart,
  isWaiting,
  type RequestPart,
  type Turn,
  TurnDone,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentsFixture as fixture, settled } from "../test/agentsFixture"
import { vi } from "vite-plus/test"

vi.stubEnv("PI_OFFLINE", "1")

const allow = () => AllowRequest.make({})

const waitingOn = (turns: ReadonlyArray<Turn>) => turns.some(({ parts }) => parts.some(isWaiting))

const firstQuestion = (part: RequestPart) =>
  Predicate.isTagged(part, "Question") ? (part.questions[0]?.question ?? "") : ""

const toolCalls = (turn: Turn | undefined) =>
  (turn?.parts ?? []).flatMap((part) =>
    Predicate.isTagged(part, "ToolCall")
      ? [{ name: part.name, output: part.output, status: part.status }]
      : [],
  )

it.live("asks pi's extension dialogs as Questions, answered with an option or text", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      reply: ({ messages }) =>
        messages.some(({ role }) => role === "tool")
          ? [{ text: "Greeted." }]
          : [{ toolCall: { id: "call-1", name: "bash", arguments: { command: "echo hi" } } }],
    })

    yield* Effect.promise(async () => {
      const extensions = join(f.home, ".pi", "agent", "extensions")
      await mkdir(extensions, { recursive: true })
      await writeFile(
        join(extensions, "greet.js"),
        `export default (pi) => pi.on("tool_call", async (event, ctx) => {
          const greeting = await ctx.ui.select("Which greeting?", ["Hi", "Hello"])
          const name = await ctx.ui.input("Who to greet?", "a name")
          const sure = await ctx.ui.confirm("Greet them?", "It prints to the terminal.")
          return { block: true, reason: greeting + " " + name + " " + sure }
        })`,
      )
    })

    const agent = yield* f.start("Greet someone")

    const replies = new Map([
      ["Which greeting?", { chosen: ["Hello"], text: null }],
      ["Who to greet?", { chosen: [], text: "Ada" }],
      ["Greet them?", { chosen: ["Yes"], text: null }],
    ])

    const [turn] = yield* f.answering(agent.id, settled(1), (part) =>
      AnswerQuestion.make({
        answers: [replies.get(firstQuestion(part)) ?? { chosen: [], text: null }],
      }),
    )

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
    assert.include(toolCalls(turn)[0]?.output ?? "", "Hello Ada true")
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
  }),
)

const stoppedWhileWaiting = Effect.fnUntraced(function* (
  f: Pick<Effect.Success<ReturnType<typeof fixture>>, "transcript" | "client">,
  agentId: string,
) {
  const [waiting] = yield* f.transcript(agentId, waitingOn)
  const request = waiting?.parts.find(isWaiting)

  yield* f.client.StopTurn({ agentId })

  const [turn] = yield* f.transcript(agentId, settled(1))
  assert.deepStrictEqual(turn?.ended?.ending, TurnStopped.make({}))
  assert.equal(turn?.parts.find(isRequestPart)?.status, "expired")

  const marked = yield* f.client.WatchWaitingAgents().pipe(
    Stream.filter((ids) => !ids.includes(agentId)),
    Stream.runHead,
  )

  assert.isTrue(Option.isSome(marked))

  const refused = yield* f.client
    .AnswerRequest({ agentId, requestId: request?.requestId ?? "", answer: allow() })
    .pipe(Effect.flip)

  assert.equal(refused._tag, "RequestNotWaiting")
})

it.live("stops a pi Turn while its extension's dialog waits", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      reply: () => [
        { toolCall: { id: "call-1", name: "bash", arguments: { command: "echo hi" } } },
      ],
    })

    yield* Effect.promise(async () => {
      const extensions = join(f.home, ".pi", "agent", "extensions")
      await mkdir(extensions, { recursive: true })
      await writeFile(
        join(extensions, "confirm.js"),
        `export default (pi) => pi.on("tool_call", async (event, ctx) => {
          const sure = await ctx.ui.confirm("Run it?", event.toolName)
          return sure ? undefined : { block: true, reason: "Declined" }
        })`,
      )
    })

    const agent = yield* f.start("Greet someone")

    yield* stoppedWhileWaiting(f, agent.id)
  }),
)
