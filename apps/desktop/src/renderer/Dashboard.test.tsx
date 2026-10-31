// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  PullRequestRef,
  PullRequestSummary,
  QueuedPullRequest,
  Revision,
  ToDo,
} from "@glass/contracts"
import { cleanup, render, screen, within } from "@testing-library/react"
import { DateTime, Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { type Handlers, testLayer } from "../../test/testBackend"

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

const mount = (handlers: Partial<Handlers>) => {
  window.history.replaceState(null, "", "#/dashboard")

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
