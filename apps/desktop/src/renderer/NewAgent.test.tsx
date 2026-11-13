// @vitest-environment happy-dom
import {
  Agent,
  type AgentEngine,
  AgentModels,
  type AgentPlace,
  FollowedRepository,
  LocalCheckout,
  LocalSkillsError,
  type NewAgent,
  SandboxPlace,
  SandboxProviderInfo,
  Skill,
  localPlace,
  SkillPack,
  SkillPackSource,
  TranscriptSnapshot,
} from "@glass/contracts"
import { cleanup, screen, waitFor, within } from "@testing-library/react"
import { Deferred, Effect, Exit, Predicate, Stream } from "effect"
import { expect, it } from "vite-plus/test"
import { placeKey } from "./agentsArea"
import { agent, agentFields } from "../../test/agent"
import { choice, listModels, mount, pixel } from "../../test/agentApp"

const pack = (name: string, commit: string, skills: ReadonlyArray<string> = []) =>
  new SkillPack({
    name,
    source: new SkillPackSource({ owner: "acme", repo: "skills", ref: "main", path: name }),
    commit,
    updatable: true,
    skills: skills.map((skill) => new Skill({ name: skill, description: `Use ${skill}.` })),
  })

const branchesAt = ({
  local = () => ["main", ["main"]],
  sandbox = { defaultBranch: "main" },
}: {
  readonly local?: (repository: FollowedRepository) => readonly [string, ReadonlyArray<string>]
  readonly sandbox?: {
    readonly defaultBranch: string
    readonly branches?: Effect.Effect<ReadonlyArray<string>>
  }
}) => ({
  GetNewAgentDefaultBranch: ({ place, repository }: PlaceRepository) =>
    Effect.succeed(
      Predicate.isTagged(place, "sandbox") ? sandbox.defaultBranch : local(repository)[0],
    ),
  ListNewAgentBranches: ({ place, repository }: PlaceRepository) =>
    Predicate.isTagged(place, "sandbox")
      ? (sandbox.branches ?? Effect.succeed([sandbox.defaultBranch]))
      : Effect.succeed(local(repository)[1]),
})

interface PlaceRepository {
  readonly place: AgentPlace
  readonly repository: FollowedRepository
}

const newAgentHandlers = (created: Array<NewAgent>, agents: ReadonlyArray<Agent>) => ({
  WatchAgents: () => Stream.make(agents),
  ListLocalCheckouts: () =>
    Effect.succeed([new LocalCheckout({ repository: agent.repository, path: "/src/greeter" })]),
  ...branchesAt({}),
  CreateAgent: (input: NewAgent) => Effect.sync(() => created.push(input)).pipe(Effect.as(agent)),
  WatchTranscript: () =>
    Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
})

const newAgentDraft = () => screen.getByRole("region", { name: "New Agent" })

it("starts an Agent from its first message, on the repository's default branch", async () => {
  const created: Array<NewAgent> = []

  const user = mount(
    {
      WatchAgents: () => Stream.make([]),
      ListLocalCheckouts: () =>
        Effect.succeed([new LocalCheckout({ repository: agent.repository, path: "/src/greeter" })]),
      ...branchesAt({ local: () => ["main", ["develop", "main"]] }),
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
  expect(within(mode).getByText("Auto")).toBeTruthy()
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
      place: localPlace,
      skillPacks: [],
      localSkills: false,
      message: "Fix the bug",
      images: [],
    },
  ])
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
})

