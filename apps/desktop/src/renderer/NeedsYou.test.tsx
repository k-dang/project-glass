// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  AgentNeedsYou,
  AgentReviewFinished,
  AllowRequest,
  GitHubConnection,
  type NeedsYou,
  PermissionRequestPart,
  PullRequestNeedsYou,
  PullRequestRef,
  PullRequestSummary,
  type RequestAnswer,
  ReviewRequested,
  WaitingRequests,
} from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect, SubscriptionRef } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { App } from "./App"
import { backendLayerAtom } from "./backend"
import { agent } from "../../test/agent"
import { type Handlers, type Held, hold, next, testLayer } from "../../test/testBackend"

const ago = (parts: Partial<DateTime.DateTime.PartsForMath>) =>
  DateTime.subtract(DateTime.nowUnsafe(), parts)

const bashRequest = PermissionRequestPart.make({
  requestId: "bash-1",
  toolName: "Bash",
  inputSummary: "pnpm test",
  input: '{ "command": "pnpm test" }',
  status: "waiting",
  reason: null,
})

const waitingAgent = AgentNeedsYou.make({
  agent,
  reasons: [WaitingRequests.make({ requests: [bashRequest] })],
  since: ago({ days: 2 }),
})

const ref = new PullRequestRef({ owner: "octo-org", repo: "glass", number: 42 })

const reviewRequested = PullRequestNeedsYou.make({
  pullRequest: new PullRequestSummary({
    ref,
    url: "https://github.com/octo-org/glass/pull/42",
    title: "Retry flaky upload",
    author: "hubot",
    isDraft: false,
    checks: "passing",
    updatedAt: DateTime.makeUnsafe("2026-10-30T11:00:00Z"),
  }),
  reasons: [ReviewRequested.make({}), AgentReviewFinished.make({})],
  since: ago({ hours: 3 }),
})

const needsYouRef = (items: NeedsYou) => Effect.runSync(SubscriptionRef.make(items))

const setNeedsYou = (needsYou: SubscriptionRef.SubscriptionRef<NeedsYou>, items: NeedsYou) =>
  Effect.runPromise(SubscriptionRef.set(needsYou, items))

const mount = (
  needsYou: SubscriptionRef.SubscriptionRef<NeedsYou>,
  handlers: Partial<Handlers> = {},
  path = "/",
) => {
  window.history.replaceState(null, "", `#${path}`)

  render(
    <RegistryProvider
      initialValues={[
        [
          backendLayerAtom,
          testLayer({
            GetConnection: () =>
              Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
            WatchNeedsYou: () => SubscriptionRef.changes(needsYou),
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
  window.history.replaceState(null, "", "#/")
})

it("says nothing needs you when nothing is waiting", async () => {
  mount(needsYouRef([]))

  expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy()
})

it("answers a waiting Agent's Permission request in its row, and drops the row when Needs you does", async () => {
  const needsYou = needsYouRef([waitingAgent])
  const answers: Array<{ agentId: string; requestId: string; answer: RequestAnswer }> = []

  const user = mount(needsYou, {
    AnswerRequest: (payload) => Effect.sync(() => void answers.push(payload)),
  })

  const list = await screen.findByRole("list", { name: "Needs you" })
  const [row] = within(list).getAllByRole("listitem")
  expect(within(row!).getByRole("link", { name: agent.name })).toBeTruthy()
  expect(within(row!).getByText("Permission request")).toBeTruthy()
  expect(within(row!).getByText("2d").textContent).toBe("waiting 2d")

  const card = within(row!).getByRole("region", { name: "Allow Bash?" })
  await user.click(within(card).getByRole("button", { name: "Allow" }))

  expect(answers).toEqual([
    { agentId: agent.id, requestId: "bash-1", answer: AllowRequest.make({}) },
  ])
  expect(within(list).getByRole("link", { name: agent.name })).toBeTruthy()

  await setNeedsYou(needsYou, [])

  expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy()
  expect(screen.queryByRole("link", { name: agent.name })).toBeNull()
})

it("lists a PR with its reasons and opens it", async () => {
  const opened: Array<Held<{ readonly pullRequest: PullRequestRef }, never, never>> = []

  const user = mount(needsYouRef([reviewRequested]), { OpenPullRequest: hold(opened) })

  const list = await screen.findByRole("list", { name: "Needs you" })
  const link = within(list).getByRole("link", { name: /Retry flaky upload/ })
  expect(within(link).getByText("octo-org/glass#42")).toBeTruthy()
  expect(within(link).getByText("Review requested · Agent review finished")).toBeTruthy()
  expect(within(link).getByText("3h").textContent).toBe("waiting 3h")

  await user.click(link)

  expect((await next(opened)).payload.pullRequest).toEqual(ref)
  expect(window.location.hash).toBe("#/reviews/octo-org/glass/42")
})

it("counts what needs you on the Dashboard link from another area", async () => {
  const needsYou = needsYouRef([waitingAgent, reviewRequested])

  mount(needsYou, {}, "/to-dos")

  expect(
    await screen.findByRole("link", { name: "Dashboard", description: "2 need you" }),
  ).toBeTruthy()

  await setNeedsYou(needsYou, [])

  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Dashboard", description: /need you/ })).toBeNull(),
  )
  expect(screen.getByRole("link", { name: "Dashboard" }).textContent).toBe("")
})
