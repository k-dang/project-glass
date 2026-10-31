// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  ActivityPage,
  Agent,
  type AgentEngine,
  AnswerQuestion,
  DenyRequest,
  PermissionRequestPart,
  QuestionPart,
  type RequestAnswer,
  type TurnPart,
  AgentModels,
  Branches,
  FollowedRepository,
  GitHubConnection,
  LocalCheckout,
  type NewAgent,
  PartAppended,
  PartSet,
  RemovalWarnings,
  type ResumableDestination,
  SandboxPlace,
  SandboxProviderInfo,
  thisMac,
  SavedPlace,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  TranscriptSnapshot,
  TurnCutOff,
  TurnDone,
  TurnEnded,
  TurnStarted,
  TurnStopped,
} from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Deferred, Effect, Exit, Stream } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { placeKey } from "./agentsArea"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { eventually } from "../../test/eventually"
import { testLayer } from "../../test/testBackend"

const sentAt = DateTime.makeUnsafe("2026-10-26T12:00:00Z")

const agentFields = {
  id: "agent-1",
  name: "agent/swift-otter",
  place: thisMac,
  repository: new FollowedRepository({ owner: "glass-demo", repo: "greeter" }),
  baseBranch: "main",
  engine: "pi",
  model: null,
  effort: null,
  permissionMode: null,
  createdAt: sentAt,
} as const

const agent = new Agent(agentFields)

const piModels = new AgentModels({
  defaultModel: { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] },
  models: [
    { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] },
    { id: "glass-test/thinker", name: "Thinker", efforts: ["off", "low", "high"] },
  ],
})

const claudeModels = new AgentModels({
  defaultModel: { id: "default", name: "Opus 5.5", efforts: ["low", "medium", "high"] },
  models: [{ id: "sonnet", name: "Sonnet 5.5", efforts: ["low", "high"] }],
})

const listModels = ({ engine }: { engine: AgentEngine }) =>
  Effect.succeed(engine === "pi" ? piModels : claudeModels)

const mount = (handlers: Parameters<typeof testLayer>[0], path = `/agents/${agent.id}`) => {
  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    WatchAgents: () => Stream.make([agent]),
    ListAgentModels: listModels,
    ...handlers,
  })

  window.history.replaceState(null, "", `#${path}`)

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <App />
    </RegistryProvider>,
  )

  return userEvent.setup()
}

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "#/")
})

