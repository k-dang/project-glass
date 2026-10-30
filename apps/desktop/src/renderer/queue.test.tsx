// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  Discussions,
  GitHubConnection,
  GitHubUnavailable,
  PullRequest,
  PullRequestRef,
  type PullRequestState,
  PullRequestSummary,
  PullRequestWorkspace,
  QueueAddition,
  QueuedPullRequest,
  noListings,
  referenceKey,
  Revision,
  TourFailure,
  type TourState,
} from "@glass/contracts"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect, Stream, SubscriptionRef } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { openReview } from "../../test/finishReview"
import { type Handlers, testLayer } from "../../test/testBackend"
import { pullRequestFields, viewer } from "../../test/workspace"

const summary = (owner: string, repo: string, number: number, title: string) =>
  new PullRequestSummary({
    ref: new PullRequestRef({ owner, repo, number }),
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title,
    author: "hubot",
    isDraft: false,
    checks: "passing",
    updatedAt: DateTime.makeUnsafe(Date.now() - 60 * 60 * 1000),
  })

const greet = summary("octo-org", "glass", 42, "Greet the world")

const wave = summary("mona", "elsewhere", 7, "Wave at the world")

const fibers = summary("effect-ts", "effect", 9, "Speed up fibers")

let clock = Date.UTC(2026, 9, 1)

const revisionOf = (pr: PullRequestSummary) =>
  new Revision({ base: "base000", head: `head-${pr.ref.number}` })

const queued = (
  pullRequest: PullRequestSummary,
  fields: { state?: PullRequestState; openedSinceQueued?: boolean } = {},
) =>
  new QueuedPullRequest({
    id: `PR_${pullRequest.ref.number}`,
    queuedAt: DateTime.makeUnsafe((clock += 1000)),
    pullRequest,
    state: fields.state ?? "open",
    revision: revisionOf(pullRequest),
    openedSinceQueued: fields.openedSinceQueued ?? false,
    problem: null,
  })

const workspaceOf = (pr: PullRequestSummary) =>
  new PullRequestWorkspace({
    viewer,
    pullRequest: new PullRequest({
      ...pullRequestFields,
      id: `PR_${pr.ref.number}`,
      ref: pr.ref,
      url: pr.url,
      title: pr.title,
      author: pr.author,
    }),
    revision: revisionOf(pr),
    updatedAt: pr.updatedAt,
    files: [],
    viewedPaths: [],
    discussions: new Discussions({ onLines: [], outdated: [], timeline: [] }),
    drafts: [],
  })

const keyOf = (entry: QueuedPullRequest) => referenceKey(entry.pullRequest.ref)

const mount = (
  initial: ReadonlyArray<QueuedPullRequest>,
  known = [greet, wave, fibers],
  watchTour: Handlers["WatchTour"] = () => Stream.make({ tour: null, job: { status: "idle" } }),
) => {
  let entries = [...initial]

  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    ListFollowedRepositories: () => Effect.succeed([]),
    ListPullRequests: () => Effect.succeed(noListings),
    ListSavedQueue: () => Effect.sync(() => entries),
    RefreshQueue: () => Effect.void,
    AddToQueue: ({ references }) =>
      Effect.sync(() => {
        const added: Array<PullRequestRef> = []
        const alreadyQueued: Array<PullRequestRef> = []
        const notFound: Array<PullRequestRef> = []

        for (const ref of references) {
          const found = known.find((pr) => referenceKey(pr.ref) === referenceKey(ref))

          if (entries.some((entry) => keyOf(entry) === referenceKey(ref))) alreadyQueued.push(ref)
          else if (found === undefined) notFound.push(ref)
          else {
            entries.push(queued(found))
            added.push(found.ref)
          }
        }

        return new QueueAddition({ added, alreadyQueued, notFound })
      }),
    RemoveFromQueue: ({ reference }) =>
      Effect.sync(() => {
        const removed = entries.find((entry) => keyOf(entry) === referenceKey(reference)) ?? null
        entries = entries.filter((entry) => entry !== removed)

        return removed
      }),
    RestoreToQueue: ({ queued: restored }) =>
      Effect.sync(() => {
        entries = [...entries, restored].toSorted(
          (a, b) => DateTime.toEpochMillis(a.queuedAt) - DateTime.toEpochMillis(b.queuedAt),
        )
      }),
    OpenPullRequest: ({ pullRequest }) =>
      Effect.succeed(
        workspaceOf(known.find((pr) => referenceKey(pr.ref) === referenceKey(pullRequest))!),
      ),
    RecordActivity: () => Effect.void,
    SubmitReview: ({ pullRequestId }) =>
      Effect.sync(() => {
        entries = entries.filter((entry) => entry.id !== pullRequestId)
      }),
    WatchTour: watchTour,
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

const openQueue = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("tab", { name: /^Queue/ }))

  return screen.findByRole("tabpanel", { name: /^Queue/ })
}

