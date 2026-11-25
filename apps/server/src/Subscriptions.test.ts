import { assert, it } from "@effect/vitest"
import { localPlace, Subscription } from "@glass/contracts"
import { Effect, Option, Schema, Stream } from "effect"
import { gitIn } from "../test/gitRepositories"
import { connectMcp, toolText } from "../test/mcpClient"
import {
  calledBy,
  glassCall,
  holding,
  repository,
  settled,
  threadsFixture,
} from "../test/threadsFixture"
import { GlobalChatCaller } from "./mcp/McpCredentials"

type Fixture = Effect.Success<typeof threadsFixture>

const subscriptionsOf = (
  f: Fixture,
  threadId: string,
  until: (subscriptions: ReadonlyArray<Subscription>) => boolean,
) =>
  f.client
    .WatchSubscriptions({ threadId })
    .pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow))

const subscribe = (args: Parameters<typeof glassCall>[1]) =>
  glassCall("subscribe_to_pull_request", args)

const covered = (subscriptions: ReadonlyArray<Subscription>) =>
  subscriptions.map(({ pullRequest, reasons, note }) => ({
    pullRequest: pullRequest === null ? null : `${pullRequest.repo}#${pullRequest.number}`,
    reasons,
    note,
  }))

it.live("subscribes a Thread to its own PR before the PR exists, for the default reasons", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture

    const thread = yield* f.start(subscribe({ note: "Keep it green" }))
    const [turn] = yield* f.transcript(thread.id, settled(1))

    assert.equal(calledBy(turn).status, "done")
    assert.deepStrictEqual(covered(yield* subscriptionsOf(f, thread.id, (all) => all.length > 0)), [
      {
        pullRequest: null,
        reasons: ["failing-checks", "review-feedback", "changes-requested", "merge-conflict"],
        note: "Keep it green",
      },
    ])
  }),
)

it.live("replaces the reasons and the note when a Thread subscribes to the same PR again", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start(subscribe({ note: "Keep it green" }))
    yield* f.transcript(thread.id, settled(1))

    yield* f.send(thread.id, subscribe({ note: "Only rebase", reasons: ["merge-conflict"] }))
    yield* f.transcript(thread.id, settled(2))

    assert.deepStrictEqual(
      covered(yield* subscriptionsOf(f, thread.id, ([first]) => first?.note === "Only rebase")),
      [{ pullRequest: null, reasons: ["merge-conflict"], note: "Only rebase" }],
    )
  }),
)

const greeterPullRequest = (number: number, headBranch: string) => ({
  owner: "glass-demo",
  repo: "greeter",
  number,
  headBranch,
  base: { sha: "b0", files: {} },
  head: { sha: `h${number}`, files: {} },
})

const named = (number: number, repo = "greeter") => ({ owner: "glass-demo", repo, number })

it.live("subscribes a Thread to a named PR in a Followed repository, beside its own PR", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
    f.github.seedPullRequest(greeterPullRequest(7, "feature/dependency"))
    const thread = yield* f.start(subscribe({ note: "Keep it green" }))
    yield* f.transcript(thread.id, settled(1))

    yield* f.send(
      thread.id,
      subscribe({
        pullRequest: named(7),
        reasons: ["merged-or-closed"],
        note: "Go on once it merges",
      }),
    )
    const [, turn] = yield* f.transcript(thread.id, settled(2))

    assert.equal(calledBy(turn).status, "done")
    assert.deepStrictEqual(
      covered(yield* subscriptionsOf(f, thread.id, (all) => all.length === 2)).map(
        ({ pullRequest, reasons }) => [pullRequest, reasons.join()],
      ),
      [
        [null, "failing-checks,review-feedback,changes-requested,merge-conflict"],
        ["greeter#7", "merged-or-closed"],
      ],
    )
  }),
)

it.live(
  "refuses a named PR outside the Followed repositories, one GitHub lacks, and one that ended",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
      f.github.seedPullRequest({ ...greeterPullRequest(7, "feature/done"), state: "MERGED" })
      f.github.seedPullRequest({ ...greeterPullRequest(3, "feature/elsewhere"), repo: "other" })
      const note = "Go on once it merges"

      const thread = yield* f.start(subscribe({ pullRequest: named(3, "other"), note }))
      yield* f.transcript(thread.id, settled(1))
      yield* f.send(thread.id, subscribe({ pullRequest: named(99), note }))
      yield* f.transcript(thread.id, settled(2))
      yield* f.send(thread.id, subscribe({ pullRequest: named(7), note }))
      const turns = yield* f.transcript(thread.id, settled(3))

      assert.deepStrictEqual(turns.map(calledBy), [
        {
          status: "failed",
          text: "Glass only knows PRs in the repositories the user follows, and glass-demo/other isn't one. Ask the user to follow it in Glass.",
        },
        {
          status: "failed",
          text: "GitHub has no PR glass-demo/greeter#99, or the user's GitHub login can't see it.",
        },
        {
          status: "failed",
          text: "PR glass-demo/greeter#7 has already merged, so there's nothing left to tell your Thread about.",
        },
      ])
      assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, () => true), [])
    }),
)

const decodeListed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ subscriptions: Schema.Array(Subscription) })),
)

