import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  Event,
  localPlace,
  PullRequestClosedEvent,
  PullRequestRef,
  PullRequestSubject,
  Subscription,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { fail, failed, subscribe, subscribeArguments } from "../test/pullRequestUpdates"
import { calledBy, glassCall, repository, settled, threadsFixture } from "../test/threadsFixture"
import { greeterPullRequest } from "../test/threadWithPullRequest"
import { EventLog } from "./EventLog"
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

const covered = (subscriptions: ReadonlyArray<Subscription>) =>
  subscriptions.map(({ subject: { pullRequest }, kinds, note }) => ({
    pullRequest: `${pullRequest.repo}#${pullRequest.number}`,
    kinds,
    note,
  }))

const greeter = (number: number, repo = "greeter") => ({ owner: "glass-demo", repo, number })

const followingGreeter = Effect.gen(function* () {
  const f = yield* threadsFixture
  yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
  f.github.seedPullRequest(greeterPullRequest(7, "feature/greet"))

  return f
})

it.live(
  "subscribes a Thread to a PR for the default kinds, and replaces them when asked again",
  () =>
    Effect.gen(function* () {
      const f = yield* followingGreeter

      const thread = yield* f.start(subscribe("Keep it green", greeter(7)))
      const [turn] = yield* f.transcript(thread.id, settled(1))

      assert.equal(calledBy(turn).status, "done")
      assert.deepStrictEqual(
        covered(yield* subscriptionsOf(f, thread.id, (all) => all.length > 0)),
        [
          {
            pullRequest: "greeter#7",
            kinds: ["ChecksFailed", "ReviewFeedback", "ChangesRequested", "MergeConflict"],
            note: "Keep it green",
          },
        ],
      )

      yield* f.send(thread.id, subscribe("Only rebase", greeter(7), ["MergeConflict"]))
      yield* f.transcript(thread.id, settled(2))

      assert.deepStrictEqual(
        covered(yield* subscriptionsOf(f, thread.id, ([first]) => first?.note === "Only rebase")),
        [{ pullRequest: "greeter#7", kinds: ["MergeConflict"], note: "Only rebase" }],
      )
    }),
)

it.live(
  "refuses a PR outside the Followed repositories, one GitHub lacks, and one that ended",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
      f.github.seedPullRequest({ ...greeterPullRequest(7, "feature/done"), state: "MERGED" })
      f.github.seedPullRequest({ ...greeterPullRequest(3, "feature/elsewhere"), repo: "other" })
      const note = "Go on once it merges"

      const thread = yield* f.start(subscribe(note, greeter(3, "other")))
      yield* f.transcript(thread.id, settled(1))
      yield* f.send(thread.id, subscribe(note, greeter(99)))
      yield* f.transcript(thread.id, settled(2))
      yield* f.send(thread.id, subscribe(note, greeter(7)))
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
          text: "PR glass-demo/greeter#7 has already merged, so there's nothing left to tell you about.",
        },
      ])
      assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, () => true), [])
    }),
)

const decodeSubscribed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ standing: Schema.NullOr(Schema.Array(Event)) })),
)

it.live("replies with what already stands on a PR that Glass already reads in detail", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.FollowRepository({ input: "glass-demo/greeter" })
    fail(f.github.seedPullRequest(greeterPullRequest(7, "feature/greet")), failed("lint"))

    const first = yield* f.start(subscribe("Keep it green", greeter(7)))
    const [firstSubscribed] = yield* f.transcript(first.id, settled(1))
    yield* f.client.ListPullRequests()
    yield* f.transcript(first.id, settled(2))

    const second = yield* f.start(subscribe("Keep it green too", greeter(7)))
    const [secondSubscribed] = yield* f.transcript(second.id, settled(1))

    assert.isNull(decodeSubscribed(calledBy(firstSubscribed).text).standing)
    assert.deepStrictEqual(
      decodeSubscribed(calledBy(secondSubscribed).text).standing?.map(({ _tag }) => _tag),
      ["ChecksFailed"],
    )
  }),
)

const decodeListed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ subscriptions: Schema.Array(Subscription) })),
)

it.live("lists a Thread's Subscriptions to its agent, which ends one by its id", () =>
  Effect.gen(function* () {
    const f = yield* followingGreeter
    const thread = yield* f.start(subscribe("Keep it green", greeter(7)))
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
      text: "You have no Subscription with that id. list_subscriptions names the ones you have.",
    })
  }),
)

it.live("ends a Subscription the user ends from the Thread", () =>
  Effect.gen(function* () {
    const f = yield* followingGreeter
    const thread = yield* f.start(subscribe("Keep it green", greeter(7)))
    const [subscription] = yield* subscriptionsOf(f, thread.id, (all) => all.length > 0)

    yield* f.client.EndSubscription({ threadId: thread.id, subscriptionId: subscription!.id })

    assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, (all) => all.length === 0), [])
  }),
)

const refusal = {
  status: "failed" as const,
  text: "Only a Turn a message started can subscribe. Glass started this one, or it began by itself.",
}

