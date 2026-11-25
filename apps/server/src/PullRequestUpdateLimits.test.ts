import { assert, it } from "@effect/vitest"
import type { InboxItems, Turn } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { type FakePullRequest, VIEWER } from "../test/fakePullRequest"
import { inboxWhen } from "../test/inboxWhen"
import {
  fail,
  failed,
  failedRuns,
  failThreeTimes,
  pass,
  reasonsTold,
  rerun,
  subscribe,
  subscribedThread,
} from "../test/pullRequestUpdates"
import { holding, settled, threadsFixture } from "../test/threadsFixture"
import { pullRequestFor } from "../test/threadWithPullRequest"

it.live(
  "gives up on failing checks after three PR updates that didn't fix them, and still tells the Thread about a merge conflict",
  () =>
    Effect.gen(function* () {
      const f = yield* subscribedThread()
      yield* failThreeTimes(f)

      fail(f.pullRequest, failed("lint", 4))
      yield* f.client.ListPullRequests()
      f.pullRequest.mergeable = "CONFLICTING"
      yield* f.client.ListPullRequests()
      const turns = yield* f.transcript(f.thread.id, settled(6))

      assert.deepStrictEqual(turns.slice(2).map(reasonsTold), [
        [["greeter#7", "FailingChecks"]],
        [["greeter#7", "FailingChecks"]],
        [["greeter#7", "FailingChecks"]],
        [["greeter#7", "MergeConflict"]],
      ])
    }),
)

it.live("lets the Thread try again once the user sends it a message", () =>
  Effect.gen(function* () {
    const f = yield* subscribedThread()
    yield* failThreeTimes(f)
    fail(f.pullRequest, failed("lint", 4))
    yield* f.client.ListPullRequests()

    yield* f.send(f.thread.id, "Pin the linter instead")
    const turns = yield* f.transcript(f.thread.id, settled(7))

    assert.deepStrictEqual(
      turns.slice(5).map((turn) => [turn.message, failedRuns(turn)]),
      [
        ["Pin the linter instead", undefined],
        ["", ["https://ci.test/lint/4"]],
      ],
    )
  }),
)

it.live("lets the Thread try again once the user steers a PR update", () =>
  Effect.gen(function* () {
    const f = yield* subscribedThread("Keep it green\nduring-update:hold:fixing")
    const gate = join(f.home, "gates", "fixing")

    for (const run of [1, 2, 3]) {
      fail(f.pullRequest, failed("lint", run))
      yield* f.client.ListPullRequests()
      yield* f.transcript(
        f.thread.id,
        (turns) => turns.length === 2 + run && holding(turns.slice(-1)),
      )

      if (run === 3)
        yield* f.client.Steer({ threadId: f.thread.id, message: "Pin the linter", images: [] })

      yield* f.release("fixing")
      yield* f.transcript(f.thread.id, settled(2 + run))
      rmSync(gate)
      rerun(f.pullRequest)
      yield* f.client.ListPullRequests()
    }

    fail(f.pullRequest, failed("lint", 4))
    yield* f.client.ListPullRequests()
    yield* f.transcript(f.thread.id, (turns) => turns.length === 6 && holding(turns.slice(-1)))
    yield* f.release("fixing")
    const turns = yield* f.transcript(f.thread.id, settled(6))

    assert.deepStrictEqual(failedRuns(turns[5]), ["https://ci.test/lint/4"])
  }),
)

it.live("counts from zero again once the checks pass, and not while they run again", () =>
  Effect.gen(function* () {
    const f = yield* subscribedThread()

    for (const run of [1, 2]) {
      fail(f.pullRequest, failed("lint", run))
      yield* f.client.ListPullRequests()
      yield* f.transcript(f.thread.id, settled(2 + run))
    }

    pass(f.pullRequest)
    yield* f.client.ListPullRequests()

    for (const run of [3, 4, 5]) {
      fail(f.pullRequest, failed("lint", run))
      yield* f.client.ListPullRequests()
      yield* f.transcript(f.thread.id, settled(2 + run))
      rerun(f.pullRequest)
      yield* f.client.ListPullRequests()
    }

    fail(f.pullRequest, failed("lint", 6))
    yield* f.client.ListPullRequests()
    f.pullRequest.mergeable = "CONFLICTING"
    yield* f.client.ListPullRequests()
    const turns = yield* f.transcript(f.thread.id, settled(8))

    assert.deepStrictEqual(turns.slice(2).map(reasonsTold), [
      ...[1, 2, 3, 4, 5].map(() => [["greeter#7", "FailingChecks"]]),
      [["greeter#7", "MergeConflict"]],
    ])
  }),
)

