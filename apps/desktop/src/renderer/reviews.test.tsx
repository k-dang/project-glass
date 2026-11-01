// @vitest-environment happy-dom
import {
  type ConnectionError,
  Discussions,
  Draft,
  FollowedRepository,
  GitHubConnection,
  GitHubUnavailable,
  LinePlace,
  NoCredentials,
  OutdatedDiscussion,
  PublishedComment,
  type OpenPullRequestError,
  PullRequest,
  PullRequestNotFound,
  PullRequestRef,
  PullRequestSummary,
  type PullRequestList,
  PullRequestWorkspace,
  noListings,
  referenceKey,
  type PullRequestListings,
  type RepositoryListing,
  RepositoryPullRequests,
  RepositoryUnavailable,
  Revision,
  type SettingsError,
} from "@glass/contracts"
import { RegistryProvider } from "@effect/atom-react"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import {
  confirmLeave,
  openPullRequest,
  openWorkspaceAtom,
  reloadPullRequest,
  targetAtom,
} from "./reviewsArea"
import { openReview } from "../../test/finishReview"
import { type Held, hold, next, testLayer, testRegistry } from "../../test/testBackend"
import { viewer } from "../../test/workspace"

const glass = new FollowedRepository({ owner: "octo-org", repo: "glass" })

const effect = new FollowedRepository({ owner: "effect-ts", repo: "effect" })

const quiet = new FollowedRepository({ owner: "octo-org", repo: "quiet" })

const summary = (
  repository: FollowedRepository,
  number: number,
  title: string,
  fields: Partial<Pick<PullRequestSummary, "author" | "isDraft" | "checks" | "updatedAt">> = {},
) =>
  new PullRequestSummary({
    ref: new PullRequestRef({ owner: repository.owner, repo: repository.repo, number }),
    url: `https://github.com/${repository.owner}/${repository.repo}/pull/${number}`,
    title,
    author: "hubot",
    isDraft: false,
    checks: "passing",
    updatedAt: DateTime.makeUnsafe(Date.now() - 2 * 60 * 60 * 1000),
    ...fields,
  })

const greet = summary(glass, 42, "Greet the world")

const wave = summary(glass, 43, "Wave at the world", { author: "mona", checks: "failing" })

const needsReview = [
  new RepositoryPullRequests({
    repository: effect,
    pullRequests: [
      summary(effect, 7, "Speed up fibers", {
        checks: "unavailable",
        updatedAt: DateTime.makeUnsafe(Date.now() - 3 * 24 * 60 * 60 * 1000),
      }),
    ],
  }),
  new RepositoryPullRequests({
    repository: glass,
    pullRequests: [wave, greet],
  }),
  new RepositoryPullRequests({
    repository: quiet,
    pullRequests: [],
  }),
]

const listings = (
  lists: Partial<Record<PullRequestList, ReadonlyArray<RepositoryListing>>>,
): PullRequestListings => ({ ...noListings, ...lists })

const needing = (...repositories: ReadonlyArray<RepositoryListing>) =>
  listings({ "needs-review": repositories })

const workspaceOf = (
  pr: PullRequestSummary,
  head: string,
  drafts: ReadonlyArray<Draft> = [],
  discussions = new Discussions({ onLines: [], outdated: [], timeline: [] }),
) =>
  new PullRequestWorkspace({
    viewer,
    pullRequest: new PullRequest({
      id: `PR_${pr.ref.number}`,
      ref: pr.ref,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      baseBranch: "main",
      headBranch: "feature",
      state: "open",
      descriptionHtml: "",
      viewerIsAuthor: false,
      approval: null,
      reviewers: [],
      checks: [],
      mergeable: "mergeable",
    }),
    revision: new Revision({ base: "base000", head }),
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    files: [],
    viewedPaths: [],
    discussions,
    drafts,
  })

const savedDraft = new Draft({
  id: "D1",
  path: "greet.ts",
  place: LinePlace.make({ side: "new", line: 2 }),
  body: "Private feedback",
})

const mount = (handlers: Parameters<typeof testLayer>[0]) => {
  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    ListFollowedRepositories: () => Effect.succeed([glass, effect, quiet]),
    ListPullRequests: () => Effect.succeed(needing(...needsReview)),
    HasPullRequestChanged: () => Effect.succeed(false),
    SubmitReview: () => Effect.die("Navigation must not submit a Review"),
    ReplyToDiscussion: () => Effect.die("Navigation must not publish a Reply"),
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "#/")
})

const rowFor = (title: string) => screen.findByRole("button", { name: new RegExp(`^${title}`) })

const listNotRefreshed = async (detail: string) =>
  expect((await screen.findByRole("status", { name: "List status" })).textContent).toContain(
    `Not refreshed: Couldn't reach GitHub. ${detail}`,
  )

