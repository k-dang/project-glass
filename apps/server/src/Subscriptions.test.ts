import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { localPlace, PullRequestSubject, Subscription } from "@glass/contracts"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import {
  calledBy,
  glassCall,
  repository,
  sendGlobal,
  settled,
  threadsFixture,
} from "../test/threadsFixture"
import { greeterPullRequest, threadWithPullRequest } from "../test/threadWithPullRequest"
import { migrationLoader } from "./Migrations"
import { Subscriptions } from "./Subscriptions"
import { Transcripts } from "./Transcripts"

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
  subscriptions.map(({ subject: { pullRequest }, reasons, note }) => ({
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

const onlyAllowed =
  "Only a Turn started by the user's message, or by a message from the Thread or Global chat that created your Thread, can."

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
      text: `Glass started this Turn, so it can't subscribe your Thread. ${onlyAllowed}`,
    })
    assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, () => true), [])
  }),
)

const keepGreen = subscribe({ note: "Keep it green" })

const refusedAgentMessage = {
  status: "failed" as const,
  text: `A message from another agent started this Turn, so it can't subscribe your Thread. ${onlyAllowed}`,
}

it.live("refuses a Subscription a Thread's creator asks for from a Turn Glass started", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture

    const creator = yield* f.start(
      `${glassCall("create_thread", newThread("Say hello"))}\non-update:create_thread ${JSON.stringify(newThread(keepGreen))}`,
    )

    const created = yield* f.client.WatchThreads().pipe(
      Stream.filter((all) => all.length === 3),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

    const firstTurns = yield* Effect.forEach(
      created.filter(({ id }) => id !== creator.id),
      ({ id }) => f.transcript(id, settled(1)).pipe(Effect.map(([turn]) => ({ id, turn: turn! }))),
    )

    const asked = firstTurns.find(({ turn }) => turn.message === keepGreen)!

    assert.deepStrictEqual(calledBy(asked.turn), refusedAgentMessage)
    assert.deepStrictEqual(yield* subscriptionsOf(f, asked.id, () => true), [])
  }),
)

it.live("refuses a Subscription a Thread that didn't create this one asks for", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const thread = yield* f.start()
    yield* f.transcript(thread.id, settled(1))

    yield* f.start(glassCall("send_thread_message", { threadId: thread.id, message: keepGreen }))
    const [, asked] = yield* f.transcript(thread.id, settled(2))

    assert.deepStrictEqual(calledBy(asked), refusedAgentMessage)
    assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, () => true), [])
  }),
)

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

    yield* sendGlobal(f.client, glassCall("create_thread", newThread(keepGreen)))

    const [thread] = yield* f.client.WatchThreads().pipe(
      Stream.filter((all) => all.length > 0),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

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

it.effect(
  "refuses a Subscription asked for by a Turn Glass has no record of yet, though the user's Turn still shows as running",
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Subscriptions.layer.pipe(
          Layer.provideMerge(Transcripts.layer),
          Layer.provideMerge(
            SqliteMigrator.layer({ loader: migrationLoader }).pipe(
              Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
            ),
          ),
        ),
      )

      const sql = Context.get(context, SqlClient.SqlClient)

      yield* sql`INSERT INTO thread ${sql.insert({
        id: "thread",
        name: "thread",
        owner: "glass-demo",
        repo: "greeter",
        base_branch: "main",
        harness: "pi",
        folder: "thread",
        created_at: "2026-11-20T00:00:00.000Z",
      })}`

      yield* Context.get(context, Transcripts).startOrQueue(
        "thread",
        { message: "Look after the PR", images: [], context: null },
        "user",
      )

      const usersTurn = yield* Context.get(context, Transcripts).runningTurn("thread")

      const subscriptions = Context.get(context, Subscriptions)

      const asked = {
        source: "github" as const,
        subject: Effect.succeed(PullRequestSubject.make({ pullRequest: null })),
        reasons: ["failing-checks" as const],
        note: "Keep it green",
      }

      const unheardOf = yield* subscriptions
        .subscribe("thread", "a-turn-the-journal-has-not-brought", asked)
        .pipe(Effect.flip)

      const betweenTurns = yield* subscriptions.subscribe("thread", null, asked).pipe(Effect.flip)
      const onTheUsersWord = yield* subscriptions.subscribe("thread", usersTurn, asked)

      assert.include(unheardOf.message, "Glass has no record of the Turn asking")
      assert.include(betweenTurns.message, "Glass has no record of the Turn asking")
      assert.strictEqual(onTheUsersWord.note, "Keep it green")
    }),
)
