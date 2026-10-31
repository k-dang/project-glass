// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  ActivityPage,
  GitHubConnection,
  RepositoryFiles,
  FileTooLarge,
  PullRequest,
  PullRequestRef,
  PullRequestWorkspace,
  Revision,
  type ResumableDestination,
  SavedPlace,
  SavedPlaceError,
  type TourState,
  noListings,
} from "@glass/contracts"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect, Option, Stream } from "effect"
import { AsyncResult } from "effect/reactivity"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { rememberPlace, savedDestinationsAtom } from "./savedPlace"
import { agent } from "../../test/agent"
import {
  type Handlers,
  type Held,
  hold,
  next,
  testLayer,
  testRegistry,
} from "../../test/testBackend"
import {
  changedFile,
  pullRequestFields,
  savedTour,
  tourChapter,
  workspace,
} from "../../test/workspace"

const pr = workspace([], {
  files: [changedFile("first.ts"), changedFile("second.ts"), changedFile("third.ts")],
})

const destination: ResumableDestination = {
  area: "reviews",
  login: pr.viewer.login,
  pullRequest: pr.pullRequest.ref,
  revision: pr.revision,
  position: { tab: "changes", file: "second.ts", order: "path" },
}

const savedPlace = (value: ResumableDestination = destination) =>
  new SavedPlace({
    destination: value,
    savedAt: DateTime.makeUnsafe("2026-10-25T18:30:00Z"),
  })

const mount = (handlers: Partial<Handlers>) => {
  window.history.replaceState(null, "", "#/dashboard")

  render(
    <RegistryProvider
      initialValues={[
        [
          backendLayerAtom,
          testLayer({
            GetConnection: () =>
              Effect.succeed(new GitHubConnection({ login: pr.viewer.login, tokenSource: "gh" })),
            ListFollowedRepositories: () => Effect.succeed([]),
            ListPullRequests: () => Effect.succeed(noListings),
            ListActivity: () =>
              Effect.succeed(new ActivityPage({ activities: [], hasMore: false })),
            GetSavedPlaces: () => Effect.succeed([savedPlace()]),
            OpenPullRequest: () => Effect.succeed(pr),
            HasPullRequestChanged: () => Effect.succeed(false),
            RecordActivity: () => Effect.void,
            ...handlers,
          }),
        ],
      ]}
    >
      <App />
    </RegistryProvider>,
  )

  return userEvent.setup()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "#/")
})

it("continues from Dashboard after visiting Settings and Activity, without saving those areas", async () => {
  const writes: Array<ResumableDestination> = []

  const user = mount({
    SavePlace: ({ destination: value }) => {
      writes.push(value)

      return Effect.succeed(savedPlace(value))
    },
    GetEngineSettings: () =>
      Effect.succeed({
        engine: "claude-code",
        models: {
          "claude-code": "claude",
          pi: { provider: "test", modelId: "test" },
        },
      }),
  })

  await screen.findByRole("link", { name: "Continue octo-org/hello-world#42" })
  expect(screen.getByRole("main", { name: "Dashboard" }).textContent).toContain("second.ts")
  expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page")
  await user.click(screen.getByRole("link", { name: "Settings" }))
  await screen.findByRole("main", { name: "Settings" })
  expect(screen.queryByRole("link", { name: /^Continue / })).toBeNull()
  await user.click(screen.getByRole("link", { name: "Activity" }))
  await screen.findByText("No Activity yet")
  expect(screen.queryByRole("link", { name: /^Continue / })).toBeNull()
  expect(writes).toEqual([])

  await user.click(screen.getByRole("link", { name: "Dashboard" }))
  await user.click(await screen.findByRole("link", { name: /^Continue / }))
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true"),
  )
  await waitFor(() =>
    expect(
      writes.some(
        (value) =>
          value.area === "reviews" &&
          value.position.tab === "changes" &&
          value.position.file === "second.ts",
      ),
    ).toBe(true),
  )
  expect(screen.queryByRole("link", { name: /^Continue / })).toBeNull()

  await user.click(screen.getByRole("link", { name: "Activity" }))
  const count = writes.length
  await screen.findByText("No Activity yet")
  await user.click(screen.getByRole("link", { name: "Dashboard" }))
  await screen.findByRole("link", { name: "Continue octo-org/hello-world#42" })
  expect(writes).toHaveLength(count)
})