it("starts on Needs review with PRs from every repository in one list, newest first", async () => {
  mount({})

  const list = await screen.findByRole("tabpanel", { name: "Needs review" })
  await within(list).findByRole("button", { name: /^Greet the world/ })

  const rows = within(list).getAllByRole("button", { name: /world|fibers/ })
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringMatching(/^Wave at the worldglass#43mona2hChecks failing/i),
    expect.stringMatching(/^Greet the worldglass#42hubot2hChecks passing/i),
    expect.stringMatching(/^Speed up fibers.*effect#7hubot3dChecks unavailable/i),
  ])
  within(within(list).getByRole("region", { name: "Past week" })).getByRole("button", {
    name: /^Speed up fibers/,
  })
})

it("names a repository by its owner too when another listed repository shares its name", async () => {
  const fork = new FollowedRepository({ owner: "mona", repo: "glass" })

  mount({
    ListPullRequests: () =>
      Effect.succeed(
        needing(
          ...needsReview,
          new RepositoryPullRequests({
            repository: fork,
            pullRequests: [summary(fork, 5, "Fork the world")],
          }),
        ),
      ),
  })

  expect((await rowFor("Fork the world")).textContent).toContain("mona/glass#5")
  expect((await rowFor("Greet the world")).textContent).toContain("octo-org/glass#42")
  expect((await rowFor("Speed up fibers")).textContent).toMatch(/[^/]effect#7/)
})

it("distinguishes no followed repositories, no PRs needing review, and a failed load", async () => {
  const lists: Array<ListCall> = []

  const user = mount({
    ListPullRequests: hold(lists),
    FollowRepository: () => Effect.succeed([quiet]),
  })

  ;(await next(lists)).answer(Effect.fail(new GitHubUnavailable({ message: "Try again later." })))
  expect((await screen.findByRole("alert")).textContent).toContain("Try again later.")
  expect(screen.queryByText("No PRs need your review")).toBeNull()

  await user.click(screen.getByRole("button", { name: "Retry" }))
  ;(await next(lists)).answer(Effect.succeed(listings({})))
  await user.click(await screen.findByRole("link", { name: "Follow repositories" }))
  await user.type(screen.getByRole("textbox", { name: "Repository" }), "octo-org/quiet{Enter}")
  await screen.findByRole("button", { name: "Unfollow octo-org/quiet" })
  await user.click(screen.getByRole("link", { name: "Reviews" }))
  ;(await next(lists)).answer(Effect.succeed(needing(listed(quiet, []))))
  await screen.findByText("No PRs need your review")
  expect(screen.queryByRole("link", { name: "Follow repositories" })).toBeNull()
})

it("arranges PRs by repository, kept through Back to PRs", async () => {
  const user = mount({
    OpenPullRequest: () => Effect.succeed(workspaceOf(wave, "head001")),
  })

  await rowFor("Wave at the world")
  await user.click(screen.getByRole("button", { name: "By repository" }))
  const glassSection = screen.getByRole("region", { name: "octo-org/glass" })
  expect(
    within(glassSection).getByRole("button", { name: /^Wave at the world/ }).textContent,
  ).not.toContain("octo-org/glass")
  within(screen.getByRole("region", { name: "effect-ts/effect" })).getByRole("button", {
    name: /^Speed up fibers/,
  })

  within(glassSection).getByRole("button", { name: /^Greet the world/ })

  await user.click(await rowFor("Wave at the world"))
  await user.click(await screen.findByRole("button", { name: "Back to PRs" }))
  const arranged = await screen.findByRole("button", { name: "By repository" })
  expect(arranged.getAttribute("aria-pressed")).toBe("true")
  await screen.findByRole("region", { name: "octo-org/glass" })
})

it("opens only full URLs or repository-qualified references", async () => {
  const opens: Array<PullRequestRef> = []

  const user = mount({
    OpenPullRequest: ({ pullRequest }) => {
      opens.push(pullRequest)

      return Effect.succeed(workspaceOf(greet, "head001"))
    },
  })

  const input = await screen.findByRole("textbox", { name: "Open a PR" })
  const open = screen.getByRole<HTMLButtonElement>("button", { name: "Open" })

  await user.type(input, "glass#42{Enter}")
  expect(open.disabled).toBe(true)
  expect(opens).toEqual([])

  await user.clear(input)
  await user.type(input, "unfollowed/repo#42{Enter}")
  await user.click(await screen.findByRole("button", { name: "Back to PRs" }))
  expect(opens).toEqual([new PullRequestRef({ owner: "unfollowed", repo: "repo", number: 42 })])

  await user.type(await screen.findByRole("textbox", { name: "Open a PR" }), `${greet.url}{Enter}`)
  await screen.findByRole("button", { name: "Back to PRs" })
  expect(opens).toEqual([
    new PullRequestRef({ owner: "unfollowed", repo: "repo", number: 42 }),
    greet.ref,
  ])
})

it("opens another PR from a PR workspace with ⌘L or Open another PR", async () => {
  const opened = {
    [referenceKey(greet.ref)]: workspaceOf(greet, "head001"),
    [referenceKey(wave.ref)]: workspaceOf(wave, "head002"),
  }

  const user = mount({
    OpenPullRequest: ({ pullRequest }) => Effect.succeed(opened[referenceKey(pullRequest)]!),
  })

  await user.click(await rowFor("Greet the world"))
  await screen.findByText("head001")
  const trigger = screen.getByRole("button", { name: "Open another PR" })
  await user.click(trigger)
  await screen.findByRole("dialog", { name: "Open a PR" })
  await user.keyboard("{Escape}")
  await eventually(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(document.activeElement).toBe(trigger)

  await user.keyboard("{Meta>}l{/Meta}")
  const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "Open a PR" })
  await eventually(() => expect(document.activeElement).toBe(input))
  await user.type(input, "owner/repo#123")
  await user.keyboard("{Control>}l{/Control}")

  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe("owner/repo#123".length)
  await user.keyboard(`${wave.url}{Enter}`)
  await screen.findByText("head002")
  expect(screen.queryByRole("dialog")).toBeNull()

  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  await user.keyboard("{Control>}l{/Control}")
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("scopes Copy to every loaded PR workspace tab and removes it when leaving", async () => {
  const user = mount({ OpenPullRequest: () => Effect.succeed(workspaceOf(greet, "head001")) })
  await user.click(await rowFor("Greet the world"))
  await screen.findByText("head001")

  for (const tab of ["Overview", "Changes", "Files"]) {
    await user.click(screen.getByRole("tab", { name: tab }))
    await user.keyboard("c")
    await screen.findByRole("dialog", { name: "Copy" })
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
  }

  await user.keyboard("c")
  await screen.findByRole("dialog", { name: "Copy" })
  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  await rowFor("Greet the world")
  expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
  await user.keyboard("c")
  expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
})

type ListCall = Held<void, PullRequestListings, ConnectionError | SettingsError>

const listed = (repository: FollowedRepository, pullRequests: ReadonlyArray<PullRequestSummary>) =>
  new RepositoryPullRequests({ repository, pullRequests })

const offline = (
  repository: FollowedRepository,
  pullRequests: ReadonlyArray<PullRequestSummary> = [],
) =>
  new RepositoryUnavailable({
    repository,
    error: new GitHubUnavailable({ message: "Offline." }),
    pullRequests,
  })

const setDocumentVisible = (visible: boolean) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(visible ? "visible" : "hidden")
  document.dispatchEvent(new Event("visibilitychange"))
}

it("refreshes on entry, window focus, every 30 seconds while visible, and on request", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const requests: Array<void> = []

  const user = mount({
    ListPullRequests: (request) => {
      requests.push(request)

      return Effect.succeed(needing(...needsReview))
    },
  })

  const refreshed = (count: number) => eventually(() => expect(requests).toHaveLength(count))
  await refreshed(1)
  await rowFor("Greet the world")

  act(() => void vi.advanceTimersByTime(30_000))
  await refreshed(2)
  act(() => void window.dispatchEvent(new Event("focus")))
  await refreshed(3)
  await user.click(screen.getByRole("button", { name: "Refresh" }))
  await refreshed(4)

  act(() => setDocumentVisible(false))
  act(() => void vi.advanceTimersByTime(180_000))
  act(() => setDocumentVisible(true))
  await refreshed(5)

  await user.click(screen.getByRole("link", { name: "Settings" }))
  act(() => void vi.advanceTimersByTime(180_000))
  act(() => void window.dispatchEvent(new Event("focus")))
  expect(requests).toHaveLength(5)
  await user.click(screen.getByRole("link", { name: "Reviews" }))
  await refreshed(6)
})

it("shows cached rows on return and refreshes them behind the list once stale", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const calls: Array<ListCall> = []

  const user = mount({ ListPullRequests: hold(calls) })

  ;(await next(calls)).answer(Effect.succeed(needing(listed(glass, [wave]))))
  await rowFor("Wave at the world")

  await user.click(screen.getByRole("link", { name: "Settings" }))
  await user.click(screen.getByRole("link", { name: "Reviews" }))
  await rowFor("Wave at the world")
  expect(calls).toHaveLength(0)

  await user.click(screen.getByRole("link", { name: "Settings" }))
  act(() => void vi.advanceTimersByTime(30_000))
  await user.click(screen.getByRole("link", { name: "Reviews" }))
  const revalidation = await next(calls)
  expect(screen.queryByText("Loading PRs…")).toBeNull()
  await rowFor("Wave at the world")
  revalidation.answer(Effect.succeed(needing(listed(glass, [greet]))))
  await rowFor("Greet the world")
})

