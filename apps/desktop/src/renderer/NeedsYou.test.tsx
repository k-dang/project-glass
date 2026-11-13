// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  Agent,
  AgentNeedsYou,
  AgentReviewFinished,
  AllowRequest,
  AwaitingReply,
  ChangesRequested,
  Check,
  ChecksFailing,
  Discussions,
  GitHubConnection,
  type NeedsYou,
  OutsideChoice,
  OutsideQuestion,
  OutsideText,
  PermissionRequestPart,
  PullRequest,
  PullRequestNeedsYou,
  PullRequestRef,
  PullRequestSummary,
  PullRequestWorkspace,
  type OutsideQuestionAnswer,
  ReadyToMerge,
  type RequestAnswer,
  TurnFailed,
  TurnFinished,
  WaitingRequests,
} from "@glass/contracts"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Cause, DateTime, Effect, Stream, SubscriptionRef } from "effect"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { App } from "./App"
import { reviewOf } from "../../test/agentReview"
import { agent, agentFields } from "../../test/agent"
import { pullRequestFields, revision, viewer } from "../../test/workspace"
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

const finished = (pullRequest: PullRequestSummary, writtenAt: DateTime.Utc) =>
  PullRequestNeedsYou.make({
    pullRequest,
    reasons: [
      AgentReviewFinished.make({
        writtenAt,
        lead: "**The retry loses the upload's checksum.** It retries the whole upload on a 503.",
      }),
    ],
    since: writtenAt,
  })

const finishedReview = finished(
  summary(ref, "Retry flaky upload", false, ago({ hours: 5 })),
  ago({ hours: 3 }),
)

const draftRef = new PullRequestRef({ owner: "octo-org", repo: "glass", number: 8 })

const finishedDraft = finished(
  summary(draftRef, "Sketch the empty state", true, ago({ hours: 1 })),
  ago({ minutes: 12 }),
)

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

const waitLabels = () => screen.getAllByRole("time").map((time) => time.textContent ?? "")

const articleOf = (name: string) => {
  const article = screen.getByRole("heading", { name }).closest("article")

  if (article === null) throw new Error(`No article for ${name}`)

  return article
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.history.replaceState(null, "", "#/")
})

it("says nothing needs you in the Inbox, and the Dashboard only links to that count", async () => {
  const user = mount(needsYouRef([]), {}, "/")

  const dashboard = await screen.findByRole("main", { name: "Dashboard" })
  const link = within(dashboard).getByRole("link", { name: "Needs you 0" })
  expect(within(dashboard).queryByRole("region", { name: "Stopped on you" })).toBeNull()

  await user.click(link)

  expect(await screen.findByRole("main", { name: "Inbox" })).toBeTruthy()
  expect(screen.getByRole("heading", { name: "Inbox 0" })).toBeTruthy()
  expect(screen.getAllByText("Nothing needs you right now.").length).toBeGreaterThan(0)
})

it("keeps a loading or failed Needs you off the empty Inbox", async () => {
  const user = mount(needsYouRef([]), { WatchNeedsYou: () => Stream.never }, "/")

  const dashboard = await screen.findByRole("main", { name: "Dashboard" })
  expect(within(dashboard).getByRole("link", { name: "Needs you" })).toBeTruthy()
  expect(within(dashboard).queryByRole("link", { name: "Needs you 0" })).toBeNull()
  expect(screen.queryByRole("link", { name: "Inbox", description: /need you/ })).toBeNull()

  await user.click(screen.getByRole("link", { name: "Inbox" }))

  expect(await screen.findByText("Loading what needs you…")).toBeTruthy()
  expect(screen.queryByText("Nothing needs you right now.")).toBeNull()
  expect(screen.getByRole("heading", { name: "Inbox" }).textContent).not.toContain("0")
  expect(screen.queryByRole("heading", { name: "Inbox 0" })).toBeNull()
})

