import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  type AgentReviewState,
  isWaiting,
  type NeedsYou,
  PullRequestRef,
  Revision,
} from "@glass/contracts"
import { Clock, DateTime, Effect, Option, Predicate, Stream } from "effect"
import { TestClock } from "effect/testing"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { vi } from "vite-plus/test"
import { agentsFixture, holding, settled } from "../test/agentsFixture"
import { watchDeadlines } from "../test/deadlines"
import { startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, type FakePullRequestSeed, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend, startSignedInBackend } from "../test/harness"
import { type ScriptedSettings, scriptedAgentRunners } from "../test/scriptedAgentRunners"

type Client = Effect.Success<ReturnType<typeof startBackend>>["client"]

const scriptedHost = fileURLToPath(new URL("../dist-test/scriptedAgentHost.mjs", import.meta.url))

const answer = { markdown: "**Nothing stands out.** The greeting now takes a name." }

const needsYou = (client: Client, until: (items: NeedsYou) => boolean) =>
  client.WatchNeedsYou().pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow))

const current = (client: Client) => needsYou(client, () => true)

const agentItems = (items: NeedsYou) =>
  items.flatMap((item) => (Predicate.isTagged(item, "Agent") ? [item] : []))

const pullRequestItems = (items: NeedsYou) =>
  items.flatMap((item) => (Predicate.isTagged(item, "PullRequest") ? [item] : []))

const agentItem = (items: NeedsYou, agentId: string) =>
  agentItems(items).find(({ agent }) => agent.id === agentId)

const titles = (items: NeedsYou) =>
  pullRequestItems(items).map(({ pullRequest }) => pullRequest.title)

const reasonsOf = (items: NeedsYou, pr: FakePullRequest) =>
  pullRequestItems(items)
    .find(({ pullRequest }) => pullRequest.url === pr.url)
    ?.reasons.map((reason) =>
      Predicate.isTagged(reason, "AwaitingReply") ? `AwaitingReply:${reason.threads}` : reason._tag,
    )

const sinceOf = (items: NeedsYou, pr: FakePullRequest) => {
  const found = pullRequestItems(items).find(({ pullRequest }) => pullRequest.url === pr.url)

  return found === undefined ? undefined : DateTime.formatIso(found.since)
}

const requestsOf = (items: NeedsYou, agentId: string) =>
  agentItem(items, agentId)?.reasons.flatMap((reason) =>
    Predicate.isTagged(reason, "WaitingRequests") ? reason.requests : [],
  ) ?? []

const finishedOf = (items: NeedsYou, agentId: string) =>
  agentItem(items, agentId)?.reasons.flatMap((reason) =>
    Predicate.isTagged(reason, "TurnFinished") ? [reason] : [],
  )[0]

const onlyFinished = (agentId: string) => (items: NeedsYou) =>
  agentItem(items, agentId)
    ?.reasons.map(({ _tag }) => _tag)
    .join() === "TurnFinished"

const ref = (pr: FakePullRequest) =>
  new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })

const revisionOf = (pr: FakePullRequest) => new Revision({ base: pr.base.sha, head: pr.head.sha })

const status = (wanted: AgentReviewState["job"]["status"]) => (state: AgentReviewState) =>
  state.job.status === wanted

const reviewed = (state: AgentReviewState) => state.review !== null && state.job.status === "idle"

const reviewsFixture = Effect.fnUntraced(function* (
  settings: ScriptedSettings = { reply: { answer } },
) {
  const runners = yield* scriptedAgentRunners(settings)
  const github = yield* startFakeGitHub({ git: true })
  const home = yield* isolatedHome
  const gates = join(home, "gates")
  mkdirSync(gates)
  vi.stubEnv("GLASS_SCRIPTED_GATES", gates)

  const { client } = yield* startBackend(
    {
      GH_TOKEN: VIEWER.token,
      GLASS_GITHUB_API_URL: github.url,
      GLASS_GIT_REMOTE: github.gitUrl,
      GLASS_AGENT_HOST_BUNDLE: scriptedHost,
    },
    home,
    runners.layer,
  )

  const seed = (title: string, extra: Partial<FakePullRequestSeed> = {}) =>
    github.seedPullRequest({
      title,
      base: { sha: "b0", files: { "greet.ts": "hello\n" } },
      head: { sha: `h-${title}`, files: { "greet.ts": "hello name\n" } },
      changedFiles: [
        {
          path: "greet.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-hello\n+hello name",
        },
      ],
      ...extra,
    })

  const reviewState = (pr: FakePullRequest, predicate: (state: AgentReviewState) => boolean) =>
    client
      .WatchAgentReview({ pullRequest: ref(pr) })
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

  const review = (pr: FakePullRequest) =>
    client
      .StartAgentReview({ pullRequest: ref(pr), revision: revisionOf(pr) })
      .pipe(Effect.andThen(reviewState(pr, reviewed)))

  return { runners, client, seed, reviewState, review }
})