it("starts an Agent with the Skill packs picked, and picks the same ones next time", async () => {
  const created: Array<NewAgent> = []

  const handlers = {
    ...newAgentHandlers(created, []),
    ListSkillPacks: () =>
      Effect.succeed([pack("docs", "1111111aaaa"), pack("team", "ae5650fbbbb")]),
  }

  const user = mount(handlers, "/agents/new")

  const packs = await within(await screen.findByRole("region", { name: "New Agent" })).findByRole(
    "combobox",
    { name: "Skill packs" },
  )

  expect(within(packs).getByText("No Skill packs")).toBeTruthy()
  await user.click(packs)
  await user.click(await screen.findByRole("option", { name: "team" }))
  await user.keyboard("{Escape}")
  expect(within(packs).getByText("team")).toBeTruthy()
  await user.type(within(newAgentDraft()).getByRole("textbox", { name: "Message" }), "One{Enter}")
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))

  cleanup()
  const again = mount(handlers, "/agents/new")

  const remembered = await within(
    await screen.findByRole("region", { name: "New Agent" }),
  ).findByRole("combobox", { name: "Skill packs" })

  expect(within(remembered).getByText("team")).toBeTruthy()
  await again.type(within(newAgentDraft()).getByRole("textbox", { name: "Message" }), "Two{Enter}")

  expect(created.map(({ skillPacks }) => skillPacks)).toEqual([["team"], ["team"]])
})

it("waits for the Skill packs to load before starting an Agent with the remembered ones", async () => {
  const created: Array<NewAgent> = []
  const listed = Deferred.makeUnsafe<void>()
  localStorage.setItem("glass.newAgent.skillPacks", JSON.stringify(["team"]))

  const user = mount(
    {
      ...newAgentHandlers(created, []),
      ListSkillPacks: () => Deferred.await(listed).pipe(Effect.as([pack("team", "ae5650fbbbb")])),
    },
    "/agents/new",
  )

  const message = await within(await screen.findByRole("region", { name: "New Agent" })).findByRole(
    "textbox",
    { name: "Message" },
  )

  await user.type(message, "Go{Enter}")
  Deferred.doneUnsafe(listed, Exit.void)
  await within(newAgentDraft()).findByRole("combobox", { name: "Skill packs" })
  await user.type(message, "{Enter}")

  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
  expect(created.map(({ skillPacks }) => skillPacks)).toEqual([["team"]])
})

