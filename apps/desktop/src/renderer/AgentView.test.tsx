// @vitest-environment happy-dom
import {
  ActivityPage,
  Agent,
  AgentChanges,
  AnswerQuestion,
  DenyRequest,
  PermissionRequestPart,
  QuestionPart,
  type RequestAnswer,
  type TurnPart,
  FollowedRepository,
  PartAppended,
  PartSet,
  RemovalWarnings,
  type ResumableDestination,
  SandboxPlace,
  type SandboxReach,
  SandboxStatus,
  SavedPlace,
  TextPart,
  ThinkingPart,
  ToDo,
  toDoMention,
  fileMention,
  ToolCallPart,
  TranscriptSnapshot,
  TurnCutOff,
  TurnDone,
  TurnEnded,
  TurnStarted,
  TurnStopped,
  QueuedMessageStarted,
  UnsentFeedback,
} from "@glass/contracts"
import { cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Deferred, Effect, Exit, Stream } from "effect"
import { expect, it } from "vite-plus/test"
import { agent, agentFields } from "../../test/agent"
import { choice, mount, pixel } from "../../test/agentApp"

const sentAt = DateTime.makeUnsafe("2026-10-26T12:00:00Z")

it("shows the Agent under Local and its Turn's parts as they stream", async () => {
  const turnId = "turn-1"

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({ turns: [], queued: [], status: null }),
        TurnStarted.make({
          turnId,
          message: "Run echo",
          images: [],
          context: null,
          feedback: [],
          sentAt,
        }),
        PartSet.make({ turnId, index: 0, part: ThinkingPart.make({ text: "I should " }) }),
        PartAppended.make({ turnId, index: 0, text: "run echo." }),
        PartSet.make({
          turnId,
          index: 1,
          part: ToolCallPart.make({
            toolCallId: "call-1",
            name: "bash",
            inputSummary: "echo hi",
            input: '{ "command": "echo hi" }',
            output: "hi",
            status: "done",
            parentToolCallId: null,
          }),
        }),
        PartSet.make({ turnId, index: 2, part: TextPart.make({ text: "It says hi." }) }),
        TurnEnded.make({
          turnId,
          ended: { at: DateTime.add(sentAt, { seconds: 3 }), ending: TurnDone.make({}) },
        }),
      ),
  })

  const list = await screen.findByRole("navigation", { name: "Agents list" })
  const onLocal = within(list).getByRole("region", { name: "Local" })
  expect(within(onLocal).getByRole("link", { name: agent.name })).toBeTruthy()

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(await within(transcript).findByText("It says hi.")).toBeTruthy()
  expect(within(transcript).getByText("Run echo")).toBeTruthy()
  const thinking = within(transcript).getByRole("button", { name: "Thinking" })
  expect(thinking.getAttribute("aria-expanded")).toBe("false")

  const user = userEvent.setup()
  await user.click(thinking)
  expect(await within(transcript).findByText("I should run echo.")).toBeTruthy()

  const tool = within(transcript).getByRole("button", { name: "Done: bash echo hi" })
  await user.click(tool)
  expect(await within(transcript).findByText("hi")).toBeTruthy()
  expect(within(transcript).getByText("Done in 3s")).toBeTruthy()
})

it("sends a message with Enter and clears the composer", async () => {
  const sent: Array<string> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Add a test{Shift>}{Enter}{/Shift}for it{Enter}")

  expect(sent).toEqual(["Add a test\nfor it"])
  expect(composer).toHaveProperty("textContent", "")
})

it("switches between Chat and Changes with Mod+D, even from the composer", async () => {
  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    GetAgentChanges: () => Effect.succeed(new AgentChanges({ id: "read", files: [] })),
  })

  await user.click(await screen.findByRole("textbox", { name: "Message" }))
  await user.keyboard("{Control>}d{/Control}")
  await screen.findByRole("region", { name: "Changes" })

  await user.keyboard("{Meta>}d{/Meta}")
  await screen.findByRole("textbox", { name: "Message" })
  expect(screen.queryByRole("region", { name: "Changes" })).toBeNull()
})

it("sends Markdown and HTML exactly as written", async () => {
  const sent: Array<string> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Rename `foo_bar` in **<App>** *now*{Enter}")

  expect(sent).toEqual(["Rename `foo_bar` in **<App>** *now*"])
})

