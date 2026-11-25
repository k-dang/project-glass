import { assert, describe, it } from "@effect/vitest"
import {
  ChangesRequestedEvent,
  ChecksFailedEvent,
  ChecksPassedEvent,
  EventPage,
  MergeConflictAppearedEvent,
  MergeConflictClearedEvent,
  PullRequestClosedEvent,
  PullRequestMergedEvent,
  PullRequestRef,
  ReviewFeedbackWaitingEvent,
} from "@glass/contracts"
import { DateTime, Effect, Option, Predicate, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { eventually } from "../test/eventually"
import { startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"
import { gitIn } from "../test/gitRepositories"
import { inboxWhen } from "../test/inboxWhen"
import { connectMcp, toolText } from "../test/mcpClient"
import { calledBy, glassCall, holding, settled, threadsFixture } from "../test/threadsFixture"
import { GlobalChatCaller } from "./mcp/McpCredentials"

const mine = {
  owner: "octo-org",
  repo: "glass",
  author: VIEWER.login,
  base: { sha: "b0", files: {} },
  head: { sha: "h1", files: {} },
}

const ref = (pr: FakePullRequest) =>
  new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })

const decodePage = Schema.decodeUnknownSync(EventPage)

interface Filter {
  readonly pullRequest?: { readonly owner: string; readonly repo: string; readonly number: number }
  readonly threadId?: string
  readonly since?: string
}

type Backend = Pick<Effect.Success<ReturnType<typeof startBackend>>, "baseUrl" | "mcpCredentials">

const eventsTool = Effect.fnUntraced(function* ({ baseUrl, mcpCredentials }: Backend) {
  const mcp = yield* connectMcp(
    baseUrl,
    yield* mcpCredentials.issue(
      GlobalChatCaller.make({ globalChatId: "global-chat", sessionId: "global-session" }),
    ),
  )

  const call = (filter: Filter = {}) => mcp.call("list_recent_events", { limit: 50, ...filter })

  return {
    call,
    page: (filter?: Filter) =>
      call(filter).pipe(Effect.map((result) => decodePage(result.structuredContent))),
  }
})

const failWritesOf = (home: string, kind: string) => {
  const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))

  try {
    database.exec(
      `CREATE TRIGGER refuse_event BEFORE INSERT ON event WHEN NEW.kind = '${kind}'
       BEGIN SELECT RAISE(FAIL, 'refused'); END`,
    )
  } finally {
    database.close()
  }
}