const refresh = () => screen.getByRole("button", { name: "Refresh" })

it("shows the saved list while GitHub answers, and spins Refresh only when asked", async () => {
  const calls: Array<ListCall> = []

  const user = mount({
    ListSavedPullRequests: () => Effect.succeed(needing(listed(glass, [wave]))),
    ListPullRequests: hold(calls),
  })

  await rowFor("Wave at the world")
  const background = await next(calls)
  expect(refresh().getAttribute("aria-busy")).toBe("false")
  background.answer(Effect.succeed(needing(listed(glass, [greet]))))
  await rowFor("Greet the world")
  expect(screen.queryByRole("button", { name: /^Wave/ })).toBeNull()

  await user.click(refresh())
  const asked = await next(calls)
  expect(refresh().getAttribute("aria-busy")).toBe("true")
  asked.answer(Effect.succeed(needing(listed(glass, [greet]))))
  await eventually(() => expect(refresh().getAttribute("aria-busy")).toBe("false"))

  act(() => void window.dispatchEvent(new Event("focus")))
  const later = await next(calls)
  expect(refresh().getAttribute("aria-busy")).toBe("false")
  later.answer(Effect.succeed(needing(listed(glass, [greet]))))
})

it("keeps healthy repositories usable and a failed repository's rows marked not refreshed until a refresh", async () => {
  const calls: Array<ListCall> = []
  const user = mount({ ListPullRequests: hold(calls) })

  const fibers = summary(effect, 7, "Speed up fibers")

  ;(await next(calls)).answer(
    Effect.succeed(needing(listed(effect, [fibers]), listed(glass, [wave, greet]))),
  )
  await rowFor("Greet the world")

  await user.click(screen.getByRole("button", { name: "Refresh" }))

  const streams = summary(effect, 8, "Speed up streams")

  ;(await next(calls)).answer(
    Effect.succeed(needing(listed(effect, [streams]), offline(glass, [wave, greet]))),
  )

  const notRefreshedRows = await screen.findAllByRole("button", { name: /world.*Not refreshed/ })
  expect(notRefreshedRows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("Not refreshed: Couldn't reach GitHub. Offline."),
    expect.stringContaining("Not refreshed: Couldn't reach GitHub. Offline."),
  ])
  expect((await rowFor("Speed up streams")).textContent).not.toContain("Not refreshed")
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()

  await user.click(screen.getByRole("button", { name: "Refresh" }))
  const retry = await next(calls)
  expect(screen.getByRole("button", { name: /^Speed up streams/ })).toBeTruthy()
  retry.answer(Effect.succeed(needing(listed(effect, [streams]), listed(glass, [greet]))))
  await eventually(() => expect(screen.queryByRole("button", { name: /^Wave/ })).toBeNull())
  expect(screen.queryByText(/Not refreshed/)).toBeNull()
  await rowFor("Greet the world")
})