it("keeps the hidden panel recoverable across Agent navigation", async () => {
  const user = mount(
    {
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/agents/missing",
  )

  await screen.findByText("This Agent is gone. Pick another Agent or start a new one.")
  const panel = screen.getByRole("complementary", { name: "Agents panel" })
  await user.click(screen.getByRole("button", { name: "Hide Agents panel" }))

  expect(panel).toHaveProperty("hidden", true)
  expect(screen.queryByRole("navigation", { name: "Agents list" })).toBeNull()
  const toggle = screen.getByRole("button", { name: "Show Agents panel" })
  expect(toggle.getAttribute("aria-controls")).toBe(panel.id)
  expect(toggle.getAttribute("aria-expanded")).toBe("false")

  await user.click(screen.getByRole("link", { name: "New Agent" }))
  await screen.findByRole("region", { name: "New Agent" })
  expect(screen.getByRole("button", { name: "Show Agents panel" })).toBeTruthy()

  await user.keyboard("{Control>}b{/Control}")
  const link = await screen.findByRole("link", { name: agent.name })
  link.focus()
  await user.keyboard("{Meta>}b{/Meta}")
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Agents panel" }))

  await user.keyboard(" ")
  expect(screen.getByRole("link", { name: agent.name })).toBeTruthy()
})

it("removes the open Agent from the sidebar after confirming its uncommitted changes", async () => {
  const removed: Array<string> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    GetRemovalWarnings: () => Effect.succeed(new RemovalWarnings({ uncommittedChanges: "some" })),
    RemoveAgent: ({ agentId }) => Effect.sync(() => void removed.push(agentId)),
  })

  await user.click(await screen.findByRole("button", { name: "Remove agent/swift-otter" }))
  const dialog = await screen.findByRole("alertdialog", { name: "Remove agent/swift-otter?" })
  await user.click(within(dialog).getByRole("button", { name: "Remove Agent" }))

  await waitFor(() => expect(removed).toEqual([agent.id]))
  expect(window.location.hash).toBe("#/agents/new")
})

