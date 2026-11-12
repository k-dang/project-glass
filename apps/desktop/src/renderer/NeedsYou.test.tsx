// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  Agent,
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
import { agent, agentFields } from "../../test/agent"
import { backendLayerAtom } from "./backend"
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

const laterAgent = AgentNeedsYou.make({
  agent: new Agent({ ...agentFields, id: "agent-2", name: "agent/quiet-lynx" }),
  reasons: [
    WaitingRequests.make({
      requests: [
        PermissionRequestPart.make({
          requestId: "bash-2",
          toolName: "Bash",
          inputSummary: "pnpm test",
          input: '{ "command": "pnpm test" }',
          status: "waiting",
          reason: null,
        }),
      ],
    }),
  ],
  since: ago({ hours: 1 }),
})

const ref = new PullRequestRef({ owner: "octo-org", repo: "glass", number: 42 })

const summary = (
  pullRequest: PullRequestRef,
  title: string,
  isDraft: boolean,
  updatedAt: DateTime.Utc,
) =>
  new PullRequestSummary({
    ref: pullRequest,
    url: `https://github.com/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}`,
    title,
    author: "hubot",
    isDraft,
    checks: "passing",
    updatedAt,
  })

const reviewRequested = PullRequestNeedsYou.make({
  pullRequest: summary(ref, "Retry flaky upload", false, ago({ hours: 5 })),
  reasons: [ReviewRequested.make({}), AgentReviewFinished.make({})],
  since: ago({ hours: 3 }),
})

const draftRef = new PullRequestRef({ owner: "octo-org", repo: "glass", number: 8 })

const finishedDraft = PullRequestNeedsYou.make({
  pullRequest: summary(draftRef, "Sketch the empty state", true, ago({ hours: 1 })),
  reasons: [AgentReviewFinished.make({})],
  since: ago({ minutes: 12 }),
})

const needsYouRef = (items: NeedsYou) => Effect.runSync(SubscriptionRef.make(items))

const setNeedsYou = (needsYou: SubscriptionRef.SubscriptionRef<NeedsYou>, items: NeedsYou) =>
  Effect.runPromise(SubscriptionRef.set(needsYou, items))

const mount = (
  needsYou: SubscriptionRef.SubscriptionRef<NeedsYou>,
  handlers: Partial<Handlers> = {},
  path = "/inbox",
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

const articleOf = (name: string) => {
  const article = screen.getByRole("heading", { name }).closest("article")

  if (article === null) throw new Error(`No article for ${name}`)

  return article
}

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "#/")
})

it("says nothing needs you in the Inbox, and the Dashboard only links to that count", async () => {
  const user = mount(needsYouRef([]), {}, "/")

  const dashboard = await screen.findByRole("main", { name: "Dashboard" })
  const link = within(dashboard).getByRole("link", { name: "Needs you 0" })
  expect(within(dashboard).queryByRole("region", { name: "Stopped on you" })).toBeNull()

  await user.click(link)

  expect(await screen.findByRole("main", { name: "Inbox" })).toBeTruthy()
  expect(screen.getAllByText("Nothing needs you right now.").length).toBeGreaterThan(0)
})

it("groups Agents, review requests, and finished reviews, and labels a draft", async () => {
  mount(needsYouRef([waitingAgent, reviewRequested, finishedDraft]))

  const stopped = await screen.findByRole("region", { name: "Stopped on you" })
  const holding = screen.getByRole("region", { name: "Holding up work" })
  const waiting = screen.getByRole("region", { name: "Waiting on you" })

  expect(within(stopped).getByRole("button", { name: /agent\/swift-otter/ })).toBeTruthy()
  expect(within(holding).getByText(/Review requested · Agent review finished/)).toBeTruthy()
  expect(within(holding).getByRole("button", { name: /Retry flaky upload/ })).toBeTruthy()
  expect(within(waiting).getByText(/Draft/)).toBeTruthy()
  expect(within(waiting).getByRole("button", { name: /Sketch the empty state/ })).toBeTruthy()
  expect(screen.getByRole("heading", { name: agent.name })).toBeTruthy()
})

