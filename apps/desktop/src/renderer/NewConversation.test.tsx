// @vitest-environment happy-dom
import {
  Conversation,
  type AgentHarness,
  AgentModels,
  type ConversationPlace,
  FollowedRepository,
  LocalCheckout,
  LocalSkillsError,
  type NewConversation,
  SandboxPlace,
  SandboxProviderInfo,
  Skill,
  localPlace,
  SkillPack,
  SkillPackSource,
  ToDo,
  TranscriptSnapshot,
} from "@glass/contracts"
import { cleanup, screen, waitFor, within } from "@testing-library/react"
import { Deferred, Effect, Exit, Predicate, Stream, SubscriptionRef } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import { expect, it } from "vite-plus/test"
import { createConversationAtom, placeKey } from "./conversationsArea"
import { conversation, conversationFields } from "../../test/conversation"
import { choice, listModels, mount, pixel } from "../../test/conversationApp"
import { eventually } from "../../test/eventually"
import { testRegistry } from "../../test/testBackend"

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
  GetNewConversationDefaultBranch: ({ place, repository }: PlaceRepository) =>
    Effect.succeed(
      Predicate.isTagged(place, "sandbox") ? sandbox.defaultBranch : local(repository)[0],
    ),
  ListNewConversationBranches: ({ place, repository }: PlaceRepository) =>
    Predicate.isTagged(place, "sandbox")
      ? (sandbox.branches ?? Effect.succeed([sandbox.defaultBranch]))
      : Effect.succeed(local(repository)[1]),
})

interface PlaceRepository {
  readonly place: ConversationPlace
  readonly repository: FollowedRepository
}

const listedOnCreate = (
  created: Array<NewConversation>,
  listed: ReadonlyArray<Conversation>,
  creating: Effect.Effect<void> = Effect.void,
) => {
  const conversations = Effect.runSync(SubscriptionRef.make(listed))

  return {
    WatchConversations: () => SubscriptionRef.changes(conversations),
    CreateConversation: (input: NewConversation) =>
      creating.pipe(
        Effect.andThen(Effect.sync(() => created.push(input))),
        Effect.andThen(SubscriptionRef.update(conversations, (all) => [...all, conversation])),
        Effect.as(conversation),
      ),
  }
}

const newConversationHandlers = (
  created: Array<NewConversation>,
  conversations: ReadonlyArray<Conversation>,
) => ({
  ...listedOnCreate(created, conversations),
  ListLocalCheckouts: () =>
    Effect.succeed([
      new LocalCheckout({ repository: conversation.repository, path: "/src/greeter" }),
    ]),
  ...branchesAt({}),
  WatchTranscript: () =>
    Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
})

const newConversationDraft = () => screen.getByRole("region", { name: "New Conversation" })

it("starts a Conversation from its first message, on the repository's default branch", async () => {
  const created: Array<NewConversation> = []

  const user = mount(
    {
      ...listedOnCreate(created, []),
      ListLocalCheckouts: () =>
        Effect.succeed([
          new LocalCheckout({ repository: conversation.repository, path: "/src/greeter" }),
        ]),
      ...branchesAt({ local: () => ["main", ["develop", "main"]] }),
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/conversations/new",
  )

  const draft = await screen.findByRole("region", { name: "New Conversation" })
  const base = await within(draft).findByRole("combobox", { name: "Base branch" })
  expect(within(base).getByText("main")).toBeTruthy()
  const mode = await within(draft).findByRole("combobox", { name: "Permission mode" })
  expect(within(mode).getByText("Auto")).toBeTruthy()
  expect(within(draft).queryByRole("combobox", { name: "Where the Conversation runs" })).toBeNull()

  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "Fix the bug{Enter}")

  expect(created).toEqual([
    {
      repository: conversation.repository,
      baseBranch: "main",
      harness: "claude-code",
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
  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))
})

it("starts a Conversation from a to-do by mentioning it", async () => {
  const created: Array<NewConversation> = []

  const toDo = new ToDo({
    id: 7,
    title: "Fix spacing",
    notes: "Looks off",
    done: false,
  })

  const user = mount(
    {
      ...newConversationHandlers(created, []),
      ListToDos: () => Effect.succeed([toDo]),
    },
    "/to-dos",
  )

  await user.click(
    await screen.findByRole("button", { name: "Start a Conversation from Fix spacing" }),
  )
  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await within(draft).findByRole("combobox", { name: "Base branch" })
  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "{Enter}")

  expect(created.map(({ message, images }) => ({ message, images }))).toEqual([
    { message: "[Fix spacing](glass://to-do/7)", images: [] },
  ])
})