const startGlass = Effect.gen(function* () {
  const github = yield* startFakeGitHub()
  const home = yield* isolatedHome

  const backend = yield* startBackend(
    { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
    home,
  )

  yield* backend.client.FollowRepository({ input: "octo-org/glass" })

  const { page } = yield* eventsTool(backend)

  return {
    ...backend,
    github,
    home,
    read: backend.client.ListPullRequests(),
    page,
    events: (filter?: Filter) =>
      page(filter).pipe(Effect.map(({ events }) => events.map(({ event }) => event))),
  }
})

describe("Events from GitHub", () => {
  it.live("records a PR's checks failing between two reads of the mirror", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const pr = f.github.seedPullRequest({ ...mine, checks: "SUCCESS" })
      yield* f.read

      pr.checks = "FAILURE"
      yield* f.read

      const { events } = yield* f.page()

      assert.deepStrictEqual(
        events.map(({ source, event }) => ({ source, event })),
        [{ source: "github", event: ChecksFailedEvent.make({ pullRequest: ref(pr), head: "h1" }) }],
      )
    }),
  )

  it.effect("records what changed when the mirror's poll comes round", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const pr = f.github.seedPullRequest({ ...mine, checks: "SUCCESS" })
      yield* f.read

      pr.checks = "FAILURE"

      yield* eventually(
        TestClock.adjust("2 minutes").pipe(
          Effect.andThen(f.events()),
          Effect.map((events) =>
            assert.deepStrictEqual(events, [
              ChecksFailedEvent.make({ pullRequest: ref(pr), head: "h1" }),
            ]),
          ),
        ),
      )
    }),
  )

  it.live("lists a PR's checks passing after they failed, newest first", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const pr = f.github.seedPullRequest({ ...mine, checks: "PENDING" })
      yield* f.read

      pr.checks = "FAILURE"
      yield* f.read
      pr.checks = "SUCCESS"
      yield* f.read

      assert.deepStrictEqual(yield* f.events(), [
        ChecksPassedEvent.make({ pullRequest: ref(pr), head: "h1" }),
        ChecksFailedEvent.make({ pullRequest: ref(pr), head: "h1" }),
      ])
    }),
  )

  it.live("records nothing for a PR's first read or a read that changed nothing", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      f.github.seedPullRequest({ ...mine, checks: "FAILURE" })
      yield* f.read
      yield* f.read

      f.github.seedPullRequest({ ...mine, checks: "SUCCESS" })
      yield* f.read

      assert.deepStrictEqual(yield* f.events(), [])
    }),
  )

  it.live("records review feedback waiting and changes requested", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const pr = f.github.seedPullRequest(mine)
      yield* f.read

      pr.addReviewThread({
        path: "README.md",
        comments: [{ author: "mona", bodyHtml: "<p>Why?</p>" }],
      })
      pr.addReview({ author: "mona", state: "CHANGES_REQUESTED" })
      yield* f.read
      yield* f.read

      assert.sameDeepMembers(yield* f.events(), [
        ReviewFeedbackWaitingEvent.make({ pullRequest: ref(pr), reviewThreads: 1 }),
        ChangesRequestedEvent.make({ pullRequest: ref(pr) }),
      ])
    }),
  )

  it.live("records a merge conflict appearing and clearing", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const pr = f.github.seedPullRequest(mine)
      yield* f.read

      pr.mergeable = "CONFLICTING"
      yield* f.read
      pr.mergeable = "UNKNOWN"
      yield* f.read
      pr.mergeable = "MERGEABLE"
      yield* f.read

      assert.deepStrictEqual(yield* f.events(), [
        MergeConflictClearedEvent.make({ pullRequest: ref(pr) }),
        MergeConflictAppearedEvent.make({ pullRequest: ref(pr) }),
      ])
    }),
  )

  it.live("sees no merge conflict in a PR that is only blocked or behind", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const pr = f.github.seedPullRequest(mine)
      pr.addReview({ author: "mona", state: "APPROVED" })
      yield* f.read
      yield* inboxWhen(f.client, (items) => items.length === 1)

      pr.reviewDecision = "REVIEW_REQUIRED"
      yield* f.read
      yield* inboxWhen(f.client, (items) => items.length === 0)
      pr.reviewDecision = null
      yield* f.read
      yield* inboxWhen(f.client, (items) => items.length === 1)
      pr.mergeStateStatus = "BEHIND"
      yield* f.read
      yield* inboxWhen(f.client, (items) => items.length === 0)

      assert.deepStrictEqual(yield* f.events(), [])
    }),
  )

  it.effect("lists one PR's Events, and the Events since a time", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const early = f.github.seedPullRequest({ ...mine, checks: "SUCCESS" })
      const late = f.github.seedPullRequest({ ...mine, checks: "SUCCESS" })
      yield* f.read
      early.checks = "FAILURE"
      yield* f.read

      yield* TestClock.adjust("1 hour")
      late.checks = "FAILURE"
      yield* f.read

      assert.deepStrictEqual(
        yield* f.events({
          pullRequest: { owner: "Octo-Org", repo: "glass", number: early.number },
        }),
        [ChecksFailedEvent.make({ pullRequest: ref(early), head: "h1" })],
      )
      assert.deepStrictEqual(yield* f.events({ since: "1970-01-01T00:30:00Z" }), [
        ChecksFailedEvent.make({ pullRequest: ref(late), head: "h1" }),
      ])
    }),
  )
})

describe("The Event log", () => {
  it.live("loses only the Event whose write failed, and the mirror carries on", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const pr = f.github.seedPullRequest({ ...mine, checks: "SUCCESS" })
      yield* f.read
      failWritesOf(f.home, "ChecksFailed")

      pr.checks = "FAILURE"
      pr.addReview({ author: "mona", state: "CHANGES_REQUESTED" })
      yield* f.read

      const [item] = yield* inboxWhen(f.client, (items) => items.length === 1)

      assert.deepStrictEqual(
        Predicate.isTagged(item, "PullRequest") ? item.reasons.map(({ _tag }) => _tag) : [],
        ["ChangesRequested", "ChecksFailing"],
      )
      assert.deepStrictEqual(yield* f.events(), [
        ChangesRequestedEvent.make({ pullRequest: ref(pr) }),
      ])
    }),
  )

  it.effect("deletes Events older than 30 days", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const pr = f.github.seedPullRequest({ ...mine, checks: "SUCCESS" })
      yield* f.read
      pr.checks = "FAILURE"
      yield* f.read

      const kinds = f.events().pipe(Effect.map((events) => events.map(({ _tag }) => _tag)))

      yield* TestClock.adjust("29 days")
      pr.checks = "SUCCESS"
      yield* f.read
      assert.deepStrictEqual(yield* kinds, ["ChecksPassed", "ChecksFailed"])

      yield* TestClock.adjust("2 days")
      pr.checks = "FAILURE"
      yield* f.read
      assert.deepStrictEqual(yield* kinds, ["ChecksFailed", "ChecksPassed"])
    }),
  )
})