it.live(
  "lists an Agent while its Permission request waits, until the user answers it and it finishes",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("Please ask permission")

      const [turn] = yield* f.transcript(agent.id, (turns) =>
        turns.some(({ parts }) => parts.some(isWaiting)),
      )

      const listed = yield* needsYou(f.client, (items) => agentItem(items, agent.id) !== undefined)

      assert.strictEqual(agentItem(listed, agent.id)?.agent.name, agent.name)
      assert.deepStrictEqual(requestsOf(listed, agent.id), turn?.parts.filter(isWaiting))
      const [request] = requestsOf(listed, agent.id)
      assert.strictEqual(request?._tag, "PermissionRequest")

      yield* f.client.AnswerRequest({
        agentId: agent.id,
        requestId: request?.requestId ?? "",
        answer: AllowRequest.make({}),
      })

      yield* needsYou(f.client, onlyFinished(agent.id))
    }),
)

it.live("lists an Agent while its Question waits, until the user answers it and it finishes", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.start("Please ask a question")

    const listed = yield* needsYou(f.client, (items) => agentItem(items, agent.id) !== undefined)
    const [question] = requestsOf(listed, agent.id)
    assert.strictEqual(question?._tag, "Question")

    yield* f.client.AnswerRequest({
      agentId: agent.id,
      requestId: question?.requestId ?? "",
      answer: AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
    })

    yield* needsYou(f.client, onlyFinished(agent.id))
  }),
)

it.live("drops a waiting Agent once it is removed", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.start("Please ask permission")
    yield* needsYou(f.client, (items) => agentItem(items, agent.id) !== undefined)

    yield* f.client.RemoveAgent({ agentId: agent.id })

    yield* needsYou(f.client, (items) => agentItem(items, agent.id) === undefined)
  }),
)

it.live("lists an Agent whose Turn finished unseen, until the user sees that Turn", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.start()
    const [turn] = yield* f.transcript(agent.id, settled(1))
    const ended = turn!.ended!

    const listed = yield* needsYou(f.client, onlyFinished(agent.id))

    assert.deepStrictEqual(finishedOf(listed, agent.id)?.ended, ended)
    assert.isTrue(DateTime.Equivalence(agentItem(listed, agent.id)!.since, ended.at))

    yield* f.client.MarkTurnSeen({ agentId: agent.id, endedAt: ended.at })

    yield* needsYou(f.client, (items) => agentItem(items, agent.id) === undefined)
  }),
)

it.live(
  "lists the Agent again when a later Turn finishes, even if the earlier one is seen after it",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start()
      const [first] = yield* f.transcript(agent.id, settled(1))
      yield* f.client.MarkTurnSeen({ agentId: agent.id, endedAt: first!.ended!.at })
      yield* needsYou(f.client, (items) => agentItem(items, agent.id) === undefined)

      yield* f.send(agent.id, "Say hello again")
      const turns = yield* f.transcript(agent.id, settled(2))
      yield* f.client.MarkTurnSeen({ agentId: agent.id, endedAt: first!.ended!.at })

      const listed = yield* needsYou(f.client, onlyFinished(agent.id))
      assert.deepStrictEqual(finishedOf(listed, agent.id)?.ended, turns[1]?.ended)
    }),
)

it.live("leaves out a Turn the user stopped", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.start("hold:never")
    yield* f.transcript(agent.id, holding)

    yield* f.client.StopTurn({ agentId: agent.id })
    yield* f.transcript(agent.id, settled(1))

    assert.isUndefined(agentItem(yield* current(f.client), agent.id))
  }),
)

it.live("keeps which finished Turns the user has seen when Glass opens again", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const seen = yield* f.start()
    const unseen = yield* f.start("Say goodbye")
    const [turn] = yield* f.transcript(seen.id, settled(1))
    yield* f.transcript(unseen.id, settled(1))
    yield* f.client.MarkTurnSeen({ agentId: seen.id, endedAt: turn!.ended!.at })
    yield* needsYou(f.client, (items) => agentItem(items, seen.id) === undefined)

    yield* f.quit
    const relaunched = yield* f.launch

    const listed = yield* needsYou(relaunched, onlyFinished(unseen.id))
    assert.isUndefined(agentItem(listed, seen.id))
  }),
)