it("starts a Conversation with the Skill packs picked, and picks the same ones next time", async () => {
  const created: Array<NewConversation> = []

  const handlers = {
    ...newConversationHandlers(created, []),
    ListSkillPacks: () =>
      Effect.succeed([pack("docs", "1111111aaaa"), pack("team", "ae5650fbbbb")]),
  }

  const user = mount(handlers, "/conversations/new")

  const packs = await within(
    await screen.findByRole("region", { name: "New Conversation" }),
  ).findByRole("combobox", { name: "Skill packs" })

  expect(within(packs).getByText("No Skill packs")).toBeTruthy()
  await user.click(packs)
  await user.click(await screen.findByRole("option", { name: "team" }))
  await user.keyboard("{Escape}")
  expect(within(packs).getByText("team")).toBeTruthy()
  await user.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
    "One{Enter}",
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))

  cleanup()
  const again = mount(handlers, "/conversations/new")

  const remembered = await within(
    await screen.findByRole("region", { name: "New Conversation" }),
  ).findByRole("combobox", { name: "Skill packs" })

  expect(within(remembered).getByText("team")).toBeTruthy()
  await again.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
    "Two{Enter}",
  )

  expect(created.map(({ skillPacks }) => skillPacks)).toEqual([["team"], ["team"]])
})

it("waits for the Skill packs to load before starting a Conversation with the remembered ones", async () => {
  const created: Array<NewConversation> = []
  const listed = Deferred.makeUnsafe<void>()
  localStorage.setItem("glass.newConversation.skillPacks", JSON.stringify(["team"]))

  const user = mount(
    {
      ...newConversationHandlers(created, []),
      ListSkillPacks: () => Deferred.await(listed).pipe(Effect.as([pack("team", "ae5650fbbbb")])),
    },
    "/conversations/new",
  )

  const message = await within(
    await screen.findByRole("region", { name: "New Conversation" }),
  ).findByRole("textbox", { name: "Message" })

  await user.type(message, "Go{Enter}")
  Deferred.doneUnsafe(listed, Exit.void)
  await within(newConversationDraft()).findByRole("combobox", { name: "Skill packs" })
  await user.type(message, "{Enter}")

  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))
  expect(created.map(({ skillPacks }) => skillPacks)).toEqual([["team"]])
})

