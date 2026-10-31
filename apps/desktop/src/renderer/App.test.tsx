// @vitest-environment happy-dom
import {
  defaultReviewPrompt,
  type Activity,
  ActivityPage,
  ActivityPullRequest,
  ActivityToDo,
  Discussions,
  Draft,
  FollowedRepository,
  FileTooLarge,
  RepositoryFiles,
  GitHubConnection,
  InvalidRepositoryInput,
  LinePlace,
  LoggedActivity,
  PullRequest,
  PullRequestOpened,
  PullRequestRef,
  ReplySent,
  PullRequestWorkspace,
  SettingsError,
  Revision,
  noListings,
  ToDoDone,
  type EngineSettings,
} from "@glass/contracts"
import { RegistryProvider } from "@effect/atom-react"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { ACTIVITY_PAGE_SIZE } from "./ActivityLogPage"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { openReview } from "../../test/finishReview"
import { type Held, hold, next, testLayer } from "../../test/testBackend"
import { viewer } from "../../test/workspace"

const workspace = new PullRequestWorkspace({
  viewer,
  pullRequest: new PullRequest({
    id: "PR_1",
    ref: new PullRequestRef({ owner: "octo-org", repo: "glass", number: 42 }),
    url: "https://github.com/octo-org/glass/pull/42",
    title: "Greet the world",
    author: "hubot",
    baseBranch: "main",
    headBranch: "greeting",
    state: "open",
    descriptionHtml: "",
    viewerIsAuthor: false,
    approval: null,
    reviewers: [],
    checks: [],
    mergeable: "mergeable",
  }),
  revision: new Revision({ base: "base000", head: "head001" }),
  updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  files: [],
  viewedPaths: [],
  discussions: new Discussions({ onLines: [], outdated: [], timeline: [] }),
  drafts: [
    new Draft({
      id: "D1",
      path: "greet.ts",
      place: LinePlace.make({ side: "new", line: 2 }),
      body: "Private feedback",
    }),
  ],
})

const tourSettings: EngineSettings = {
  engine: "claude-code",
  models: {
    "claude-code": "claude-sonnet-5-5",
    pi: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
  },
}

const mount = (handlers: Parameters<typeof testLayer>[0]) => {
  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    ListFollowedRepositories: () => Effect.succeed([]),
    GetEngineSettings: ({ feature }) =>
      Effect.succeed(feature === "tours" ? tourSettings : { ...tourSettings, engine: "pi" }),
    GetReviewPrompt: () => Effect.succeed(defaultReviewPrompt),
    ListPullRequests: () => Effect.succeed(noListings),
    ...handlers,
  })

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

it("turns Tours for the Queue on from Settings, and back off if saving fails", async () => {
  const saves: Array<Held<{ enabled: boolean }, void, SettingsError>> = []
  const user = mount({ SetQueueTours: hold(saves) })
  await user.click(await screen.findByRole("link", { name: "Follow repositories" }))
  const tours = within(await screen.findByRole("region", { name: "Tours" }))
  const toggle = tours.getByRole("switch", { name: "Tours for the Queue" })
  await waitFor(() => expect(toggle.getAttribute("aria-disabled")).toBeNull())

  await user.click(toggle)
  expect(toggle.getAttribute("aria-checked")).toBe("true")
  const saving = await next(saves)
  expect(saving.payload.enabled).toBe(true)
  saving.answer(Effect.fail(new SettingsError({ message: "Couldn't save settings." })))

  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"))
  expect(tours.getByRole("alert").textContent).toContain("Couldn't save settings.")
})

it("takes an empty Reviews screen to Settings and shows saved follows and unfollows", async () => {
  const repository = new FollowedRepository({ owner: "octo-org", repo: "glass" })

  const user = mount({
    FollowRepository: () => Effect.succeed([repository]),
    UnfollowRepository: () => Effect.succeed([]),
  })

  await user.click(await screen.findByRole("link", { name: "Follow repositories" }))
  const settings = await screen.findByRole("main", { name: "Settings" })
  const input = within(settings).getByRole<HTMLInputElement>("textbox", { name: "Repository" })
  await user.type(input, "octo-org/glass")
  await user.keyboard("{Enter}")
  const unfollow = await within(settings).findByRole("button", { name: "Unfollow octo-org/glass" })
  expect(input.value).toBe("")
  await user.click(unfollow)
  await within(settings).findByText("No followed repositories yet.")

  await user.click(screen.getByRole("link", { name: "Reviews" }))
  await screen.findByRole("link", { name: "Follow repositories" })
})