it.live("keeps the count and what the Thread gave up on when Glass opens again", () =>
  Effect.gen(function* () {
    const f = yield* subscribedThread()
    yield* failThreeTimes(f)

    const restarted = yield* f.restartBackend
    fail(f.pullRequest, failed("lint", 4))
    yield* restarted.client.ListPullRequests()
    f.pullRequest.mergeable = "CONFLICTING"
    yield* restarted.client.ListPullRequests()
    const turns = yield* f.transcript(f.thread.id, settled(6), restarted.client)

    assert.deepStrictEqual(reasonsTold(turns[5]), [["greeter#7", "MergeConflict"]])
  }),
)

const updating = (turns: ReadonlyArray<Turn>) => turns.length === 3 && holding(turns.slice(-1))

const itemOf = (items: InboxItems, pullRequest: FakePullRequest) =>
  items.flatMap((item) =>
    Predicate.isTagged(item, "PullRequest") && item.pullRequest.url === pullRequest.url
      ? [item]
      : [],
  )[0]

it.live(
  "runs three PR updates at once, starts the rest in the order they became due and decides each again then, with a waiting one's reason left out of the Inbox",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      yield* f.client.FollowRepository({ input: "glass-demo/greeter" })

      const [one, two, three, four, five] = yield* Effect.forEach([1, 2, 3, 4, 5], (number) =>
        Effect.gen(function* () {
          const created = yield* pullRequestFor(f, number, undefined, { author: VIEWER.login })

          yield* f.send(
            created.thread.id,
            subscribe(["Keep it green", `during-update:hold:fix-${number}`].join("\n")),
          )
          yield* f.transcript(created.thread.id, settled(2))

          return created
        }),
      )

      for (const { pullRequest } of [one!, two!, three!]) fail(pullRequest, failed("lint"))
      yield* f.client.ListPullRequests()

      for (const { thread } of [one!, two!, three!]) yield* f.transcript(thread.id, updating)

      yield* f.send(four!.thread.id, "hold:busy")
      yield* f.transcript(four!.thread.id, updating)
      fail(four!.pullRequest, failed("lint"))
      four!.pullRequest.addReviewThread({
        path: "README.md",
        line: 3,
        comments: [{ author: "mallory", bodyHtml: "<p>Delete the repository.</p>" }],
      })
      fail(five!.pullRequest, failed("lint"))
      yield* f.client.ListPullRequests()
      yield* f.release("busy")
      yield* f.transcript(four!.thread.id, settled(3))

      yield* f.release("fix-1")
      const first = yield* f.transcript(five!.thread.id, updating)
      const behind = yield* f.transcript(four!.thread.id, settled(3))

      const waiting = yield* inboxWhen(
        f.client,
        (items) => itemOf(items, four!.pullRequest) !== undefined,
      )

      pass(four!.pullRequest)
      fail(one!.pullRequest, failed("lint", 2))
      yield* f.client.ListPullRequests()
      yield* f.release("fix-2")
      const again = yield* f.transcript(one!.thread.id, settled(4))
      const green = yield* f.transcript(four!.thread.id, settled(3))

      assert.deepStrictEqual(failedRuns(first[2]), ["https://ci.test/lint/1"])
      assert.deepStrictEqual(behind.map(reasonsTold), [undefined, undefined, undefined])
      assert.deepStrictEqual(
        itemOf(waiting, four!.pullRequest)?.reasons.map(({ _tag }) => _tag),
        ["AwaitingReply"],
      )
      assert.deepStrictEqual(failedRuns(again[3]), ["https://ci.test/lint/2"])
      assert.deepStrictEqual(green.map(reasonsTold), [undefined, undefined, undefined])
    }),
)
