import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  AnswerQuestion,
  type AgentReviewState,
  isWaiting,
  type InboxItems,
  PullRequestRef,
  Revision,
} from "@glass/contracts"
import { Clock, DateTime, Effect, Option, Predicate, Stream } from "effect"
import { TestClock } from "effect/testing"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { vi } from "vite-plus/test"
import { threadsFixture, holding, settled } from "../test/threadsFixture"
import { watchDeadlines } from "../test/deadlines"
import { startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, type FakePullRequestSeed, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend, startSignedInBackend } from "../test/harness"
import { inboxWhen } from "../test/inboxWhen"
import { scriptedReviews } from "../test/scriptedReviews"

type Client = Effect.Success<ReturnType<typeof startBackend>>["client"]

const scriptedHost = fileURLToPath(new URL("../dist-test/scriptedAgentHost.mjs", import.meta.url))

const answer = {
  markdown: "**Nothing stands out.** The greeting now takes a name.",
  hotspots: [],
  lowAttention: [],
}

const current = (client: Client) => inboxWhen(client, () => true)

const threadItems = (items: InboxItems) =>
  items.flatMap((item) => (Predicate.isTagged(item, "Thread") ? [item] : []))

const pullRequestItems = (items: InboxItems) =>
  items.flatMap((item) => (Predicate.isTagged(item, "PullRequest") ? [item] : []))

const threadItem = (items: InboxItems, threadId: string) =>
  threadItems(items).find(({ thread }) => thread.id === threadId)

const titles = (items: InboxItems) =>
  pullRequestItems(items).map(({ pullRequest }) => pullRequest.title)

const itemOf = (items: InboxItems, pr: FakePullRequest) =>
  pullRequestItems(items).find(({ pullRequest }) => pullRequest.url === pr.url)

const reasonsOf = (items: InboxItems, pr: FakePullRequest) =>
  itemOf(items, pr)?.reasons.map((reason) =>
    Predicate.isTagged(reason, "AwaitingReply")
      ? `AwaitingReply:${reason.reviewThreads}`
      : reason._tag,
  )

const sinceOf = (items: InboxItems, pr: FakePullRequest) => {
  const found = pullRequestItems(items).find(({ pullRequest }) => pullRequest.url === pr.url)

  return found === undefined ? undefined : DateTime.formatIso(found.since)
}

const requestsOf = (items: InboxItems, threadId: string) =>
  threadItem(items, threadId)?.reasons.flatMap((reason) =>
    Predicate.isTagged(reason, "WaitingRequests") ? reason.requests : [],
  ) ?? []

const finishedOf = (items: InboxItems, threadId: string) =>
  threadItem(items, threadId)?.reasons.flatMap((reason) =>
    Predicate.isTagged(reason, "TurnFinished") ? [reason] : [],
  )[0]

const onlyFinished = (threadId: string) => (items: InboxItems) =>
  threadItem(items, threadId)
    ?.reasons.map(({ _tag }) => _tag)
    .join() === "TurnFinished"

const ref = (pr: FakePullRequest) =>
  new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })

const revisionOf = (pr: FakePullRequest) => new Revision({ base: pr.base.sha, head: pr.head.sha })

const status = (wanted: AgentReviewState["job"]["status"]) => (state: AgentReviewState) =>
  state.job.status === wanted

const reviewed = (state: AgentReviewState) => state.review !== null && state.job.status === "idle"