it("continues the last PR alongside the last Agent opened after it", async () => {
  mount({
    GetSavedPlaces: () =>
      Effect.succeed([savedPlace({ area: "agents", agentId: agent.id }), savedPlace()]),
    WatchAgents: () => Stream.make([agent]),
  })

  await screen.findByRole("link", { name: "Continue agent/swift-otter" })
  expect(
    screen
      .getAllByRole("link", { name: /^Continue / })
      .map((link) => link.getAttribute("aria-label")),
  ).toEqual(["Continue octo-org/hello-world#42", "Continue agent/swift-otter"])
})

it("invites the user into each area without a Saved place, without creating one", async () => {
  const save = vi.fn<Handlers["SavePlace"]>(({ destination: value }) =>
    Effect.succeed(savedPlace(value)),
  )

  const user = mount({ GetSavedPlaces: () => Effect.succeed([]), SavePlace: save })

  await screen.findByRole("link", { name: "Start an Agent", description: "No Agent yet" })
  await user.click(
    screen.getByRole("link", { name: "Browse pull requests", description: "No pull request yet" }),
  )
  await screen.findByRole("heading", { name: "Reviews" })
  expect(save).not.toHaveBeenCalled()
})

it("selects and reveals the restored repository file when the tree finishes loading", async () => {
  const listings: Array<
    Held<{ pullRequest: PullRequestRef; revision: Revision }, RepositoryFiles, never>
  > = []

  const path = "src/components/Review.tsx"

  const user = mount({
    GetSavedPlaces: () =>
      Effect.succeed([savedPlace({ ...destination, position: { tab: "files", file: path } })]),
    ListRepositoryFiles: hold(listings),
    GetFileContents: () => Effect.succeed(FileTooLarge.make({})),
  })

  await user.click(await screen.findByRole("link", { name: /^Continue / }))
  await screen.findByText("File too large to show")
  await screen.findByText("Loading files…")
  expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true")

  const listing = await next(listings)
  await act(async () =>
    listing.answer(
      Effect.succeed(
        new RepositoryFiles({
          paths: ["README.md", "src/index.ts", "src/components/Panel.tsx", path, "other/hidden.ts"],
          truncated: false,
        }),
      ),
    ),
  )

  const tree = await waitFor(() => {
    const element = screen
      .getByRole("tabpanel", { name: "Files" })
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelector<HTMLElement>('[role="tree"]')

    if (element == null) throw new Error("Repository file tree hasn't rendered")

    return element
  })

  await within(tree).findByRole("treeitem", { name: "Review.tsx", selected: true })
  expect(within(tree).getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded")).toBe(
    "true",
  )
  expect(
    within(tree).getByRole("treeitem", { name: "components" }).getAttribute("aria-expanded"),
  ).toBe("true")
  expect(within(tree).getByRole("treeitem", { name: "other" }).getAttribute("aria-expanded")).toBe(
    "false",
  )
})

const mockTourGeometry = () =>
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("aria-label") === "Tour Chapters") return new DOMRect(0, 0, 1000, 800)

    if (
      this.tagName === "SECTION" &&
      this.parentElement?.getAttribute("aria-label") === "Tour Chapters"
    ) {
      const index = Array.from(this.parentElement.children).indexOf(this)

      return new DOMRect(0, index * 900 - this.parentElement.scrollTop, 1000, 850)
    }

    return this.classList.contains("overflow-auto") ? new DOMRect(0, 0, 1000, 800) : new DOMRect()
  })

it("restores a later Chapter and file when the saved Tour arrives after the workspace", async () => {
  mockTourGeometry()

  const watches: Array<Held<{ pullRequest: PullRequestRef }, TourState, never>> = []
  const writes: Array<ResumableDestination> = []

  const resumed: ResumableDestination = {
    ...destination,
    position: { tab: "changes", file: "third.ts", order: "tour" },
  }

  const user = mount({
    GetSavedPlaces: () => Effect.succeed([savedPlace(resumed)]),
    WatchTour: (payload) => Stream.fromEffect(hold(watches)(payload)),
    SavePlace: ({ destination: value }) => {
      writes.push(value)

      return Effect.succeed(savedPlace(value))
    },
  })

  await user.click(await screen.findByRole("link", { name: /^Continue / }))
  const watch = await next(watches)
  await screen.findByRole("tabpanel", { name: "Changes" })
  expect(screen.queryByLabelText("Tour Chapters")).toBeNull()

  await act(async () =>
    watch.answer(
      Effect.succeed({
        tour: savedTour([
          tourChapter("First Chapter", ["first.ts"]),
          tourChapter("Later Chapter", ["second.ts", "third.ts"]),
        ]),
        job: { status: "idle" },
      }),
    ),
  )

  const tour = await screen.findByLabelText("Tour Chapters")
  const later = within(tour).getByRole("region", { name: "Later Chapter" })
  const navigation = within(later).getByRole("navigation", { name: "Files in Later Chapter" })
  await waitFor(() => expect(tour.scrollTop).toBe(880))
  expect(
    within(navigation)
      .getByRole("button", { name: /third.ts/ })
      .getAttribute("aria-current"),
  ).toBe("location")
  fireEvent.scroll(tour)
  expect(writes.length).toBeGreaterThan(0)
  expect(
    writes.every(
      (value) =>
        value.area === "reviews" &&
        value.position.tab === "changes" &&
        value.position.file === "third.ts",
    ),
  ).toBe(true)
})

