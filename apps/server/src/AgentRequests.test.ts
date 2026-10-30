import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  DenyRequest,
  isRequestPart,
  isWaiting,
  type RequestPart,
  type Turn,
  TurnDone,
  TurnInterrupted,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  agentsFixture as fixture,
  claudeAgentsFixture,
  claudeCode,
  lastText,
  settled,
} from "../test/agentsFixture"
import type { FakeAnthropicReply, FakeAnthropicRequest } from "../test/fakeAnthropic"
import { vi } from "vite-plus/test"

vi.stubEnv("PI_OFFLINE", "1")

const allow = () => AllowRequest.make({})

const asked = (turn: Turn | undefined) =>
  (turn?.parts ?? []).flatMap((part) =>
    Predicate.isTagged(part, "PermissionRequest")
      ? [{ tool: part.toolName, summary: part.inputSummary, status: part.status }]
      : [],
  )

const toolCalls = (turn: Turn | undefined) =>
  (turn?.parts ?? []).flatMap((part) =>
    Predicate.isTagged(part, "ToolCall")
      ? [{ name: part.name, output: part.output, status: part.status }]
      : [],
  )

const answerSteps =
  (steps: ReadonlyArray<FakeAnthropicReply>) =>
  (request: FakeAnthropicRequest): FakeAnthropicReply => {
    if ((request.tools ?? []).length === 0) return { type: "text", text: "Fake session" }

    const results = (request.messages ?? []).flatMap(({ content }) =>
      Predicate.isString(content) ? [] : content.filter(({ type }) => type === "tool_result"),
    )

    return steps[results.length] ?? { type: "text", text: "Done." }
  }

const readEditRun: ReadonlyArray<FakeAnthropicReply> = [
  { type: "tool_use", name: "Read", input: { file_path: "README.md" } },
  {
    type: "tool_use",
    name: "Edit",
    input: { file_path: "README.md", old_string: "greeter", new_string: "Hello" },
  },
  { type: "tool_use", name: "Bash", input: { command: "ls" } },
]

it.live("uses the real Claude CLI's Default, Accept edits and Bypass permission decisions", () =>
  Effect.gen(function* () {
    const f = yield* claudeAgentsFixture(answerSteps(readEditRun))
    const modes = ["default", "acceptEdits", "bypassPermissions"] as const
    const askedIn: Partial<Record<(typeof modes)[number], ReturnType<typeof asked>>> = {}
    let defaultReadme = ""

    for (const permissionMode of modes) {
      const agent = yield* f.start("Tidy the README", { ...claudeCode, permissionMode })

      if (permissionMode === "default") defaultReadme = join(f.worktree(agent.name), "README.md")
      assert.equal(agent.permissionMode, permissionMode)
      const [turn] = yield* f.answering(agent.id, settled(1), allow)
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
      assert.isTrue(toolCalls(turn).every(({ status }) => status === "done"))
      assert.equal(
        readFileSync(join(f.worktree(agent.name), "README.md"), "utf8").trim(),
        "# Hello",
      )
      askedIn[permissionMode] = asked(turn)
    }

    assert.deepStrictEqual(askedIn, {
      default: [{ tool: "Edit", summary: defaultReadme, status: "allowed" }],
      acceptEdits: [],
      bypassPermissions: [],
    })
  }),
)

it.live("tells the real Claude CLI why the user denied a tool call, and the Turn goes on", () =>
  Effect.gen(function* () {
    const f = yield* claudeAgentsFixture()

    const agent = yield* f.start("Please run `touch denied.txt`", {
      ...claudeCode,
      permissionMode: "default",
    })

    const [turn] = yield* f.answering(agent.id, settled(1), () =>
      DenyRequest.make({ reason: "Leave the checkout alone" }),
    )

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    const request = turn?.parts.find((part) => Predicate.isTagged(part, "PermissionRequest"))
    assert.deepStrictEqual(
      request && { tool: request.toolName, status: request.status, reason: request.reason },
      { tool: "Bash", status: "denied", reason: "Leave the checkout alone" },
    )
    assert.include(lastText(turn)?.text ?? "", "Leave the checkout alone")
    assert.isFalse(existsSync(join(f.worktree(agent.name), "denied.txt")))
  }),
)

