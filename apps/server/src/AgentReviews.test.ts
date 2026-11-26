import { assert, it } from "@effect/vitest"
import {
  AgentReviewTurn,
  type AgentHarness,
  type AgentReviewState,
  applyTranscriptUpdate,
  defaultReviewPrompt,
  emptyTranscript,
  PullRequestRef,
  Revision,
  acceptedSuggestedDraftOf,
  type Turn,
} from "@glass/contracts"
import { Clock, DateTime, Effect, Exit, Option, Predicate, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { vi } from "vite-plus/test"
import { eventually } from "../test/eventually"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { watchDeadlines } from "../test/deadlines"
import { isolatedHome, startBackend } from "../test/harness"
import { type ReviewScript, reviewStopped } from "../test/scriptedAdapter"
import { scriptedReviews } from "../test/scriptedReviews"
import { scriptedHost } from "../test/threadsFixture"
import { Deadlines } from "./ServerConfig"

const answer = {
  markdown: [
    "**The greeting drops callers' punctuation.** The greeting now takes a name.",
    "## Punctuation is dropped\n\nBlocking: `greet` in `greet.ts` strips the name's trailing `!`.",
  ].join("\n\n"),
  hotspots: [],
  lowAttention: [],
}

const deadline = 60_000

type BackendClient = Effect.Success<ReturnType<typeof startBackend>>["client"]

const transcript = (
  client: BackendClient,
  threadId: string,
  until: (turns: ReadonlyArray<Turn>) => boolean,
) =>
  client.WatchTranscript({ threadId }).pipe(
    Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
    Stream.map(({ turns }) => turns),
    Stream.filter(until),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

const ended = (count: number) => (turns: ReadonlyArray<Turn>) =>
  turns.length === count && turns.every((turn) => turn.ended !== null)

const texts = (turn: Turn | undefined) =>
  (turn?.parts ?? []).flatMap((part) => (Predicate.isTagged(part, "Text") ? [part.text] : []))

const toolCalls = (turn: Turn | undefined) =>
  (turn?.parts ?? []).filter((part) => Predicate.isTagged(part, "ToolCall"))

const holding = (turns: ReadonlyArray<Turn>) => texts(turns[0]).includes("Holding.")

const fixture = Effect.fnUntraced(function* (
  script: ReviewScript = { submit: [answer] },
  harness: AgentHarness = "pi",
) {
  const github = yield* startFakeGitHub({ git: true })
  const home = yield* isolatedHome
  const { watched, deadlineSet } = yield* watchDeadlines(deadline)
  const gates = join(home, "gates")
  mkdirSync(gates)
  vi.stubEnv("GLASS_SCRIPTED_GATES", gates)
  const reviews = scriptedReviews(gates)
  yield* reviews.script(script)

  const pr = github.seedPullRequest({
    title: "Greet people",
    body: "Use the person's name.",
    base: {
      sha: "b0",
      files: { "greet.ts": "hello\nbye\n", "main.ts": "greet()\n", "old/name.ts": "a\nb\n" },
    },
    head: {
      sha: "h1",
      files: {
        "greet.ts": "hi\nhello name\nbye\n",
        "main.ts": "greet()\n",
        "src/name.ts": "a\nB\n",
      },
    },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n-hello\n+hi\n+hello name\n bye",
      },
      {
        path: "src/name.ts",
        previousPath: "old/name.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,2 +1,2 @@\n a\n-b\n+B",
      },
    ],
  })

  pr.addReviewThread({
    path: "greet.ts",
    line: 2,
    comments: [{ author: "hubot", bodyHtml: "<p>Why a name?</p>" }],
  })
  pr.addDraft({ path: "greet.ts", side: "RIGHT", line: 1, body: "My own note", diffHunk: "" })

  const ref = new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })
  const revision = new Revision({ base: pr.base.sha, head: pr.head.sha })

  const env = {
    GH_TOKEN: VIEWER.token,
    GLASS_GITHUB_API_URL: github.url,
    GLASS_GIT_REMOTE: github.gitUrl,
    GLASS_AGENT_HOST_BUNDLE: scriptedHost,
  }

  let serverScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

  const started = yield* startBackend(env, home).pipe(
    Effect.provideService(Scope.Scope, serverScope),
    Effect.provideService(Clock.Clock, watched),
    Effect.updateService(Deadlines, (deadlines) => ({ ...deadlines, agentReviewMs: deadline })),
  )

  let client = started.client

  const engineSettings = yield* client.GetEngineSettings({ feature: "agentReviews" })
  yield* client.SetEngineSettings({
    feature: "agentReviews",
    engineSettings: { ...engineSettings, harness },
  })

  const state = (predicate: (state: AgentReviewState) => boolean) =>
    Effect.suspend(() =>
      client
        .WatchAgentReview({ pullRequest: ref })
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow)),
    )

  const failed = state((current) => current.job.status === "failed").pipe(
    Effect.map(({ job }) => (job.status === "failed" ? job.reason : assert.fail(job.status))),
  )

  const reviewThreads = Effect.suspend(() =>
    client.WatchThreads().pipe(
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.map((threads) => threads.filter(({ forReview }) => forReview)),
    ),
  )

  const runningThread = eventually(
    reviewThreads.pipe(
      Effect.flatMap((threads) =>
        threads.length === 0 ? Effect.fail("No Review Thread yet") : Effect.succeed(threads[0]!.id),
      ),
    ),
  )

  return {
    deadlineSet,
    reviews,
    github,
    home,
    gates,
    pr,
    ref,
    revision,
    get client() {
      return client
    },
    state,
    failed,
    reviewThreads,
    runningThread,
    checkout: (threadId: string) =>
      join(home, ".project-glass", "agent-review-checkouts", threadId),
    start: Effect.suspend(() => client.StartAgentReview({ pullRequest: ref, revision })),
    transcript: (threadId: string, until: (turns: ReadonlyArray<Turn>) => boolean) =>
      Effect.suspend(() => transcript(client, threadId, until)),
    send: (threadId: string, message: string) =>
      Effect.suspend(() => client.SendMessage({ threadId, message, images: [], feedback: [] })),
    restart: Effect.gen(function* () {
      yield* Scope.close(serverScope, Exit.void)
      serverScope = yield* Scope.make()
      client = (yield* startBackend(env, home).pipe(
        Effect.provideService(Scope.Scope, serverScope),
      )).client

      return yield* state(() => true)
    }),
  }
})

