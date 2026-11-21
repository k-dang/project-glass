// @vitest-environment happy-dom
import {
  Thread,
  type AgentHarness,
  AgentModels,
  type ThreadPlace,
  FollowedRepository,
  LocalCheckout,
  LocalSkillsError,
  type NewThread,
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
import { createThreadAtom, placeKey } from "./threadsArea"
import { thread, threadFields } from "../../test/thread"
import { choice, listModels, mount, pixel } from "../../test/threadApp"
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
  GetNewThreadDefaultBranch: ({ place, repository }: PlaceRepository) =>
    Effect.succeed(
      Predicate.isTagged(place, "sandbox") ? sandbox.defaultBranch : local(repository)[0],
    ),
  ListNewThreadBranches: ({ place, repository }: PlaceRepository) =>
    Predicate.isTagged(place, "sandbox")
      ? (sandbox.branches ?? Effect.succeed([sandbox.defaultBranch]))
      : Effect.succeed(local(repository)[1]),
})

interface PlaceRepository {
  readonly place: ThreadPlace
  readonly repository: FollowedRepository
}

const listedOnCreate = (
  created: Array<NewThread>,
  listed: ReadonlyArray<Thread>,
  creating: Effect.Effect<void> = Effect.void,
) => {
  const threads = Effect.runSync(SubscriptionRef.make(listed))

  return {
    WatchThreads: () => SubscriptionRef.changes(threads),
    CreateThread: (input: NewThread) =>
      creating.pipe(
        Effect.andThen(Effect.sync(() => created.push(input))),
        Effect.andThen(SubscriptionRef.update(threads, (all) => [...all, thread])),
        Effect.as(thread),
      ),
  }
}

const newThreadHandlers = (created: Array<NewThread>, threads: ReadonlyArray<Thread>) => ({
  ...listedOnCreate(created, threads),
  ListLocalCheckouts: () =>
    Effect.succeed([new LocalCheckout({ repository: thread.repository, path: "/src/greeter" })]),
  ...branchesAt({}),
  WatchTranscript: () =>
    Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
})

const newThreadDraft = () => screen.getByRole("region", { name: "New Thread" })

const findDraft = () => screen.findByRole("region", { name: "New Thread" })

const send = async (user: ReturnType<typeof mount>, message?: string) => {
  const composer = within(newThreadDraft()).getByRole("textbox", { name: "Message" })

  if (message !== undefined) await user.type(composer, message)

  await waitFor(() =>
    expect(within(newThreadDraft()).getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      false,
    ),
  )
  await user.type(composer, "{Enter}")
}

const baseBranchShows = (branch: string) =>
  waitFor(() =>
    expect(
      within(within(newThreadDraft()).getByRole("combobox", { name: "Base branch" })).getByText(
        branch,
      ),
    ).toBeTruthy(),
  )

