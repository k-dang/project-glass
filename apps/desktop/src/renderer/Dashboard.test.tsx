// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  type ActivityLogError,
  ActivityStamp,
  PullRequestRef,
  PullRequestSummary,
  QueuedPullRequest,
  Revision,
  ToDo,
} from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { type Handlers, type Held, hold, next, testLayer } from "../../test/testBackend"

const queued = (number: number, title: string) =>
  new QueuedPullRequest({
    id: `PR_${number}`,
    queuedAt: DateTime.makeUnsafe("2026-10-30T12:00:00Z"),
    pullRequest: new PullRequestSummary({
      ref: new PullRequestRef({ owner: "octo-org", repo: "glass", number }),
      url: `https://github.com/octo-org/glass/pull/${number}`,
      title,
      author: "hubot",
      isDraft: false,
      checks: "passing",
      updatedAt: DateTime.makeUnsafe("2026-10-30T11:00:00Z"),
    }),
    state: "open",
    revision: new Revision({ base: "base000", head: `head-${number}` }),
    openedSinceQueued: false,
    problem: null,
  })

const stamp = (kind: ActivityStamp["kind"], occurredAt: Date) =>
  new ActivityStamp({ kind, occurredAt: DateTime.fromDateUnsafe(occurredAt) })

const mount = (handlers: Partial<Handlers>) => {
  window.history.replaceState(null, "", "#/")

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, testLayer(handlers)]]}>
      <App />
    </RegistryProvider>,
  )
}

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "#/")
})

it("lists the Queue and the open To-dos", async () => {
  mount({
    ListSavedQueue: () => Effect.succeed([queued(42, "Greet the world"), queued(7, "Wave")]),
    ListToDos: () =>
      Effect.succeed([
        new ToDo({ id: 1, title: "Reply to Mona", notes: "", done: false }),
        new ToDo({ id: 2, title: "Rebase the branch", notes: "", done: true }),
      ]),
  })

  const queue = await screen.findByRole("list", { name: "Queue" })
  expect(
    within(queue)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href")),
  ).toEqual(["/#/reviews/octo-org/glass/42", "/#/reviews/octo-org/glass/7"])

  const toDos = await screen.findByRole("list", { name: "Open to-dos" })
  expect(
    within(toDos)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Reply to Mona"])
})

it("shows the first five queued PRs", async () => {
  mount({
    ListSavedQueue: () =>
      Effect.succeed([1, 2, 3, 4, 5, 6].map((number) => queued(number, `Change ${number}`))),
  })

  const queue = await screen.findByRole("list", { name: "Queue" })
  expect(
    within(queue)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual([
    "Change 1 glass",
    "Change 2 glass",
    "Change 3 glass",
    "Change 4 glass",
    "Change 5 glass",
  ])
})

it("totals what the user got done over the chosen days", async () => {
  const now = new Date()

  const today = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)

  mount({
    ListActivityStamps: () =>
      Effect.succeed([
        stamp("ReplySent", today(-10)),
        stamp("ReplySent", now),
        stamp("ToDoDone", now),
        stamp("ReviewSubmitted", today(-40)),
      ]),
  })

  const totals = await screen.findByRole("list", { name: "Activity totals" })
  expect(
    within(totals)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Reviews 0", "Replies 2", "Agents started 0", "To-dos done 1"])

  await userEvent.setup().click(screen.getByRole("button", { name: "7 days" }))
  expect(
    within(screen.getByRole("list", { name: "Activity totals" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Reviews 0", "Replies 1", "Agents started 0", "To-dos done 1"])
})

it("keeps the Activity chart visible while refreshing on a return to the Dashboard", async () => {
  const reads: Array<
    Held<
      Parameters<Handlers["ListActivityStamps"]>[0],
      ReadonlyArray<ActivityStamp>,
      ActivityLogError
    >
  > = []

  const now = new Date()
  const user = userEvent.setup()

  mount({ ListActivityStamps: hold(reads) })
  const first = await next(reads)
  expect(screen.getByText("Loading your Activity…")).toBeTruthy()
  first.answer(Effect.succeed([stamp("AgentStarted", now)]))
  await screen.findByText("Agents started", { exact: false })
  expect(screen.getByRole("list", { name: "Activity totals" }).textContent).toContain(
    "Agents started 1",
  )

  await user.click(screen.getByRole("link", { name: "Go to Activity" }))
  await screen.findByRole("main", { name: "Activity" })
  await user.click(screen.getByRole("link", { name: "Dashboard" }))
  const refresh = await next(reads)

  expect(screen.queryByText("Loading your Activity…")).toBeNull()
  expect(screen.getByRole("list", { name: "Activity totals" }).textContent).toContain(
    "Agents started 1",
  )

  refresh.answer(Effect.succeed([stamp("AgentStarted", now), stamp("AgentStarted", now)]))
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Activity totals" }).textContent).toContain(
      "Agents started 2",
    ),
  )
})