it("gives a Sandbox Conversation the Local skills when picked, warning which skill names its sources share", async () => {
  const created: Array<NewConversation> = []
  localStorage.setItem("glass.newConversation.skillPacks", JSON.stringify(["team"]))

  const handlers = {
    ...newConversationHandlers(created, []),
    ListSandboxProviders: () =>
      Effect.succeed([
        new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", harnesses: ["claude-code"] }),
      ]),
    ListSkillPacks: () =>
      Effect.succeed([pack("team", "ae5650fbbbb", ["architect", "grilling", "tdd"])]),
    ListFollowedRepositories: () => Effect.succeed([conversation.repository]),
    ListLocalSkills: () => Effect.succeed(["grilling", "notes", "tdd"]),
  }

  const user = mount(handlers, "/conversations/new")
  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await within(draft).findByRole("combobox", { name: "Skill packs" })
  expect(within(draft).queryByRole("checkbox", { name: "Local skills" })).toBeNull()

  await user.click(within(draft).getByRole("combobox", { name: "Where the Conversation runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))

  const localSkills = await within(newConversationDraft()).findByRole("checkbox", {
    name: "Local skills",
  })

  expect(
    within(newConversationDraft()).queryByRole("list", { name: "Shared skill names" }),
  ).toBeNull()

  await user.click(localSkills)

  const shared = await within(newConversationDraft()).findByRole("list", {
    name: "Shared skill names",
  })

  expect(
    within(shared)
      .getAllByRole("listitem")
      .map(({ textContent }) => textContent),
  ).toEqual([
    "grilling is in Local skills and team. The Conversation has each, as /local:grilling and /team:grilling.",
    "tdd is in Local skills and team. The Conversation has each, as /local:tdd and /team:tdd.",
  ])

  await user.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
    "Fix the bug{Enter}",
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))
  expect(created).toMatchObject([{ skillPacks: ["team"], localSkills: true }])

  cleanup()
  mount(handlers, "/conversations/new")
  const again = await screen.findByRole("region", { name: "New Conversation" })
  await user.click(
    await within(again).findByRole("combobox", { name: "Where the Conversation runs" }),
  )
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))
  expect(
    (
      await within(newConversationDraft()).findByRole("checkbox", { name: "Local skills" })
    ).getAttribute("aria-checked"),
  ).toBe("true")
})

it("warns a local Conversation which skill names its Skill packs share with the Local skills", async () => {
  localStorage.setItem("glass.newConversation.skillPacks", JSON.stringify(["team"]))

  mount(
    {
      ...newConversationHandlers([], []),
      ListSkillPacks: () =>
        Effect.succeed([pack("team", "ae5650fbbbb", ["architect", "grilling"])]),
      ListLocalSkills: () => Effect.succeed(["grilling", "notes"]),
    },
    "/conversations/new",
  )

  const shared = await within(
    await screen.findByRole("region", { name: "New Conversation" }),
  ).findByRole("list", { name: "Shared skill names" })

  expect(
    within(newConversationDraft()).queryByRole("checkbox", { name: "Local skills" }),
  ).toBeNull()
  expect(within(shared).getByRole("listitem").textContent).toBe(
    "grilling is in Local skills and team. The Conversation has each, as /grilling and /team:grilling.",
  )
})

it("shows when the Local skills can't be read, and still starts the Sandbox Conversation", async () => {
  const created: Array<NewConversation> = []
  localStorage.setItem("glass.newConversation.localSkills", "true")
  localStorage.setItem("glass.newConversation.skillPacks", JSON.stringify(["team"]))

  const user = mount(
    {
      ...newConversationHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([conversation.repository]),
      ListSkillPacks: () => Effect.succeed([pack("team", "ae5650fbbbb", ["architect"])]),
      ListLocalSkills: () =>
        Effect.fail(new LocalSkillsError({ message: "Glass couldn't read your Local skills." })),
    },
    "/conversations/new",
  )

  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await user.click(
    await within(draft).findByRole("combobox", { name: "Where the Conversation runs" }),
  )
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))
  expect(
    await within(newConversationDraft()).findByText("Couldn't read your Local skills"),
  ).toBeTruthy()

  await user.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
    "Fix the bug{Enter}",
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))
  expect(created).toMatchObject([{ skillPacks: ["team"], localSkills: true }])
})

it("shows the first message at once while the Conversation starts", async () => {
  const started = Deferred.makeUnsafe<void>()

  const user = mount(
    {
      ...listedOnCreate([], [], Deferred.await(started)),
      ListLocalCheckouts: () =>
        Effect.succeed([
          new LocalCheckout({ repository: conversation.repository, path: "/src/greeter" }),
        ]),
      ...branchesAt({}),
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/conversations/new",
  )

  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await within(draft).findByRole("combobox", { name: "Base branch" })
  const composer = within(draft).getByRole("textbox", { name: "Message" })
  await user.type(composer, "Fix the bug{Enter}")

  expect(within(draft).getByText("Fix the bug")).toBeTruthy()
  expect(
    within(draft).getByText(/Making the Conversation's copy of glass-demo\/greeter from main/),
  ).toBeTruthy()
  expect(composer).toHaveProperty("textContent", "")

  Deferred.doneUnsafe(started, Exit.void)
  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))
})