it.live("answers the real Claude CLI's Questions with an option or text", () =>
  Effect.gen(function* () {
    const f = yield* claudeAgentsFixture(
      answerSteps([
        {
          type: "tool_use",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Tabs or spaces?",
                header: "Indent",
                options: [
                  { label: "Tabs", description: "One per level" },
                  { label: "Spaces", description: "Two per level" },
                ],
                multiSelect: false,
              },
              {
                question: "Which folders?",
                header: "Folders",
                options: [
                  { label: "src", description: "The code" },
                  { label: "test", description: "The tests" },
                ],
                multiSelect: true,
              },
            ],
          },
        },
      ]),
    )

    const agent = yield* f.start("Format the code", { ...claudeCode, permissionMode: "default" })

    const [turn] = yield* f.answering(agent.id, settled(1), () =>
      AnswerQuestion.make({
        answers: [
          { chosen: ["Tabs"], text: null },
          { chosen: [], text: "Only the README" },
        ],
      }),
    )

    const questionPart = turn?.parts.find((part) => Predicate.isTagged(part, "Question"))
    assert.deepStrictEqual(
      questionPart?.questions.map(({ question, multiSelect, options }) => ({
        question,
        multiSelect,
        options: options.map(({ label }) => label),
      })),
      [
        { question: "Tabs or spaces?", multiSelect: false, options: ["Tabs", "Spaces"] },
        { question: "Which folders?", multiSelect: true, options: ["src", "test"] },
      ],
    )
    assert.deepStrictEqual(questionPart?.answers, [
      { chosen: ["Tabs"], text: null },
      { chosen: [], text: "Only the README" },
    ])
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    const output = toolCalls(turn).find(({ name }) => name === "AskUserQuestion")?.output ?? ""
    assert.include(output, "Tabs")
    assert.include(output, "Only the README")
    assert.isTrue(
      f.claude.provider.calls.some(({ messages }) =>
        messages?.some(({ content }) =>
          Predicate.isString(content)
            ? false
            : content.some(
                ({ type, content: result }) =>
                  type === "tool_result" &&
                  JSON.stringify(result).includes("Tabs") &&
                  JSON.stringify(result).includes("Only the README"),
              ),
        ),
      ),
    )
  }),
)

it.live("continues a conversation through the pinned Claude CLI and shared model endpoint", () =>
  Effect.gen(function* () {
    const f = yield* claudeAgentsFixture()
    const agent = yield* f.start("Remember lantern", claudeCode)
    const [first] = yield* f.transcript(agent.id, settled(1))
    assert.include(lastText(first)?.text ?? "", "Remember lantern")
    yield* f.send(agent.id, "Continue the conversation")
    const [, second] = yield* f.transcript(agent.id, settled(2))
    assert.include(lastText(second)?.text ?? "", "Continue the conversation")
    assert.deepStrictEqual(second?.ended?.ending, TurnDone.make({}))

    const continued = f.claude.provider.calls.findLast(({ messages }) =>
      messages?.some(({ content }) =>
        JSON.stringify(content).includes("Continue the conversation"),
      ),
    )

    assert.include(JSON.stringify(continued?.messages), "Remember lantern")
  }),
)

const firstQuestion = (part: RequestPart) =>
  Predicate.isTagged(part, "Question") ? (part.questions[0]?.question ?? "") : ""

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

const waitingOn = (turns: ReadonlyArray<Turn>) => turns.some(({ parts }) => parts.some(isWaiting))

const askToRun = "Please run `touch notes.txt`"

it.live(
  "keeps a waiting request for a new watch, marks its Agent, and refuses messages until it's answered",
  () =>
    Effect.gen(function* () {
      const f = yield* claudeAgentsFixture()
      const agent = yield* f.start(askToRun, { ...claudeCode, permissionMode: "default" })

      const marked = (has: boolean) =>
        f.client.WatchWaitingAgents().pipe(
          Stream.filter((ids) => ids.includes(agent.id) === has),
          Stream.runHead,
        )

      yield* f.transcript(agent.id, waitingOn)
      yield* marked(true)

      const refused = yield* Effect.all([
        f.send(agent.id, "Hurry up").pipe(Effect.flip),
        f.steer(agent.id, "Hurry up").pipe(Effect.flip),
      ])

      assert.deepStrictEqual(
        refused.map(({ _tag }) => _tag),
        ["RequestWaiting", "RequestWaiting"],
      )
      assert.deepStrictEqual((yield* f.watch(agent.id, () => true)).queued, [])

      // A second watch, as a reloaded renderer opens, still sees the request waiting.
      const [turn] = yield* f.transcript(agent.id, waitingOn)
      const request = turn?.parts.find(isWaiting)
      assert.equal(request?._tag, "PermissionRequest")

      const answer = { agentId: agent.id, requestId: request?.requestId ?? "", answer: allow() }

      const misfit = yield* f.client
        .AnswerRequest({ ...answer, answer: AnswerQuestion.make({ answers: [] }) })
        .pipe(Effect.flip)

      assert.equal(misfit._tag, "AgentError")

      yield* f.client.AnswerRequest(answer)
      yield* marked(false)

      const again = yield* f.client.AnswerRequest(answer).pipe(Effect.flip)
      assert.equal(again._tag, "RequestNotWaiting")

      const [done] = yield* f.transcript(agent.id, settled(1))
      assert.include(lastText(done)?.text ?? "", "The fake model saw:")
    }),
)