it("shows the Skill packs and commits an Agent was created with, and its Local skills, in its details", async () => {
  const user = mount({
    WatchAgents: () =>
      Stream.make([
        new Agent({
          ...agentFields,
          place: SandboxPlace.make({ providerId: "fake" }),
          skillPacks: [{ name: "team", commit: "ae5650fbbbb" }],
          localSkills: true,
        }),
      ]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })

  await user.click(await screen.findByRole("button", { name: "Details" }))

  expect(await screen.findByText("team @ ae5650f · Local skills")).toBeTruthy()
})

it("lists a Sandbox Agent's commands again once its Sandbox can be reached", async () => {
  const reached = Deferred.makeUnsafe<void>()
  let made = false

  const user = mount({
    WatchAgents: () =>
      Stream.concat(
        Stream.make([inSandboxWith("connecting")]),
        Stream.fromEffect(Deferred.await(reached)).pipe(Stream.as([inSandboxWith("reachable")])),
      ),
    ListAgentCommands: () =>
      Effect.sync(() =>
        made ? [{ name: "local:grilling", description: "Ask hard questions." }] : [],
      ),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "/")
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull()

  made = true
  Deferred.doneUnsafe(reached, Exit.void)
  await user.type(composer, "{Backspace}/gr")

  expect(
    within(await screen.findByRole("listbox", { name: "Commands" })).getByRole("option")
      .textContent,
  ).toBe("/local:grillingAsk hard questions.")
})

it("lists a Sandbox Agent under Sandboxes, and shows the step its Sandbox is at while it's made", async () => {
  const inSandbox = new Agent({
    ...agentFields,
    id: "agent-2",
    name: "agent/calm-heron",
    place: SandboxPlace.make({ providerId: "fake" }),
    engine: "claude-code",
    permissionMode: "bypassPermissions",
  })

  const onLamp = new Agent({
    ...agentFields,
    id: "agent-3",
    name: "agent/quick-wren",
    repository: new FollowedRepository({ owner: "glass-demo", repo: "lamp" }),
  })

  const later = new Agent({ ...agentFields, id: "agent-4", name: "agent/slow-newt" })

  mount(
    {
      WatchAgents: () => Stream.make([inSandbox, agent, onLamp, later]),
      WatchTranscript: () =>
        Stream.make(
          TranscriptSnapshot.make({
            turns: [runningTurn],
            queued: [],
            status: "Cloning the repository",
          }),
        ),
    },
    `/agents/${inSandbox.id}`,
  )

  const list = await screen.findByRole("navigation", { name: "Agents list" })
  const sections = within(list).getAllByRole("region")
  expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual([
    "Local",
    "Sandboxes",
  ])
  expect(
    within(sections[0]!)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label")),
  ).toEqual([agent.name, later.name, onLamp.name])
  expect(within(sections[1]!).getByRole("link", { name: inSandbox.name })).toBeTruthy()

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(await within(transcript).findByText("Cloning the repository…")).toBeTruthy()
  await screen.findByRole("button", { name: "Claude Code: Opus 5.5" })
  expect(screen.queryByRole("combobox", { name: "Permission mode" })).toBeNull()
})

it("changes the open Agent's model from the composer, closing the picker", async () => {
  const changes: Array<{ model: string | null; effort: string | null }> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    ChangeAgentModel: ({ model, effort }) =>
      Effect.sync(() => changes.push({ model, effort })).pipe(
        Effect.as(new Agent({ ...agentFields, model, effort })),
      ),
  })

  await user.click(await screen.findByRole("button", { name: "pi: gpt-test" }))
  await user.click(choice(await screen.findByRole("dialog"), "Model", "Thinker"))

  expect(changes).toEqual([{ model: "glass-test/thinker", effort: null }])
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

const call = (toolCallId: string, name: string, parentToolCallId: string | null) =>
  ToolCallPart.make({
    toolCallId,
    name,
    inputSummary: toolCallId,
    input: "{}",
    output: "ok",
    status: "done",
    parentToolCallId,
  })

it("nests a subagent's tool calls under the tool call that started it", async () => {
  const turnId = "turn-1"

  const user = mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          queued: [],
          status: null,
          turns: [
            {
              id: turnId,
              message: "Delegate",
              images: [],
              context: null,
              feedback: [],
              sentAt,
              ended: null,
              parts: [call("task-1", "Agent", null), call("bash-1", "Bash", "task-1")],
            },
          ],
        }),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  const parent = await within(transcript).findByRole("button", { name: "Done: Agent task-1" })
  expect(within(transcript).queryByRole("button", { name: "Done: Bash bash-1" })).toBeNull()

  await user.click(parent)
  expect(await within(transcript).findByRole("button", { name: "Done: Bash bash-1" })).toBeTruthy()
})

it.each(["{Control>}n{/Control}", "{Meta>}n{/Meta}"])(
  "opens a New Agent with %s",
  async (shortcut) => {
    const user = mount({
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    })

    await screen.findByRole("link", { name: agent.name })
    await user.keyboard(shortcut)

    await waitFor(() => expect(window.location.hash).toBe("#/agents/new"))
  },
)

it("shows a Turn cut off when Glass lost the Agent", async () => {
  const turnId = "turn-1"

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({ turns: [], queued: [], status: null }),
        TurnStarted.make({
          turnId,
          message: "Run echo",
          images: [],
          context: null,
          feedback: [],
          sentAt,
        }),
        TurnEnded.make({
          turnId,
          ended: { at: DateTime.add(sentAt, { seconds: 4 }), ending: TurnCutOff.make({}) },
        }),
      ),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(
    await within(transcript).findByText("Cut off after 4s when Glass lost the Agent"),
  ).toBeTruthy()
})

it("makes the open Agent the Saved place, which Activity leaves for Dashboard to continue", async () => {
  const saved: Array<ResumableDestination> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SavePlace: ({ destination }) => {
      saved.push(destination)

      return Effect.succeed(new SavedPlace({ destination, savedAt: sentAt }))
    },
    ListActivity: () => Effect.succeed(new ActivityPage({ activities: [], hasMore: false })),
  })

  await waitFor(() => expect(saved).toEqual([{ area: "agents", agentId: agent.id }]))

  await user.click(screen.getByRole("link", { name: "Activity" }))
  await screen.findByText("No Activity yet")
  await user.click(screen.getByRole("link", { name: "Dashboard" }))
  await user.click(await screen.findByRole("link", { name: `Continue ${agent.name}` }))

  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
  expect(saved).toHaveLength(1)
})