const field = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Add to the Queue" })

const note = () => screen.getByRole("status", { name: "Queue field status" })

const rows = (panel: HTMLElement) =>
  within(within(panel).getByRole("list", { name: "Queue" }))
    .getAllByRole("button", { name: /world|fibers/ })
    .map((row) => row.textContent)

it("queues every PR in a paste at once, and reports duplicates and problems", async () => {
  const user = mount([])
  const tab = await screen.findByRole("tab", { name: /^Queue/ })
  expect(tab.textContent).toBe("Queue")
  const panel = await openQueue(user)
  await within(panel).findByText("Your Queue is empty")

  await user.click(field())
  await user.paste(`Could you look at ${greet.url} and mona/elsewhere#7 today?`)
  await eventually(() => expect(field().value).toBe(""))
  expect(note().textContent).toBe("")
  expect(rows(panel)).toEqual([
    expect.stringMatching(/Greet the worldglass#42/),
    expect.stringMatching(/Wave at the worldelsewhere#7/),
  ])
  expect(tab.textContent).toBe("Queue2")
  expect(field().value).toBe("")

  await user.paste(`OCTO-ORG/Glass#42 and ${fibers.url}`)
  await eventually(() => expect(note().textContent).toBe("1 already queued"))
  await user.paste("octo-org/glass#42")
  await eventually(() => expect(note().textContent).toBe("Already queued"))

  await user.type(field(), "nobody/nothing#1{Enter}")
  await eventually(() => expect(note().textContent).toBe("Couldn't find nobody/nothing#1"))
  expect(field().value).toBe("nobody/nothing#1")

  await user.clear(field())
  await user.type(field(), "just some words{Enter}")
  expect(note().textContent).toBe("Not a PR link")
  expect(rows(panel)).toHaveLength(3)
})

it("keeps pasted text in the field when GitHub can't be reached", async () => {
  window.history.replaceState(null, "", "#/reviews?list=queue")

  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    ListFollowedRepositories: () => Effect.succeed([]),
    ListPullRequests: () => Effect.succeed(noListings),
    AddToQueue: () => Effect.fail(new GitHubUnavailable({ message: "Offline." })),
  })

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <App />
    </RegistryProvider>,
  )

  const user = userEvent.setup()
  await screen.findByText("Your Queue is empty")
  await user.click(field())
  await user.paste(greet.url)
  await eventually(() => expect(note().textContent).toBe("Couldn't reach GitHub. Offline."))
  expect(field().value).toBe(greet.url)
})

it("marks unopened and finished PRs, and Undo puts a removed PR back in its place", async () => {
  window.history.replaceState(null, "", "#/reviews?list=queue")

  const user = mount([
    queued(greet, { openedSinceQueued: true }),
    queued(wave, { state: "merged" }),
    queued(fibers, { state: "closed", openedSinceQueued: true }),
  ])

  const panel = await screen.findByRole("tabpanel", { name: /^Queue/ })
  await within(panel).findByRole("button", { name: /Greet the world/ })
  expect(rows(panel)).toEqual([
    expect.not.stringMatching(/Not opened|Merged|Closed/),
    expect.stringMatching(/Not opened.*Wave at the world.*Merged/),
    expect.stringMatching(/^(?!.*Not opened).*Speed up fibers.*Closed/),
  ])

  await user.click(screen.getByRole("button", { name: "Remove mona/elsewhere#7 from the Queue" }))
  await eventually(() => expect(rows(panel)).toHaveLength(2))
  await user.click(await screen.findByRole("button", { name: "Undo" }))
  await eventually(() =>
    expect(rows(panel)).toEqual([
      expect.stringContaining("Greet the world"),
      expect.stringContaining("Wave at the world"),
      expect.stringContaining("Speed up fibers"),
    ]),
  )
})