it("keeps local branch, harness, model, effort, and unsent work when exploring a Sandbox", async () => {
  const created: Array<NewConversation> = []

  const user = mount(
    {
      ...newConversationHandlers(created, []),
      ...branchesAt({
        local: () => ["main", ["main", "develop"]],
        sandbox: { defaultBranch: "trunk" },
      }),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([conversation.repository]),
      ListAgentModels: ({ harness, place }) =>
        Predicate.isTagged(place, "sandbox")
          ? Effect.succeed(
              new AgentModels({
                defaultModel: { id: "remote", name: "Remote model", efforts: [] },
                models: [],
              }),
            )
          : listModels({ harness }),
    },
    "/conversations/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(
      await within(await screen.findByRole("region", { name: "New Conversation" })).findByRole(
        "combobox",
        { name },
      ),
    )
    await user.click(await screen.findByRole("option", { name: option }))
  }

  await select("Base branch", "develop")
  await user.click(
    await within(newConversationDraft()).findByRole("button", { name: "Claude Code: Opus 5.5" }),
  )
  await user.click(choice(await screen.findByRole("dialog"), "Agent harness", "pi"))
  await within(newConversationDraft()).findByRole("button", { name: "pi: gpt-test" })
  await user.click(choice(await screen.findByRole("dialog"), "Model", "Thinker"))
  await select("Effort", "High")
  await user.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
    "Keep my choices",
  )
  const clipboard = new DataTransfer()
  clipboard.items.add(
    new File([Uint8Array.from(atob(pixel.data), (c) => c.charCodeAt(0))], "pixel.png", {
      type: "image/png",
    }),
  )
  await user.paste(clipboard)
  await within(newConversationDraft()).findByRole("img", { name: "Attachment 1" })

  await select("Where the Conversation runs", "Fake Sandboxes")
  await within(newConversationDraft()).findByRole("button", { name: "Claude Code: Remote model" })
  expect(
    within(within(newConversationDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
      "trunk",
    ),
  ).toBeTruthy()
  expect(within(newConversationDraft()).queryByRole("combobox", { name: "Effort" })).toBeNull()
  expect(
    within(newConversationDraft()).queryByRole("combobox", { name: "Permission mode" }),
  ).toBeNull()

  await select("Where the Conversation runs", "Local")
  await within(newConversationDraft()).findByRole("button", { name: "pi: Thinker" })
  expect(
    within(within(newConversationDraft()).getByRole("combobox", { name: "Effort" })).getByText(
      "High",
    ),
  ).toBeTruthy()
  expect(
    within(within(newConversationDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
      "develop",
    ),
  ).toBeTruthy()
  expect(within(newConversationDraft()).getByRole("textbox", { name: "Message" })).toHaveProperty(
    "textContent",
    "Keep my choices",
  )
  await user.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
    "{Enter}",
  )
  expect(created).toMatchObject([
    {
      place: localPlace,
      baseBranch: "develop",
      harness: "pi",
      model: "glass-test/thinker",
      effort: "high",
      permissionMode: null,
      images: [pixel],
    },
  ])
})