it.live("lists a Sandbox Agent still waiting when Glass opens again", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.startSandbox("Please ask permission")
    yield* needsYou(f.client, (items) => agentItem(items, agent.id) !== undefined)

    yield* f.quit
    const relaunched = yield* f.launch

    assert.strictEqual(requestsOf(yield* current(relaunched), agent.id).length, 1)
  }),
)

it.live(
  "lists a queued PR once its Agent review is finished, not while one waits, runs, or failed",
  () =>
    Effect.gen(function* () {
      const f = yield* reviewsFixture({ reply: "hold" })
      const [first, second] = [f.seed("Greet"), f.seed("Wave")]
      yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
      yield* f.client.AddToQueue({ references: [ref(first), ref(second)] })
      yield* f.reviewState(first, status("reviewing"))
      yield* f.reviewState(second, status("waiting"))

      assert.deepStrictEqual(yield* current(f.client), [])

      yield* f.runners.release({ answer })
      const { review } = yield* f.reviewState(first, reviewed)

      const listed = yield* needsYou(f.client, (items) => titles(items).includes("Greet"))
      assert.deepStrictEqual(reasonsOf(listed, first), ["AgentReviewFinished"])
      assert.strictEqual(
        sinceOf(listed, first),
        review === null ? undefined : DateTime.formatIso(review.writtenAt),
      )

      yield* f.reviewState(second, reviewed)
      yield* f.runners.configure({ reply: "hold" })
      yield* f.client.StartAgentReview({ pullRequest: ref(first), revision: revisionOf(first) })
      yield* f.reviewState(first, (state) => status("reviewing")(state) && state.review !== null)
      assert.deepStrictEqual(titles(yield* current(f.client)), ["Wave"])

      yield* f.runners.release({ fail: "failed" })
      yield* f.reviewState(first, (state) => status("failed")(state) && state.review !== null)
      assert.deepStrictEqual(titles(yield* current(f.client)), ["Wave"])
    }),
)

it.live("drops a queued PR once it leaves the Queue or the user submits a Review", () =>
  Effect.gen(function* () {
    const f = yield* reviewsFixture()
    const [removed, submitted] = [f.seed("Greet"), f.seed("Wave")]
    yield* f.client.AddToQueue({ references: [ref(removed), ref(submitted)] })
    yield* f.review(removed)
    yield* f.review(submitted)
    yield* needsYou(f.client, (items) => titles(items).length === 2)

    yield* f.client.RemoveFromQueue({ reference: ref(removed) })
    assert.deepStrictEqual(titles(yield* current(f.client)), ["Wave"])

    const opened = yield* f.client.LoadPullRequest({ pullRequest: ref(submitted) })
    yield* f.client.SubmitReview({
      pullRequestId: opened.pullRequest.id,
      revision: opened.revision,
      decision: "approve",
      summary: "",
    })
    assert.deepStrictEqual(yield* current(f.client), [])
  }),
)

it.live("drops a PR the user marks done until its Agent review is written again", () =>
  Effect.gen(function* () {
    const f = yield* reviewsFixture()
    const pr = f.seed("Greet")
    yield* f.client.AddToQueue({ references: [ref(pr)] })
    const first = (yield* f.review(pr)).review!
    yield* needsYou(f.client, (items) => titles(items).length === 1)

    yield* f.client.MarkAgentReviewDone({ pullRequest: ref(pr), writtenAt: first.writtenAt })
    yield* needsYou(f.client, (items) => titles(items).length === 0)

    yield* f.client.StartAgentReview({ pullRequest: ref(pr), revision: revisionOf(pr) })
    yield* f.reviewState(
      pr,
      (state) => reviewed(state) && !DateTime.Equivalence(state.review!.writtenAt, first.writtenAt),
    )

    assert.deepStrictEqual(titles(yield* current(f.client)), ["Greet"])
  }),
)

it.live("lists a queued draft with a finished Agent review, but not a closed or merged PR", () =>
  Effect.gen(function* () {
    const f = yield* reviewsFixture()
    const draft = f.seed("Draft", { isDraft: true })
    const closed = f.seed("Closed")
    const merged = f.seed("Merged")
    yield* f.client.AddToQueue({ references: [ref(draft), ref(closed), ref(merged)] })
    yield* f.review(draft)
    yield* f.review(closed)
    yield* f.review(merged)
    yield* needsYou(f.client, (items) => titles(items).length === 3)

    closed.edit({ state: "CLOSED" })
    merged.edit({ state: "MERGED" })
    yield* f.client.RefreshQueue()

    assert.deepStrictEqual(titles(yield* current(f.client)), ["Draft"])
  }),
)