it.live("leaves a request no longer answerable once its Turn ends", () =>
  Effect.gen(function* () {
    const f = yield* claudeAgentsFixture()
    const agent = yield* f.start(askToRun, { ...claudeCode, permissionMode: "default" })
    yield* f.transcript(agent.id, waitingOn)

    const restarted = yield* f.restart
    const [turn] = yield* f.transcript(agent.id, settled(1), restarted)

    assert.deepStrictEqual(turn?.ended?.ending, TurnInterrupted.make({}))
    assert.deepStrictEqual(asked(turn), [
      { tool: "Bash", summary: "touch notes.txt", status: "expired" },
    ])

    const waiting = yield* restarted
      .WatchWaitingAgents()
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.deepStrictEqual(waiting, [])

    const request = turn?.parts.find((part) => Predicate.isTagged(part, "PermissionRequest"))

    const refused = yield* restarted
      .AnswerRequest({ agentId: agent.id, requestId: request?.requestId ?? "", answer: allow() })
      .pipe(Effect.flip)

    assert.equal(refused._tag, "RequestNotWaiting")
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

it.live("stops a Claude Code Turn while a request waits, and the next message runs", () =>
  Effect.gen(function* () {
    const f = yield* claudeAgentsFixture()
    const agent = yield* f.start(askToRun, { ...claudeCode, permissionMode: "default" })

    yield* stoppedWhileWaiting(f, agent.id)

    yield* f.send(agent.id, "Try again")
    const [, again] = yield* f.answering(agent.id, settled(2), allow)
    assert.deepStrictEqual(again?.ended?.ending, TurnDone.make({}))
  }),
)

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

it.live(
  "changes a Claude Code Agent's Permission mode for its next Turn, and refuses one for pi",
  () =>
    Effect.gen(function* () {
      const f = yield* claudeAgentsFixture(undefined, { output: "Hi." })
      const agent = yield* f.start(askToRun, { ...claudeCode, permissionMode: "default" })
      const [first] = yield* f.answering(agent.id, settled(1), allow)
      assert.lengthOf(asked(first), 1)

      const changed = yield* f.client.ChangePermissionMode({
        agentId: agent.id,
        permissionMode: "bypassPermissions",
      })

      assert.equal(changed.permissionMode, "bypassPermissions")

      yield* f.send(agent.id, "Please run `touch after-mode-change.txt`")
      const [, second] = yield* f.answering(agent.id, settled(2), allow)
      assert.deepStrictEqual(asked(second), [])
      assert.isTrue(existsSync(join(f.worktree(agent.name), "after-mode-change.txt")))

      const pi = yield* f.start("Say hello")

      const refused = yield* f.client
        .ChangePermissionMode({ agentId: pi.id, permissionMode: "auto" })
        .pipe(Effect.flip)

      assert.equal(refused._tag, "NoPermissionModes")
    }),
)

it.live(
  "starts a Claude Code Agent in Default unless a mode is chosen, and a pi Agent in none",
  () =>
    Effect.gen(function* () {
      const f = yield* claudeAgentsFixture()

      const unchosen = yield* f.start("Say hello", { ...claudeCode, permissionMode: null })
      const chosen = yield* f.start("Say hello", { ...claudeCode, permissionMode: "acceptEdits" })
      const automatic = yield* f.start("Say hello", { ...claudeCode, permissionMode: "auto" })
      assert.deepStrictEqual(
        [unchosen.permissionMode, chosen.permissionMode, automatic.permissionMode],
        ["default", "acceptEdits", "auto"],
      )

      const pi = { engine: "pi-cli", model: null, effort: null } as const
      assert.isNull(
        (yield* f.start("Say hello", { ...pi, permissionMode: "acceptEdits" })).permissionMode,
      )
    }),
)