it.each([
  ["merged", "Merged", "lucide-git-merge"],
  ["closed", "Closed", "lucide-git-pull-request-closed"],
] as const)(
  "shows %s in the leading icon with a hover and keyboard hint",
  async (state, label, icon) => {
    window.history.replaceState(null, "", "#/reviews?list=queue")
    const user = mount([queued(wave, { state })])

    const row = await screen.findByRole("button", {
      name: new RegExp(`Wave at the world.*${label}`),
    })

    expect(row.querySelector(`svg.${icon}`)).not.toBeNull()
    expect(within(row).getByText(label).classList.contains("sr-only")).toBe(true)
    expect(within(row).queryByText(/Checks/)).toBeNull()

    await user.click(field())
    await user.tab()
    expect(document.activeElement).toBe(row)
    expect((await screen.findByRole("tooltip")).textContent).toBe(label)
    await user.keyboard("{Escape}")
    await eventually(() => expect(screen.queryByRole("tooltip")).toBeNull())

    await user.tab()
    await user.hover(row.querySelector("svg")!)
    expect((await screen.findByRole("tooltip")).textContent).toBe(label)
    await user.unhover(row.querySelector("svg")!)
    await eventually(() => expect(screen.queryByRole("tooltip")).toBeNull())
  },
)

const savedTour = (head: string): TourState => ({
  tour: {
    revision: new Revision({ base: "base000", head }),
    writtenAt: DateTime.makeUnsafe(clock),
    intent: "Explain the change.",
    chapters: [],
    everythingElse: [],
  },
  job: { status: "idle" },
})

it("shows where each queued PR's Tour stands as it changes", async () => {
  window.history.replaceState(null, "", "#/reviews?list=queue")

  const greetTour = Effect.runSync(
    SubscriptionRef.make<TourState>({ tour: null, job: { status: "waiting" } }),
  )

  const failed: TourState = {
    tour: null,
    job: {
      status: "failed",
      reason: new TourFailure({
        reason: "not-ready",
        message: "Claude Code is not signed in.",
        runner: null,
      }),
    },
  }

  const states = new Map([
    [referenceKey(greet.ref), SubscriptionRef.changes(greetTour)],
    [referenceKey(wave.ref), Stream.make(failed)],
    [referenceKey(fibers.ref), Stream.make(savedTour("older-head"))],
  ])

  mount([queued(greet), queued(wave), queued(fibers)], undefined, ({ pullRequest }) =>
    states.get(referenceKey(pullRequest))!,
  )

  const panel = await screen.findByRole("tabpanel", { name: /^Queue/ })
  await eventually(() =>
    expect(rows(panel)).toEqual([
      expect.stringContaining("Tour waiting"),
      expect.stringContaining("Tour failed: Claude Code is not signed in."),
      expect.stringContaining("Tour outdated"),
    ]),
  )

  const startedAt = Date.now()
  await Effect.runPromise(
    SubscriptionRef.set(greetTour, {
      tour: null,
      job: { status: "writing", startedAt, runner: null },
    }),
  )
  await eventually(() => expect(rows(panel)[0]).toContain("Writing Tour"))
  await Effect.runPromise(SubscriptionRef.set(greetTour, savedTour(revisionOf(greet).head)))
  await eventually(() => expect(rows(panel)[0]).toContain("Tour ready"))
})

const bar = () => screen.getByRole("region", { name: "Queue" })

const showing = (title: string) =>
  screen.findByRole("heading", { level: 1, name: new RegExp(`^${title} #`) })