it.live("lists a waiting Agent before a PR that has waited longer", () =>
  Effect.gen(function* () {
    const f = yield* reviewsFixture()
    const pr = f.seed("Greet")
    yield* f.client.AddToQueue({ references: [ref(pr)] })
    yield* f.review(pr)

    yield* f.client.FollowUpAgentReview({
      pullRequest: ref(pr),
      revision: revisionOf(pr),
      message: "Please ask permission",
    })

    const listed = yield* needsYou(f.client, (items) => items.length === 2)

    assert.deepStrictEqual(
      listed.map(({ _tag }) => _tag),
      ["Agent", "PullRequest"],
    )
    assert.isTrue(DateTime.isLessThan(listed[1]!.since, listed[0]!.since))
  }),
)

it.live("lists an Agent review's Follow-up Agent while its request waits", () =>
  Effect.gen(function* () {
    const f = yield* reviewsFixture()
    const pr = f.seed("Greet")
    yield* f.review(pr)

    yield* f.client.FollowUpAgentReview({
      pullRequest: ref(pr),
      revision: revisionOf(pr),
      message: "Please ask permission",
    })
    const { review } = yield* f.reviewState(pr, (state) => state.review?.agentId != null)
    const agentId = review?.agentId ?? ""

    const listed = yield* needsYou(f.client, (items) => agentItem(items, agentId) !== undefined)

    assert.strictEqual(requestsOf(listed, agentId)[0]?._tag, "PermissionRequest")
    const agents = yield* f.client.WatchAgents().pipe(Stream.runHead, Effect.map(Option.getOrThrow))
    assert.isTrue(agents.some(({ id, forReview }) => id === agentId && forReview))
  }),
)

const mine = {
  owner: "octo-org",
  repo: "glass",
  author: VIEWER.login,
  base: { sha: "b0", files: {} },
}

it.live("lists the user's own PRs with what they wait on, until nothing does", () =>
  Effect.gen(function* () {
    const { github, client } = yield* startSignedInBackend
    yield* client.FollowRepository({ input: "octo-org/glass" })

    const pr = github.seedPullRequest({
      ...mine,
      checks: "FAILURE",
      head: { sha: "h1", files: {} },
    })

    pr.addReview({ author: "mona", state: "CHANGES_REQUESTED" })

    const asked = pr.addReviewThread({
      path: "README.md",
      comments: [{ author: "mona", bodyHtml: "<p>Why?</p>" }],
    })

    pr.addReviewThread({
      path: "README.md",
      comments: [
        { author: "mona", bodyHtml: "<p>Rename this?</p>" },
        { author: VIEWER.login, bodyHtml: "<p>Done</p>" },
      ],
    })
    pr.addReviewThread({
      path: "README.md",
      resolved: true,
      comments: [{ author: "mona", bodyHtml: "<p>Nit</p>" }],
    })

    yield* client.ListPullRequests()
    const listed = yield* needsYou(client, (items) => reasonsOf(items, pr) !== undefined)
    assert.deepStrictEqual(reasonsOf(listed, pr), [
      "ChangesRequested",
      "ChecksFailing",
      "AwaitingReply:1",
    ])
    assert.strictEqual(Date.parse(sinceOf(listed, pr) ?? ""), Date.parse(pr.updatedAt))

    pr.addReview({ author: "mona", state: "APPROVED" })
    pr.checks = "SUCCESS"
    pr.setResolved(asked.id, true)
    yield* client.ListPullRequests()
    const ready = yield* needsYou(client, (items) => reasonsOf(items, pr)?.[0] === "ReadyToMerge")
    assert.deepStrictEqual(reasonsOf(ready, pr), ["ReadyToMerge"])

    pr.mergeable = "CONFLICTING"
    yield* client.ListPullRequests()
    yield* needsYou(client, (items) => reasonsOf(items, pr) === undefined)
  }),
)

it.live("drops the user's PRs once their repository is unfollowed", () =>
  Effect.gen(function* () {
    const { github, client } = yield* startSignedInBackend
    const [followed] = yield* client.FollowRepository({ input: "octo-org/glass" })

    const pr = github.seedPullRequest({
      ...mine,
      checks: "FAILURE",
      head: { sha: "h1", files: {} },
    })

    yield* client.ListPullRequests()
    yield* needsYou(client, (items) => reasonsOf(items, pr) !== undefined)

    yield* client.UnfollowRepository({ repository: followed! })
    yield* client.ListPullRequests()

    yield* needsYou(client, (items) => reasonsOf(items, pr) === undefined)
  }),
)