it("shows a failed repository without rows instead of an empty list, and keeps rows through a failed refresh", async () => {
  const calls: Array<ListCall> = []

  const user = mount({ ListPullRequests: hold(calls) })

  ;(await next(calls)).answer(Effect.succeed(needing(offline(glass), listed(quiet, []))))
  await screen.findByText("Couldn't load octo-org/glass")
  expect(screen.queryByText("No PRs need your review")).toBeNull()
  expect(screen.queryByRole("region", { name: "octo-org/quiet" })).toBeNull()

  await user.click(screen.getByRole("button", { name: "Retry" }))
  ;(await next(calls)).answer(Effect.succeed(needing(listed(glass, [wave]))))
  await rowFor("Wave at the world")
  await user.click(screen.getByRole("button", { name: "Refresh" }))
  ;(await next(calls)).answer(Effect.fail(new GitHubUnavailable({ message: "Try again later." })))
  await listNotRefreshed("Try again later.")
  expect(screen.getByRole("button", { name: /^Wave at the world/ }).textContent).toContain(
    "Not refreshed",
  )

  await user.click(screen.getByRole("button", { name: "Refresh" }))
  ;(await next(calls)).answer(Effect.succeed(needing(listed(glass, []))))
  await screen.findByText("No PRs need your review")
  await user.click(screen.getByRole("button", { name: "Refresh" }))
  ;(await next(calls)).answer(Effect.fail(new GitHubUnavailable({ message: "Try again later." })))
  await listNotRefreshed("Try again later.")
  expect(screen.queryByText("No PRs need your review")).toBeNull()
})

it("opens a PR from the list, and Back to PRs closes it", async () => {
  const opens: Array<PullRequestRef> = []

  const user = mount({
    OpenPullRequest: ({ pullRequest }) => {
      opens.push(pullRequest)

      return Effect.succeed(workspaceOf(greet, "head001", [savedDraft]))
    },
  })

  await user.click(await rowFor("Greet the world"))
  await screen.findByText("Private feedback")
  await user.click(screen.getByRole("button", { name: "Back to PRs" }))

  await screen.findByRole("tabpanel", { name: "Needs review" })
  expect(screen.queryByText("Private feedback")).toBeNull()
  expect(screen.queryByRole("alertdialog")).toBeNull()

  await user.click(await rowFor("Greet the world"))
  await screen.findByText("Private feedback")
  expect(opens).toEqual([greet.ref])
})

it("opens nothing without GitHub credentials, showing the problem once until Try again", async () => {
  const opens: Array<PullRequestRef> = []
  let credentials = false

  window.history.replaceState(null, "", "#/reviews/octo-org/glass/42")

  const user = mount({
    GetConnection: () =>
      credentials
        ? Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" }))
        : Effect.fail(new NoCredentials()),
    OpenPullRequest: ({ pullRequest }) => {
      opens.push(pullRequest)

      return Effect.succeed(workspaceOf(greet, "head001"))
    },
  })

  expect((await screen.findByRole("alert")).textContent).toContain("No GitHub credentials found")
  expect(screen.getAllByRole("alert")).toHaveLength(1)
  screen.getByRole("button", { name: "Copy gh auth login" })
  expect(opens).toEqual([])

  credentials = true
  await user.click(screen.getByRole("button", { name: "Try again" }))

  await screen.findByText("head001")
  expect(opens).toEqual([greet.ref])
})

it("goes Back to PRs with Escape once nothing else needs closing", async () => {
  const user = mount({ OpenPullRequest: () => Effect.succeed(workspaceOf(greet, "head001")) })

  await user.click(await rowFor("Greet the world"))
  await screen.findByText("head001")
  await user.keyboard("c")
  await screen.findByRole("dialog", { name: "Copy" })
  await user.keyboard("{Escape}")
  await eventually(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(screen.getByText("head001")).toBeTruthy()

  await user.keyboard("{Escape}")
  await screen.findByRole("tabpanel", { name: "Needs review" })
})

it("names the PR while it opens, and Back to PRs leaves before it arrives", async () => {
  const opens: Array<
    Held<{ pullRequest: PullRequestRef }, PullRequestWorkspace, OpenPullRequestError>
  > = []

  const user = mount({ OpenPullRequest: hold(opens) })

  await user.click(await rowFor("Greet the world"))
  await next(opens)
  const loading = screen.getByRole("status", { name: "Loading pull request" })
  expect(loading.textContent).toContain("octo-org/glass")
  expect(loading.textContent).toContain("#42")

  await user.click(within(loading).getByRole("button", { name: "Back to PRs" }))
  await screen.findByRole("tabpanel", { name: "Needs review" })
})

const deleteDraft = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: /Delete Draft on greet.ts/ })

const reloadHint = () => screen.getByRole("tooltip").textContent