const reviewsFixture = Effect.fnUntraced(function* (held = false) {
  const github = yield* startFakeGitHub({ git: true })
  const home = yield* isolatedHome
  const gates = join(home, "gates")
  mkdirSync(gates)
  vi.stubEnv("GLASS_SCRIPTED_GATES", gates)
  const reviews = scriptedReviews(gates)
  yield* held ? reviews.hold : reviews.script({ submit: [answer] })

  const { client } = yield* startBackend(
    {
      GH_TOKEN: VIEWER.token,
      GLASS_GITHUB_API_URL: github.url,
      GLASS_GIT_REMOTE: github.gitUrl,
      GLASS_AGENT_HOST_BUNDLE: scriptedHost,
    },
    home,
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

  return { reviews, client, seed, reviewState, review }
})

it.live(
  "lists a Thread while its Permission request waits, until the user answers it and it finishes",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start("Please ask permission")

      const [turn] = yield* f.transcript(thread.id, (turns) =>
        turns.some(({ parts }) => parts.some(isWaiting)),
      )

      const listed = yield* inboxWhen(
        f.client,
        (items) => threadItem(items, thread.id) !== undefined,
      )

      assert.strictEqual(threadItem(listed, thread.id)?.thread.name, thread.name)
      assert.deepStrictEqual(requestsOf(listed, thread.id), turn?.parts.filter(isWaiting))
      const [request] = requestsOf(listed, thread.id)
      assert.strictEqual(request?._tag, "PermissionRequest")

      yield* f.client.AnswerRequest({
        threadId: thread.id,
        requestId: request?.requestId ?? "",
        answer: AllowRequest.make({}),
      })

      yield* inboxWhen(f.client, onlyFinished(thread.id))
    }),
)

it.live("lists a Thread while its Question waits, until the user answers it and it finishes", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start("Please ask a question")

    const listed = yield* inboxWhen(f.client, (items) => threadItem(items, thread.id) !== undefined)

    const [question] = requestsOf(listed, thread.id)
    assert.strictEqual(question?._tag, "Question")

    yield* f.client.AnswerRequest({
      threadId: thread.id,
      requestId: question?.requestId ?? "",
      answer: AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
    })

    yield* inboxWhen(f.client, onlyFinished(thread.id))
  }),
)

it.live("drops a waiting Thread once it is removed", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start("Please ask permission")
    yield* inboxWhen(f.client, (items) => threadItem(items, thread.id) !== undefined)

    yield* f.client.RemoveThread({ threadId: thread.id })

    yield* inboxWhen(f.client, (items) => threadItem(items, thread.id) === undefined)
  }),
)

it.live("lists a Thread whose Turn finished unseen, until the user sees that Turn", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start()
    const [turn] = yield* f.transcript(thread.id, settled(1))
    const ended = turn!.ended!

    const listed = yield* inboxWhen(f.client, onlyFinished(thread.id))

    assert.deepStrictEqual(finishedOf(listed, thread.id)?.ended, ended)
    assert.isTrue(DateTime.Equivalence(threadItem(listed, thread.id)!.since, ended.at))

    yield* f.client.MarkTurnSeen({ threadId: thread.id, endedAt: ended.at })

    yield* inboxWhen(f.client, (items) => threadItem(items, thread.id) === undefined)
  }),
)

it.live(
  "lists the Thread again when a later Turn finishes, even if the earlier one is seen after it",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start()
      const [first] = yield* f.transcript(thread.id, settled(1))
      yield* f.client.MarkTurnSeen({ threadId: thread.id, endedAt: first!.ended!.at })
      yield* inboxWhen(f.client, (items) => threadItem(items, thread.id) === undefined)

      yield* f.send(thread.id, "Say hello again")
      const turns = yield* f.transcript(thread.id, settled(2))
      yield* f.client.MarkTurnSeen({ threadId: thread.id, endedAt: first!.ended!.at })

      const listed = yield* inboxWhen(f.client, onlyFinished(thread.id))
      assert.deepStrictEqual(finishedOf(listed, thread.id)?.ended, turns[1]?.ended)
    }),
)

it.live("leaves out a Turn the user stopped", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start("hold:never")
    yield* f.transcript(thread.id, holding)

    yield* f.client.StopTurn({ threadId: thread.id })
    yield* f.transcript(thread.id, settled(1))

    assert.isUndefined(threadItem(yield* current(f.client), thread.id))
  }),
)

it.live("keeps which finished Turns the user has seen when Glass opens again", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const seen = yield* f.start()
    const unseen = yield* f.start("Say goodbye")
    const [turn] = yield* f.transcript(seen.id, settled(1))
    yield* f.transcript(unseen.id, settled(1))
    yield* f.client.MarkTurnSeen({ threadId: seen.id, endedAt: turn!.ended!.at })
    yield* inboxWhen(f.client, (items) => threadItem(items, seen.id) === undefined)

    yield* f.quit
    const relaunched = yield* f.launch

    const listed = yield* inboxWhen(relaunched, onlyFinished(unseen.id))
    assert.isUndefined(threadItem(listed, seen.id))
  }),
)