it.live("leaves out others' PRs and the user's PRs nobody has approved yet", () =>
  Effect.gen(function* () {
    const { github, client } = yield* startSignedInBackend
    yield* client.FollowRepository({ input: "octo-org/glass" })
    github.seedPullRequest({
      ...mine,
      author: "mona",
      checks: "FAILURE",
      head: { sha: "h1", files: {} },
    })
    github.seedPullRequest({ ...mine, checks: "SUCCESS", head: { sha: "h2", files: {} } })
    const draft = github.seedPullRequest({ ...mine, isDraft: true, head: { sha: "h3", files: {} } })
    draft.addReview({ author: "mona", state: "APPROVED" })

    yield* client.ListPullRequests()

    assert.deepStrictEqual(yield* current(client), [])
  }),
)

it.live(
  "lists the user's own queued PR once, with its finished Agent review and failing checks",
  () =>
    Effect.gen(function* () {
      const f = yield* reviewsFixture()
      yield* f.client.FollowRepository({ input: "octo-org/hello-world" })
      const pr = f.seed("Greet", { author: VIEWER.login, checks: "FAILURE" })
      yield* f.client.AddToQueue({ references: [ref(pr)] })
      yield* f.review(pr)

      yield* f.client.ListPullRequests()
      const listed = yield* needsYou(f.client, (items) => reasonsOf(items, pr)?.length === 2)

      assert.deepStrictEqual(titles(listed), ["Greet"])
      assert.deepStrictEqual(reasonsOf(listed, pr), ["AgentReviewFinished", "ChecksFailing"])
    }),
)

it.effect("refreshes the user's PRs once two minutes pass without a sync", () =>
  Effect.gen(function* () {
    const { watched, deadlineSet } = yield* watchDeadlines(120_000)
    const github = yield* startFakeGitHub()

    const { client } = yield* startBackend({
      GH_TOKEN: VIEWER.token,
      GLASS_GITHUB_API_URL: github.url,
    }).pipe(Effect.provideService(Clock.Clock, watched))

    yield* client.FollowRepository({ input: "octo-org/glass" })

    const pr = github.seedPullRequest({
      ...mine,
      checks: "FAILURE",
      head: { sha: "h1", files: {} },
    })

    yield* deadlineSet
    yield* client.ListPullRequests()
    yield* needsYou(client, (items) => reasonsOf(items, pr) !== undefined)
    yield* deadlineSet

    pr.checks = "SUCCESS"
    yield* TestClock.adjust("2 minutes")

    yield* needsYou(client, (items) => reasonsOf(items, pr) === undefined)
  }),
)

it.live(
  "lists the Global conversation while its own Question waits, until the user answers it",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      yield* f.client.SendGlobalMessage({
        message: "Please ask a question",
        images: [],
        context: null,
      })

      const listed = yield* needsYou(f.client, (items) =>
        items.some(Predicate.isTagged("GlobalConversation")),
      )

      const asked = listed.flatMap((item) =>
        Predicate.isTagged(item, "GlobalConversation") ? [item] : [],
      )[0]

      assert.strictEqual(listed[0], asked)
      const [question] = asked?.requests ?? []
      assert.strictEqual(question?._tag, "Question")

      yield* f.client.AnswerGlobalRequest({
        requestId: question?.requestId ?? "",
        answer: AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
      })

      yield* needsYou(f.client, (items) => !items.some(Predicate.isTagged("GlobalConversation")))
    }),
)

it.live(
  "drops a queued PR once the Global conversation reports the Agent review it started, leaving it not done",
  () =>
    Effect.gen(function* () {
      const f = yield* reviewsFixture({ reply: "hold" })
      const pr = f.seed("Greet")
      yield* f.client.AddToQueue({ references: [ref(pr)] })

      const start = { pullRequest: ref(pr), revision: revisionOf(pr) }
      yield* f.client.SendGlobalMessage({
        message: `call:start_agent_review ${JSON.stringify(start)}`,
        images: [],
        context: null,
      })
      yield* f.reviewState(pr, status("reviewing"))
      yield* f.runners.release({ answer })

      const { review } = yield* f.reviewState(
        pr,
        (state) => reviewed(state) && state.review?.reported === true,
      )

      assert.isFalse(review?.done)
      yield* needsYou(f.client, (items) => titles(items).length === 0)
    }),
)