describe("Events for a Thread's PR", () => {
  it.live("records a Thread's PR merging or closing once, and lists it for that Thread", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      yield* f.client.FollowRepository({ input: "glass-demo/greeter" })

      const onPullRequest = Effect.fnUntraced(function* (gate: string, number: number) {
        const headBranch = `feature/${gate}`
        const thread = yield* f.start(`hold:${gate}`)
        yield* f.transcript(thread.id, holding)
        gitIn(f.worktree(thread.name), "switch", "--quiet", "-c", headBranch)

        const pr = f.github.seedPullRequest({
          owner: "glass-demo",
          repo: "greeter",
          number,
          headBranch,
          base: { sha: "b0", files: {} },
          head: { sha: `h${number}`, files: {} },
        })

        yield* f.release(gate)

        return { pr, threadId: thread.id }
      })

      const pullRequestsWhen = (client: typeof f.client, state: "Open" | "ended") =>
        client.WatchThreadPullRequests().pipe(
          Stream.filter(
            (listed) =>
              listed.length === 2 &&
              listed.every((pr) => Predicate.isTagged(pr.state, "Open") === (state === "Open")),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )

      const merged = yield* onPullRequest("merged", 7)
      const closed = yield* onPullRequest("closed", 8)
      yield* pullRequestsWhen(f.client, "Open")

      merged.pr.edit({ state: "MERGED" })
      closed.pr.edit({ state: "CLOSED" })
      yield* f.client.ListPullRequests()
      yield* pullRequestsWhen(f.client, "ended")

      const recorded = Effect.fnUntraced(function* (backend: Backend) {
        const { page } = yield* eventsTool(backend)

        const of = (threadId: string) =>
          page({ threadId }).pipe(Effect.map(({ events }) => events.map(({ event }) => event)))

        return { merged: yield* of(merged.threadId), closed: yield* of(closed.threadId) }
      })

      const expected = {
        merged: [
          PullRequestMergedEvent.make({
            pullRequest: ref(merged.pr),
            mergedAt: DateTime.makeUnsafe(merged.pr.mergedAt ?? ""),
          }),
        ],
        closed: [
          PullRequestClosedEvent.make({
            pullRequest: ref(closed.pr),
            closedAt: DateTime.makeUnsafe(closed.pr.closedAt ?? ""),
          }),
        ],
      }

      assert.deepStrictEqual(yield* recorded(f), expected)

      const restarted = yield* f.restartBackend
      yield* restarted.client.ListPullRequests()
      yield* pullRequestsWhen(restarted.client, "ended")

      assert.deepStrictEqual(yield* recorded(restarted), expected)
    }),
  )

  it.live("answers a Thread's agent, with no Events for a Thread without a PR", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start()
      yield* f.transcript(thread.id, settled(1))

      yield* f.send(thread.id, glassCall("list_recent_events", { limit: 5, threadId: thread.id }))
      const [, asked] = yield* f.transcript(thread.id, settled(2))
      const answered = calledBy(asked)

      assert.deepStrictEqual(
        { status: answered.status, page: JSON.parse(answered.text) },
        { status: "done", page: { events: [], hasMore: false } },
      )
    }),
  )

  it.live("explains a Thread that doesn't exist, or a PR passed with a Thread", () =>
    Effect.gen(function* () {
      const f = yield* startGlass
      const { call } = yield* eventsTool(f)

      const both = yield* call({
        threadId: "no-such-thread",
        pullRequest: { owner: "octo-org", repo: "glass", number: 1 },
      })

      assert.isTrue(both.isError)
      assert.include(toolText(both), "not both")

      const missing = yield* call({ threadId: "no-such-thread" })

      assert.isTrue(missing.isError)
      assert.include(toolText(missing), "no Thread with that id")
    }),
  )
})
