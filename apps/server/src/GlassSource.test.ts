import { assert, it } from "@effect/vitest"
import {
  AnswerQuestion,
  localPlace,
  type InboxItems,
  LoggedEvent,
  ThreadFinishedEvent,
  ThreadSubject,
  ThreadWaitingEvent,
  type Turn,
  TurnDone,
  TurnFailed,
  Update,
} from "@glass/contracts"
import { DateTime, Effect, Option, Predicate, Stream } from "effect"
import {
  threadsFixture,
  glassCalls,
  globalTurns,
  holding,
  lastSettled,
  startedWorkTold,
  threadEventsTold,
  repository,
  sendGlobal,
  settled,
} from "../test/threadsFixture"
import { eventually } from "../test/eventually"
import { eventsTool } from "../test/pullRequestUpdates"
import { toldIn } from "./GlassSource"

const hiddenFromScriptedAskUser = (json: string) => json.replaceAll("ask", "\\u0061sk")

const createThread = (message: string) =>
  `call:create_thread ${hiddenFromScriptedAskUser(
    JSON.stringify({
      repository: { owner: repository.owner, repo: repository.repo },
      baseBranch: "main",
      place: localPlace,
      harness: "pi",
      model: null,
      effort: null,
      message,
    }),
  )}`

const startedWorkUpdates = (turns: ReadonlyArray<Turn>) =>
  turns.filter((turn) => startedWorkTold([turn]).length > 0)

it.live(
  "tells the Global chat in one Update about the Threads that finished during its own Turn, marking them seen",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      yield* sendGlobal(f.client, createThread("hold:first"))
      yield* sendGlobal(f.client, createThread("hold:second"))
      yield* sendGlobal(f.client, "hold:global")
      yield* globalTurns(f.client, holding)

      const started = yield* f.threads
      assert.lengthOf(started, 2)

      yield* f.release("first")
      yield* f.release("second")

      const asked = yield* Effect.forEach(started, (thread) =>
        f
          .transcript(thread.id, settled(1))
          .pipe(Effect.map(([turn]) => [thread.id, "ThreadFinished", createThread(turn!.message)])),
      )

      const { events } = yield* eventsTool(f)

      yield* eventually(
        events().pipe(
          Effect.filterOrFail(
            (found) => found.filter(Predicate.isTagged("ThreadFinished")).length === 2,
            () => "Glass hasn't recorded both Threads finishing yet",
          ),
        ),
      )
      yield* f.release("global")
      const turns = yield* globalTurns(f.client, settled(4))

      assert.lengthOf(startedWorkUpdates(turns), 1)
      assert.strictEqual(turns[3]?.message, "")
      assert.sameDeepMembers(
        startedWorkTold(turns).map(({ note, event }) => [
          "threadId" in event && event.threadId,
          event._tag,
          note,
        ]),
        asked,
      )

      yield* f.client.WatchInbox().pipe(
        Stream.filter((items: InboxItems) =>
          items.every(
            (item) =>
              !Predicate.isTagged(item, "Thread") ||
              !started.some(({ id }) => id === item.thread.id),
          ),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )
    }),
)

it.live(
  "tells the Global chat when a Thread it started waits on a Question, and again when it ends",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

      yield* sendGlobal(f.client, createThread("Please ask a question"))
      yield* globalTurns(f.client, settled(1))
      const [thread] = yield* f.threads
      assert.isDefined(thread)

      const waiting = yield* globalTurns(
        f.client,
        (all) => threadEventsTold(all).length === 1 && all.every(({ ended }) => ended !== null),
      )

      assert.deepStrictEqual(threadEventsTold(waiting), [[thread.id, "ThreadWaiting"]])

      yield* f.answering(thread.id, settled(1), () =>
        AnswerQuestion.make({ answers: [{ chosen: [], text: "Only source files" }] }),
      )

      const turns = yield* globalTurns(f.client, (all) => threadEventsTold(all).length === 2)

      assert.deepStrictEqual(threadEventsTold(turns), [
        [thread.id, "ThreadWaiting"],
        [thread.id, "ThreadFinished"],
      ])
    }),
)

it.live("tells nothing about a Thread it started that the user stopped", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

    yield* sendGlobal(f.client, createThread("hold:never"))
    yield* globalTurns(f.client, settled(1))
    const [thread] = yield* f.threads
    assert.isDefined(thread)
    yield* f.transcript(thread.id, holding)
    yield* f.client.StopTurn({ threadId: thread.id })
    yield* f.transcript(thread.id, settled(1))

    yield* sendGlobal(f.client, "After")

    const turns = yield* globalTurns(f.client, lastSettled("After"))

    assert.deepStrictEqual(startedWorkTold(turns), [])
  }),
)

it.live("keeps an Update about started work after restart without telling it again", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })
    yield* sendGlobal(f.client, createThread("Finish this"))

    const before = yield* globalTurns(
      f.client,
      (all) => startedWorkUpdates(all).length === 1 && all.every(({ ended }) => ended !== null),
    )

    const startedWorkUpdateId = startedWorkUpdates(before)[0]?.id
    const restarted = yield* f.restart
    yield* sendGlobal(restarted, "After restart")
    const after = yield* globalTurns(restarted, lastSettled("After restart"))

    assert.deepStrictEqual(
      startedWorkUpdates(after).map(({ id }) => id),
      [startedWorkUpdateId],
    )
    assert.deepStrictEqual(threadEventsTold(after), threadEventsTold(before))
  }),
)

it.live("tells the new Session about work started before Start fresh", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    yield* f.client.LinkLocalCheckout({ path: f.clone.checkout })

    const asked = createThread("hold:first")
    yield* sendGlobal(f.client, asked)
    yield* globalTurns(f.client, settled(1))
    const [thread] = yield* f.threads
    assert.isDefined(thread)

    yield* f.client.StartGlobalChatFresh()
    yield* f.release("first")

    const [startedWorkUpdate] = yield* globalTurns(f.client, settled(1))

    assert.deepStrictEqual(
      startedWorkTold(startedWorkUpdate === undefined ? [] : [startedWorkUpdate]).map(
        ({ note, event }) => ["threadId" in event && event.threadId, event._tag, note],
      ),
      [[thread.id, "ThreadFinished", asked]],
    )

    yield* sendGlobal(f.client, "call:list_started_work")
    const [, listed] = yield* globalTurns(f.client, settled(2))

    assert.include(glassCalls(listed)?.[0]?.output, thread.id)
  }),
)

it("marks finished work seen only once an Update that told it ends without failing", () => {
  const at = DateTime.makeUnsafe("2026-11-27T12:00:00Z")
  const finished = ThreadFinishedEvent.make({ threadId: "started", name: "Started", endedAt: at })
  const waiting = ThreadWaitingEvent.make({ threadId: "asking", name: "Asking", requestId: "r1" })

  const update = Update.make({
    subscriptions: [
      {
        subscriptionId: "s1",
        subject: ThreadSubject.make({ threadId: "started" }),
        note: "",
        events: [
          new LoggedEvent({ id: 1, source: "glass", occurredAt: at, event: finished }),
          new LoggedEvent({ id: 2, source: "glass", occurredAt: at, event: waiting }),
        ],
      },
    ],
  })

  assert.deepStrictEqual(toldIn({ update, ended: { at, ending: TurnDone.make({}) } }), [finished])
  assert.deepStrictEqual(
    toldIn({ update, ended: { at, ending: TurnFailed.make({ reason: "Gone" }) } }),
    [],
  )
  assert.deepStrictEqual(toldIn(null), [])
})