it("reopens a PR as Glass last loaded it, marking Reload once GitHub says it changed", async () => {
  const opens: Array<
    Held<{ pullRequest: PullRequestRef }, PullRequestWorkspace, OpenPullRequestError>
  > = []

  const checks: Array<Held<{ updatedAt: DateTime.Utc }, boolean, ConnectionError>> = []
  const user = mount({ OpenPullRequest: hold(opens), HasPullRequestChanged: hold(checks) })

  await user.click(await rowFor("Greet the world"))
  ;(await next(opens)).answer(Effect.succeed(workspaceOf(greet, "head001", [savedDraft])))
  await screen.findByText("Private feedback")
  ;(await next(checks)).answer(Effect.succeed(false))
  await user.click(screen.getByRole("button", { name: "Back to PRs" }))

  await user.click(await rowFor("Greet the world"))
  const check = await next(checks)
  expect(screen.getByText("head001")).toBeTruthy()
  expect(deleteDraft().disabled).toBe(false)
  await user.hover(screen.getByRole("button", { name: "Reload" }))
  await screen.findByRole("tooltip")
  expect(reloadHint()).not.toContain("Changed on GitHub")

  check.answer(Effect.succeed(true))
  await eventually(() => expect(reloadHint()).toContain("Changed on GitHub"))
  expect(opens).toHaveLength(0)

  await user.click(screen.getByRole("button", { name: "Reload" }))
  ;(await next(opens)).answer(Effect.succeed(workspaceOf(greet, "head002", [savedDraft])))
  await screen.findByText("head002")
  await user.unhover(screen.getByRole("button", { name: "Reload" }))
  await user.hover(screen.getByRole("button", { name: "Reload" }))
  await screen.findByRole("tooltip")
  expect(reloadHint()).not.toContain("Changed on GitHub")
})

it("monitors a visible workspace without overlapping reads or replacing its Revision and Drafts", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const checks: Array<Held<{ updatedAt: DateTime.Utc }, boolean, ConnectionError>> = []
  const calls: Array<void> = []
  const opens: Array<PullRequestRef> = []

  const user = mount({
    OpenPullRequest: ({ pullRequest }) => {
      opens.push(pullRequest)

      return Effect.succeed(workspaceOf(greet, "head001", [savedDraft]))
    },
    HasPullRequestChanged: (input) => {
      calls.push(undefined)

      return hold(checks)(input)
    },
  })

  await user.click(await rowFor("Greet the world"))
  await screen.findByText("Private feedback")
  const initial = await next(checks)
  act(() => void window.dispatchEvent(new Event("focus")))
  act(() => void vi.advanceTimersByTime(30_000))
  expect(calls).toHaveLength(1)
  await act(async () => initial.answer(Effect.succeed(false)))

  act(() => setDocumentVisible(false))
  act(() => void vi.advanceTimersByTime(60_000))
  act(() => void window.dispatchEvent(new Event("focus")))
  expect(calls).toHaveLength(1)
  act(() => setDocumentVisible(true))
  const changed = await next(checks)
  await act(async () => changed.answer(Effect.succeed(true)))

  await user.hover(screen.getByRole("button", { name: "Reload" }))
  await screen.findByRole("tooltip")
  expect(reloadHint()).toContain("Changed on GitHub")
  expect(screen.getByText("head001")).toBeTruthy()
  expect(screen.getByText("Private feedback")).toBeTruthy()
  expect(opens).toEqual([greet.ref])

  act(() => void vi.advanceTimersByTime(60_000))
  act(() => void window.dispatchEvent(new Event("focus")))
  expect(calls).toHaveLength(2)

  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  act(() => void vi.advanceTimersByTime(60_000))
  act(() => void window.dispatchEvent(new Event("focus")))
  expect(calls).toHaveLength(2)
})

const withDiscussion = (head: string, resolved = false) =>
  workspaceOf(
    greet,
    head,
    [],
    new Discussions({
      onLines: [],
      outdated: [
        new OutdatedDiscussion({
          id: "T1",
          path: "greet.ts",
          originalLine: 2,
          diffHunk: "",
          resolved,
          comments: [
            new PublishedComment({
              id: "C1",
              author: "hubot",
              avatarUrl: null,
              bodyHtml: "<p>Why there?</p>",
              createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
            }),
          ],
        }),
      ],
      timeline: [],
    }),
  )

it.each(["resolution", "Viewed-file"])(
  "keeps the next PR open when a %s write finishes after leaving a pending Reload",
  async (writeKind) => {
    const writes: Array<Held<void, void, never>> = []
    const opened: Array<PullRequestRef> = []

    const registry = testRegistry({
      GetConnection: () =>
        Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
      OpenPullRequest: ({ pullRequest }) => {
        opened.push(pullRequest)

        return Effect.succeed(
          referenceKey(pullRequest) === referenceKey(greet.ref)
            ? withDiscussion("head001")
            : workspaceOf(wave, "head002"),
        )
      },
      SetDiscussionResolved: () => hold(writes)(undefined).pipe(Effect.as(true)),
      SetFileViewed: () => hold(writes)(undefined),
    })

    try {
      openPullRequest(registry, greet.ref)

      const first = await Effect.runPromise(
        AtomRegistry.getResult(registry, openWorkspaceAtom, { suspendOnWaiting: true }),
      )

      if (writeKind === "resolution") first.resolutions.set("T1", true)
      else first.viewedFiles.set("greet.ts", true)

      const write = await next(writes)
      const reloading = reloadPullRequest(registry)
      expect(await confirmLeave(registry)).toBe(true)
      openPullRequest(registry, wave.ref)
      await Effect.runPromise(
        AtomRegistry.getResult(registry, openWorkspaceAtom, { suspendOnWaiting: true }),
      )

      await reloading
      expect(first.drafts.locked()).toBe(false)
      expect(first.replies.locked()).toBe(false)
      expect(first.viewedFiles.snapshot().locked).toBe(false)
      expect(registry.get(first.resolutions.lockedAtom)).toBe(false)

      write.answer(Effect.void)
      await eventually(() => {
        expect(registry.get(first.resolutions.viewAtom("T1")).feedback).toBeNull()
        expect(first.viewedFiles.snapshot().saving.size).toBe(0)
      })

      const current = await Effect.runPromise(
        AtomRegistry.getResult(registry, openWorkspaceAtom, { suspendOnWaiting: true }),
      )

      expect(registry.get(targetAtom)).toEqual(wave.ref)
      expect(current.workspace.pullRequest.ref).toEqual(wave.ref)
      expect(opened).toEqual([greet.ref, wave.ref])
    } finally {
      registry.dispose()
    }
  },
)