it("answers a permission in the detail pane and selects the next item when that one leaves", async () => {
  const needsYou = needsYouRef([waitingAgent, laterAgent])
  const answers: Array<{ agentId: string; requestId: string; answer: RequestAnswer }> = []

  const user = mount(needsYou, {
    AnswerRequest: (payload) => Effect.sync(() => void answers.push(payload)),
  })

  await screen.findByRole("heading", { name: agent.name })
  await user.click(within(articleOf(agent.name)).getByRole("button", { name: "Allow" }))

  expect(answers).toEqual([
    { agentId: agent.id, requestId: "bash-1", answer: AllowRequest.make({}) },
  ])

  await setNeedsYou(needsYou, [laterAgent])

  expect(await screen.findByRole("heading", { name: "agent/quiet-lynx" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /agent\/swift-otter/ })).toBeNull()
})

it("moves with j and k, opens a pull request with Enter, and allows with a", async () => {
  const answers: Array<{ agentId: string; requestId: string; answer: RequestAnswer }> = []
  const opened: Array<Held<{ readonly pullRequest: PullRequestRef }, never, never>> = []

  const user = mount(needsYouRef([waitingAgent, reviewRequested]), {
    AnswerRequest: (payload) => Effect.sync(() => void answers.push(payload)),
    LoadPullRequest: hold(opened),
  })

  const agentRow = await screen.findByRole("button", { name: /agent\/swift-otter/ })
  expect(agentRow.getAttribute("aria-current")).toBe("true")

  await user.keyboard("j")
  const pullRequest = screen.getByRole("button", { name: /Retry flaky upload/ })
  expect(pullRequest.getAttribute("aria-current")).toBe("true")
  expect(agentRow.getAttribute("aria-current")).toBeNull()

  await user.keyboard("k")
  expect(agentRow.getAttribute("aria-current")).toBe("true")

  await user.keyboard("a")
  expect(answers).toEqual([
    { agentId: agent.id, requestId: "bash-1", answer: AllowRequest.make({}) },
  ])

  await user.keyboard("j")
  await user.keyboard("{Enter}")

  expect((await next(opened)).payload.pullRequest).toEqual(ref)
  expect(window.location.hash).toBe("#/reviews/octo-org/glass/42")
})

it("opens the pull request and offers the Agent review when one is finished", async () => {
  const opened: Array<Held<{ readonly pullRequest: PullRequestRef }, never, never>> = []

  const user = mount(needsYouRef([reviewRequested, finishedDraft]), {
    LoadPullRequest: hold(opened),
  })

  await user.click(await screen.findByRole("button", { name: /Retry flaky upload/ }))
  const pane = within(articleOf("Retry flaky upload"))
  expect(pane.getByText(/hubot/)).toBeTruthy()
  expect(pane.getByText(/Review requested · Agent review finished/)).toBeTruthy()
  expect(pane.getByText(/Updated/)).toBeTruthy()

  expect(screen.getByRole("region", { name: "Waiting on you" }).textContent).toContain("Draft")

  await user.click(pane.getByRole("link", { name: "Read Agent review" }))

  expect((await next(opened)).payload.pullRequest).toEqual(ref)
  expect(window.location.hash).toBe("#/reviews/octo-org/glass/42")
})

it("counts what needs you on the Inbox link from another area", async () => {
  const needsYou = needsYouRef([waitingAgent, reviewRequested])

  mount(needsYou, {}, "/to-dos")

  expect(await screen.findByRole("link", { name: "Inbox", description: "2 need you" })).toBeTruthy()
  expect(screen.queryByRole("link", { name: "Dashboard", description: /need you/ })).toBeNull()

  await setNeedsYou(needsYou, [])

  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Inbox", description: /need you/ })).toBeNull(),
  )
  expect(screen.getByRole("link", { name: "Inbox" }).textContent).toBe("")
})
