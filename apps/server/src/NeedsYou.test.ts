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
import { DateTime, Effect, Option, Predicate, Stream } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { vi } from "vite-plus/test"
import { agentsFixture } from "../test/agentsFixture"
import { startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, type FakePullRequestSeed, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"
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
    ?.reasons.map(({ _tag }) => _tag)

const sinceOf = (items: NeedsYou, pr: FakePullRequest) => {
  const found = pullRequestItems(items).find(({ pullRequest }) => pullRequest.url === pr.url)

  return found === undefined ? undefined : DateTime.formatIso(found.since)
}

const requestsOf = (items: NeedsYou, agentId: string) =>
  agentItem(items, agentId)?.reasons.flatMap(({ requests }) => requests) ?? []

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

it.live("lists an Agent while its Permission request waits, until the user answers it", () =>
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

    yield* needsYou(f.client, (items) => agentItem(items, agent.id) === undefined)
  }),
)

it.live("lists an Agent while its Question waits, until the user answers it", () =>
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

    yield* needsYou(f.client, (items) => agentItem(items, agent.id) === undefined)
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