it("shows the Agent under Local and its Turn's parts as they stream", async () => {
  const turnId = "turn-1"

  mount({
    WatchTranscript: () =>
      Stream.make(
        TranscriptSnapshot.make({ turns: [], queued: [], status: null }),
        TurnStarted.make({ turnId, message: "Run echo", images: [], sentAt }),
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
  expect(composer).toHaveProperty("value", "")
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

it("starts an Agent from its first message, on the repository's default branch", async () => {
  const created: Array<NewAgent> = []

  const user = mount(
    {
      WatchAgents: () => Stream.make([]),
      ListLocalCheckouts: () =>
        Effect.succeed([new LocalCheckout({ repository: agent.repository, path: "/src/greeter" })]),
      ListBranches: () =>
        Effect.succeed(new Branches({ defaultBranch: "main", branches: ["develop", "main"] })),
      CreateAgent: (input) => Effect.sync(() => created.push(input)).pipe(Effect.as(agent)),
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/agents/new",
  )

  const draft = await screen.findByRole("region", { name: "New Agent" })
  const base = await within(draft).findByRole("combobox", { name: "Base branch" })
  expect(within(base).getByText("main")).toBeTruthy()
  const mode = await within(draft).findByRole("combobox", { name: "Permission mode" })
  expect(within(mode).getByText("Default")).toBeTruthy()
  expect(within(draft).queryByRole("combobox", { name: "Where the Agent runs" })).toBeNull()

  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "Fix the bug{Enter}")

  expect(created).toEqual([
    {
      repository: agent.repository,
      baseBranch: "main",
      engine: "claude-code",
      model: null,
      effort: null,
      permissionMode: null,
      place: thisMac,
      message: "Fix the bug",
      images: [],
    },
  ])
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
})

it("shows the first message at once while the Agent starts", async () => {
  const started = Deferred.makeUnsafe<void>()

  const user = mount(
    {
      WatchAgents: () => Stream.make([]),
      ListLocalCheckouts: () =>
        Effect.succeed([new LocalCheckout({ repository: agent.repository, path: "/src/greeter" })]),
      ListBranches: () =>
        Effect.succeed(new Branches({ defaultBranch: "main", branches: ["main"] })),
      CreateAgent: () => Deferred.await(started).pipe(Effect.as(agent)),
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/agents/new",
  )

  const draft = await screen.findByRole("region", { name: "New Agent" })
  await within(draft).findByRole("combobox", { name: "Base branch" })
  const composer = within(draft).getByRole("textbox", { name: "Message" })
  await user.type(composer, "Fix the bug{Enter}")

  expect(within(draft).getByText("Fix the bug")).toBeTruthy()
  expect(
    within(draft).getByText(/Making the Agent's copy of glass-demo\/greeter from main/),
  ).toBeTruthy()
  expect(composer).toHaveProperty("value", "")

  Deferred.doneUnsafe(started, Exit.void)
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
})

const choice = (picker: HTMLElement, group: string, item: string) =>
  within(within(picker).getByRole("group", { name: group })).getByRole("button", { name: item })

const newAgentHandlers = (created: Array<NewAgent>, agents: ReadonlyArray<Agent>) => ({
  WatchAgents: () => Stream.make(agents),
  ListLocalCheckouts: () =>
    Effect.succeed([new LocalCheckout({ repository: agent.repository, path: "/src/greeter" })]),
  ListBranches: () => Effect.succeed(new Branches({ defaultBranch: "main", branches: ["main"] })),
  CreateAgent: (input: NewAgent) => Effect.sync(() => created.push(input)).pipe(Effect.as(agent)),
  WatchTranscript: () =>
    Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
})

const newAgentDraft = () => screen.getByRole("region", { name: "New Agent" })

it("starts an Agent in a Sandbox on a Followed repository, from its branches on GitHub", async () => {
  const created: Array<NewAgent> = []
  const listedModels: Array<string | null> = []
  const followed = new FollowedRepository({ owner: "glass-demo", repo: "lamp" })

  const user = mount(
    {
      ...newAgentHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes" })]),
      ListFollowedRepositories: () => Effect.succeed([followed]),
      ListGitHubBranches: () =>
        Effect.succeed(new Branches({ defaultBranch: "trunk", branches: ["trunk"] })),
      ListAgentModels: (payload) => {
        listedModels.push(placeKey(payload.place))

        return listModels(payload)
      },
    },
    "/agents/new",
  )

  const draft = await screen.findByRole("region", { name: "New Agent" })
  await user.click(await within(draft).findByRole("combobox", { name: "Where the Agent runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))

  await waitFor(() =>
    expect(
      within(within(newAgentDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
        "trunk",
      ),
    ).toBeTruthy(),
  )
  expect(
    within(newAgentDraft()).getByText(/in a Sandbox of its own from Fake Sandboxes/),
  ).toBeTruthy()
  expect(within(newAgentDraft()).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  expect(listedModels).toContain("sandbox:fake")

  await user.type(
    within(newAgentDraft()).getByRole("textbox", { name: "Message" }),
    "Fix the bug{Enter}",
  )

  expect(created).toMatchObject([
    {
      repository: followed,
      baseBranch: "trunk",
      place: SandboxPlace.make({ providerId: "fake" }),
      permissionMode: null,
    },
  ])
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
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

it("starts an Agent with the last one's program, model, and effort, in the Default Permission mode", async () => {
  const created: Array<NewAgent> = []

  const last = new Agent({
    ...agentFields,
    engine: "claude-code",
    model: "sonnet",
    effort: "high",
    permissionMode: "bypassPermissions",
  })

  const user = mount(newAgentHandlers(created, [last]), "/agents/new")

  const draft = await screen.findByRole("region", { name: "New Agent" })
  await within(draft).findByRole("button", { name: "Claude Code: Sonnet 5.5" })
  expect(
    within(within(draft).getByRole("combobox", { name: "Effort" })).getByText("High"),
  ).toBeTruthy()

  await within(draft).findByRole("combobox", { name: "Base branch" })
  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "Fix the bug{Enter}")

  expect(created).toMatchObject([
    { engine: "claude-code", model: "sonnet", effort: "high", permissionMode: null },
  ])
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
})

it("offers the chosen agent program's own models, and efforts only for models that take one", async () => {
  const created: Array<NewAgent> = []
  const user = mount(newAgentHandlers(created, []), "/agents/new")

  const draft = await screen.findByRole("region", { name: "New Agent" })
  await user.click(await within(draft).findByRole("button", { name: "Claude Code: Opus 5.5" }))
  const picker = await screen.findByRole("dialog")
  await user.click(choice(picker, "Agent program", "pi"))

  await within(draft).findByRole("button", { name: "pi: gpt-test" })
  expect(within(draft).queryByRole("combobox", { name: "Effort" })).toBeNull()

  await within(picker).findByRole("group", { name: "Model" })
  await user.click(choice(picker, "Model", "Thinker"))
  await user.click(await within(draft).findByRole("combobox", { name: "Effort" }))
  await user.click(await screen.findByRole("option", { name: "Low" }))
  await waitFor(() =>
    expect(
      within(within(draft).getByRole("combobox", { name: "Effort" })).getByText("Low"),
    ).toBeTruthy(),
  )

  await within(draft).findByRole("combobox", { name: "Base branch" })
  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "Fix the bug{Enter}")

  expect(created).toMatchObject([
    { engine: "pi", model: "glass-test/thinker", effort: "low", permissionMode: null },
  ])
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
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
  await eventually(() => expect(screen.queryByRole("dialog")).toBeNull())
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
        TurnStarted.make({ turnId, message: "Run echo", images: [], sentAt }),
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
      turns: [{ id: "turn-1", message: "List files", images: [], sentAt, ended: null, parts }],
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
  expect(composer.getAttribute("placeholder")).toBe("Answer the Permission request above first")
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
  sentAt,
  ended: null,
  parts: [],
}

const running = (queued: ReadonlyArray<{ id: string; message: string }> = []) =>
  Stream.make(
    TranscriptSnapshot.make({
      turns: [runningTurn],
      queued: queued.map((message) => ({ ...message, images: [] })),
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
  await waitFor(() => expect(composer.getAttribute("placeholder")).toContain("⌘Enter"))
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
      Effect.sync(() => void cancelled.push(queuedMessageId)),
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
          queued: queued.map((message) => ({ ...message, images: [] })),
          status: null,
        }),
      ),
    ...handlers,
  })

  await again.click(await screen.findByRole("button", { name: "Send now: Then add docs" }))
  expect(sentNow).toEqual(["queued-1"])
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

  expect(composer).toHaveProperty("value", "Then docs")
})

const pixel = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
} as const

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
  await waitFor(() => expect(composer).toHaveProperty("value", "Half a"))
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

  await user.type(await screen.findByRole("textbox", { name: "Message" }), "Half a thought")
  expect(saved).toEqual([])
  await user.click(screen.getByRole("link", { name: other.name }))

  await waitFor(() => expect(saved).toEqual([{ agentId: agent.id, message: "Half a thought" }]))
})