it("restores each harness's choices and keeps local Permission mode separate from a Sandbox", async () => {
  const created: Array<NewConversation> = []

  const user = mount(
    {
      ...newConversationHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([conversation.repository]),
      ...branchesAt({ sandbox: { defaultBranch: "main" } }),
    },
    "/conversations/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(
      await within(await screen.findByRole("region", { name: "New Conversation" })).findByRole(
        "combobox",
        { name },
      ),
    )
    await user.click(await screen.findByRole("option", { name: option }))
  }

  await user.click(
    await within(await screen.findByRole("region", { name: "New Conversation" })).findByRole(
      "button",
      {
        name: "Claude Code: Opus 5.5",
      },
    ),
  )
  await user.click(choice(await screen.findByRole("dialog"), "Model", "Sonnet 5.5"))
  await select("Effort", "High")
  await select("Permission mode", "Accept edits")
  await user.click(
    within(newConversationDraft()).getByRole("button", { name: "Claude Code: Sonnet 5.5" }),
  )
  await user.click(choice(await screen.findByRole("dialog"), "Agent harness", "pi"))
  await within(newConversationDraft()).findByRole("button", { name: "pi: gpt-test" })
  expect(within(newConversationDraft()).queryByRole("combobox", { name: "Effort" })).toBeNull()
  await user.click(choice(await screen.findByRole("dialog"), "Agent harness", "Claude Code"))
  await user.keyboard("{Escape}")
  await within(newConversationDraft()).findByRole("button", { name: "Claude Code: Sonnet 5.5" })
  await select("Where the Conversation runs", "Fake Sandboxes")
  await within(newConversationDraft()).findByRole("button", { name: "Claude Code: Opus 5.5" })
  expect(
    within(newConversationDraft()).queryByRole("combobox", { name: "Permission mode" }),
  ).toBeNull()
  await select("Where the Conversation runs", "Local")
  await within(newConversationDraft()).findByRole("button", { name: "Claude Code: Sonnet 5.5" })
  expect(
    within(
      within(newConversationDraft()).getByRole("combobox", { name: "Permission mode" }),
    ).getByText("Accept edits"),
  ).toBeTruthy()
  await user.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
    "Fix it{Enter}",
  )
  expect(created).toMatchObject([
    { harness: "claude-code", model: "sonnet", effort: "high", permissionMode: "acceptEdits" },
  ])
})

it("keeps branches per repository and falls back when a remembered branch disappears", async () => {
  const other = new FollowedRepository({ owner: "glass-demo", repo: "lamp" })
  let localBranches = ["main", "develop"]
  const created: Array<NewConversation> = []

  const user = mount(
    {
      ...newConversationHandlers(created, []),
      ListLocalCheckouts: () =>
        Effect.succeed(
          [conversation.repository, other].map(
            (repository) => new LocalCheckout({ repository, path: `/src/${repository.repo}` }),
          ),
        ),
      ...branchesAt({
        local: (repository) =>
          repository.repo === "lamp" ? ["trunk", ["trunk"]] : ["main", localBranches],
      }),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([]),
    },
    "/conversations/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(
      await within(await screen.findByRole("region", { name: "New Conversation" })).findByRole(
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
      within(
        within(newConversationDraft()).getByRole("combobox", { name: "Base branch" }),
      ).getByText("trunk"),
    ).toBeTruthy(),
  )
  await select("Repository", "glass-demo/greeter")
  await waitFor(() =>
    expect(
      within(
        within(newConversationDraft()).getByRole("combobox", { name: "Base branch" }),
      ).getByText("develop"),
    ).toBeTruthy(),
  )
  await select("Where the Conversation runs", "Fake Sandboxes")
  expect(
    (await within(newConversationDraft()).findByRole("combobox", { name: "Repository" }))
      .textContent,
  ).toContain("No repositories")
  expect(within(newConversationDraft()).getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  )
  localBranches = ["main"]
  await select("Where the Conversation runs", "Local")
  await waitFor(() =>
    expect(
      within(
        within(newConversationDraft()).getByRole("combobox", { name: "Base branch" }),
      ).getByText("main"),
    ).toBeTruthy(),
  )
  await user.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
    "Fix it{Enter}",
  )
  expect(created).toMatchObject([{ repository: conversation.repository, baseBranch: "main" }])
})