const waitingTurn = (parts: ReadonlyArray<TurnPart>) =>
  Stream.make(
    TranscriptSnapshot.make({
      turns: [
        {
          id: "turn-1",
          message: "List files",
          images: [],
          context: null,
          feedback: [],
          sentAt,
          ended: null,
          parts,
        },
      ],
      queued: [],
      status: null,
    }),
  )

const bashRequest = PermissionRequestPart.make({
  requestId: "bash-1",
  toolName: "Bash",
  inputSummary: "rm -rf build",
  input: '{ "command": "rm -rf build" }',
  status: "waiting",
  reason: null,
})

it("marks an Agent waiting on a Permission request, and denies it with a reason from its card", async () => {
  const answers: Array<{ requestId: string; answer: RequestAnswer }> = []

  const user = mount({
    WatchWaitingAgents: () => Stream.make([agent.id]),
    WatchTranscript: () => waitingTurn([bashRequest]),
    AnswerRequest: ({ requestId, answer }) =>
      Effect.sync(() => void answers.push({ requestId, answer })),
  })

  expect(
    await screen.findByRole("link", { name: agent.name, description: /Waiting on you/ }),
  ).toBeTruthy()

  const composer = await screen.findByRole("textbox", { name: "Message" })
  expect(composer.getAttribute("aria-placeholder")).toBe(
    "Answer the Permission request above first",
  )
  expect(screen.getByRole("button", { name: "Show it" })).toBeTruthy()

  const card = await screen.findByRole("region", { name: "Allow Bash?" })
  expect(within(card).getByText('{ "command": "rm -rf build" }')).toBeTruthy()
  await user.type(
    within(card).getByRole("textbox", { name: "Why not? (optional)" }),
    "Use git clean",
  )
  await user.click(within(card).getByRole("button", { name: "Deny" }))

  expect(answers).toEqual([
    { requestId: "bash-1", answer: DenyRequest.make({ reason: "Use git clean" }) },
  ])
})

const options = (...labels: ReadonlyArray<string>) =>
  labels.map((label) => ({ label, description: null }))

it("answers a Question with an option for one and the user's own words for another", async () => {
  const answers: Array<RequestAnswer> = []

  const user = mount({
    WatchTranscript: () =>
      waitingTurn([
        QuestionPart.make({
          requestId: "ask-1",
          questions: [
            {
              header: "Indent",
              question: "Tabs or spaces?",
              detail: null,
              options: options("Tabs", "Spaces"),
              multiSelect: false,
              freeText: true,
            },
            {
              header: null,
              question: "Which folders?",
              detail: null,
              options: options("src", "test"),
              multiSelect: true,
              freeText: true,
            },
          ],
          status: "waiting",
          answers: null,
        }),
      ]),
    AnswerRequest: ({ answer }) => Effect.sync(() => void answers.push(answer)),
  })

  const card = await screen.findByRole("region", { name: "The Agent asks you a few things" })
  const answer = within(card).getByRole("button", { name: "Answer" })
  expect(answer).toHaveProperty("disabled", true)

  await user.click(within(card).getByRole("radio", { name: "Spaces" }))
  const folders = within(card).getByRole("group", { name: "Which folders?" })
  await user.type(
    within(folders).getByRole("textbox", { name: "Or answer in your own words" }),
    "Only the README",
  )
  await user.click(answer)

  expect(answers).toEqual([
    AnswerQuestion.make({
      answers: [
        { chosen: ["Spaces"], text: null },
        { chosen: [], text: "Only the README" },
      ],
    }),
  ])
})

it("shows a request left when its Turn ended as no longer answerable", async () => {
  mount({
    WatchTranscript: () => waitingTurn([{ ...bashRequest, status: "expired" }]),
  })

  const card = await screen.findByRole("region", { name: "Allow Bash?" })
  expect(within(card).getByText("No longer answerable: its Turn ended.")).toBeTruthy()
  expect(within(card).queryByRole("button", { name: "Allow" })).toBeNull()
})