it.each(["success", "failure"])(
  "waits for a resolution %s before Reload and unlocks controls if a later Reload fails",
  async (outcome) => {
    const opens: Array<
      Held<{ pullRequest: PullRequestRef }, PullRequestWorkspace, OpenPullRequestError>
    > = []

    const resolves: Array<
      Held<{ discussionId: string; resolved: boolean }, boolean, ConnectionError>
    > = []

    const user = mount({ OpenPullRequest: hold(opens), SetDiscussionResolved: hold(resolves) })

    await user.click(await rowFor("Greet the world"))
    ;(await next(opens)).answer(Effect.succeed(withDiscussion("head001")))
    await user.click(await screen.findByRole("button", { name: /^Resolve thread/ }))
    const resolving = await next(resolves)

    await user.click(screen.getByRole("button", { name: "Reload" }))
    expect(opens).toHaveLength(0)

    resolving.answer(
      outcome === "success"
        ? Effect.succeed(true)
        : Effect.fail(new GitHubUnavailable({ message: "Offline." })),
    )
    const reload = await next(opens)

    const control = await screen.findByRole<HTMLButtonElement>("button", {
      name: outcome === "success" ? /^Unresolve thread/ : /^Retry resolving thread/,
    })

    expect(control.disabled).toBe(true)
    await user.click(control)
    expect(resolves).toHaveLength(0)

    reload.answer(Effect.succeed(withDiscussion("head002", outcome === "success")))
    await screen.findByText("head002")
    const name = outcome === "success" ? /^Unresolve thread/ : /^Resolve thread/
    expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(false)
    expect(screen.queryByText(/Couldn't resolve this Discussion/)).toBeNull()

    await user.click(screen.getByRole("button", { name: "Reload" }))
    ;(await next(opens)).answer(Effect.fail(new GitHubUnavailable({ message: "Offline." })))
    await screen.findByRole("alert")
    await eventually(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(false),
    )
    await user.click(screen.getByRole("button", { name }))
    ;(await next(resolves)).answer(Effect.succeed(outcome !== "success"))
  },
)

it("leaves a PR while a resolution is in flight and shows its result when returning", async () => {
  const resolves: Array<
    Held<{ discussionId: string; resolved: boolean }, boolean, ConnectionError>
  > = []

  const user = mount({
    OpenPullRequest: () => Effect.succeed(withDiscussion("head001")),
    SetDiscussionResolved: hold(resolves),
  })

  await user.click(await rowFor("Greet the world"))
  await user.click(await screen.findByRole("button", { name: /^Resolve thread/ }))
  const resolving = await next(resolves)

  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  await screen.findByRole("tabpanel", { name: "Needs review" })
  await user.click(await rowFor("Greet the world"))
  expect(await screen.findByText("Resolving…")).toBeTruthy()

  resolving.answer(Effect.succeed(true))
  expect(await screen.findByRole("button", { name: /^Unresolve thread/ })).toBeTruthy()
})

it("reopens a PR with the Drafts GitHub saved or deleted since it loaded", async () => {
  const user = mount({
    OpenPullRequest: () => Effect.succeed(workspaceOf(greet, "head001", [savedDraft])),
    DeleteDraft: () => Effect.void,
  })

  await user.click(await rowFor("Greet the world"))
  await user.click(await screen.findByRole("button", { name: /Delete Draft on greet.ts/ }))
  await eventually(() => expect(screen.queryByText("Private feedback")).toBeNull())
  await user.click(screen.getByRole("button", { name: "Back to PRs" }))

  await user.click(await rowFor("Greet the world"))
  await screen.findByText("head001")
  expect(screen.queryByText("Private feedback")).toBeNull()
})

it("reopens a PR without discarded feedback, and keeps it open when a Reload can't reach GitHub", async () => {
  const opens: Array<
    Held<{ pullRequest: PullRequestRef }, PullRequestWorkspace, OpenPullRequestError>
  > = []

  const user = mount({ OpenPullRequest: hold(opens) })

  await user.click(await rowFor("Greet the world"))
  ;(await next(opens)).answer(Effect.succeed(workspaceOf(greet, "head001", [savedDraft])))
  await user.type(await openReview(user), "Almost there")
  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  await user.click(await screen.findByRole("button", { name: "Discard feedback" }))

  await user.click(await rowFor("Greet the world"))
  await screen.findByText("head001")
  await user.click(screen.getByRole("button", { name: "Reload" }))
  ;(await next(opens)).answer(Effect.fail(new GitHubUnavailable({ message: "Offline." })))
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't reach GitHub")
  expect(screen.getByText("head001")).toBeTruthy()
  await eventually(() => expect(deleteDraft().disabled).toBe(false))
  expect((await openReview(user)).value).toBe("")
})

it("returns to Reviewing after opening a PR", async () => {
  window.history.replaceState(null, "", "#/reviews?list=reviewing")
  let touched = false

  const user = mount({
    ListPullRequests: () =>
      Effect.succeed(listings({ reviewing: [listed(glass, touched ? [greet] : [])] })),
    OpenPullRequest: () =>
      Effect.sync(() => {
        touched = true

        return workspaceOf(greet, "head001")
      }),
  })

  await screen.findByText("No PRs to resume")
  const input = screen.getByRole("textbox", { name: "Open a PR" })
  await user.type(input, `${greet.url}{Enter}`)
  await user.click(await screen.findByRole("button", { name: "Back to PRs" }))

  expect((await rowFor("Greet the world")).textContent).toContain("Greet the world")
})

it("keeps summary text typed during a Reload, and holds Back to PRs until it finishes", async () => {
  const opens: Array<
    Held<{ pullRequest: PullRequestRef }, PullRequestWorkspace, OpenPullRequestError>
  > = []

  const user = mount({ OpenPullRequest: hold(opens) })
  await user.click(await rowFor("Greet the world"))
  ;(await next(opens)).answer(Effect.succeed(workspaceOf(greet, "head001")))

  await user.type(await openReview(user), "Looks")
  await user.click(screen.getByRole("button", { name: "Reload" }))
  const reload = await next(opens)
  await user.type(await openReview(user), " close")
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Back to PRs" }).disabled).toBe(true)

  reload.answer(Effect.succeed(workspaceOf(greet, "head002")))
  await screen.findByText("head002")
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Review summary" }).value).toBe(
    "Looks close",
  )
})

it("submits a Review with ⌘↵ from the Changes tab, staying open through a stray click until it lands", async () => {
  const submits: Array<Held<{ decision: string; summary: string }, void, never>> = []

  const user = mount({
    OpenPullRequest: () => Effect.succeed(workspaceOf(greet, "head001", [savedDraft])),
    SubmitReview: hold(submits),
  })

  await user.click(await rowFor("Greet the world"))
  await user.click(await screen.findByRole("tab", { name: "Changes" }))
  const summaryBox = await openReview(user)
  await eventually(() => expect(document.activeElement).toBe(summaryBox))
  await user.click(screen.getByRole("radio", { name: /^Approve/ }))
  await user.type(summaryBox, "Ship it")
  await user.keyboard("{Meta>}{Enter}{/Meta}")
  const submit = await next(submits)
  expect(submit.payload).toMatchObject({ decision: "approve", summary: "Ship it" })

  await user.click(screen.getByRole("heading", { level: 1 }))
  expect(screen.getByRole("dialog", { name: "Finish your Review" })).toBeTruthy()

  submit.answer(Effect.void)
  await screen.findByText("Approved and published 1 Draft.")
  expect(screen.queryByRole("dialog", { name: "Finish your Review" })).toBeNull()
})

it("goes back only after in-flight Draft writes finish, without asking about GitHub-saved Drafts", async () => {
  const deletes: Array<Held<{ id: string }, void, ConnectionError>> = []

  const user = mount({
    OpenPullRequest: () =>
      Effect.succeed(
        workspaceOf(greet, "head001", [
          savedDraft,
          new Draft({
            id: "D2",
            path: "wave.ts",
            place: LinePlace.make({ side: "new", line: 1 }),
            body: "Kept",
          }),
        ]),
      ),
    DeleteDraft: hold(deletes),
  })

  await user.click(await rowFor("Greet the world"))
  await user.click(await screen.findByRole("button", { name: /Delete Draft on greet.ts/ }))
  const deletion = await next(deletes)
  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  expect(screen.queryByRole("tabpanel", { name: "Needs review" })).toBeNull()

  deletion.answer(Effect.void)
  await screen.findByRole("tabpanel", { name: "Needs review" })
  expect(screen.queryByRole("alertdialog")).toBeNull()
})

it("asks before Back to PRs discards unsaved feedback, and stays on the PR when canceled", async () => {
  const deletes: Array<Held<{ id: string }, void, ConnectionError>> = []

  const user = mount({
    OpenPullRequest: ({ pullRequest }) =>
      referenceKey(pullRequest) === referenceKey(wave.ref)
        ? Effect.fail(new PullRequestNotFound({ ref: wave.ref }))
        : Effect.succeed(workspaceOf(greet, "head001", [savedDraft])),
    DeleteDraft: hold(deletes),
  })

  await user.click(await rowFor("Greet the world"))
  await user.type(await openReview(user), "Almost there")
  await user.click(screen.getByRole("button", { name: /Delete Draft on greet.ts/ }))
  ;(await next(deletes)).answer(Effect.fail(new GitHubUnavailable({ message: "Offline." })))
  await screen.findByText("Couldn't delete")

  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  const dialog = await screen.findByRole("alertdialog", { name: "Discard unpublished feedback?" })
  expect(dialog.textContent).toMatch(/Drafts that couldn't save to GitHub.*Review summary/)
  const cancel = within(dialog).getByRole("button", { name: "Cancel" })
  await eventually(() => expect(document.activeElement).toBe(cancel))
  await user.click(cancel)
  await eventually(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  expect((await openReview(user)).value).toBe("Almost there")
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: /Delete Draft on greet.ts/ }).disabled,
  ).toBe(false)

  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  await user.click(await screen.findByRole("button", { name: "Discard feedback" }))
  await user.click(await rowFor("Wave at the world"))
  expect((await screen.findByRole("alert")).textContent).toContain("Pull request not found")
  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  await screen.findByRole("tabpanel", { name: "Needs review" })
})