it.each(["Control", "Meta"])(
  "steps through the Queue with the %s shortcut, and Back to PRs returns to the Queue tab",
  async (modifier) => {
    window.history.replaceState(null, "", "#/reviews?list=queue")
    const user = mount([queued(greet), queued(wave), queued(fibers)])

    await user.click(await screen.findByRole("button", { name: /Wave at the world/ }))
    await showing("Wave at the world")
    expect(bar().textContent).toContain("2 of 3")
    const dots = within(bar()).getByRole("list", { name: "Queue order" })

    expect(
      within(dots)
        .getAllByRole("button")
        .map((dot) => [dot.getAttribute("aria-label"), dot.getAttribute("aria-current")]),
    ).toEqual([
      ["Greet the world", null],
      ["Wave at the world", "true"],
      ["Speed up fibers", null],
    ])

    await user.click(within(dots).getByRole("button", { name: "Greet the world" }))
    await showing("Greet the world")
    expect(bar().textContent).toContain("1 of 3")
    await user.click(within(bar()).getByRole("button", { name: "Next PR" }))
    await showing("Wave at the world")

    await user.keyboard(`{${modifier}>}{Shift>}[BracketRight]{/Shift}{/${modifier}}`)
    await showing("Speed up fibers")
    fireEvent.keyDown(window, {
      key: "}",
      code: "BracketRight",
      metaKey: modifier === "Meta",
      ctrlKey: modifier === "Control",
      shiftKey: true,
    })
    await showing("Greet the world")
    expect(bar().textContent).toContain("1 of 3")

    await user.click(within(bar()).getByRole("button", { name: "Remove & next" }))
    await showing("Wave at the world")
    expect(bar().textContent).toContain("1 of 2")

    await user.keyboard(`{${modifier}>}]{/${modifier}}`)
    await showing("Speed up fibers")
    expect(bar().textContent).toContain("1 of 1")
    expect(within(bar()).queryByRole("button", { name: "Next PR" })).toBeNull()

    await user.click(within(bar()).getByRole("button", { name: /^Remove/ }))
    await eventually(() => expect(screen.queryByRole("region", { name: "Queue" })).toBeNull())
    await showing("Speed up fibers")

    await user.click(screen.getByRole("button", { name: "Back to PRs" }))
    const tab = await screen.findByRole("tab", { name: /^Queue/ })
    expect(tab.getAttribute("aria-selected")).toBe("true")
    await screen.findByText("Your Queue is empty")
  },
)

it("keeps the bar while a reviewed PR stays open, offering the next one, until the user leaves it", async () => {
  window.history.replaceState(null, "", "#/reviews?list=queue")
  const user = mount([queued(greet), queued(wave)])

  await user.click(await screen.findByRole("button", { name: /Greet the world/ }))
  await showing("Greet the world")
  await user.type(await openReview(user), "Looks good")
  await user.click(screen.getByRole("button", { name: /^Submit Review/ }))
  await eventually(() => expect(bar().textContent).toContain("Reviewed · out of the Queue"))

  await user.click(screen.getByRole("link", { name: "Settings" }))
  await user.click(screen.getByRole("link", { name: "Reviews" }))
  await showing("Greet the world")
  expect(bar().textContent).toContain("Reviewed · out of the Queue")

  await user.click(within(bar()).getByRole("button", { name: "Next PR" }))
  await showing("Wave at the world")
  expect(bar().textContent).toContain("1 of 1")
  await user.click(within(bar()).getByRole("button", { name: /^Remove/ }))
  await eventually(() => expect(screen.queryByRole("region", { name: "Queue" })).toBeNull())

  await user.click(screen.getByRole("button", { name: "Back to PRs" }))
  await user.click(await screen.findByRole("textbox", { name: "Add to the Queue" }))
  await user.paste(greet.url)
  await user.click(await screen.findByRole("button", { name: /Greet the world/ }))
  await showing("Greet the world")
  expect(bar().textContent).toContain("1 of 1")
  await user.click(within(bar()).getByRole("button", { name: /^Remove/ }))
  await eventually(() => expect(screen.queryByRole("region", { name: "Queue" })).toBeNull())
})

it("adds PRs to the Queue from the bar without leaving the PR under review", async () => {
  window.history.replaceState(null, "", "#/reviews?list=queue")
  const user = mount([queued(greet)])

  await user.click(await screen.findByRole("button", { name: /Greet the world/ }))
  await showing("Greet the world")
  expect(bar().textContent).toContain("1 of 1")

  await user.click(within(bar()).getByRole("button", { name: "Add" }))
  await user.click(await screen.findByRole("textbox", { name: "Add to the Queue" }))
  await user.paste(greet.url)
  await eventually(() => expect(note().textContent).toBe("Already queued"))

  await user.paste(`${wave.url} ${fibers.url}`)
  await eventually(() => expect(bar().textContent).toContain("1 of 3"))
  await eventually(() =>
    expect(screen.queryByRole("textbox", { name: "Add to the Queue" })).toBeNull(),
  )
  await showing("Greet the world")
})