it("changes a Claude Code Agent's Permission mode from the composer, and offers none for pi", async () => {
  const changes: Array<string> = []

  const claudeAgent = new Agent({
    ...agentFields,
    engine: "claude-code",
    permissionMode: "default",
  })

  const user = mount({
    WatchAgents: () => Stream.make([claudeAgent]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    ChangePermissionMode: ({ permissionMode }) =>
      Effect.sync(() => changes.push(permissionMode)).pipe(
        Effect.as(new Agent({ ...agentFields, engine: "claude-code", permissionMode })),
      ),
  })

  await user.click(await screen.findByRole("combobox", { name: "Permission mode" }))
  await user.click(await screen.findByRole("option", { name: "Auto" }))
  expect(changes).toEqual(["auto"])

  cleanup()
  mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
  })
  await screen.findByRole("button", { name: "pi: gpt-test" })
  expect(screen.queryByRole("combobox", { name: "Permission mode" })).toBeNull()
})

const runningTurn = {
  id: "turn-1",
  message: "Build it",
  images: [],
  context: null,
  feedback: [],
  sentAt,
  ended: null,
  parts: [],
}

const running = (queued: ReadonlyArray<{ id: string; message: string }> = []) =>
  Stream.make(
    TranscriptSnapshot.make({
      turns: [runningTurn],
      queued: queued.map((message) => ({ ...message, images: [], context: null, feedback: [] })),
      status: null,
    }),
  )

it("queues a message sent with Enter while a Turn runs, and Steers one sent with ⌘Enter", async () => {
  const sent: Array<{ message: string; steer: boolean }> = []

  const user = mount({
    WatchTranscript: () => running(),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push({ message, steer: false })),
    Steer: ({ message }) => Effect.sync(() => void sent.push({ message, steer: true })),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await waitFor(() => expect(composer.getAttribute("aria-placeholder")).toContain("⌘Enter"))
  await user.type(composer, "Then add docs{Enter}")
  await user.type(composer, "Use tabs{Meta>}{Enter}{/Meta}")

  expect(sent).toEqual([
    { message: "Then add docs", steer: false },
    { message: "Use tabs", steer: true },
  ])
})

it("lists Queued messages, cancels one, and sends one now once no Turn runs", async () => {
  const cancelled: Array<string> = []
  const sentNow: Array<string> = []
  const queued = [{ id: "queued-1", message: "Then add docs" }]

  const handlers = {
    CancelQueuedMessage: ({ queuedMessageId }: { queuedMessageId: string }) =>
      Effect.sync(() => {
        cancelled.push(queuedMessageId)

        return new UnsentFeedback({ notes: [], staged: [] })
      }),
    SendQueuedMessage: ({ queuedMessageId }: { queuedMessageId: string }) =>
      Effect.sync(() => void sentNow.push(queuedMessageId)),
  }

  const user = mount({ WatchTranscript: () => running(queued), ...handlers })

  const list = await screen.findByRole("region", { name: "Queued messages" })
  expect(within(list).queryByRole("button", { name: "Send now: Then add docs" })).toBeNull()
  await user.click(within(list).getByRole("button", { name: "Cancel: Then add docs" }))
  expect(cancelled).toEqual(["queued-1"])

  cleanup()

  const stopped = { ...runningTurn, ended: { at: sentAt, ending: TurnStopped.make({}) } }

  const again = mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({
          turns: [stopped],
          queued: queued.map((message) => ({
            ...message,
            images: [],
            context: null,
            feedback: [],
          })),
          status: null,
        }),
      ),
    ...handlers,
  })

  await again.click(await screen.findByRole("button", { name: "Send now: Then add docs" }))
  expect(sentNow).toEqual(["queued-1"])
})

it("says it's too late to cancel a Queued message that already started its Turn", async () => {
  const user = mount({
    WatchTranscript: () => running([{ id: "queued-1", message: "Then add docs" }]),
    CancelQueuedMessage: () => Effect.fail(new QueuedMessageStarted()),
  })

  const list = await screen.findByRole("region", { name: "Queued messages" })
  await user.click(within(list).getByRole("button", { name: "Cancel: Then add docs" }))

  expect(await screen.findByText("Too late to cancel")).toBeTruthy()
})

