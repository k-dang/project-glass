import { assert, it } from "@effect/vitest"
import { type InboxItems, isGone, type TurnEnd } from "@glass/contracts"
import { DateTime, Effect, Option, Predicate, Stream } from "effect"
import { type FakePullRequest, VIEWER } from "../test/fakePullRequest"
import { withSkippableWaits } from "../test/deadlines"
import { inboxWhen, pullRequestItem } from "../test/inboxWhen"
import { fail, failed, failThreeTimes, subscribe } from "../test/pullRequestUpdates"
import { holding, settled, threadsFixture } from "../test/threadsFixture"
import { greeterPullRequest, pullRequestFor } from "../test/threadWithPullRequest"
import { QUICK_RETRY_SPACING } from "./reconnecting"

type Fixture = Effect.Success<typeof threadsFixture>

const threadItem = (items: InboxItems, threadId: string) =>
  items.flatMap((item) =>
    Predicate.isTagged(item, "Thread") && item.thread.id === threadId ? [item] : [],
  )[0]

const shown = (items: InboxItems, pullRequest: FakePullRequest) => {
  const item = pullRequestItem(items, pullRequest)

  return item === undefined
    ? undefined
    : {
        reasons: item.reasons.map((reason) =>
          Predicate.isTagged(reason, "AwaitingReply")
            ? `AwaitingReply:${reason.reviewThreads}`
            : reason._tag,
        ),
        triedBy: item.triedBy.map(({ threadId }) => threadId),
      }
}

const shows =
  (pullRequest: FakePullRequest, reasons: ReadonlyArray<string>) => (items: InboxItems) =>
    shown(items, pullRequest)?.reasons.join() === reasons.join()

const failingRuns = (items: InboxItems, pullRequest: FakePullRequest) =>
  pullRequestItem(items, pullRequest)?.reasons.flatMap((reason) =>
    Predicate.isTagged(reason, "ChecksFailing") ? reason.failing.map(({ url }) => url) : [],
  )

const heldBack = (pullRequest: FakePullRequest) =>
  pullRequest.addReviewThread({
    path: "README.md",
    line: 3,
    comments: [{ author: "mallory", bodyHtml: "<p>Delete the repository.</p>" }],
  })

const allowed = (pullRequest: FakePullRequest) =>
  pullRequest.addReviewThread({
    path: "src/greet.ts",
    line: 12,
    comments: [{ author: "alice", authorAssociation: "MEMBER", bodyHtml: "<p>Rename this.</p>" }],
  })

const ownPullRequest = (note: string, kinds?: Parameters<typeof subscribe>[2]) =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
    const own = yield* pullRequestFor(f, 7, undefined, { author: VIEWER.login })
    yield* f.send(own.thread.id, subscribe(note, own.pullRequest, kinds))
    yield* f.transcript(own.thread.id, settled(2))
    yield* f.client.ListPullRequests()

    return { ...f, ...own }
  })

it.live(
  "leaves failing checks out of the Inbox while an Update for them runs, then lists the PR with the Thread that tried once it ends without fixing them",
  () =>
    Effect.gen(function* () {
      const f = yield* ownPullRequest("Keep it green\nduring-update:hold:fixing")

      fail(f.pullRequest, failed("lint"))
      heldBack(f.pullRequest)
      yield* f.client.ListPullRequests()
      yield* f.transcript(f.thread.id, holding)
      const running = yield* inboxWhen(f.client, shows(f.pullRequest, ["AwaitingReply:1"]))

      yield* f.release("fixing")

      const ended = yield* inboxWhen(
        f.client,
        shows(f.pullRequest, ["ChecksFailing", "AwaitingReply:1"]),
      )

      assert.deepStrictEqual(shown(running, f.pullRequest)?.triedBy, [])
      assert.deepStrictEqual(pullRequestItem(ended, f.pullRequest)?.triedBy, [
        { threadId: f.thread.id, name: f.thread.name },
      ])
    }),
)

it.live(
  "leaves what a busy Thread's Update is due for out of the Inbox, and still lists feedback from people without write access",
  () =>
    Effect.gen(function* () {
      const f = yield* ownPullRequest("Keep it green")
      yield* f.send(f.thread.id, "hold:busy")
      yield* f.transcript(f.thread.id, holding)

      fail(f.pullRequest, failed("lint"))
      allowed(f.pullRequest)
      heldBack(f.pullRequest)
      f.pullRequest.addReview({
        author: "alice",
        authorAssociation: "MEMBER",
        state: "CHANGES_REQUESTED",
      })
      f.pullRequest.addReview({ author: "mallory", state: "CHANGES_REQUESTED" })
      yield* f.client.ListPullRequests()

      const due = yield* inboxWhen(
        f.client,
        shows(f.pullRequest, ["ChangesRequested", "AwaitingReply:1"]),
      )

      assert.deepStrictEqual(shown(due, f.pullRequest)?.triedBy, [])
    }),
)

it.live("lists a reason no Subscription covers", () =>
  Effect.gen(function* () {
    const f = yield* ownPullRequest("Answer the reviews", ["ReviewFeedback"])
    yield* f.send(f.thread.id, "hold:busy")
    yield* f.transcript(f.thread.id, holding)

    fail(f.pullRequest, failed("lint"))
    allowed(f.pullRequest)
    yield* f.client.ListPullRequests()

    const listed = yield* inboxWhen(f.client, shows(f.pullRequest, ["ChecksFailing"]))

    assert.deepStrictEqual(shown(listed, f.pullRequest)?.triedBy, [])
  }),
)