const reviewed = (state: AgentReviewState) => state.review !== null && state.job.status === "idle"

const hotspot = (title: string) => ({
  title,
  kind: "public-contract",
  place: null,
  why: `Why ${title}`,
  evidence: `Evidence ${title}`,
  check: `Check ${title}`,
})

it.live("starts a hidden Review Thread whose first Turn carries the review prompt", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const { review } = yield* f.state(reviewed)
    const threadId = review!.threadId!

    assert.strictEqual(review?.markdown, answer.markdown)
    assert.deepStrictEqual(review?.revision, f.revision)

    const [thread] = yield* f.reviewThreads
    assert.strictEqual(thread?.id, threadId)
    assert.strictEqual(thread?.harness, "pi")

    const [first] = yield* f.transcript(threadId, ended(1))
    assert.deepStrictEqual(first?.context, AgentReviewTurn.make({}))
    assert.include(first?.message, "Use the person's name.")
    assert.include(first?.message, f.revision.base)
    assert.include(first?.message, f.revision.head)
    assert.include(first?.message, "Why a name?")
    assert.notInclude(first?.message, "My own note")
    assert.notInclude(first?.message, "+hello name")
    assert.deepStrictEqual(texts(first), [".git,greet.ts,main.ts,src"])
    assert.isFalse(existsSync(f.checkout(threadId)))

    const activity = yield* f.client.ListActivity({ limit: 10 })
    assert.isEmpty(activity.activities)

    assert.deepStrictEqual(yield* f.restart, { review, job: { status: "idle" } })
  }),
)

it.live("tells the agent why it refused an answer, and saves the one it accepts", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      submit: [{ ...answer, hotspots: [{ ...hotspot("Unknown kind"), kind: "style" }] }, answer],
    })

    yield* f.start
    const { review } = yield* f.state(reviewed)

    const [first] = yield* f.transcript(review!.threadId!, ended(1))
    const [refused, accepted] = toolCalls(first)
    assert.strictEqual(refused?.status, "failed")
    assert.include(refused?.output, `["hotspots"][0]["kind"]`)
    assert.strictEqual(accepted?.status, "done")
    assert.strictEqual(review?.markdown, answer.markdown)
  }),
)

it.live("keeps the first five hotspots, linking only the ones placed in the diff", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      submit: [
        {
          ...answer,
          hotspots: [
            {
              ...hotspot("In the diff"),
              place: { path: "greet.ts", side: "new", startLine: 1, endLine: 2 },
            },
            {
              ...hotspot("Unchanged file"),
              place: { path: "main.ts", side: "new", startLine: 1, endLine: 1 },
            },
            {
              ...hotspot("Past the hunk"),
              place: { path: "greet.ts", side: "new", startLine: 3, endLine: 9 },
            },
            {
              ...hotspot("Old side"),
              place: { path: "greet.ts", side: "old", startLine: 1, endLine: 1 },
            },
            hotspot("No place"),
            hotspot("Sixth"),
          ],
          lowAttention: [
            { path: "src/name.ts", reason: "Rename" },
            { path: "greet.ts", reason: "A hotspot is here" },
            { path: "nowhere.ts", reason: "Not changed" },
          ],
        },
      ],
    })

    yield* f.start
    const { review } = yield* f.state(reviewed)

    assert.deepStrictEqual(
      review?.hotspots.map(({ title, place }) => [title, place]),
      [
        ["In the diff", { path: "greet.ts", side: "new", startLine: 1, endLine: 2 }],
        ["Unchanged file", null],
        ["Past the hunk", null],
        ["Old side", { path: "greet.ts", side: "old", startLine: 1, endLine: 1 }],
        ["No place", null],
      ],
    )
    assert.deepStrictEqual(review?.lowAttention, [{ path: "src/name.ts", reason: "Rename" }])

    const restored = yield* f.restart
    assert.deepStrictEqual(restored.review, review)
  }),
)