const newThread = (message: string) => ({
  repository: { owner: repository.owner, repo: repository.repo },
  baseBranch: "main",
  place: localPlace,
  harness: "pi",
  model: null,
  effort: null,
  message,
})

const subscribeArgs = JSON.stringify(subscribeArguments("Keep it green", greeter(7)))

it.live("refuses a Subscription asked for in a Turn Glass started", () =>
  Effect.gen(function* () {
    const f = yield* followingGreeter

    const thread = yield* f.start(
      `${glassCall("create_thread", newThread("Say hello"))}\non-update:subscribe ${subscribeArgs}`,
    )

    const [, update] = yield* f.transcript(thread.id, settled(2))

    assert.equal(update?.context?._tag, "StartedWorkUpdate")
    assert.deepStrictEqual(calledBy(update), refusal)
    assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, () => true), [])
  }),
)

it.live("refuses a Subscription asked for in a Turn the Agent harness started by itself", () =>
  Effect.gen(function* () {
    const f = yield* followingGreeter

    const thread = yield* f.start(
      `Start a command in the background\nthen-unprompted:subscribe ${subscribeArgs}`,
    )

    const [, unprompted] = yield* f.transcript(thread.id, settled(2))

    assert.deepStrictEqual(calledBy(unprompted), refusal)
    assert.deepStrictEqual(yield* subscriptionsOf(f, thread.id, () => true), [])
  }),
)

it.live("subscribes a Thread in a Sandbox as one on this device", () =>
  Effect.gen(function* () {
    const f = yield* followingGreeter

    const thread = yield* f.startSandbox(subscribe("Keep it green", greeter(7)))
    const [turn] = yield* f.transcript(thread.id, settled(1))

    assert.equal(calledBy(turn).status, "done")
    assert.equal((yield* subscriptionsOf(f, thread.id, (all) => all.length > 0)).length, 1)
  }),
)

const storeInAUsersTurn = Effect.gen(function* () {
  const context = yield* Layer.build(
    Subscriptions.layer.pipe(
      Layer.provideMerge(Layer.merge(Transcripts.layer, EventLog.layer)),
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

  yield* Context.get(context, Transcripts).startOrQueue("thread", {
    message: "Look after the PR",
    images: [],
    context: null,
  })

  return {
    subscriptions: Context.get(context, Subscriptions),
    eventLog: Context.get(context, EventLog),
    usersTurn: yield* Context.get(context, Transcripts).runningTurn("thread"),
  }
})

const askedIn = (turnId: string | null) => ({ threadId: "thread", turnId })

const greeterSeven = {
  subject: Effect.succeed(PullRequestSubject.make({ pullRequest: new PullRequestRef(greeter(7)) })),
  kinds: ["ChecksFailed" as const],
  note: "Keep it green",
}

it.effect("refuses a Subscription asked for by a Turn Glass has no record of", () =>
  Effect.gen(function* () {
    const { subscriptions, usersTurn } = yield* storeInAUsersTurn

    const unheardOf = yield* subscriptions
      .subscribe("thread", askedIn("a-turn-the-journal-has-not-brought"), greeterSeven)
      .pipe(Effect.flip)

    const betweenTurns = yield* subscriptions
      .subscribe("thread", askedIn(null), greeterSeven)
      .pipe(Effect.flip)

    const asked = yield* subscriptions.subscribe("thread", askedIn(usersTurn), greeterSeven)

    assert.strictEqual(unheardOf.message, refusal.text)
    assert.strictEqual(betweenTurns.message, refusal.text)
    assert.strictEqual(asked.note, "Keep it green")
  }),
)

it.effect("refuses to record an Update for a Subscription the user has ended", () =>
  Effect.gen(function* () {
    const { subscriptions, usersTurn } = yield* storeInAUsersTurn
    const { id } = yield* subscriptions.subscribe("thread", askedIn(usersTurn), greeterSeven)

    const delivered = [
      {
        subscriptionId: id,
        deliveredThrough: 1,
        updatesInARow: 1,
        afterMessage: null,
        ends: false,
      },
    ]

    yield* subscriptions.deliver(delivered)
    yield* subscriptions.end("thread", id)
    const refused = yield* subscriptions.deliver(delivered).pipe(Effect.flip)

    assert.strictEqual(refused.message, "A Subscription ended before it was told.")
  }),
)

it.effect("tells a Subscription made again only the Events from then on", () =>
  Effect.gen(function* () {
    const { subscriptions, eventLog, usersTurn } = yield* storeInAUsersTurn
    yield* subscriptions.subscribe("thread", askedIn(usersTurn), greeterSeven)

    yield* eventLog.record("github", [
      {
        subject: "glass-demo/greeter#7",
        event: PullRequestClosedEvent.make({
          pullRequest: new PullRequestRef(greeter(7)),
          closedAt: DateTime.makeUnsafe("2026-11-20T00:00:00Z"),
        }),
      },
    ])
    yield* subscriptions.subscribe("thread", askedIn(usersTurn), { ...greeterSeven, note: "Again" })

    const [again] = yield* subscriptions.states("thread")

    assert.strictEqual(again?.note, "Again")
    assert.strictEqual(again?.deliveredThrough, yield* eventLog.latestId)
  }),
)