it("shows pending saves and actionable errors without claiming failed changes were saved", async () => {
  const repository = new FollowedRepository({ owner: "octo-org", repo: "glass" })

  const follows: Array<
    Held<
      { input: string },
      ReadonlyArray<FollowedRepository>,
      InvalidRepositoryInput | SettingsError
    >
  > = []

  const unfollows: Array<
    Held<{ repository: FollowedRepository }, ReadonlyArray<FollowedRepository>, SettingsError>
  > = []

  const user = mount({ FollowRepository: hold(follows), UnfollowRepository: hold(unfollows) })
  await user.click(await screen.findByRole("link", { name: "Follow repositories" }))
  const repositories = screen.getByRole("region", { name: "Followed repositories" })
  const input = screen.getByRole("textbox", { name: "Repository" })
  await user.type(input, "invalid")
  await user.keyboard("{Enter}")
  const invalid = await next(follows)
  expect(invalid.payload.input).toBe("invalid")
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Following…" }).disabled).toBe(true)
  expect(within(repositories).getByRole("status").textContent).toBe("Saving followed repositories…")
  invalid.answer(Effect.fail(new InvalidRepositoryInput({ input: "invalid" })))
  expect((await screen.findByRole("alert")).textContent).toContain("Enter owner/repo")
  expect(within(repositories).getByRole("status").textContent).toBe("")

  await user.clear(input)
  await user.type(input, "https://github.com/octo-org/glass")
  await user.keyboard("{Enter}")
  ;(await next(follows)).answer(
    Effect.fail(
      new SettingsError({
        message: "Check that the directory is writable, then retry.",
      }),
    ),
  )
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Check that the directory is writable",
  )
  expect(screen.queryByRole("button", { name: "Unfollow octo-org/glass" })).toBeNull()
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Repository" }).value).toBe(
    "https://github.com/octo-org/glass",
  )

  await user.click(screen.getByRole("button", { name: "Follow" }))
  ;(await next(follows)).answer(Effect.succeed([repository]))
  const unfollow = await screen.findByRole("button", { name: "Unfollow octo-org/glass" })
  await user.click(input)
  await user.tab()
  expect(document.activeElement).toBe(unfollow)
  await user.keyboard("{Enter}")
  const removal = await next(unfollows)
  expect(screen.getByRole("button", { name: "Unfollow octo-org/glass" }).textContent).toBe(
    "Unfollowing…",
  )
  removal.answer(
    Effect.fail(new SettingsError({ message: "Couldn't save. Check free space and retry." })),
  )
  expect((await screen.findByRole("alert")).textContent).toContain("Check free space")
  expect(screen.getByRole("button", { name: "Unfollow octo-org/glass" }).textContent).toBe(
    "Unfollow",
  )
})

it("distinguishes configuration loading and failure from an empty configuration and supports Retry", async () => {
  const reads: Array<Held<void, ReadonlyArray<FollowedRepository>, SettingsError>> = []

  const user = mount({ ListFollowedRepositories: hold(reads) })
  await user.click(await screen.findByRole("link", { name: "Settings" }))
  const first = await next(reads)
  const settings = await screen.findByRole("main", { name: "Settings" })
  const repositories = within(settings).getByRole("region", { name: "Followed repositories" })
  expect(within(repositories).getByRole("status").textContent).toBe(
    "Loading followed repositories…",
  )
  expect(screen.queryByText("No followed repositories yet.")).toBeNull()
  first.answer(
    Effect.fail(
      new SettingsError({
        message: "Couldn't read configuration. Check file permissions and retry.",
      }),
    ),
  )
  expect((await screen.findByRole("alert")).textContent).toContain("Check file permissions")
  await user.click(screen.getByRole("button", { name: "Retry" }))
  ;(await next(reads)).answer(Effect.succeed([]))
  await within(settings).findByText("No followed repositories yet.")
})

it("preserves a pending follow and its failure when leaving and returning to Settings", async () => {
  const follows: Array<Held<{ input: string }, ReadonlyArray<FollowedRepository>, SettingsError>> =
    []

  const user = mount({ FollowRepository: hold(follows) })
  await user.click(await screen.findByRole("link", { name: "Follow repositories" }))
  await user.type(screen.getByRole("textbox", { name: "Repository" }), "octo-org/glass")
  await user.keyboard("{Enter}")
  const follow = await next(follows)
  await user.click(screen.getByRole("link", { name: "Reviews" }))
  await user.click(screen.getByRole("link", { name: "Settings" }))
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Following…" }).disabled).toBe(true)
  follow.answer(Effect.fail(new SettingsError({ message: "Check free space and retry." })))
  expect((await screen.findByRole("alert")).textContent).toContain("Check free space")
  await user.click(screen.getByRole("link", { name: "Reviews" }))
  await user.click(screen.getByRole("link", { name: "Settings" }))
  expect(screen.getByRole("alert").textContent).toContain("Check free space")
})