it.live("lists a Sandbox Thread still waiting when Glass opens again", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.startSandbox("Please ask permission")
    yield* inboxWhen(f.client, (items) => threadItem(items, thread.id) !== undefined)

    yield* f.quit
    const relaunched = yield* f.launch

    assert.strictEqual(requestsOf(yield* current(relaunched), thread.id).length, 1)
  }),
)

it.live(
  "lists a queued PR once its Agent review is finished, not while one waits, runs, or failed",
  () =>
    Effect.gen(function* () {
      const f = yield* reviewsFixture(true)
      const [first, second, third] = [f.seed("Greet"), f.seed("Wave"), f.seed("Fibers")]
      yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
      yield* f.client.AddToQueue({ references: [ref(first), ref(second), ref(third)] })
      yield* f.reviewState(first, status("reviewing"))
      yield* f.reviewState(second, status("reviewing"))
      yield* f.reviewState(third, status("waiting"))

      assert.deepStrictEqual(yield* current(f.client), [])

      yield* f.reviews.release({ submit: [answer] })
      const { review } = yield* f.reviewState(first, reviewed)

      const listed = yield* inboxWhen(f.client, (items) => titles(items).includes("Greet"))
      assert.deepStrictEqual(reasonsOf(listed, first), ["AgentReviewFinished"])
      assert.strictEqual(
        sinceOf(listed, first),
        review === null ? undefined : DateTime.formatIso(review.writtenAt),
      )

      yield* f.reviewState(second, reviewed)
      yield* f.reviewState(third, reviewed)
      yield* f.reviews.hold
      yield* f.client.StartAgentReview({ pullRequest: ref(first), revision: revisionOf(first) })
      yield* f.reviewState(first, (state) => status("reviewing")(state) && state.review !== null)
      assert.deepStrictEqual(titles(yield* current(f.client)), ["Wave", "Fibers"])

      yield* f.reviews.release({ fail: "failed" })
      yield* f.reviewState(first, (state) => status("failed")(state) && state.review !== null)
      assert.deepStrictEqual(titles(yield* current(f.client)), ["Wave", "Fibers"])
    }),
)

it.live("drops a queued PR once it leaves the Queue or the user submits a Review", () =>
  Effect.gen(function* () {
    const f = yield* reviewsFixture()
    const [removed, submitted] = [f.seed("Greet"), f.seed("Wave")]
    yield* f.client.AddToQueue({ references: [ref(removed), ref(submitted)] })
    yield* f.review(removed)
    yield* f.review(submitted)
    yield* inboxWhen(f.client, (items) => titles(items).length === 2)

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
    yield* inboxWhen(f.client, (items) => titles(items).length === 1)

    yield* f.client.MarkAgentReviewDone({ pullRequest: ref(pr), writtenAt: first.writtenAt })
    yield* inboxWhen(f.client, (items) => titles(items).length === 0)

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
    yield* inboxWhen(f.client, (items) => titles(items).length === 3)

    closed.edit({ state: "CLOSED" })
    merged.edit({ state: "MERGED" })
    yield* f.client.RefreshQueue()

    assert.deepStrictEqual(titles(yield* current(f.client)), ["Draft"])
  }),
)