it("keeps tracking the Tour after Reload removes the selected file", async () => {
  mockTourGeometry()

  const writes: Array<ResumableDestination> = []

  const refreshed = new PullRequestWorkspace({
    viewer: pr.viewer,
    pullRequest: pr.pullRequest,
    revision: new Revision({ base: "b0", head: "h2" }),
    updatedAt: pr.updatedAt,
    files: pr.files.filter(({ path }) => path !== "third.ts"),
    viewedPaths: [],
    discussions: pr.discussions,
    drafts: [],
  })

  let opens = 0

  const user = mount({
    GetSavedPlaces: () =>
      Effect.succeed([
        savedPlace({
          ...destination,
          position: { tab: "changes", file: "third.ts", order: "tour" },
        }),
      ]),
    OpenPullRequest: () => Effect.succeed(opens++ === 0 ? pr : refreshed),
    WatchTour: () =>
      Stream.make({
        tour: savedTour([
          tourChapter("First Chapter", ["first.ts"]),
          tourChapter("Later Chapter", ["second.ts", "third.ts"]),
        ]),
        job: { status: "idle" },
      }),
    SavePlace: ({ destination: value }) => {
      writes.push(value)

      return Effect.succeed(savedPlace(value))
    },
  })

  await user.click(await screen.findByRole("link", { name: /^Continue / }))
  const initial = await screen.findByLabelText("Tour Chapters")
  await waitFor(() => expect(initial.scrollTop).toBe(880))
  await user.click(screen.getByRole("button", { name: "Reload" }))
  await waitFor(() => expect(screen.getByLabelText("Tour Chapters")).not.toBe(initial))

  const tour = screen.getByLabelText("Tour Chapters")
  expect(within(tour).queryByRole("button", { name: /third.ts/ })).toBeNull()
  expect(within(tour).queryByRole("region", { name: "Everything else" })).toBeNull()
  tour.scrollTop = 900
  fireEvent.scroll(tour)

  await waitFor(() =>
    expect(writes.at(-1)).toMatchObject({
      revision: refreshed.revision,
      position: { tab: "changes", file: "second.ts", order: "tour" },
    }),
  )
})

it("continues the newest work even while an older destination is still saving", async () => {
  const calls: Array<Held<{ destination: ResumableDestination }, SavedPlace, never>> = []

  const other = new PullRequestWorkspace({
    viewer: pr.viewer,
    pullRequest: new PullRequest({
      ...pullRequestFields,
      ref: new PullRequestRef({ owner: "octo-org", repo: "hello-world", number: 43 }),
      url: "https://github.com/octo-org/hello-world/pull/43",
      title: "Another piece of work",
    }),
    revision: pr.revision,
    updatedAt: pr.updatedAt,
    files: pr.files,
    viewedPaths: [],
    discussions: pr.discussions,
    drafts: [],
  })

  const user = mount({
    SavePlace: hold(calls),
    OpenPullRequest: ({ pullRequest }) => Effect.succeed(pullRequest.number === 43 ? other : pr),
  })

  await user.click(await screen.findByRole("link", { name: /^Continue / }))
  const first = await next(calls)
  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  await user.type(await screen.findByRole("textbox", { name: "Open a PR" }), other.pullRequest.url)
  await user.keyboard("{Enter}")
  await screen.findByRole("heading", { name: "Another piece of work #43" })
  await user.click(screen.getByRole("link", { name: "Dashboard" }))
  await screen.findByRole("link", { name: "Continue octo-org/hello-world#43" })
  expect(screen.queryByRole("link", { name: "Continue octo-org/hello-world#42" })).toBeNull()

  first.answer(Effect.succeed(savedPlace(first.payload.destination)))
  const second = await next(calls)
  expect(second.payload.destination).toMatchObject({ pullRequest: { number: 43 } })
  await user.click(screen.getByRole("link", { name: "Continue octo-org/hello-world#43" }))
  await screen.findByRole("heading", { name: "Another piece of work #43" })
  second.answer(Effect.succeed(savedPlace(second.payload.destination)))
})