it.live("fails a review whose Turn ends without an accepted answer, removing its Thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ submit: [{ markdown: " \n", hotspots: [], lowAttention: [] }] })
    yield* f.start

    const unanswered = yield* f.failed
    assert.strictEqual(unanswered.reason, "unusable-output")
    assert.strictEqual(unanswered.runner?.harness, "pi")
    assert.isEmpty(yield* f.reviewThreads)

    yield* f.reviews.script({ fail: "pi could not reach its model." })
    yield* f.start
    yield* f.state(({ job }) => job.status === "reviewing")

    const crashed = yield* f.state(
      ({ job }) => job.status === "failed" && job.reason.reason === "runner",
    )

    assert.strictEqual(
      crashed.job.status === "failed" && crashed.job.reason.message,
      "pi could not reach its model.",
    )
    assert.isNull(crashed.review)
    assert.isEmpty(yield* f.reviewThreads)
  }),
)

it.live("stops a running review and removes its Thread when Glass quits", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.reviews.hold
    yield* f.start
    const threadId = yield* f.runningThread
    yield* f.transcript(threadId, holding)

    assert.deepStrictEqual(yield* f.restart, { review: null, job: { status: "idle" } })
    yield* eventually(
      Effect.sync(() => assert.isTrue(existsSync(join(f.gates, reviewStopped(threadId))))),
    )
    assert.isFalse(existsSync(f.checkout(threadId)))
    assert.isEmpty(yield* f.reviewThreads)
  }),
)

it.live("removes the Review Threads and checkouts no Agent review keeps when Glass starts", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const threadId = (yield* f.state(reviewed)).review!.threadId!
    yield* f.send(threadId, "Why?")
    yield* f.transcript(threadId, ended(2))
    const stray = f.checkout("left-by-a-crash")
    mkdirSync(stray)

    yield* f.restart
    assert.isTrue(existsSync(f.checkout(threadId)))
    assert.isFalse(existsSync(stray))

    const database = new DatabaseSync(join(f.home, ".project-glass", "glass.db"))

    try {
      database.exec("UPDATE agent_reviews SET thread_id = NULL")
    } finally {
      database.close()
    }

    yield* f.restart
    assert.isEmpty(yield* f.reviewThreads)
    assert.isFalse(existsSync(f.checkout(threadId)))
  }),
)

it.live("stops a review's Turn when the review is cancelled, keeping the last review", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const first = (yield* f.state(reviewed)).review!

    yield* f.reviews.hold
    yield* f.start
    yield* f.state(({ job }) => job.status === "reviewing")

    const held = yield* eventually(
      f.reviewThreads.pipe(
        Effect.flatMap((threads) => {
          const found = threads.find(({ id }) => id !== first.threadId)

          return found === undefined ? Effect.fail("Not started") : Effect.succeed(found.id)
        }),
      ),
    )

    yield* f.transcript(held, holding)
    assert.isTrue(existsSync(f.checkout(held)))

    yield* f.client.CancelAgentReview({ pullRequest: f.ref })

    const cancelled = yield* f.state(({ job }) => job.status === "idle")
    assert.deepStrictEqual(cancelled.review, first)
    yield* eventually(
      Effect.sync(() => assert.isTrue(existsSync(join(f.gates, reviewStopped(held))))),
    )
    assert.isFalse(existsSync(f.checkout(held)))
    assert.deepStrictEqual(
      (yield* f.reviewThreads).map(({ id }) => id),
      [first.threadId],
    )
    assert.deepStrictEqual((yield* f.restart).review, first)
  }),
)