it("stops the running Turn, which then shows it was stopped", async () => {
  const stops: Array<string> = []
  const ended = Deferred.makeUnsafe<void>()

  const user = mount({
    WatchTranscript: () =>
      Stream.concat(
        running(),
        Stream.fromEffect(Deferred.await(ended)).pipe(
          Stream.as(
            TurnEnded.make({
              turnId: runningTurn.id,
              ended: { at: DateTime.add(sentAt, { seconds: 4 }), ending: TurnStopped.make({}) },
            }),
          ),
        ),
      ),
    StopTurn: ({ agentId }) =>
      Effect.sync(() => {
        stops.push(agentId)
        Deferred.doneUnsafe(ended, Exit.void)
      }),
  })

  await user.click(await screen.findByRole("button", { name: "Stop" }))

  expect(stops).toEqual([agent.id])
  expect(await screen.findByText("Stopped after 4s")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
})

it("recalls the last message with ↑ in an empty composer", async () => {
  const user = mount({ WatchTranscript: () => running([{ id: "queued-1", message: "Then docs" }]) })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await screen.findByRole("region", { name: "Queued messages" })
  await user.click(composer)
  await user.keyboard("{ArrowUp}")

  expect(composer).toHaveProperty("textContent", "Then docs")
})

it("sends a pasted image with the message", async () => {
  const sent: Array<{ message: string; images: ReadonlyArray<unknown> }> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message, images }) => Effect.sync(() => void sent.push({ message, images })),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  const bytes = Uint8Array.from(atob(pixel.data), (char) => char.charCodeAt(0))
  await user.click(composer)
  const clipboard = new DataTransfer()
  clipboard.items.add(new File([bytes], "pixel.png", { type: "image/png" }))
  await user.paste(clipboard)
  expect(await screen.findByRole("img", { name: "Attachment 1" })).toBeTruthy()

  await user.type(composer, "What's this?{Enter}")

  expect(sent).toEqual([{ message: "What's this?", images: [pixel] }])
})

it("shows the Agent's unsent message from before and saves what the user writes", async () => {
  const saved: Array<string> = []

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    GetUnsentMessage: () => Effect.succeed({ message: "Half a", images: [] }),
    SaveUnsentMessage: ({ message }) => Effect.sync(() => void saved.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await waitFor(() => expect(composer).toHaveProperty("textContent", "Half a"))
  await user.type(composer, " thought")

  await waitFor(() => expect(saved.at(-1)).toBe("Half a thought"))
})

it("saves what the user was still writing when they switch to another Agent", async () => {
  const other = new Agent({ ...agentFields, id: "agent-2", name: "agent/calm-heron" })
  const saved: Array<{ agentId: string; message: string }> = []

  const user = mount({
    WatchAgents: () => Stream.make([agent, other]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SaveUnsentMessage: ({ agentId, message }) =>
      Effect.sync(() => void saved.push({ agentId, message })),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer.firstElementChild!, "Half a thought")
  expect(saved).toEqual([])
  await user.click(screen.getByRole("link", { name: other.name }))

  await waitFor(() => expect(saved).toEqual([{ agentId: agent.id, message: "Half a thought" }]))
})

const noTranscript = () =>
  Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null }))

const inSandboxWith = (reach: SandboxReach) =>
  new Agent({
    ...agentFields,
    place: SandboxPlace.make({ providerId: "fake" }),
    engine: "claude-code",
    permissionMode: "bypassPermissions",
    sandbox: new SandboxStatus({ expiresAt: DateTime.makeUnsafe("2026-10-28T12:00:00Z"), reach }),
  })