it.each([
  { model: "removed-model", effort: "high", expectedModel: null, expectedEffort: null },
  { model: "sonnet", effort: "unsupported", expectedModel: "sonnet", expectedEffort: null },
])(
  "uses valid defaults for unavailable model or effort: $model / $effort",
  async ({ model, effort, expectedModel, expectedEffort }) => {
    const created: Array<NewConversation> = []

    const user = mount(
      newConversationHandlers(created, [
        new Conversation({ ...conversationFields, harness: "claude-code", model, effort }),
      ]),
      "/conversations/new",
    )

    await within(await screen.findByRole("region", { name: "New Conversation" })).findByRole(
      "button",
      {
        name: `Claude Code: ${expectedModel === null ? "Opus 5.5" : "Sonnet 5.5"}`,
      },
    )
    await user.type(
      within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
      "Fix it{Enter}",
    )
    expect(created).toMatchObject([{ model: expectedModel, effort: expectedEffort }])
  },
)

it("keeps an unlinked Local place blocked and never inherits Sandbox bypass permissions", async () => {
  const sandbox = SandboxPlace.make({ providerId: "fake" })

  const user = mount(
    {
      ...newConversationHandlers(
        [],
        [
          new Conversation({
            ...conversationFields,
            place: sandbox,
            harness: "claude-code",
            permissionMode: "bypassPermissions",
          }),
        ],
      ),
      ListLocalCheckouts: () => Effect.succeed([]),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([conversation.repository]),
      ...branchesAt({ sandbox: { defaultBranch: "main" } }),
    },
    "/conversations/new",
  )

  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "Unsent work")
  expect(within(draft).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  await user.click(
    await within(draft).findByRole("combobox", { name: "Where the Conversation runs" }),
  )
  await user.click(await screen.findByRole("option", { name: "Local" }))
  await waitFor(() =>
    expect(
      within(newConversationDraft()).getByRole("combobox", { name: "Repository" }).textContent,
    ).toContain("No repositories"),
  )
  expect(within(newConversationDraft()).getByRole("textbox", { name: "Message" })).toHaveProperty(
    "textContent",
    "Unsent work",
  )
  expect(within(newConversationDraft()).getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  )
  expect(
    within(
      within(newConversationDraft()).getByRole("combobox", { name: "Permission mode" }),
    ).getByText("Auto"),
  ).toBeTruthy()
})

it("starts a Sandbox Conversation on the default branch, listing other branches only when asked", async () => {
  const created: Array<NewConversation> = []
  const listedModels: Array<string | null> = []
  let listedBranches = 0
  const followed = new FollowedRepository({ owner: "glass-demo", repo: "lamp" })

  const user = mount(
    {
      ...newConversationHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code", "pi"],
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
    "/conversations/new",
  )

  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await user.click(
    await within(draft).findByRole("combobox", { name: "Where the Conversation runs" }),
  )
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))

  await waitFor(() =>
    expect(
      within(
        within(newConversationDraft()).getByRole("combobox", { name: "Base branch" }),
      ).getByText("trunk"),
    ).toBeTruthy(),
  )
  expect(
    within(newConversationDraft()).getByText("The agent works on a branch of its own."),
  ).toBeTruthy()
  expect(
    within(newConversationDraft()).queryByRole("combobox", { name: "Permission mode" }),
  ).toBeNull()
  expect(listedModels).toContain("sandbox:fake")
  expect(listedBranches).toBe(0)

  await user.click(within(newConversationDraft()).getByRole("combobox", { name: "Base branch" }))
  await user.click(await screen.findByRole("option", { name: "release" }))
  expect(listedBranches).toBe(1)

  await user.type(
    within(newConversationDraft()).getByRole("textbox", { name: "Message" }),
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
  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))
})