it("opens Overview with an explanation when the saved Revision changed", async () => {
  const user = mount({
    GetSavedPlaces: () =>
      Effect.succeed([savedPlace({ ...destination, revision: { base: "b0", head: "old" } })]),
  })

  await user.click(await screen.findByRole("link", { name: /^Continue / }))
  await screen.findByText(
    "This PR changed since you last read it. Opened Overview at its current Revision.",
  )
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true")
})

it("doesn't offer another GitHub identity's saved destination", async () => {
  mount({
    GetSavedPlaces: () => Effect.succeed([savedPlace({ ...destination, login: "someone-else" })]),
  })

  await screen.findByRole("link", {
    name: "Browse pull requests",
    description: "No saved review for this account",
  })
  expect(screen.queryByRole("link", { name: /^Continue / })).toBeNull()
})

it("keeps Changes usable when the saved file is no longer in its diff", async () => {
  const user = mount({
    GetSavedPlaces: () =>
      Effect.succeed([
        savedPlace({
          ...destination,
          position: { tab: "changes", file: "missing.ts", order: "path" },
        }),
      ]),
  })

  await user.click(await screen.findByRole("link", { name: /^Continue / }))
  await screen.findByText("The saved file isn't in this diff. Opened Changes from the start.")
  expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
})

it("lets the user retry a failed saved-place read", async () => {
  let reads = 0

  const user = mount({
    GetSavedPlaces: () => {
      reads++

      return reads === 1
        ? Effect.fail(
            new SavedPlaceError({ message: "Couldn't read your saved place. Try again." }),
          )
        : Effect.succeed([savedPlace()])
    },
  })

  await screen.findByText("Couldn't remember your place")
  await user.click(screen.getByRole("button", { name: "Retry" }))
  await screen.findByRole("link", { name: /^Continue / })
  expect(reads).toBe(2)
})

it("reports a failed position save and retries without interrupting the review", async () => {
  let writes = 0

  const user = mount({
    SavePlace: ({ destination: value }) => {
      writes++

      return writes === 1
        ? Effect.fail(new SavedPlaceError({ message: "Couldn't save your place. Try again." }))
        : Effect.succeed(savedPlace(value))
    },
  })

  await user.click(await screen.findByRole("link", { name: /^Continue / }))
  await screen.findByText("Couldn't save your place")
  await user.click(screen.getByRole("button", { name: "Retry" }))
  await waitFor(() => expect(writes).toBe(2))
  expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
})

it("serializes saves and skips intermediate positions while an earlier save is in flight", async () => {
  const calls: Array<Held<{ destination: ResumableDestination }, SavedPlace, never>> = []
  const registry = testRegistry({ SavePlace: hold(calls) })
  const release = registry.mount(savedDestinationsAtom)

  try {
    rememberPlace(registry, destination)
    const first = await next(calls)
    rememberPlace(registry, { ...destination, position: { tab: "overview" } })

    const last: ResumableDestination = {
      ...destination,
      position: { tab: "files", file: "README.md" },
    }

    rememberPlace(registry, last)
    expect(calls).toHaveLength(0)
    expect(Option.getOrNull(AsyncResult.value(registry.get(savedDestinationsAtom)))).toEqual([last])

    first.answer(Effect.succeed(savedPlace(first.payload.destination)))
    const second = await next(calls)
    expect(second.payload.destination).toEqual(last)
    expect(Option.getOrNull(AsyncResult.value(registry.get(savedDestinationsAtom)))).toEqual([last])
    second.answer(Effect.succeed(savedPlace(last)))
    await waitFor(() =>
      expect(Option.getOrNull(AsyncResult.value(registry.get(savedDestinationsAtom)))).toEqual([
        last,
      ]),
    )
  } finally {
    release()
    registry.dispose()
  }
})

it("keeps one destination per area, newest first", async () => {
  const registry = testRegistry({})
  const release = registry.mount(savedDestinationsAtom)
  const opened: ResumableDestination = { area: "agents", agentId: agent.id }

  const later: ResumableDestination = {
    ...destination,
    position: { tab: "files", file: "README.md" },
  }

  try {
    rememberPlace(registry, destination)
    rememberPlace(registry, opened)
    rememberPlace(registry, later)
    await waitFor(() =>
      expect(Option.getOrNull(AsyncResult.value(registry.get(savedDestinationsAtom)))).toEqual([
        later,
        opened,
      ]),
    )
  } finally {
    release()
    registry.dispose()
  }
})