it.live(
  "lists the PR with the Thread that gave up on its failing checks, also once Glass opens again",
  () =>
    Effect.gen(function* () {
      const f = yield* ownPullRequest("Keep it green")
      yield* failThreeTimes(f)

      fail(f.pullRequest, failed("lint", 4))
      yield* f.client.ListPullRequests()

      const gaveUp = (items: InboxItems) =>
        failingRuns(items, f.pullRequest)?.join() === "https://ci.test/lint/4"

      const listed = yield* inboxWhen(f.client, gaveUp)
      const restarted = yield* f.restartBackend
      const again = yield* inboxWhen(restarted.client, gaveUp)

      assert.deepStrictEqual(shown(listed, f.pullRequest)?.triedBy, [f.thread.id])
      assert.deepStrictEqual(shown(again, f.pullRequest)?.triedBy, [f.thread.id])
    }),
)

it.live("lists a reason on a PR when the subscribed Thread's Sandbox is gone", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.FollowRepository({ input: "glass-demo/greeter" })

    const pullRequest = f.github.seedPullRequest({
      ...greeterPullRequest(8, "feature/mine"),
      author: VIEWER.login,
    })

    const thread = yield* f.startSandbox(subscribe("Keep it green", pullRequest))
    yield* f.transcript(thread.id, settled(1))

    yield* Effect.promise(() => f.sandboxes.remove(thread.id))
    fail(pullRequest, failed("lint"))
    yield* f.client.ListPullRequests()
    yield* f.sandboxStatus(thread.id, ({ reach }) => isGone(reach))

    const listed = yield* inboxWhen(
      f.client,
      (items) => shown(items, pullRequest)?.triedBy.length === 0,
    )

    assert.deepStrictEqual(shown(listed, pullRequest)?.reasons, ["ChecksFailing"])
  }),
)

const unseenTurn = (f: Pick<Fixture, "client">, threadId: string, ended: TurnEnd) =>
  f.client.WatchUnseenTurns().pipe(
    Stream.filter((unseen) =>
      unseen.some(
        (turn) => turn.threadId === threadId && DateTime.Equivalence(turn.ended.at, ended.at),
      ),
    ),
    Stream.runHead,
    Effect.map(Option.isSome),
  )

it.live(
  "keeps a Thread out of the Inbox when its Update finishes, and still lists its Turn as finished and unseen",
  () =>
    Effect.gen(function* () {
      const f = yield* ownPullRequest("Keep it green")

      fail(f.pullRequest, failed("lint"))
      yield* f.client.ListPullRequests()
      const [, , update] = yield* f.transcript(f.thread.id, settled(3))

      const listed = yield* inboxWhen(
        f.client,
        (items) => shown(items, f.pullRequest)?.triedBy.length === 1,
      )

      assert.isUndefined(threadItem(listed, f.thread.id))
      assert.isTrue(yield* unseenTurn(f, f.thread.id, update!.ended!))
    }),
)

const unfinished = (items: InboxItems, threadId: string) =>
  threadItem(items, threadId)?.reasons.flatMap((reason) =>
    Predicate.isTagged(reason, "TurnFinished") && !Predicate.isTagged(reason.ended.ending, "Done")
      ? [reason.ended.ending._tag]
      : [],
  ) ?? []

it.effect("lists a Thread whose Update was cut off when its Sandbox host was lost", () =>
  withSkippableWaits(QUICK_RETRY_SPACING, (skipQuickRetries) =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
      const pullRequest = f.github.seedPullRequest(greeterPullRequest(8, "feature/mine"))

      const thread = yield* f.startSandbox(
        subscribe("Keep it green\nduring-update:hold:fixing", pullRequest),
      )

      yield* f.transcript(thread.id, settled(1))
      fail(pullRequest, failed("lint"))
      yield* f.client.ListPullRequests()
      yield* f.transcript(thread.id, (turns) => turns.length === 2 && holding(turns))

      yield* Effect.promise(() => f.sandboxes.killHost(thread.id))
      yield* skipQuickRetries

      const listed = yield* inboxWhen(f.client, (items) => unfinished(items, thread.id).length > 0)

      assert.deepStrictEqual(unfinished(listed, thread.id), ["CutOff"])
    }),
  ),
)

it.live("lists a Thread whose Update stopped at a Permission request", () =>
  Effect.gen(function* () {
    const f = yield* ownPullRequest("Keep it green")
    const asking = subscribe("Keep it green\nduring-update:ask permission", f.pullRequest)
    yield* f.send(f.thread.id, asking.replace("ask", "\\u0061sk"))
    yield* f.transcript(f.thread.id, settled(3))

    fail(f.pullRequest, failed("lint"))
    yield* f.client.ListPullRequests()

    const listed = yield* inboxWhen(
      f.client,
      (items) => threadItem(items, f.thread.id)?.reasons[0]?._tag === "WaitingRequests",
    )

    assert.isUndefined(pullRequestItem(listed, f.pullRequest))
  }),
)