it.live("checks the Revision out again for the first Follow-up, continuing the same Thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const prompt = "Look only at how names are handled."
    yield* f.client.SetReviewPrompt({ prompt })
    yield* f.start
    const threadId = (yield* f.state(reviewed)).review!.threadId!
    assert.isFalse(existsSync(f.checkout(threadId)))

    yield* f.send(threadId, "show the review")
    const [, followUp] = yield* f.transcript(threadId, ended(2))
    const [instructions, files] = texts(followUp)
    assert.include(instructions, prompt)
    assert.notInclude(instructions, defaultReviewPrompt)
    assert.strictEqual(files, ".git,greet.ts,main.ts,src")

    yield* f.send(threadId, "show the session")
    const turns = yield* f.transcript(threadId, ended(3))
    assert.deepStrictEqual(texts(turns[2]), [threadId, "Reply to: show the session"])
    assert.isTrue(existsSync(f.checkout(threadId)))
  }),
)

it.live("keeps the Suggested drafts the agent places on lines of the diff", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const threadId = (yield* f.state(reviewed)).review!.threadId!

    yield* f.send(threadId, "suggest new:greet.ts:2 Could this keep the caller's `!`?")
    yield* f.transcript(threadId, ended(2))
    yield* f.send(threadId, "suggest new:main.ts:1 Unrelated aside.")
    yield* f.transcript(threadId, ended(3))
    yield* f.send(threadId, "suggest old:greet.ts:1 Why drop hello?")

    const turns = yield* f.transcript(threadId, ended(4))

    const suggested = turns
      .slice(1)
      .map((turn) => toolCalls(turn).map((call) => acceptedSuggestedDraftOf(call)))

    assert.deepStrictEqual(suggested, [
      [{ path: "greet.ts", side: "new", line: 2, body: "Could this keep the caller's `!`?" }],
      [null],
      [{ path: "greet.ts", side: "old", line: 1, body: "Why drop hello?" }],
    ])
  }),
)

it.live("removes the previous Thread and its checkout when the Agent review is written again", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const previous = (yield* f.state(reviewed)).review!.threadId!
    yield* f.send(previous, "Why?")
    yield* f.transcript(previous, ended(2))
    assert.isTrue(existsSync(f.checkout(previous)))

    yield* f.start

    const rewritten = yield* f.state(
      (state) => reviewed(state) && state.review?.threadId !== previous,
    )

    const replacement = rewritten.review!.threadId!

    yield* eventually(Effect.sync(() => assert.isFalse(existsSync(f.checkout(previous)))))

    const gone = yield* f.client
      .WatchTranscript({ threadId: previous })
      .pipe(Stream.runHead, Effect.flip)

    assert.strictEqual(gone._tag, "ThreadNotFound")
    assert.deepStrictEqual(
      (yield* f.reviewThreads).map(({ id }) => id),
      [replacement],
    )
    assert.strictEqual((yield* f.restart).review?.threadId, replacement)
  }),
)

it.live("marks only the Agent review it names done, keeping that across restarts", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const { writtenAt } = (yield* f.state(reviewed)).review!

    yield* f.client.MarkAgentReviewDone({
      pullRequest: f.ref,
      writtenAt: DateTime.subtract(writtenAt, { minutes: 1 }),
    })
    assert.isFalse((yield* f.state(() => true)).review?.done)

    yield* f.client.MarkAgentReviewDone({ pullRequest: f.ref, writtenAt })
    const done = (yield* f.state((state) => state.review?.done === true)).review!

    assert.deepStrictEqual((yield* f.restart).review, done)
  }),
)

it.live("fails as a stale Revision when the PR has moved on, starting no Thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.pr.push({ head: { sha: "h2", files: { "greet.ts": "hey\n" } } })
    yield* f.start

    assert.strictEqual((yield* f.failed).reason, "stale-revision")
    assert.isEmpty(yield* f.reviewThreads)
  }),
)

it.live(
  "fails as no access when git refuses the Connection, and as a failed fetch when unreachable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const repository = `${f.pr.owner}/${f.pr.repo}`
      f.github.gitRefusedRepositories.add(repository)
      yield* f.start
      assert.strictEqual((yield* f.failed).reason, "no-access")

      f.github.gitRefusedRepositories.clear()
      f.github.unavailableRepositories.add(repository)
      yield* f.start
      yield* f.state(({ job }) => job.status === "failed" && job.reason.reason === "fetch-failed")
    }),
)

it.effect("stops the Turn and fails as timed out when the agent passes its limit", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.reviews.hold
    yield* f.start
    yield* f.deadlineSet
    yield* TestClock.adjust(deadline)

    const failure = yield* f.failed
    assert.strictEqual(failure.reason, "timeout")
    assert.strictEqual(failure.runner?.harness, "pi")
    assert.isEmpty(yield* f.reviewThreads)
  }),
)

it.live("reviews on the engine chosen for Agent reviews", () =>
  Effect.gen(function* () {
    const f = yield* fixture(undefined, "claude-code")
    yield* f.start
    yield* f.state(reviewed)

    const [thread] = yield* f.reviewThreads
    assert.strictEqual(thread?.harness, "claude-code")
  }),
)