it("gives a Sandbox Agent the Local skills when picked, warning which skill names its sources share", async () => {
  const created: Array<NewAgent> = []
  localStorage.setItem("glass.newAgent.skillPacks", JSON.stringify(["team"]))

  const handlers = {
    ...newAgentHandlers(created, []),
    ListSandboxProviders: () =>
      Effect.succeed([
        new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", engines: ["claude-code"] }),
      ]),
    ListSkillPacks: () =>
      Effect.succeed([pack("team", "ae5650fbbbb", ["architect", "grilling", "tdd"])]),
    ListFollowedRepositories: () => Effect.succeed([agent.repository]),
    ListLocalSkills: () => Effect.succeed(["grilling", "notes", "tdd"]),
  }

  const user = mount(handlers, "/agents/new")
  const draft = await screen.findByRole("region", { name: "New Agent" })
  await within(draft).findByRole("combobox", { name: "Skill packs" })
  expect(within(draft).queryByRole("checkbox", { name: "Local skills" })).toBeNull()

  await user.click(within(draft).getByRole("combobox", { name: "Where the Agent runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))
  const localSkills = await within(newAgentDraft()).findByRole("checkbox", { name: "Local skills" })
  expect(within(newAgentDraft()).queryByRole("list", { name: "Shared skill names" })).toBeNull()

  await user.click(localSkills)
  const shared = await within(newAgentDraft()).findByRole("list", { name: "Shared skill names" })
  expect(
    within(shared)
      .getAllByRole("listitem")
      .map(({ textContent }) => textContent),
  ).toEqual([
    "grilling is in Local skills and team. The Agent has each, as /local:grilling and /team:grilling.",
    "tdd is in Local skills and team. The Agent has each, as /local:tdd and /team:tdd.",
  ])

  await user.type(
    within(newAgentDraft()).getByRole("textbox", { name: "Message" }),
    "Fix the bug{Enter}",
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
  expect(created).toMatchObject([{ skillPacks: ["team"], localSkills: true }])

  cleanup()
  mount(handlers, "/agents/new")
  const again = await screen.findByRole("region", { name: "New Agent" })
  await user.click(await within(again).findByRole("combobox", { name: "Where the Agent runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))
  expect(
    (await within(newAgentDraft()).findByRole("checkbox", { name: "Local skills" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true")
})

it("warns a local Agent which skill names its Skill packs share with the Local skills", async () => {
  localStorage.setItem("glass.newAgent.skillPacks", JSON.stringify(["team"]))

  mount(
    {
      ...newAgentHandlers([], []),
      ListSkillPacks: () =>
        Effect.succeed([pack("team", "ae5650fbbbb", ["architect", "grilling"])]),
      ListLocalSkills: () => Effect.succeed(["grilling", "notes"]),
    },
    "/agents/new",
  )

  const shared = await within(await screen.findByRole("region", { name: "New Agent" })).findByRole(
    "list",
    { name: "Shared skill names" },
  )

  expect(within(newAgentDraft()).queryByRole("checkbox", { name: "Local skills" })).toBeNull()
  expect(within(shared).getByRole("listitem").textContent).toBe(
    "grilling is in Local skills and team. The Agent has each, as /grilling and /team:grilling.",
  )
})

it("shows when the Local skills can't be read, and still starts the Sandbox Agent", async () => {
  const created: Array<NewAgent> = []
  localStorage.setItem("glass.newAgent.localSkills", "true")
  localStorage.setItem("glass.newAgent.skillPacks", JSON.stringify(["team"]))

  const user = mount(
    {
      ...newAgentHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", engines: ["claude-code"] }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([agent.repository]),
      ListSkillPacks: () => Effect.succeed([pack("team", "ae5650fbbbb", ["architect"])]),
      ListLocalSkills: () =>
        Effect.fail(new LocalSkillsError({ message: "Glass couldn't read your Local skills." })),
    },
    "/agents/new",
  )

  const draft = await screen.findByRole("region", { name: "New Agent" })
  await user.click(await within(draft).findByRole("combobox", { name: "Where the Agent runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))
  expect(await within(newAgentDraft()).findByText("Couldn't read your Local skills")).toBeTruthy()

  await user.type(
    within(newAgentDraft()).getByRole("textbox", { name: "Message" }),
    "Fix the bug{Enter}",
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
  expect(created).toMatchObject([{ skillPacks: ["team"], localSkills: true }])
})

it("shows the first message at once while the Agent starts", async () => {
  const started = Deferred.makeUnsafe<void>()

  const user = mount(
    {
      WatchAgents: () => Stream.make([]),
      ListLocalCheckouts: () =>
        Effect.succeed([new LocalCheckout({ repository: agent.repository, path: "/src/greeter" })]),
      ...branchesAt({}),
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
  expect(composer).toHaveProperty("textContent", "")

  Deferred.doneUnsafe(started, Exit.void)
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
})

it("keeps local branch, program, model, effort, and unsent work when exploring a Sandbox", async () => {
  const created: Array<NewAgent> = []

  const user = mount(
    {
      ...newAgentHandlers(created, []),
      ...branchesAt({
        local: () => ["main", ["main", "develop"]],
        sandbox: { defaultBranch: "trunk" },
      }),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", engines: ["claude-code"] }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([agent.repository]),
      ListAgentModels: ({ engine, place }) =>
        Predicate.isTagged(place, "sandbox")
          ? Effect.succeed(
              new AgentModels({
                defaultModel: { id: "remote", name: "Remote model", efforts: [] },
                models: [],
              }),
            )
          : listModels({ engine }),
    },
    "/agents/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(
      await within(await screen.findByRole("region", { name: "New Agent" })).findByRole(
        "combobox",
        { name },
      ),
    )
    await user.click(await screen.findByRole("option", { name: option }))
  }

  await select("Base branch", "develop")
  await user.click(
    await within(newAgentDraft()).findByRole("button", { name: "Claude Code: Opus 5.5" }),
  )
  await user.click(choice(await screen.findByRole("dialog"), "Agent program", "pi"))
  await within(newAgentDraft()).findByRole("button", { name: "pi: gpt-test" })
  await user.click(choice(await screen.findByRole("dialog"), "Model", "Thinker"))
  await select("Effort", "High")
  await user.type(
    within(newAgentDraft()).getByRole("textbox", { name: "Message" }),
    "Keep my choices",
  )
  const clipboard = new DataTransfer()
  clipboard.items.add(
    new File([Uint8Array.from(atob(pixel.data), (c) => c.charCodeAt(0))], "pixel.png", {
      type: "image/png",
    }),
  )
  await user.paste(clipboard)
  await within(newAgentDraft()).findByRole("img", { name: "Attachment 1" })

  await select("Where the Agent runs", "Fake Sandboxes")
  await within(newAgentDraft()).findByRole("button", { name: "Claude Code: Remote model" })
  expect(
    within(within(newAgentDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
      "trunk",
    ),
  ).toBeTruthy()
  expect(within(newAgentDraft()).queryByRole("combobox", { name: "Effort" })).toBeNull()
  expect(within(newAgentDraft()).queryByRole("combobox", { name: "Permission mode" })).toBeNull()

  await select("Where the Agent runs", "Local")
  await within(newAgentDraft()).findByRole("button", { name: "pi: Thinker" })
  expect(
    within(within(newAgentDraft()).getByRole("combobox", { name: "Effort" })).getByText("High"),
  ).toBeTruthy()
  expect(
    within(within(newAgentDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
      "develop",
    ),
  ).toBeTruthy()
  expect(within(newAgentDraft()).getByRole("textbox", { name: "Message" })).toHaveProperty(
    "textContent",
    "Keep my choices",
  )
  await user.type(within(newAgentDraft()).getByRole("textbox", { name: "Message" }), "{Enter}")
  expect(created).toMatchObject([
    {
      place: localPlace,
      baseBranch: "develop",
      engine: "pi",
      model: "glass-test/thinker",
      effort: "high",
      permissionMode: null,
      images: [pixel],
    },
  ])
})

it("restores each program's choices and keeps local Permission mode separate from a Sandbox", async () => {
  const created: Array<NewAgent> = []

  const user = mount(
    {
      ...newAgentHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", engines: ["claude-code"] }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([agent.repository]),
      ...branchesAt({ sandbox: { defaultBranch: "main" } }),
    },
    "/agents/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(
      await within(await screen.findByRole("region", { name: "New Agent" })).findByRole(
        "combobox",
        { name },
      ),
    )
    await user.click(await screen.findByRole("option", { name: option }))
  }

  await user.click(
    await within(await screen.findByRole("region", { name: "New Agent" })).findByRole("button", {
      name: "Claude Code: Opus 5.5",
    }),
  )
  await user.click(choice(await screen.findByRole("dialog"), "Model", "Sonnet 5.5"))
  await select("Effort", "High")
  await select("Permission mode", "Accept edits")
  await user.click(within(newAgentDraft()).getByRole("button", { name: "Claude Code: Sonnet 5.5" }))
  await user.click(choice(await screen.findByRole("dialog"), "Agent program", "pi"))
  await within(newAgentDraft()).findByRole("button", { name: "pi: gpt-test" })
  expect(within(newAgentDraft()).queryByRole("combobox", { name: "Effort" })).toBeNull()
  await user.click(choice(await screen.findByRole("dialog"), "Agent program", "Claude Code"))
  await user.keyboard("{Escape}")
  await within(newAgentDraft()).findByRole("button", { name: "Claude Code: Sonnet 5.5" })
  await select("Where the Agent runs", "Fake Sandboxes")
  await within(newAgentDraft()).findByRole("button", { name: "Claude Code: Opus 5.5" })
  expect(within(newAgentDraft()).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  await select("Where the Agent runs", "Local")
  await within(newAgentDraft()).findByRole("button", { name: "Claude Code: Sonnet 5.5" })
  expect(
    within(within(newAgentDraft()).getByRole("combobox", { name: "Permission mode" })).getByText(
      "Accept edits",
    ),
  ).toBeTruthy()
  await user.type(
    within(newAgentDraft()).getByRole("textbox", { name: "Message" }),
    "Fix it{Enter}",
  )
  expect(created).toMatchObject([
    { engine: "claude-code", model: "sonnet", effort: "high", permissionMode: "acceptEdits" },
  ])
})

it("keeps branches per repository and falls back when a remembered branch disappears", async () => {
  const other = new FollowedRepository({ owner: "glass-demo", repo: "lamp" })
  let localBranches = ["main", "develop"]
  const created: Array<NewAgent> = []

  const user = mount(
    {
      ...newAgentHandlers(created, []),
      ListLocalCheckouts: () =>
        Effect.succeed(
          [agent.repository, other].map(
            (repository) => new LocalCheckout({ repository, path: `/src/${repository.repo}` }),
          ),
        ),
      ...branchesAt({
        local: (repository) =>
          repository.repo === "lamp" ? ["trunk", ["trunk"]] : ["main", localBranches],
      }),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", engines: ["claude-code"] }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([]),
    },
    "/agents/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(
      await within(await screen.findByRole("region", { name: "New Agent" })).findByRole(
        "combobox",
        { name },
      ),
    )
    await user.click(await screen.findByRole("option", { name: option }))
  }

  await select("Base branch", "develop")
  await select("Repository", "glass-demo/lamp")
  await waitFor(() =>
    expect(
      within(within(newAgentDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
        "trunk",
      ),
    ).toBeTruthy(),
  )
  await select("Repository", "glass-demo/greeter")
  await waitFor(() =>
    expect(
      within(within(newAgentDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
        "develop",
      ),
    ).toBeTruthy(),
  )
  await select("Where the Agent runs", "Fake Sandboxes")
  expect(
    (await within(newAgentDraft()).findByRole("combobox", { name: "Repository" })).textContent,
  ).toContain("No repositories")
  expect(within(newAgentDraft()).getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  )
  localBranches = ["main"]
  await select("Where the Agent runs", "Local")
  await waitFor(() =>
    expect(
      within(within(newAgentDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
        "main",
      ),
    ).toBeTruthy(),
  )
  await user.type(
    within(newAgentDraft()).getByRole("textbox", { name: "Message" }),
    "Fix it{Enter}",
  )
  expect(created).toMatchObject([{ repository: agent.repository, baseBranch: "main" }])
})

it.each([
  { model: "removed-model", effort: "high", expectedModel: null, expectedEffort: null },
  { model: "sonnet", effort: "unsupported", expectedModel: "sonnet", expectedEffort: null },
])(
  "uses valid defaults for unavailable model or effort: $model / $effort",
  async ({ model, effort, expectedModel, expectedEffort }) => {
    const created: Array<NewAgent> = []

    const user = mount(
      newAgentHandlers(created, [
        new Agent({ ...agentFields, engine: "claude-code", model, effort }),
      ]),
      "/agents/new",
    )

    await within(await screen.findByRole("region", { name: "New Agent" })).findByRole("button", {
      name: `Claude Code: ${expectedModel === null ? "Opus 5.5" : "Sonnet 5.5"}`,
    })
    await user.type(
      within(newAgentDraft()).getByRole("textbox", { name: "Message" }),
      "Fix it{Enter}",
    )
    expect(created).toMatchObject([{ model: expectedModel, effort: expectedEffort }])
  },
)

it("keeps an unlinked Local place blocked and never inherits Sandbox bypass permissions", async () => {
  const sandbox = SandboxPlace.make({ providerId: "fake" })

  const user = mount(
    {
      ...newAgentHandlers(
        [],
        [
          new Agent({
            ...agentFields,
            place: sandbox,
            engine: "claude-code",
            permissionMode: "bypassPermissions",
          }),
        ],
      ),
      ListLocalCheckouts: () => Effect.succeed([]),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", engines: ["claude-code"] }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([agent.repository]),
      ...branchesAt({ sandbox: { defaultBranch: "main" } }),
    },
    "/agents/new",
  )

  const draft = await screen.findByRole("region", { name: "New Agent" })
  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "Unsent work")
  expect(within(draft).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  await user.click(await within(draft).findByRole("combobox", { name: "Where the Agent runs" }))
  await user.click(await screen.findByRole("option", { name: "Local" }))
  await waitFor(() =>
    expect(
      within(newAgentDraft()).getByRole("combobox", { name: "Repository" }).textContent,
    ).toContain("No repositories"),
  )
  expect(within(newAgentDraft()).getByRole("textbox", { name: "Message" })).toHaveProperty(
    "textContent",
    "Unsent work",
  )
  expect(within(newAgentDraft()).getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  )
  expect(
    within(within(newAgentDraft()).getByRole("combobox", { name: "Permission mode" })).getByText(
      "Auto",
    ),
  ).toBeTruthy()
})

it("starts a Sandbox Agent on the default branch, listing other branches only when asked", async () => {
  const created: Array<NewAgent> = []
  const listedModels: Array<string | null> = []
  let listedBranches = 0
  const followed = new FollowedRepository({ owner: "glass-demo", repo: "lamp" })

  const user = mount(
    {
      ...newAgentHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            engines: ["claude-code", "pi"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([followed]),
      ...branchesAt({
        sandbox: {
          defaultBranch: "trunk",
          branches: Effect.sync(() => {
            listedBranches += 1

            return ["trunk", "release"]
          }),
        },
      }),
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
  expect(within(newAgentDraft()).getByText("The Agent works on a branch of its own.")).toBeTruthy()
  expect(within(newAgentDraft()).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  expect(listedModels).toContain("sandbox:fake")
  expect(listedBranches).toBe(0)

  await user.click(within(newAgentDraft()).getByRole("combobox", { name: "Base branch" }))
  await user.click(await screen.findByRole("option", { name: "release" }))
  expect(listedBranches).toBe(1)

  await user.type(
    within(newAgentDraft()).getByRole("textbox", { name: "Message" }),
    "Fix the bug{Enter}",
  )

  expect(created).toMatchObject([
    {
      repository: followed,
      baseBranch: "release",
      place: SandboxPlace.make({ providerId: "fake" }),
      permissionMode: null,
    },
  ])
  await waitFor(() => expect(window.location.hash).toBe(`#/agents/${agent.id}`))
})

it("lists every Agent program's models before one is chosen", async () => {
  const listed: Array<AgentEngine> = []

  mount(
    {
      ...newAgentHandlers([], []),
      ListAgentModels: (payload) => {
        listed.push(payload.engine)

        return listModels(payload)
      },
    },
    "/agents/new",
  )

  await screen.findByRole("region", { name: "New Agent" })
  await waitFor(() => expect(listed).toContain("pi"))
  expect(listed).toContain("claude-code")
  expect(listed).toContain("opencode")
})

it("offers only the Agent programs a Sandbox provider runs", async () => {
  const user = mount(
    {
      ...newAgentHandlers([], []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", engines: ["pi"] }),
        ]),
      ListFollowedRepositories: () =>
        Effect.succeed([new FollowedRepository({ owner: "glass-demo", repo: "lamp" })]),
      ...branchesAt({ sandbox: { defaultBranch: "trunk" } }),
    },
    "/agents/new",
  )

  const draft = await screen.findByRole("region", { name: "New Agent" })
  await within(draft).findByRole("button", { name: "Claude Code: Opus 5.5" })
  await user.click(await within(draft).findByRole("combobox", { name: "Where the Agent runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))

  await user.click(await within(newAgentDraft()).findByRole("button", { name: "pi: gpt-test" }))

  const programs = within(await screen.findByRole("dialog")).getByRole("group", {
    name: "Agent program",
  })

  expect(
    within(programs)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["pi"])
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