it.live("lists a waiting Thread before a PR that has waited longer", () =>
  Effect.gen(function* () {
    const f = yield* reviewsFixture()
    const pr = f.seed("Greet")
    yield* f.client.AddToQueue({ references: [ref(pr)] })
    const { review } = yield* f.review(pr)

    yield* f.client.SendMessage({
      threadId: review!.threadId!,
      message: "Please ask permission",
      images: [],
      feedback: [],
    })

    const listed = yield* inboxWhen(f.client, (items) => items.length === 2)

    assert.deepStrictEqual(
      listed.map(({ _tag }) => _tag),
      ["Thread", "PullRequest"],
    )
    assert.isTrue(DateTime.isLessThan(listed[1]!.since, listed[0]!.since))
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
      checkContexts: [
        { kind: "CheckRun", name: "test", workflow: "CI", conclusion: "FAILURE" },
        { kind: "CheckRun", name: "lint", workflow: "CI" },
        { kind: "StatusContext", context: "deploy", state: "ERROR" },
      ],
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
    const listed = yield* inboxWhen(client, (items) => reasonsOf(items, pr) !== undefined)
    assert.deepStrictEqual(reasonsOf(listed, pr), [
      "ChangesRequested",
      "ChecksFailing",
      "AwaitingReply:1",
    ])
    assert.deepStrictEqual(
      (itemOf(listed, pr)?.reasons ?? []).flatMap((reason) =>
        Predicate.isTagged(reason, "ChecksFailing") ? reason.failing.map(({ name }) => name) : [],
      ),
      ["CI / test", "deploy"],
    )
    assert.strictEqual(Date.parse(sinceOf(listed, pr) ?? ""), Date.parse(pr.updatedAt))

    pr.addReview({ author: "mona", state: "APPROVED" })
    pr.checks = "SUCCESS"
    pr.setResolved(asked.id, true)
    yield* client.ListPullRequests()
    const ready = yield* inboxWhen(client, (items) => reasonsOf(items, pr)?.[0] === "ReadyToMerge")
    assert.deepStrictEqual(reasonsOf(ready, pr), ["ReadyToMerge"])

    pr.mergeable = "CONFLICTING"
    yield* client.ListPullRequests()
    yield* inboxWhen(client, (items) => reasonsOf(items, pr) === undefined)
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
    yield* inboxWhen(client, (items) => reasonsOf(items, pr) !== undefined)

    yield* client.UnfollowRepository({ repository: followed! })
    yield* client.ListPullRequests()

    yield* inboxWhen(client, (items) => reasonsOf(items, pr) === undefined)
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
      const listed = yield* inboxWhen(f.client, (items) => reasonsOf(items, pr)?.length === 2)

      assert.deepStrictEqual(titles(listed), ["Greet"])
      assert.deepStrictEqual(reasonsOf(listed, pr), ["AgentReviewFinished", "ChecksFailing"])
      assert.deepStrictEqual(
        (itemOf(listed, pr)?.reasons ?? []).flatMap((reason) =>
          Predicate.isTagged(reason, "AgentReviewFinished") ? [reason.lead] : [],
        ),
        [answer.markdown],
      )
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
    yield* inboxWhen(client, (items) => reasonsOf(items, pr) !== undefined)
    yield* deadlineSet

    pr.checks = "SUCCESS"
    yield* TestClock.adjust("2 minutes")

    yield* inboxWhen(client, (items) => reasonsOf(items, pr) === undefined)
  }),
)

it.live("lists the Global chat while its own Question waits, until the user answers it", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.SendGlobalMessage({
      message: "Please ask a question",
      images: [],
      context: null,
    })

    const listed = yield* inboxWhen(f.client, (items) =>
      items.some(Predicate.isTagged("GlobalChat")),
    )

    const asked = listed.flatMap((item) =>
      Predicate.isTagged(item, "GlobalChat") ? [item] : [],
    )[0]

    assert.strictEqual(listed[0], asked)
    const [question] = asked?.requests ?? []
    assert.strictEqual(question?._tag, "Question")

    yield* f.client.AnswerGlobalRequest({
      requestId: question?.requestId ?? "",
      answer: AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
    })

    yield* inboxWhen(f.client, (items) => !items.some(Predicate.isTagged("GlobalChat")))
  }),
)

it.live(
  "drops a queued PR once a Started work update includes the Agent review the Global chat started, leaving it not done",
  () =>
    Effect.gen(function* () {
      const f = yield* reviewsFixture(true)
      const pr = f.seed("Greet")
      yield* f.client.AddToQueue({ references: [ref(pr)] })

      const start = { pullRequest: ref(pr), revision: revisionOf(pr) }
      yield* f.client.SendGlobalMessage({
        message: `call:start_agent_review ${JSON.stringify(start)}`,
        images: [],
        context: null,
      })
      yield* f.reviewState(pr, status("reviewing"))
      yield* f.reviews.release({ submit: [answer] })

      const { review } = yield* f.reviewState(
        pr,
        (state) => reviewed(state) && state.review?.includedInStartedWorkUpdate === true,
      )

      assert.isFalse(review?.done)
      yield* inboxWhen(f.client, (items) => titles(items).length === 0)
    }),
)