it("shows a failed Needs you as a failure, not an empty Inbox", async () => {
  const user = mount(
    needsYouRef([]),
    { WatchNeedsYou: () => Stream.failCause(Cause.die("Needs you dropped")) },
    "/",
  )

  const dashboard = await screen.findByRole("main", { name: "Dashboard" })
  expect(within(dashboard).queryByRole("link", { name: "Needs you 0" })).toBeNull()
  expect(within(dashboard).getByRole("link", { name: "Needs you" })).toBeTruthy()

  await user.click(screen.getByRole("link", { name: "Inbox" }))

  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
  expect(screen.queryByText("Nothing needs you right now.")).toBeNull()
  expect(screen.queryByRole("heading", { name: "Inbox 0" })).toBeNull()
  expect(screen.queryByRole("link", { name: "Needs you 0" })).toBeNull()
})

it("advances the wait while the Inbox stays open", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
  const openedAt = DateTime.nowUnsafe()

  const fresh = finished(summary(ref, "Retry flaky upload", false, openedAt), openedAt)

  mount(needsYouRef([fresh]))

  expect(await screen.findByText(/Updated now/)).toBeTruthy()
  expect(waitLabels().some((text) => text.includes("now"))).toBe(true)

  await act(() => vi.advanceTimersByTimeAsync(60_000))

  expect(screen.getByText(/Updated 1m/)).toBeTruthy()
  expect(screen.queryByText(/Updated now/)).toBeNull()
  expect(waitLabels().every((text) => text.includes("1m"))).toBe(true)
  expect(waitLabels().some((text) => text.includes("now"))).toBe(false)
})

it("groups Agents and finished reviews, and labels a draft", async () => {
  mount(needsYouRef([waitingAgent, finishedReview, finishedDraft]))

  const stopped = await screen.findByRole("region", { name: "Stopped on you" })
  const reviews = screen.getByRole("region", { name: "Agent reviews to read" })

  expect(within(stopped).getByRole("button", { name: /agent\/swift-otter/ })).toBeTruthy()
  expect(within(reviews).getByRole("button", { name: /Retry flaky upload/ })).toBeTruthy()
  expect(within(reviews).getByText(/Draft/)).toBeTruthy()
  expect(within(reviews).getByRole("button", { name: /Sketch the empty state/ })).toBeTruthy()
  expect(screen.getByRole("heading", { name: agent.name })).toBeTruthy()
})