it("asks before history leaves another area for the list, discarding the open PR's summary", async () => {
  const user = mount({ OpenPullRequest: () => Effect.succeed(workspaceOf(greet, "head001")) })

  await user.click(await rowFor("Greet the world"))
  await user.type(await openReview(user), "Almost there")
  await user.click(screen.getByRole("link", { name: "Settings" }))
  await screen.findByRole("main", { name: "Settings" })

  window.history.go(-2)
  const dialog = await screen.findByRole("alertdialog", { name: "Discard unpublished feedback?" })
  expect(dialog.textContent).toMatch(/Review summary/)
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }))

  await user.click(await screen.findByRole("link", { name: "Reviews" }))
  expect((await openReview(user)).value).toBe("Almost there")
})

it("waits for the discard choice before reloading unsaved Drafts and unlocks them on Escape", async () => {
  const opens: Array<
    Held<{ pullRequest: PullRequestRef }, PullRequestWorkspace, OpenPullRequestError>
  > = []

  const user = mount({
    OpenPullRequest: hold(opens),
    DeleteDraft: () => Effect.fail(new GitHubUnavailable({ message: "Offline." })),
  })

  await user.click(await rowFor("Greet the world"))
  ;(await next(opens)).answer(Effect.succeed(workspaceOf(greet, "head001", [savedDraft])))
  await user.click(await screen.findByRole("button", { name: /Delete Draft on greet.ts/ }))
  await screen.findByText("Couldn't delete")
  await user.click(screen.getByRole("button", { name: "Reload" }))
  await screen.findByRole("alertdialog", { name: "Discard unpublished feedback?" })
  expect(opens).toHaveLength(0)

  await user.keyboard("{Escape}")
  await eventually(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  expect(opens).toHaveLength(0)
  await eventually(() => {
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Delete Draft on greet.ts/ }).disabled,
    ).toBe(false)
  })

  await user.click(screen.getByRole("button", { name: "Reload" }))
  await user.click(await screen.findByRole("button", { name: "Discard feedback" }))
  ;(await next(opens)).answer(Effect.succeed(workspaceOf(greet, "head002")))
  await screen.findByText("head002")
  expect(screen.queryByText("Private feedback")).toBeNull()
})