it("keeps the active PR workspace, Revision, and unpublished feedback when its repository is unfollowed", async () => {
  const repository = new FollowedRepository({ owner: "octo-org", repo: "glass" })

  const user = mount({
    ListFollowedRepositories: () => Effect.succeed([repository]),
    UnfollowRepository: () => Effect.succeed([]),
    OpenPullRequest: () => Effect.succeed(workspace),
  })

  await user.type(
    await screen.findByRole("textbox", { name: "Open a PR" }),
    workspace.pullRequest.url,
  )
  await user.keyboard("{Enter}")

  await user.type(await openReview(user), "Keep this summary")
  await screen.findByText("Private feedback")
  await user.click(screen.getByRole("link", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: "Unfollow octo-org/glass" }))
  await screen.findByText("No followed repositories yet.")
  await user.click(screen.getByRole("link", { name: "Reviews" }))
  expect((await openReview(user)).value).toBe("Keep this summary")
  await screen.findByText("head001")
  await screen.findByText("Private feedback")
  await screen.findByText("Saved privately")
})

it("uses the supplied backend for repository file listing and reading", async () => {
  const user = mount({
    OpenPullRequest: () => Effect.succeed(workspace),
    ListRepositoryFiles: () =>
      Effect.succeed(new RepositoryFiles({ paths: ["README.md"], truncated: false })),
    GetFileContents: () => Effect.succeed(FileTooLarge.make({})),
  })

  await user.type(
    await screen.findByRole("textbox", { name: "Open a PR" }),
    workspace.pullRequest.url,
  )
  await user.keyboard("{Enter}")
  await user.click(await screen.findByRole("tab", { name: "Files" }))

  const tree = await waitFor(() => {
    const element = document
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelector<HTMLElement>('[role="tree"]')

    if (element == null) throw new Error("Repository file tree hasn't rendered")

    return element
  })

  await user.click(await within(tree).findByRole("treeitem", { name: /README.md/ }))
  expect((await screen.findByText("File too large to show")).textContent).toBe(
    "File too large to show",
  )
})

const logged = (id: number, occurredAt: Date, activity: Activity) =>
  new LoggedActivity({ id, occurredAt: DateTime.fromDateUnsafe(occurredAt), activity })

const recorded = new ActivityPullRequest({
  ref: workspace.pullRequest.ref,
  title: workspace.pullRequest.title,
  revision: workspace.revision,
})

it("lists Activity by day, pages older Activity, and keeps the log on return", async () => {
  const limits: Array<number> = []

  const reply = logged(
    2,
    new Date(),
    ReplySent.make({ pullRequest: recorded, discussionId: "PRRT_1", body: "Done." }),
  )

  const opened = logged(
    1,
    new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    PullRequestOpened.make({ pullRequest: recorded }),
  )

  const user = mount({
    ListActivity: ({ limit }) => {
      limits.push(limit)

      return Effect.succeed(
        limit === ACTIVITY_PAGE_SIZE
          ? new ActivityPage({ activities: [reply], hasMore: true })
          : new ActivityPage({ activities: [reply, opened], hasMore: false }),
      )
    },
  })

  await user.click(await screen.findByRole("link", { name: "Activity" }))
  const today = await screen.findByRole("region", { name: "Today" })
  expect(within(today).getByRole("listitem").textContent).toContain("Replied")
  expect(within(today).getByRole("listitem").textContent).toContain("Done.")

  await user.click(screen.getByRole("button", { name: "Load more" }))
  await screen.findByText("Opened")
  expect(limits).toEqual([ACTIVITY_PAGE_SIZE, 2 * ACTIVITY_PAGE_SIZE])
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull()

  await user.click(screen.getByRole("link", { name: "Reviews" }))
  await user.click(await screen.findByRole("link", { name: "Activity" }))
  await screen.findByText("Opened")
  expect(limits).toEqual([ACTIVITY_PAGE_SIZE, 2 * ACTIVITY_PAGE_SIZE])

  await user.click(screen.getByRole("button", { name: "Refresh" }))
  await waitFor(() =>
    expect(limits).toEqual([ACTIVITY_PAGE_SIZE, 2 * ACTIVITY_PAGE_SIZE, 2 * ACTIVITY_PAGE_SIZE]),
  )
})

it("lists to-do Activity", async () => {
  const done = logged(
    1,
    new Date(),
    ToDoDone.make({ toDo: new ActivityToDo({ id: 7, title: "Write the release notes" }) }),
  )

  const user = mount({
    ListActivity: () => Effect.succeed(new ActivityPage({ activities: [done], hasMore: false })),
  })

  await user.click(await screen.findByRole("link", { name: "Activity" }))
  const today = await screen.findByRole("region", { name: "Today" })
  expect(within(today).getByRole("listitem").textContent).toContain(
    "Marked doneWrite the release notes",
  )
})