it("starts a Thread from its first message, on the repository's default branch", async () => {
  const created: Array<NewThread> = []

  const user = mount(
    {
      ...listedOnCreate(created, []),
      ListLocalCheckouts: () =>
        Effect.succeed([
          new LocalCheckout({ repository: thread.repository, path: "/src/greeter" }),
        ]),
      ...branchesAt({ local: () => ["main", ["develop", "main"]] }),
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/threads/new",
  )

  const draft = await findDraft()
  const base = await within(draft).findByRole("combobox", { name: "Base branch" })
  expect(await within(base).findByText("main")).toBeTruthy()
  const mode = await within(draft).findByRole("combobox", { name: "Permission mode" })
  expect(within(mode).getByText("Auto")).toBeTruthy()
  expect(within(draft).queryByRole("combobox", { name: "Where the Thread runs" })).toBeNull()

  await send(user, "Fix the bug")

  await waitFor(() =>
    expect(created).toEqual([
      {
        repository: thread.repository,
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
    ]),
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
})

it("starts a Thread from a to-do by mentioning it", async () => {
  const created: Array<NewThread> = []

  const toDo = new ToDo({
    id: 7,
    title: "Fix spacing",
    notes: "Looks off",
    done: false,
  })

  const user = mount(
    {
      ...newThreadHandlers(created, []),
      WatchToDos: () => Stream.make([toDo]),
    },
    "/to-dos",
  )

  await user.click(await screen.findByRole("button", { name: "Start a Thread from Fix spacing" }))
  await findDraft()
  await send(user)

  await waitFor(() =>
    expect(created.map(({ message, images }) => ({ message, images }))).toEqual([
      { message: "[Fix spacing](glass://to-do/7)", images: [] },
    ]),
  )
})

it("starts a Thread with the Skill packs picked, and picks the same ones next time", async () => {
  const created: Array<NewThread> = []

  const handlers = {
    ...newThreadHandlers(created, []),
    ListSkillPacks: () =>
      Effect.succeed([pack("docs", "1111111aaaa"), pack("team", "ae5650fbbbb")]),
  }

  const user = mount(handlers, "/threads/new")

  const packs = await within(await findDraft()).findByRole("combobox", { name: "Skill packs" })

  expect(within(packs).getByText("No Skill packs")).toBeTruthy()
  await user.click(packs)
  await user.click(await screen.findByRole("option", { name: "team" }))
  await user.keyboard("{Escape}")
  expect(within(packs).getByText("team")).toBeTruthy()
  await send(user, "One")
  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))

  cleanup()
  const again = mount(handlers, "/threads/new")

  const remembered = await within(await findDraft()).findByRole("combobox", { name: "Skill packs" })

  expect(within(remembered).getByText("team")).toBeTruthy()
  await send(again, "Two")

  await waitFor(() =>
    expect(created.map(({ skillPacks }) => skillPacks)).toEqual([["team"], ["team"]]),
  )
})

it("waits for the Skill packs to load before starting a Thread with the remembered ones", async () => {
  const created: Array<NewThread> = []
  const listed = Deferred.makeUnsafe<void>()
  localStorage.setItem("glass.newConversation.skillPacks", JSON.stringify(["team"]))

  const user = mount(
    {
      ...newThreadHandlers(created, []),
      ListSkillPacks: () => Deferred.await(listed).pipe(Effect.as([pack("team", "ae5650fbbbb")])),
    },
    "/threads/new",
  )

  const message = await within(await findDraft()).findByRole("textbox", { name: "Message" })

  await user.type(message, "Go{Enter}")
  Deferred.doneUnsafe(listed, Exit.void)
  await send(user)

  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
  expect(created.map(({ skillPacks }) => skillPacks)).toEqual([["team"]])
})

it("gives a Sandbox Thread the Local skills when picked, warning which skill names its sources share", async () => {
  const created: Array<NewThread> = []
  localStorage.setItem("glass.newConversation.skillPacks", JSON.stringify(["team"]))

  const handlers = {
    ...newThreadHandlers(created, []),
    ListSandboxProviders: () =>
      Effect.succeed([
        new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", harnesses: ["claude-code"] }),
      ]),
    ListSkillPacks: () =>
      Effect.succeed([pack("team", "ae5650fbbbb", ["architect", "grilling", "tdd"])]),
    ListFollowedRepositories: () => Effect.succeed([thread.repository]),
    ListLocalSkills: () => Effect.succeed(["grilling", "notes", "tdd"]),
  }

  const user = mount(handlers, "/threads/new")
  const draft = await findDraft()
  await within(draft).findByRole("combobox", { name: "Skill packs" })
  expect(within(draft).queryByRole("checkbox", { name: "Local skills" })).toBeNull()

  await user.click(await within(draft).findByRole("combobox", { name: "Where the Thread runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))

  const localSkills = await within(await findDraft()).findByRole("checkbox", {
    name: "Local skills",
  })

  expect(within(newThreadDraft()).queryByRole("list", { name: "Shared skill names" })).toBeNull()

  await user.click(localSkills)

  const shared = await within(await findDraft()).findByRole("list", {
    name: "Shared skill names",
  })

  expect(
    within(shared)
      .getAllByRole("listitem")
      .map(({ textContent }) => textContent),
  ).toEqual([
    "grilling is in Local skills and team. The Thread has each, as /local:grilling and /team:grilling.",
    "tdd is in Local skills and team. The Thread has each, as /local:tdd and /team:tdd.",
  ])

  await send(user, "Fix the bug")
  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
  expect(created).toMatchObject([{ skillPacks: ["team"], localSkills: true }])

  cleanup()
  mount(handlers, "/threads/new")
  const again = await findDraft()
  await user.click(await within(again).findByRole("combobox", { name: "Where the Thread runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))
  expect(
    (await within(await findDraft()).findByRole("checkbox", { name: "Local skills" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true")
})

it("warns a local Thread which skill names its Skill packs share with the Local skills", async () => {
  localStorage.setItem("glass.newConversation.skillPacks", JSON.stringify(["team"]))

  mount(
    {
      ...newThreadHandlers([], []),
      ListSkillPacks: () =>
        Effect.succeed([pack("team", "ae5650fbbbb", ["architect", "grilling"])]),
      ListLocalSkills: () => Effect.succeed(["grilling", "notes"]),
    },
    "/threads/new",
  )

  const shared = await within(await findDraft()).findByRole("list", { name: "Shared skill names" })

  expect(within(newThreadDraft()).queryByRole("checkbox", { name: "Local skills" })).toBeNull()
  expect(within(shared).getByRole("listitem").textContent).toBe(
    "grilling is in Local skills and team. The Thread has each, as /grilling and /team:grilling.",
  )
})

it("shows when the Local skills can't be read, and still starts the Sandbox Thread", async () => {
  const created: Array<NewThread> = []
  localStorage.setItem("glass.newConversation.localSkills", "true")
  localStorage.setItem("glass.newConversation.skillPacks", JSON.stringify(["team"]))

  const user = mount(
    {
      ...newThreadHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([thread.repository]),
      ListSkillPacks: () => Effect.succeed([pack("team", "ae5650fbbbb", ["architect"])]),
      ListLocalSkills: () =>
        Effect.fail(new LocalSkillsError({ message: "Glass couldn't read your Local skills." })),
    },
    "/threads/new",
  )

  const draft = await findDraft()
  await user.click(await within(draft).findByRole("combobox", { name: "Where the Thread runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))
  expect(await within(await findDraft()).findByText("Couldn't read your Local skills")).toBeTruthy()

  await send(user, "Fix the bug")
  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
  expect(created).toMatchObject([{ skillPacks: ["team"], localSkills: true }])
})

it("shows the first message at once while the Thread starts", async () => {
  const started = Deferred.makeUnsafe<void>()

  const user = mount(
    {
      ...listedOnCreate([], [], Deferred.await(started)),
      ListLocalCheckouts: () =>
        Effect.succeed([
          new LocalCheckout({ repository: thread.repository, path: "/src/greeter" }),
        ]),
      ...branchesAt({}),
      WatchTranscript: () =>
        Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null })),
    },
    "/threads/new",
  )

  const draft = await findDraft()
  const composer = within(draft).getByRole("textbox", { name: "Message" })
  await send(user, "Fix the bug")

  expect(within(draft).getByText("Fix the bug")).toBeTruthy()
  expect(
    within(draft).getByText(/Making the Thread's copy of glass-demo\/greeter from main/),
  ).toBeTruthy()
  expect(composer).toHaveProperty("textContent", "")

  Deferred.doneUnsafe(started, Exit.void)
  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
})

it("keeps local branch, harness, model, effort, and unsent work when exploring a Sandbox", async () => {
  const created: Array<NewThread> = []

  const user = mount(
    {
      ...newThreadHandlers(created, []),
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
      ListFollowedRepositories: () => Effect.succeed([thread.repository]),
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
    "/threads/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(await within(await findDraft()).findByRole("combobox", { name }))
    await user.click(await screen.findByRole("option", { name: option }))
  }

  await baseBranchShows("main")
  await select("Base branch", "develop")
  await user.click(
    await within(await findDraft()).findByRole("button", { name: "Claude Code: Opus 5.5" }),
  )
  await user.click(choice(await screen.findByRole("dialog"), "Agent harness", "pi"))
  await within(await findDraft()).findByRole("button", { name: "pi: gpt-test" })
  await user.click(choice(await screen.findByRole("dialog"), "Model", "Thinker"))
  await select("Effort", "High")
  await user.type(
    within(newThreadDraft()).getByRole("textbox", { name: "Message" }),
    "Keep my choices",
  )
  const clipboard = new DataTransfer()
  clipboard.items.add(
    new File([Uint8Array.from(atob(pixel.data), (c) => c.charCodeAt(0))], "pixel.png", {
      type: "image/png",
    }),
  )
  await user.paste(clipboard)
  await within(await findDraft()).findByRole("img", { name: "Attachment 1" })

  await select("Where the Thread runs", "Fake Sandboxes")
  await within(await findDraft()).findByRole("button", { name: "Claude Code: Remote model" })
  expect(
    await within(
      within(newThreadDraft()).getByRole("combobox", { name: "Base branch" }),
    ).findByText("trunk"),
  ).toBeTruthy()
  expect(within(newThreadDraft()).queryByRole("combobox", { name: "Effort" })).toBeNull()
  expect(within(newThreadDraft()).queryByRole("combobox", { name: "Permission mode" })).toBeNull()

  await select("Where the Thread runs", "Local")
  await within(await findDraft()).findByRole("button", { name: "pi: Thinker" })
  expect(
    within(within(newThreadDraft()).getByRole("combobox", { name: "Effort" })).getByText("High"),
  ).toBeTruthy()
  await baseBranchShows("develop")
  expect(within(newThreadDraft()).getByRole("textbox", { name: "Message" })).toHaveProperty(
    "textContent",
    "Keep my choices",
  )
  await send(user)
  await waitFor(() =>
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
    ]),
  )
})

it("restores each harness's choices and keeps local Permission mode separate from a Sandbox", async () => {
  const created: Array<NewThread> = []

  const user = mount(
    {
      ...newThreadHandlers(created, []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.succeed([thread.repository]),
      ...branchesAt({ sandbox: { defaultBranch: "main" } }),
    },
    "/threads/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(await within(await findDraft()).findByRole("combobox", { name }))
    await user.click(await screen.findByRole("option", { name: option }))
  }

  await user.click(
    await within(await findDraft()).findByRole("button", {
      name: "Claude Code: Opus 5.5",
    }),
  )
  await user.click(choice(await screen.findByRole("dialog"), "Model", "Sonnet 5.5"))
  await select("Effort", "High")
  await select("Permission mode", "Accept edits")
  await user.click(
    within(newThreadDraft()).getByRole("button", { name: "Claude Code: Sonnet 5.5" }),
  )
  await user.click(choice(await screen.findByRole("dialog"), "Agent harness", "pi"))
  await within(await findDraft()).findByRole("button", { name: "pi: gpt-test" })
  expect(within(newThreadDraft()).queryByRole("combobox", { name: "Effort" })).toBeNull()
  await user.click(choice(await screen.findByRole("dialog"), "Agent harness", "Claude Code"))
  await user.keyboard("{Escape}")
  await within(await findDraft()).findByRole("button", { name: "Claude Code: Sonnet 5.5" })
  await select("Where the Thread runs", "Fake Sandboxes")
  await within(await findDraft()).findByRole("button", {
    name: "Claude Code: Opus 5.5",
  })
  expect(within(newThreadDraft()).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  await select("Where the Thread runs", "Local")
  await within(await findDraft()).findByRole("button", {
    name: "Claude Code: Sonnet 5.5",
  })
  expect(
    within(within(newThreadDraft()).getByRole("combobox", { name: "Permission mode" })).getByText(
      "Accept edits",
    ),
  ).toBeTruthy()
  await send(user, "Fix it")
  await waitFor(() =>
    expect(created).toMatchObject([
      { harness: "claude-code", model: "sonnet", effort: "high", permissionMode: "acceptEdits" },
    ]),
  )
})

it("keeps branches per repository and falls back when a remembered branch disappears", async () => {
  const other = new FollowedRepository({ owner: "glass-demo", repo: "lamp" })
  let localBranches = ["main", "develop"]
  const created: Array<NewThread> = []

  const user = mount(
    {
      ...newThreadHandlers(created, []),
      ListLocalCheckouts: () =>
        Effect.succeed(
          [thread.repository, other].map(
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
    "/threads/new",
  )

  const select = async (name: string, option: string) => {
    await user.click(await within(await findDraft()).findByRole("combobox", { name }))
    await user.click(await screen.findByRole("option", { name: option }))
  }

  await baseBranchShows("main")
  await select("Base branch", "develop")
  await select("Repository", "glass-demo/lamp")
  await baseBranchShows("trunk")
  await select("Repository", "glass-demo/greeter")
  await baseBranchShows("develop")
  await select("Where the Thread runs", "Fake Sandboxes")
  await waitFor(() =>
    expect(
      within(newThreadDraft()).getByRole("combobox", { name: "Repository" }).textContent,
    ).toContain("No repositories"),
  )
  expect(within(newThreadDraft()).getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  )
  localBranches = ["main"]
  await select("Where the Thread runs", "Local")
  await baseBranchShows("main")
  await send(user, "Fix it")
  await waitFor(() =>
    expect(created).toMatchObject([{ repository: thread.repository, baseBranch: "main" }]),
  )
})

it.each([
  { model: "removed-model", effort: "high", expectedModel: null, expectedEffort: null },
  { model: "sonnet", effort: "unsupported", expectedModel: "sonnet", expectedEffort: null },
])(
  "uses valid defaults for unavailable model or effort: $model / $effort",
  async ({ model, effort, expectedModel, expectedEffort }) => {
    const created: Array<NewThread> = []

    const user = mount(
      newThreadHandlers(created, [
        new Thread({ ...threadFields, harness: "claude-code", model, effort }),
      ]),
      "/threads/new",
    )

    await within(await findDraft()).findByRole("button", {
      name: `Claude Code: ${expectedModel === null ? "Opus 5.5" : "Sonnet 5.5"}`,
    })
    await send(user, "Fix it")
    await waitFor(() =>
      expect(created).toMatchObject([{ model: expectedModel, effort: expectedEffort }]),
    )
  },
)

it("keeps an unlinked Local place blocked and never inherits Sandbox bypass permissions", async () => {
  const sandbox = SandboxPlace.make({ providerId: "fake" })

  const user = mount(
    {
      ...newThreadHandlers(
        [],
        [
          new Thread({
            ...threadFields,
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
      ListFollowedRepositories: () => Effect.succeed([thread.repository]),
      ...branchesAt({ sandbox: { defaultBranch: "main" } }),
    },
    "/threads/new",
  )

  const where = await screen.findByRole("combobox", { name: "Where the Thread runs" })
  const draft = newThreadDraft()
  await user.type(within(draft).getByRole("textbox", { name: "Message" }), "Unsent work")
  expect(within(draft).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  await user.click(where)
  await user.click(await screen.findByRole("option", { name: "Local" }))
  await waitFor(() =>
    expect(
      within(newThreadDraft()).getByRole("combobox", { name: "Repository" }).textContent,
    ).toContain("No repositories"),
  )
  expect(within(newThreadDraft()).getByRole("textbox", { name: "Message" })).toHaveProperty(
    "textContent",
    "Unsent work",
  )
  expect(within(newThreadDraft()).getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  )
  expect(
    within(within(newThreadDraft()).getByRole("combobox", { name: "Permission mode" })).getByText(
      "Auto",
    ),
  ).toBeTruthy()
})

it("starts a Sandbox Thread on the default branch, listing other branches only when asked", async () => {
  const created: Array<NewThread> = []
  const listedModels: Array<string | null> = []
  let listedBranches = 0
  const followed = new FollowedRepository({ owner: "glass-demo", repo: "lamp" })

  const user = mount(
    {
      ...newThreadHandlers(created, []),
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
    "/threads/new",
  )

  const draft = await findDraft()
  await user.click(await within(draft).findByRole("combobox", { name: "Where the Thread runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))

  await baseBranchShows("trunk")
  expect(within(newThreadDraft()).getByText("The agent works on a branch of its own.")).toBeTruthy()
  expect(within(newThreadDraft()).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  expect(listedModels).toContain("sandbox:fake")
  expect(listedBranches).toBe(0)

  await user.click(within(newThreadDraft()).getByRole("combobox", { name: "Base branch" }))
  await user.click(await screen.findByRole("option", { name: "release" }))
  expect(listedBranches).toBe(1)

  await send(user, "Fix the bug")

  await waitFor(() =>
    expect(created).toMatchObject([
      {
        repository: followed,
        baseBranch: "release",
        place: SandboxPlace.make({ providerId: "fake" }),
        permissionMode: null,
      },
    ]),
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
})

it("lists every Agent harness's models before one is chosen", async () => {
  const listed: Array<AgentHarness> = []

  mount(
    {
      ...newThreadHandlers([], []),
      ListAgentModels: (payload) => {
        listed.push(payload.harness)

        return listModels(payload)
      },
    },
    "/threads/new",
  )

  await findDraft()
  await waitFor(() => expect(listed).toContain("pi"))
  expect(listed).toContain("claude-code")
})

it("offers only the Agent harnesses a Sandbox provider runs", async () => {
  const user = mount(
    {
      ...newThreadHandlers([], []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({ id: "fake", name: "Fake Sandboxes", harnesses: ["pi"] }),
        ]),
      ListFollowedRepositories: () =>
        Effect.succeed([new FollowedRepository({ owner: "glass-demo", repo: "lamp" })]),
      ...branchesAt({ sandbox: { defaultBranch: "trunk" } }),
    },
    "/threads/new",
  )

  const draft = await findDraft()
  await within(draft).findByRole("button", { name: "Claude Code: Opus 5.5" })
  await user.click(await within(draft).findByRole("combobox", { name: "Where the Thread runs" }))
  await user.click(await screen.findByRole("option", { name: "Fake Sandboxes" }))

  await user.click(await within(await findDraft()).findByRole("button", { name: "pi: gpt-test" }))

  const harnesses = within(await screen.findByRole("dialog")).getByRole("group", {
    name: "Agent harness",
  })

  expect(
    within(harnesses)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["pi"])
})

it("starts a Thread with the last one's harness, model, and effort, in the Default Permission mode", async () => {
  const created: Array<NewThread> = []

  const last = new Thread({
    ...threadFields,
    harness: "claude-code",
    model: "sonnet",
    effort: "high",
    permissionMode: "bypassPermissions",
  })

  const user = mount(newThreadHandlers(created, [last]), "/threads/new")

  const draft = await findDraft()
  await within(draft).findByRole("button", { name: "Claude Code: Sonnet 5.5" })
  expect(
    within(within(draft).getByRole("combobox", { name: "Effort" })).getByText("High"),
  ).toBeTruthy()

  await send(user, "Fix the bug")

  await waitFor(() =>
    expect(created).toMatchObject([
      { harness: "claude-code", model: "sonnet", effort: "high", permissionMode: null },
    ]),
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
})

it("offers the chosen Agent harness's own models, and efforts only for models that take one", async () => {
  const created: Array<NewThread> = []
  const user = mount(newThreadHandlers(created, []), "/threads/new")

  const draft = await findDraft()
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

  await send(user, "Fix the bug")

  await waitFor(() =>
    expect(created).toMatchObject([
      { harness: "pi", model: "glass-test/thinker", effort: "low", permissionMode: null },
    ]),
  )
  await waitFor(() => expect(window.location.hash).toBe(`#/threads/${thread.id}`))
})

it("watches a created Thread's transcript while waiting for it to be listed", async () => {
  const listed = Effect.runSync(SubscriptionRef.make<ReadonlyArray<Thread>>([]))
  const watched: Array<string> = []

  const registry = testRegistry({
    WatchThreads: () => SubscriptionRef.changes(listed),
    CreateThread: () => Effect.succeed(thread),
    WatchTranscript: ({ threadId }) => {
      watched.push(threadId)

      return Stream.make(TranscriptSnapshot.make({ turns: [], queued: [], status: null }))
    },
  })

  const release = registry.mount(createThreadAtom)

  try {
    registry.set(createThreadAtom, {
      ...threadFields,
      message: "Say hello",
      images: [],
    })
    await eventually(() => expect(watched).toEqual([thread.id]))
    expect(AsyncResult.isSuccess(registry.get(createThreadAtom))).toBe(false)

    Effect.runSync(SubscriptionRef.set(listed, [thread]))
    expect(
      await Effect.runPromise(
        AtomRegistry.getResult(registry, createThreadAtom, { suspendOnWaiting: true }),
      ),
    ).toEqual(thread)
  } finally {
    release()
    registry.dispose()
  }
})

it("opens on the last Thread's Sandbox when Sandbox providers and Threads load after the checkouts", async () => {
  const loaded = Deferred.makeUnsafe<void>()
  const modelPlaces: Array<string> = []
  let listedCheckouts = false

  mount(
    {
      ...newThreadHandlers([], []),
      ListLocalCheckouts: () =>
        Effect.sync(() => {
          listedCheckouts = true

          return [new LocalCheckout({ repository: thread.repository, path: "/src/greeter" })]
        }),
      WatchThreads: () =>
        Stream.fromEffect(
          Deferred.await(loaded).pipe(
            Effect.as([
              new Thread({ ...threadFields, place: SandboxPlace.make({ providerId: "fake" }) }),
            ]),
          ),
        ),
      ListSandboxProviders: () =>
        Deferred.await(loaded).pipe(
          Effect.as([
            new SandboxProviderInfo({
              id: "fake",
              name: "Fake Sandboxes",
              harnesses: ["claude-code"],
            }),
          ]),
        ),
      ListFollowedRepositories: () => Effect.succeed([thread.repository]),
      ListAgentModels: (payload) => {
        modelPlaces.push(placeKey(payload.place))

        return listModels(payload)
      },
    },
    "/threads/new",
  )

  await eventually(() => expect(listedCheckouts).toBe(true))
  Deferred.doneUnsafe(loaded, Exit.void)

  const draft = await findDraft()
  const where = within(draft).getByRole("combobox", { name: "Where the Thread runs" })
  expect(within(where).getByText("Fake Sandboxes")).toBeTruthy()
  expect(within(draft).queryByRole("combobox", { name: "Permission mode" })).toBeNull()
  expect(modelPlaces).not.toContain(placeKey(localPlace))
})

it("keeps the New Thread region on screen when first switching to a Sandbox", async () => {
  const user = mount(
    {
      ...newThreadHandlers([], []),
      ListSandboxProviders: () =>
        Effect.succeed([
          new SandboxProviderInfo({
            id: "fake",
            name: "Fake Sandboxes",
            harnesses: ["claude-code"],
          }),
        ]),
      ListFollowedRepositories: () => Effect.yieldNow.pipe(Effect.as([thread.repository])),
      ...branchesAt({ sandbox: { defaultBranch: "trunk" } }),
    },
    "/threads/new",
  )

  const draft = await findDraft()
  await user.click(await within(draft).findByRole("combobox", { name: "Where the Thread runs" }))
  const sandbox = await screen.findByRole("option", { name: "Fake Sandboxes" })
  let vanished = false

  const observer = new MutationObserver(() => {
    if (screen.queryByRole("region", { name: "New Thread" }) === null) vanished = true
  })

  observer.observe(document.body, { childList: true, subtree: true })
  await user.click(sandbox)

  await waitFor(() =>
    expect(
      within(
        within(newThreadDraft()).getByRole("combobox", { name: "Where the Thread runs" }),
      ).getByText("Fake Sandboxes"),
    ).toBeTruthy(),
  )
  observer.disconnect()
  expect(vanished).toBe(false)
})