it("dims a Sandbox Agent Glass can't reach, and makes one whose Sandbox expired read-only", async () => {
  const reached: Array<string> = []

  const user = mount({
    WatchAgents: () => Stream.make([inSandboxWith("unreachable")]),
    WatchTranscript: noTranscript,
    ReachSandbox: ({ agentId }) =>
      Effect.sync(() => {
        reached.push(agentId)
      }),
  })

  const link = await screen.findByRole("link", { description: /Can't reach its Sandbox · Expires/ })
  expect(link.className).toContain("opacity-60")
  expect(
    screen.getByText(
      /Glass can't reach this Agent's Sandbox. Once it answers, Glass fills in what the Agent did./,
    ),
  ).toBeTruthy()
  expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(reached).toEqual([agentFields.id]))

  cleanup()
  mount({
    WatchAgents: () => Stream.make([inSandboxWith("expired")]),
    WatchTranscript: noTranscript,
  })

  expect(
    await screen.findByText(
      "This Agent's Sandbox expired, so it can't take messages. Its transcript stays until you remove the Agent.",
    ),
  ).toBeTruthy()
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull()
  expect(screen.getByRole("link", { description: /Sandbox expired/ })).toBeTruthy()
})

const flaky = new ToDo({ id: 3, title: "Fix the flaky test", notes: "", done: false })

it("mentions an open To-do picked after @, and shows the Mention as its title", async () => {
  const sent: Array<string> = []

  const user = mount({
    ListToDos: () =>
      Effect.succeed([
        flaky,
        new ToDo({ id: 4, title: "Fix the docs", notes: "", done: true }),
        new ToDo({ id: 5, title: "Write the release notes", notes: "", done: false }),
      ]),
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({ turns: [], queued: [], status: null }),
        TurnStarted.make({
          turnId: "turn-1",
          message: `Earlier: ${toDoMention(flaky)}`,
          images: [],
          context: null,
          feedback: [],
          sentAt,
        }),
      ),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const transcript = await screen.findByRole("region", { name: "Transcript" })
  expect(await within(transcript).findByText("Fix the flaky test")).toBeTruthy()
  expect(within(transcript).queryByText(/glass:\/\//)).toBeNull()

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Look at @fix")
  const choices = await screen.findByRole("listbox", { name: "Mentions" })
  expect(
    within(choices)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Fix the flaky test"])

  await user.keyboard("{Enter}")
  expect(screen.queryByRole("listbox", { name: "Mentions" })).toBeNull()
  await user.type(composer, "now{Enter}")

  expect(sent).toEqual([`Look at ${toDoMention(flaky)} now`])
})

it("offers the Agent's files after its To-dos, those named after what's typed first", async () => {
  const sent: Array<string> = []

  const user = mount({
    ListToDos: () => Effect.succeed([flaky]),
    ListAgentFiles: () => Effect.succeed(["fixtures/readme.md", "src/fix.ts", "docs/notes.md"]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Open @fix")
  const choices = await screen.findByRole("listbox", { name: "Mentions" })
  expect(
    within(choices)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Fix the flaky test", "fix.tssrc", "readme.mdfixtures"])

  await user.keyboard("{ArrowDown}{Enter}")
  await user.type(composer, "{Enter}")

  expect(sent).toEqual([`Open ${fileMention("src/fix.ts")}`])
})

it("keeps the To-do choices closed after Escape, so Enter sends the @ as written", async () => {
  const sent: Array<string> = []

  const user = mount({
    ListToDos: () => Effect.succeed([flaky]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "Ping @f")
  await screen.findByRole("listbox", { name: "Mentions" })
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("listbox", { name: "Mentions" })).toBeNull()
  await user.keyboard("{Enter}")

  expect(sent).toEqual(["Ping @f"])
})

it("offers the program's commands after a leading /, and only there", async () => {
  const sent: Array<string> = []

  const user = mount({
    ListAgentCommands: () =>
      Effect.succeed([
        { name: "greet", description: "Greets the user by name." },
        { name: "review", description: "Reviews the diff." },
      ]),
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.type(composer, "/gr")
  const choices = await screen.findByRole("listbox", { name: "Commands" })
  expect(
    within(choices)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["/greetGreets the user by name."])

  await user.keyboard("{Enter}")
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull()
  await user.type(composer, "Ada{Enter}")
  expect(sent).toEqual(["/greet Ada"])

  await user.type(composer, "Run /gr")
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull()
})

it("keeps pasted lines and To-do mentions as written", async () => {
  const sent: Array<string> = []

  const pasted = `First\n\nThen ${toDoMention(flaky)} after`

  const user = mount({
    WatchTranscript: () =>
      Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    SendMessage: ({ message }) => Effect.sync(() => void sent.push(message)),
  })

  const composer = await screen.findByRole("textbox", { name: "Message" })
  await user.click(composer)
  await user.paste(pasted)
  expect(within(composer).getByText("Fix the flaky test")).toBeTruthy()
  await user.keyboard("{Enter}")

  expect(sent).toEqual([pasted])
})