it.live("lists a Thread's Subscriptions to its agent, which ends one by its id", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start(subscribe({ note: "Keep it green" }))
    yield* f.transcript(thread.id, settled(1))

    yield* f.send(thread.id, glassCall("list_subscriptions", {}))
    const [, listed] = yield* f.transcript(thread.id, settled(2))
    const [subscription] = decodeListed(calledBy(listed).text).subscriptions
    const end = glassCall("end_subscription", { subscriptionId: subscription!.id })
    yield* f.send(thread.id, end)
    const [, , ended] = yield* f.transcript(thread.id, settled(3))

    assert.equal(subscription?.note, "Keep it green")
    assert.equal(calledBy(ended).status, "done")
    assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, (all) => all.length === 0), [])

    yield* f.send(thread.id, end)
    const [, , , again] = yield* f.transcript(thread.id, settled(4))

    assert.deepStrictEqual(calledBy(again), {
      status: "failed",
      text: "Your Thread has no Subscription with that id. list_subscriptions names the ones it has.",
    })
  }),
)

const newThread = (message: string) => ({
  repository: { owner: repository.owner, repo: repository.repo },
  baseBranch: "main",
  place: localPlace,
  harness: "pi",
  model: null,
  effort: null,
  message,
})

it.live("refuses a Subscription asked for in a Turn Glass started", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture

    const thread = yield* f.start(
      `${glassCall("create_thread", newThread("Say hello"))}\non-update:subscribe_to_pull_request {"note":"Keep it green"}`,
    )

    const [, update] = yield* f.transcript(thread.id, settled(2))

    assert.equal(update?.context?._tag, "StartedWorkUpdate")
    assert.deepStrictEqual(calledBy(update), {
      status: "failed",
      text: "Glass started this Turn, so it can't subscribe your Thread to a PR. Only a Turn the user's message started can.",
    })
    assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, () => true), [])
  }),
)

const threadWithPullRequest = Effect.gen(function* () {
  const f = yield* threadsFixture
  yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
  const thread = yield* f.start("hold:first")
  yield* f.transcript(thread.id, holding)
  gitIn(f.worktree(thread.name), "switch", "--quiet", "-c", "feature/own")
  const pullRequest = f.github.seedPullRequest(greeterPullRequest(7, "feature/own"))
  yield* f.release("first")
  yield* f.transcript(thread.id, settled(1))

  yield* f.client.WatchThreadPullRequests().pipe(
    Stream.filter((listed) => listed.some(({ threadId }) => threadId === thread.id)),
    Stream.runHead,
  )

  return { ...f, thread, pullRequest }
})

it.live(
  "subscribes a Thread to the PR it has, ends the Subscription once that PR merges, and refuses another",
  () =>
    Effect.gen(function* () {
      const f = yield* threadWithPullRequest

      yield* f.send(f.thread.id, subscribe({ note: "Keep it green" }))
      const [, subscribed] = yield* f.transcript(f.thread.id, settled(2))

      assert.equal(calledBy(subscribed).status, "done")
      assert.equal((yield* subscriptionsOf(f, f.thread.id, (all) => all.length > 0)).length, 1)

      f.pullRequest.edit({ state: "MERGED" })
      yield* f.client.ListPullRequests()

      assert.deepStrictEqual(yield* subscriptionsOf(f, f.thread.id, (all) => all.length === 0), [])

      yield* f.send(f.thread.id, subscribe({ note: "Keep it green" }))
      const [, , refused] = yield* f.transcript(f.thread.id, settled(3))

      assert.deepStrictEqual(calledBy(refused), {
        status: "failed",
        text: "Your Thread's PR #7 has already merged, so there's nothing left to tell your Thread about.",
      })
    }),
)

it.live("ends a Subscription to a named PR once that PR closes, keeping the Thread's others", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
    const dependency = f.github.seedPullRequest(greeterPullRequest(7, "feature/dependency"))

    const thread = yield* f.start(
      subscribe({
        pullRequest: named(7),
        reasons: ["merged-or-closed"],
        note: "Go on once it merges",
      }),
    )

    yield* f.transcript(thread.id, settled(1))
    yield* f.send(thread.id, subscribe({ note: "Keep it green" }))
    yield* f.transcript(thread.id, settled(2))
    yield* subscriptionsOf(f, thread.id, (all) => all.length === 2)

    dependency.edit({ state: "CLOSED" })
    yield* f.client.ListPullRequests()

    assert.deepStrictEqual(
      covered(yield* subscriptionsOf(f, thread.id, (all) => all.length === 1)).map(
        ({ note }) => note,
      ),
      ["Keep it green"],
    )
  }),
)

it.live("subscribes a Thread in a Sandbox as one on this device", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture

    const thread = yield* f.startSandbox(subscribe({ note: "Keep it green" }))
    const [turn] = yield* f.transcript(thread.id, settled(1))

    assert.equal(calledBy(turn).status, "done")
    assert.equal((yield* subscriptionsOf(f, thread.id, (all) => all.length > 0)).length, 1)
  }),
)

it.live("subscribes a Thread the Global chat creates when the message creating it says to", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

    const globalChat = yield* connectMcp(
      f.baseUrl,
      yield* f.mcpCredentials.issue(
        GlobalChatCaller.make({ globalChatId: "global-chat", sessionId: "global-session" }),
      ),
    )

    const created = yield* globalChat.call(
      "create_thread",
      newThread(subscribe({ note: "Keep it green" })),
    )

    const [thread] = yield* f.threads

    assert.isFalse(created.isError, toolText(created))
    assert.deepStrictEqual(
      covered(yield* subscriptionsOf(f, thread!.id, (all) => all.length > 0)).map(
        ({ note }) => note,
      ),
      ["Keep it green"],
    )
  }),
)

it.live("ends a Subscription the user ends from the Thread", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start(subscribe({ note: "Keep it green" }))
    const [subscription] = yield* subscriptionsOf(f, thread.id, (all) => all.length > 0)

    yield* f.client.EndSubscription({ threadId: thread.id, subscriptionId: subscription!.id })

    assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, (all) => all.length === 0), [])
  }),
)