it("puts an Agent whose Turn finished unseen under Agents that finished, saying how it ended", async () => {
  const user = mount(
    needsYouRef([
      AgentNeedsYou.make({
        agent,
        reasons: [
          TurnFinished.make({
            ended: {
              at: ago({ minutes: 2 }),
              ending: TurnFailed.make({ reason: "Out of tokens" }),
            },
          }),
        ],
        since: ago({ minutes: 2 }),
      }),
    ]),
  )

  const finishedAgents = await screen.findByRole("region", { name: "Agents that finished" })
  const row = within(finishedAgents).getByRole("button", { name: /agent\/swift-otter/ })
  await user.click(row)
  expect(within(row).getByText("glass-demo/greeter")).toBeTruthy()
  expect(within(row).getByText("Failed")).toBeTruthy()
  expect(screen.queryByRole("region", { name: "Stopped on you" })).toBeNull()
  expect(within(articleOf(agent.name)).getByRole("link", { name: "Open the Agent" })).toBeTruthy()
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

const outsideQuestion = OutsideQuestion.make({
  id: "ask-1",
  question: "Ship the retry change?",
  choices: ["Ship it", "Hold it"],
  askedBy: "Claude Code",
  since: ago({ minutes: 1 }),
})

it("answers an outside question in Stopped on you", async () => {
  const answers: Array<{ id: string; answer: OutsideQuestionAnswer }> = []
  const needsYou = needsYouRef([outsideQuestion, finishedReview])

  const user = mount(needsYou, {
    AnswerOutsideQuestion: (payload) => Effect.sync(() => void answers.push(payload)),
  })

  const stopped = await screen.findByRole("region", { name: "Stopped on you" })
  const row = within(stopped).getByRole("button", { name: /Ship the retry change/ })
  expect(row.getAttribute("aria-current")).toBe("true")
  expect(within(stopped).getByText("Asked by Claude Code")).toBeTruthy()

  const pane = within(articleOf("Ship the retry change?"))
  await user.click(pane.getByRole("radio", { name: "Ship it" }))
  await user.click(pane.getByRole("button", { name: "Send" }))

  expect(answers).toEqual([{ id: "ask-1", answer: OutsideChoice.make({ choice: "Ship it" }) }])

  await setNeedsYou(needsYou, [finishedReview])
  expect(await screen.findByRole("heading", { name: "Retry flaky upload" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /Ship the retry change/ })).toBeNull()
})

it("sends a typed answer when an outside question has no choices", async () => {
  const answers: Array<{ id: string; answer: OutsideQuestionAnswer }> = []

  const user = mount(
    needsYouRef([OutsideQuestion.make({ ...outsideQuestion, id: "ask-2", choices: [] })]),
    {
      AnswerOutsideQuestion: (payload) => Effect.sync(() => void answers.push(payload)),
    },
  )

  await screen.findByRole("heading", { name: "Ship the retry change?" })
  const pane = within(articleOf("Ship the retry change?"))
  await user.type(pane.getByRole("textbox", { name: "Your answer" }), "Not yet")
  await user.click(pane.getByRole("button", { name: "Send" }))

  expect(answers).toEqual([{ id: "ask-2", answer: OutsideText.make({ text: "Not yet" }) }])
})

it("starts the next outside question with an empty answer", async () => {
  const answers: Array<{ id: string; answer: OutsideQuestionAnswer }> = []
  const typed = OutsideQuestion.make({ ...outsideQuestion, id: "ask-3", choices: [] })

  const chosen = OutsideQuestion.make({
    ...outsideQuestion,
    id: "ask-4",
    question: "Merge it today?",
    choices: ["Merge today", "Wait for CI"],
  })

  const needsYou = needsYouRef([typed, chosen])

  const user = mount(needsYou, {
    AnswerOutsideQuestion: (payload) => Effect.sync(() => void answers.push(payload)),
  })

  await screen.findByRole("heading", { name: "Ship the retry change?" })
  await user.type(
    within(articleOf("Ship the retry change?")).getByRole("textbox", { name: "Your answer" }),
    "release/2026-11",
  )
  await user.click(
    within(articleOf("Ship the retry change?")).getByRole("button", { name: "Send" }),
  )
  await setNeedsYou(needsYou, [chosen])

  await screen.findByRole("heading", { name: "Merge it today?" })
  const pane = within(articleOf("Merge it today?"))
  expect(pane.getByRole("textbox", { name: "Or type an answer" })).toHaveProperty("value", "")
  await user.click(pane.getByRole("radio", { name: "Wait for CI" }))
  await user.click(pane.getByRole("button", { name: "Send" }))

  expect(answers).toEqual([
    { id: "ask-3", answer: OutsideText.make({ text: "release/2026-11" }) },
    { id: "ask-4", answer: OutsideChoice.make({ choice: "Wait for CI" }) },
  ])
})

it("allows the selected permission with a", async () => {
  const answers: Array<{ agentId: string; requestId: string; answer: RequestAnswer }> = []

  const user = mount(needsYouRef([waitingAgent, finishedReview]), {
    AnswerRequest: (payload) => Effect.sync(() => void answers.push(payload)),
  })

  const agentRow = await screen.findByRole("button", { name: /agent\/swift-otter/ })
  expect(agentRow.getAttribute("aria-current")).toBe("true")

  await user.keyboard("a")
  expect(answers).toEqual([
    { agentId: agent.id, requestId: "bash-1", answer: AllowRequest.make({}) },
  ])
})

it("goes Back from an opened item to the Inbox with that item still selected", async () => {
  const opened: Array<Held<{ readonly pullRequest: PullRequestRef }, never, never>> = []

  const user = mount(needsYouRef([waitingAgent, finishedReview]), {
    LoadPullRequest: hold(opened),
  })

  await user.click(await screen.findByRole("button", { name: /Retry flaky upload/ }))
  await user.click(screen.getByRole("link", { name: "Open pull request" }))
  await next(opened)

  await user.click(screen.getByRole("button", { name: "Back" }))

  await waitFor(() => expect(window.location.hash).toBe("#/inbox"))
  const row = await screen.findByRole("button", { name: /Retry flaky upload/ })
  expect(row.getAttribute("aria-current")).toBe("true")

  await user.click(screen.getByRole("button", { name: "Forward" }))
  await waitFor(() => expect(window.location.hash).toBe("#/reviews/octo-org/glass/42"))
})

it("moves through the rows with j and k, skipping a folded group", async () => {
  const user = mount(needsYouRef([waitingAgent, laterAgent, finishedReview]))

  const first = await screen.findByRole("button", { name: /agent\/swift-otter/ })
  expect(first.getAttribute("aria-current")).toBe("true")

  await user.keyboard("j")
  const second = screen.getByRole("button", { name: /agent\/quiet-lynx/ })
  expect(second.getAttribute("aria-current")).toBe("true")
  expect(document.activeElement).toBe(second)

  await user.keyboard("j")
  expect(screen.getByRole("heading", { name: "Retry flaky upload" })).toBeTruthy()

  await user.keyboard("k")
  expect(screen.getByRole("heading", { name: "agent/quiet-lynx" })).toBeTruthy()

  await user.click(screen.getByRole("button", { name: /^Stopped on you/ }))
  expect(screen.queryByRole("button", { name: /agent\/quiet-lynx/ })).toBeNull()
  expect(screen.getByRole("heading", { name: "Retry flaky upload" })).toBeTruthy()

  await user.keyboard("k")
  expect(screen.getByRole("heading", { name: "Retry flaky upload" })).toBeTruthy()
})

it("marks a finished Agent review done with Done or e, naming the review it saw", async () => {
  const done: Array<{ readonly pullRequest: PullRequestRef; readonly writtenAt: DateTime.Utc }> = []

  const user = mount(needsYouRef([finishedReview, finishedDraft]), {
    MarkAgentReviewDone: (payload) => Effect.sync(() => void done.push(payload)),
  })

  await user.click(await screen.findByRole("button", { name: /Retry flaky upload/ }))
  await user.click(within(articleOf("Retry flaky upload")).getByRole("button", { name: "Done" }))

  await user.click(screen.getByRole("button", { name: /Sketch the empty state/ }))
  await user.keyboard("e")

  await waitFor(() =>
    expect(done).toEqual([
      { pullRequest: ref, writtenAt: finishedReview.since },
      { pullRequest: draftRef, writtenAt: finishedDraft.since },
    ]),
  )
})

it("shows why the user's own PRs wait on them, without Agent review actions", async () => {
  const mineRef = new PullRequestRef({ owner: "octo-org", repo: "glass", number: 51 })
  const readyRef = new PullRequestRef({ owner: "octo-org", repo: "glass", number: 52 })

  const user = mount(
    needsYouRef([
      PullRequestNeedsYou.make({
        pullRequest: summary(mineRef, "Cache the diff", false, ago({ hours: 2 })),
        reasons: [
          ChangesRequested.make({}),
          ChecksFailing.make({
            failing: ["CI / test", "CI / lint", "deploy", "e2e"].map(
              (name) => new Check({ name, state: "failed", url: null }),
            ),
          }),
          AwaitingReply.make({ threads: 2 }),
        ],
        since: ago({ hours: 2 }),
      }),
      PullRequestNeedsYou.make({
        pullRequest: summary(readyRef, "Trim the log", false, ago({ hours: 1 })),
        reasons: [ReadyToMerge.make({})],
        since: ago({ hours: 1 }),
      }),
    ]),
  )

  const mine = await screen.findByRole("region", { name: "Your pull requests" })
  const cache = within(mine).getByRole("button", { name: /Cache the diff/ })

  for (const reason of ["Changes requested", "CI failing", "2 threads awaiting reply"]) {
    expect(within(cache).getByText(reason)).toBeTruthy()
  }

  expect(within(mine).getByText("Ready to merge")).toBeTruthy()

  await user.click(screen.getByRole("button", { name: /Cache the diff/ }))
  const pane = within(articleOf("Cache the diff"))
  const failing = within(pane.getByRole("region", { name: "Failing checks" }))
  expect(failing.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "CI / test",
    "CI / lint",
    "deploy",
  ])
  expect(failing.getByText("and 1 more")).toBeTruthy()
  expect(pane.queryByRole("region", { name: "Agent review" })).toBeNull()
  expect(pane.getByRole("link", { name: "Open pull request" })).toBeTruthy()
  expect(pane.queryByRole("link", { name: "Read Agent review" })).toBeNull()
  expect(pane.queryByRole("button", { name: "Done" })).toBeNull()
})

it("opens the pull request and offers its finished Agent review", async () => {
  const opened: Array<Held<{ readonly pullRequest: PullRequestRef }, never, never>> = []

  const user = mount(needsYouRef([finishedReview, finishedDraft]), {
    LoadPullRequest: hold(opened),
  })

  await user.click(await screen.findByRole("button", { name: /Retry flaky upload/ }))
  const pane = within(articleOf("Retry flaky upload"))
  expect(pane.getByText(/hubot/)).toBeTruthy()
  expect(pane.getByText("Agent review finished")).toBeTruthy()
  expect(
    within(pane.getByRole("region", { name: "Agent review" })).getByText(
      "The retry loses the upload's checksum.",
    ),
  ).toBeTruthy()
  expect(pane.getByText(/Updated/)).toBeTruthy()

  expect(screen.getByRole("region", { name: "Agent reviews to read" }).textContent).toContain(
    "Draft",
  )

  await user.click(pane.getByRole("link", { name: "Read Agent review" }))

  expect((await next(opened)).payload.pullRequest).toEqual(ref)
  expect(window.location.hash).toBe("#/reviews/octo-org/glass/42")
})

it("counts what needs you on the Inbox link from another area", async () => {
  const needsYou = needsYouRef([waitingAgent, finishedReview])

  mount(needsYou, {}, "/to-dos")

  expect(await screen.findByRole("link", { name: "Inbox", description: "2 need you" })).toBeTruthy()
  expect(screen.queryByRole("link", { name: "Dashboard", description: /need you/ })).toBeNull()

  await setNeedsYou(needsYou, [])

  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Inbox", description: /need you/ })).toBeNull(),
  )
  expect(screen.getByRole("link", { name: "Inbox" }).textContent).toBe("")
})