it("lists every Agent harness's models before one is chosen", async () => {
  const listed: Array<AgentHarness> = []

  mount(
    {
      ...newConversationHandlers([], []),
      ListAgentModels: (payload) => {
        listed.push(payload.harness)

        return listModels(payload)
      },
    },
    "/conversations/new",
  )

  await screen.findByRole("region", { name: "New Conversation" })
  await waitFor(() => expect(listed).toContain("pi"))
  expect(listed).toContain("claude-code")
})

it("offers only the Agent harnesses a Sandbox provider runs", async () => {
  const user = mount(
    {
      ...newConversationHandlers([], []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", harnesses: ["pi"] }),
        ]),
      ListFollowedRepositories: () =>
        Effect.succeed([new FollowedRepository({ owner: "glass-demo", repo: "lamp" })]),
      ...branchesAt({ sandbox: { defaultBranch: "trunk" } }),
    },
    "/conversations/new",
  )

  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await within(draft).findByRole("button", { name: "Claude Code: Opus 5.5" })
  await user.click(
    await within(draft).findByRole("combobox", { name: "Where the Conversation runs" }),
  )
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))

  await user.click(
    await within(newConversationDraft()).findByRole("button", { name: "pi: gpt-test" }),
  )

  const harnesses = within(await screen.findByRole("dialog")).getByRole("group", {
    name: "Agent harness",
  })

  expect(
    within(harnesses)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["pi"])
})

it("starts a Conversation with the last one's harness, model, and effort, in the Default Permission mode", async () => {
  const created: Array<NewConversation> = []

  const last = new Conversation({
    ...conversationFields,
    harness: "claude-code",
    model: "sonnet",
    effort: "high",
    permissionMode: "bypassPermissions",
  })

  const user = mount(newConversationHandlers(created, [last]), "/conversations/new")

  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await within(draft).findByRole("button", { name: "Claude Code: Sonnet 5.5" })
  expect(
    within(within(draft).getByRole("combobox", { name: "Effort" })).getByText("High"),
  ).toBeTruthy()

  await within(draft).findByRole("combobox", { name: "Base branch" })
  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "Fix the bug{Enter}")

  expect(created).toMatchObject([
    { harness: "claude-code", model: "sonnet", effort: "high", permissionMode: null },
  ])
  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))
})

it("offers the chosen Agent harness's own models, and efforts only for models that take one", async () => {
  const created: Array<NewConversation> = []
  const user = mount(newConversationHandlers(created, []), "/conversations/new")

  const draft = await screen.findByRole("region", { name: "New Conversation" })
  await user.click(await within(draft).findByRole("button", { name: "Claude Code: Opus 5.5" }))
  const picker = await screen.findByRole("dialog")
  await user.click(choice(picker, "Agent harness", "pi"))

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
    { harness: "pi", model: "glass-test/thinker", effort: "low", permissionMode: null },
  ])
  await waitFor(() => expect(window.location.hash).toBe(`#/conversations/${conversation.id}`))
})

it("watches a created Conversation's transcript while waiting for it to be listed", async () => {
  const listed = Effect.runSync(SubscriptionRef.make<ReadonlyArray<Conversation>>([]))
  const watched: Array<string> = []

  const registry = testRegistry({
    WatchConversations: () => SubscriptionRef.changes(listed),
    CreateConversation: () => Effect.succeed(conversation),
    WatchTranscript: ({ conversationId }) => {
      watched.push(conversationId)

      return Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null }))
    },
  })

  const release = registry.mount(createConversationAtom)

  try {
    registry.set(createConversationAtom, {
      ...conversationFields,
      message: "Say hello",
      images: [],
    })
    await eventually(() => expect(watched).toEqual([conversation.id]))
    expect(AsyncResult.isSuccess(registry.get(createConversationAtom))).toBe(false)

    Effect.runSync(SubscriptionRef.set(listed, [conversation]))
    expect(
      await Effect.runPromise(
        AtomRegistry.getResult(registry, createConversationAtom, { suspendOnWaiting: true }),
      ),
    ).toEqual(conversation)
  } finally {
    release()
    registry.dispose()
  }
})