it("switches between the PR lists, opens a PR from each, and Back to PRs returns to its list", async () => {
  const opens: Array<PullRequestRef> = []
  const myDraft = summary(glass, 50, "Sketch the inbox", { author: "kevin", isDraft: true })
  const revisited = summary(effect, 9, "Trim the scheduler", { author: "mona" })

  let requests = 0

  const user = mount({
    ListPullRequests: () =>
      Effect.sync(() => {
        requests++

        return listings({
          "needs-review": needsReview,
          "my-prs": [listed(glass, [myDraft])],
          reviewing: [listed(effect, [revisited])],
        })
      }),
    OpenPullRequest: ({ pullRequest }) => {
      opens.push(pullRequest)

      return Effect.succeed(
        workspaceOf(
          referenceKey(pullRequest) === referenceKey(myDraft.ref) ? myDraft : revisited,
          "head001",
        ),
      )
    },
  })

  const tabs = await screen.findAllByRole("tab")
  expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
    ["Needs review", "true"],
    ["My PRs", "false"],
    ["Reviewing", "false"],
    ["Queue", "false"],
  ])

  await rowFor("Greet the world")
  const loaded = requests
  await user.click(screen.getByRole("tab", { name: "My PRs" }))
  const mine = await screen.findByRole("tabpanel", { name: "My PRs" })
  expect(requests).toBe(loaded)
  expect(within(mine).queryByText("Greet the world")).toBeNull()
  expect(
    (await within(mine).findByRole("button", { name: /^Sketch the inbox/ })).textContent,
  ).toMatch(/Sketch the inbox.*Draft PR.*#50.*kevin/)

  await user.click(within(mine).getByRole("button", { name: /^Sketch the inbox/ }))
  await user.click(await screen.findByRole("button", { name: "Back to PRs" }))

  const returned = await screen.findByRole("tab", { name: "My PRs" })
  expect(returned.getAttribute("aria-selected")).toBe("true")
  returned.focus()
  await user.keyboard("{ArrowRight}{Enter}")
  const reviewing = await screen.findByRole("tabpanel", { name: "Reviewing" })
  const row = await within(reviewing).findByRole("button", { name: /^Trim the scheduler/ })
  expect(row.textContent).not.toMatch(/Draft PR/)

  await user.click(row)
  await screen.findByRole("button", { name: "Back to PRs" })
  expect(opens).toEqual([myDraft.ref, revisited.ref])
})

it("returns to the PR's tab after another area", async () => {
  const user = mount({ OpenPullRequest: () => Effect.succeed(workspaceOf(greet, "head001")) })

  await user.click(await rowFor("Greet the world"))
  await user.click(await screen.findByRole("tab", { name: "Changes" }))
  await user.click(screen.getByRole("link", { name: "Settings" }))
  await screen.findByRole("main", { name: "Settings" })
  await user.click(screen.getByRole("link", { name: "Reviews" }))

  const changes = await screen.findByRole("tab", { name: "Changes" })
  expect(changes.getAttribute("aria-selected")).toBe("true")
})