const loadedWorkspace = () =>
  Effect.succeed(
    new PullRequestWorkspace({
      viewer,
      pullRequest: new PullRequest({
        ...pullRequestFields,
        ref,
        url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      }),
      revision,
      updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
      files: [],
      viewedPaths: [],
      discussions: new Discussions({ onLines: [], outdated: [], timeline: [] }),
      drafts: [],
    }),
  )

const reviewHandlers: Partial<Handlers> = {
  HasPullRequestChanged: () => Effect.succeed(false),
  WatchAgentReview: () => Stream.make({ review: reviewOf(revision), job: { status: "idle" } }),
}

it("opens Changes and the Agent review when the pull request is still loading", async () => {
  const opened: Array<Held<{ readonly pullRequest: PullRequestRef }, PullRequestWorkspace, never>> =
    []

  const user = mount(needsYouRef([finishedReview]), {
    LoadPullRequest: hold(opened),
    ...reviewHandlers,
  })

  await user.click(await screen.findByRole("link", { name: "Read Agent review" }))
  expect(await screen.findByRole("status", { name: "Loading pull request" })).toBeTruthy()
  expect(screen.queryByRole("complementary", { name: "Agent review" })).toBeNull()
  expect(screen.queryByRole("tab", { name: "Changes" })).toBeNull()

  ;(await next(opened)).answer(loadedWorkspace())

  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true"),
  )
  expect(screen.getByRole("complementary", { name: "Agent review" })).toBeTruthy()
})
