import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  ExtensionStatusesChanged,
  PartSet,
  TextPart,
  TurnDone,
  TurnEnded,
  TurnStarted,
} from "@glass/contracts"
import { DateTime, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { eventually } from "../../test/eventually"
import type { HarnessAdapter, HarnessSession } from "./adapter"
import { HostConversations, conversationLock, overBudget } from "./HostConversations"
import { Journal, JournalBudget } from "./Journal"
import {
  HostConversationError,
  WorkRole,
  type ConversationStart,
  type HostEvent,
  type StartOutcome,
} from "./protocol"
import type { StopEnding } from "./turnLoop"

const stall = 5_000

const startupFailed = new HostConversationError({
  message: "The Conversation's Agent harness did not start.",
})

interface Handshake {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  readonly closed: Deferred.Deferred<void>
  readonly exit: Deferred.Deferred<void>
  readonly failure?: HostConversationError
}

const handshake = (failure?: HostConversationError) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const exit = yield* Deferred.make<void>()

    if (failure === undefined) return { entered, release, closed, exit } satisfies Handshake

    return { entered, release, closed, exit, failure } satisfies Handshake
  })

const request = (conversationId: string): ConversationStart => ({
  conversationId,
  harness: "pi",
  folder: conversationId,
  role: WorkRole.make({}),
  skills: [],
})

const session = (exit: Deferred.Deferred<void>): HarnessSession => ({
  configure: () => Effect.void,
  startTurn: () => Effect.void,
  steer: () => Effect.void,
  stopTurn: () => Effect.succeed(null),
  answer: () => Effect.void,
  closed: Deferred.await(exit),
  stopped: Deferred.isDone(exit),
})

const hosted = Effect.gen(function* () {
  const pending = yield* Queue.unbounded<Handshake>()
  let opened = 0
  let open = 0
  let peak = 0

  const adapter = {
    models: Effect.die("This test does not list models"),
    commands: () => Effect.die("This test does not list commands"),
    start: () =>
      Effect.gen(function* () {
        const next = yield* Queue.take(pending)

        open += 1
        opened += 1
        peak = Math.max(peak, open)

        yield* Effect.addFinalizer(() =>
          Deferred.succeed(next.closed, undefined).pipe(Effect.asVoid),
        )
        yield* Deferred.succeed(next.entered, undefined)
        yield* Deferred.await(next.release).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              open -= 1
            }),
          ),
        )

        if (next.failure !== undefined) return yield* Effect.fail(next.failure)

        return session(next.exit)
      }),
  } satisfies HarnessAdapter

  const context = yield* Layer.build(
    HostConversations.make({ "claude-code": adapter, pi: adapter }).pipe(
      Layer.provideMerge(Journal.layer),
      Layer.provide(NodeFileSystem.layer),
    ),
  )

  const conversations = yield* HostConversations.pipe(Effect.provideContext(context))

  return {
    conversations,
    offer: (next: Handshake) => Queue.offer(pending, next).pipe(Effect.asVoid),
    opened: () => opened,
    peak: () => peak,
  }
})

const release = (gate: Handshake) => Deferred.succeed(gate.release, undefined)

it.live(
  "starts another Conversation while one's Agent harness is still starting",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const held = yield* handshake()
      const other = yield* handshake()

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)

      yield* host.offer(other)
      yield* release(other)

      const otherStart = yield* Effect.forkChild(host.conversations.start(request("b")), {
        startImmediately: true,
      })

      yield* Deferred.await(other.entered)
      assert.equal(yield* Fiber.join(otherStart), "started")
      assert.equal(host.peak(), 2)

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
      assert.equal(host.opened(), 2)
    }),
  stall,
)

it.live(
  "removes a running Conversation while another's Agent harness is still starting",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const running = yield* handshake()
      const held = yield* handshake()

      yield* host.offer(running)
      yield* release(running)
      assert.equal(yield* host.conversations.start(request("b")), "started")

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)

      const stopping = yield* Effect.forkChild(host.conversations.stop("b"), {
        startImmediately: true,
      })

      yield* Deferred.await(running.closed)
      yield* Fiber.join(stopping)

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
    }),
  stall,
)

it.live(
  "closes a running Conversation's Agent harness while another's is still starting",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const running = yield* handshake()
      const held = yield* handshake()

      yield* host.offer(running)
      yield* release(running)
      assert.equal(yield* host.conversations.start(request("b")), "started")

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)

      yield* Deferred.succeed(running.exit, undefined)
      yield* Deferred.await(running.closed)

      const again = yield* handshake()
      yield* host.offer(again)
      yield* release(again)
      assert.equal(yield* host.conversations.start(request("b")), "started")
      assert.equal(host.opened(), 3)

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
    }),
  stall,
)

it.live(
  "starts one Agent harness when the same Conversation is started twice",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const first = yield* handshake()
      const second = yield* handshake()

      yield* host.offer(first)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(first.entered)

      yield* host.offer(second)

      const again = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Effect.yieldNow
      assert.equal(host.opened(), 1)
      assert.isFalse(yield* Deferred.isDone(second.entered))

      yield* release(first)
      yield* release(second)
      assert.equal(yield* Fiber.join(starting), "started")
      assert.equal(yield* Fiber.join(again), "alreadyRunning")
      assert.equal(host.opened(), 1)
      assert.equal(host.peak(), 1)
    }),
  stall,
)

it.live(
  "removes a Conversation only after its startup has registered the Agent harness",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const first = yield* handshake()

      yield* host.offer(first)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(first.entered)

      const stopping = yield* Effect.forkChild(host.conversations.stop("a"), {
        startImmediately: true,
      })

      yield* Effect.yieldNow
      assert.isFalse(yield* Deferred.isDone(first.closed))

      yield* release(first)
      assert.equal(yield* Fiber.join(starting), "started")
      yield* Fiber.join(stopping)
      yield* Deferred.await(first.closed)

      const again = yield* handshake()
      yield* host.offer(again)
      yield* release(again)
      assert.equal(yield* host.conversations.start(request("a")), "started")
      assert.equal(host.opened(), 2)
    }),
  stall,
)

it.live(
  "starts a Conversation again after its Agent harness fails to start",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const failed = yield* handshake(startupFailed)
      const again = yield* handshake()

      yield* host.offer(failed)
      yield* release(failed)
      const error = yield* host.conversations.start(request("a")).pipe(Effect.flip)
      assert.strictEqual(error, startupFailed)
      yield* Deferred.await(failed.closed)

      yield* host.offer(again)
      yield* release(again)
      assert.equal(yield* host.conversations.start(request("a")), "started")
      assert.equal(host.opened(), 2)
    }),
  stall,
)

it.live(
  "starts another Conversation while one's Agent harness is failing to start",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const failing = yield* handshake(startupFailed)
      const other = yield* handshake()

      yield* host.offer(failing)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(failing.entered)

      yield* host.offer(other)
      yield* release(other)
      assert.equal(yield* host.conversations.start(request("b")), "started")
      assert.equal(host.peak(), 2)

      yield* release(failing)
      const error = yield* Fiber.join(starting).pipe(Effect.flip)
      assert.strictEqual(error, startupFailed)
      yield* Deferred.await(failing.closed)
    }),
  stall,
)

it.live(
  "starts a Conversation again after its startup is interrupted",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const held = yield* handshake()
      const again = yield* handshake()

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)
      yield* Fiber.interrupt(starting)

      yield* host.offer(again)
      yield* release(again)
      assert.equal(yield* host.conversations.start(request("a")), "started")
      assert.equal(host.opened(), 2)
    }),
  stall,
)

it.live(
  "drops one Conversation's lock while another's Agent harness is still starting",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const held = yield* handshake()
      const other = yield* handshake()

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)
      assert.isDefined(conversationLock(host.conversations, "a"))

      yield* host.offer(other)
      yield* release(other)
      assert.equal(yield* host.conversations.start(request("b")), "started")
      assert.isUndefined(conversationLock(host.conversations, "b"))
      assert.isDefined(conversationLock(host.conversations, "a"))

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
      assert.isUndefined(conversationLock(host.conversations, "a"))
    }),
  stall,
)

const queuedStart = (
  failure: HostConversationError | undefined,
  leave: (
    starting: Fiber.Fiber<StartOutcome, HostConversationError>,
    gate: Handshake,
  ) => Effect.Effect<void, HostConversationError | StartOutcome>,
) =>
  Effect.gen(function* () {
    const host = yield* hosted
    const held = yield* handshake(failure)
    const waiter = yield* handshake()

    yield* host.offer(held)

    const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(held.entered)

    yield* host.offer(waiter)

    const waiting = yield* Effect.forkChild(host.conversations.start(request("a")), {
      startImmediately: true,
    })

    yield* Effect.yieldNow
    const entry = conversationLock(host.conversations, "a")
    assert.isDefined(entry)

    yield* leave(starting, held)
    yield* Deferred.await(waiter.entered)
    assert.strictEqual(conversationLock(host.conversations, "a"), entry)

    yield* release(waiter)
    assert.equal(yield* Fiber.join(waiting), "started")
    assert.isUndefined(conversationLock(host.conversations, "a"))
  })

it.live(
  "keeps the same lock until a startup queued behind a failure finishes",
  () =>
    queuedStart(startupFailed, (starting, gate) =>
      release(gate).pipe(
        Effect.andThen(Fiber.join(starting).pipe(Effect.flip)),
        Effect.tap((error) => Effect.sync(() => assert.strictEqual(error, startupFailed))),
        Effect.asVoid,
      ),
    ),
  stall,
)

it.live(
  "keeps the same lock until a startup queued behind an interrupt finishes",
  () => queuedStart(undefined, (starting) => Fiber.interrupt(starting)),
  stall,
)

it.live(
  "drops a Conversation's lock after startup and a queued removal both finish",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const held = yield* handshake()

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.conversations.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)

      const stopping = yield* Effect.forkChild(host.conversations.stop("a"), {
        startImmediately: true,
      })

      yield* Effect.yieldNow
      assert.isDefined(conversationLock(host.conversations, "a"))

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
      yield* Fiber.join(stopping)
      yield* Deferred.await(held.closed)
      assert.isUndefined(conversationLock(host.conversations, "a"))
    }),
  stall,
)

const BUDGET = 1_000

const wrote = (turnId: string, chars: number) =>
  PartSet.make({ turnId, index: 0, part: TextPart.make({ text: "a".repeat(chars) }) })

const budgeted = (
  sessionFor: (report: (event: HostEvent) => Effect.Effect<void>) => HarnessSession,
) =>
  Effect.gen(function* () {
    const reporting = yield* Deferred.make<(event: HostEvent) => Effect.Effect<void>>()

    const adapter: HarnessAdapter = {
      models: Effect.die("This test does not list models"),
      commands: () => Effect.die("This test does not list commands"),
      start: ({ report }) =>
        Deferred.succeed(reporting, report).pipe(Effect.as(sessionFor(report))),
    }

    const context = yield* Layer.build(
      HostConversations.make({ "claude-code": adapter, pi: adapter }).pipe(
        Layer.provideMerge(Journal.layer),
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(Layer.succeed(JournalBudget, BUDGET)),
      ),
    )

    const conversations = yield* HostConversations.pipe(Effect.provideContext(context))
    const journal = yield* Journal.pipe(Effect.provideContext(context))

    yield* conversations.start(request("a"))

    return { conversations, journal, report: yield* Deferred.await(reporting) }
  })

it.effect("stops a Turn once the journal passes its budget, keeping everything it wrote", () =>
  Effect.gen(function* () {
    const at = yield* DateTime.now
    const exit = yield* Deferred.make<void>()
    let stops = 0

    const ended = (turnId: string) =>
      TurnEnded.make({ turnId, ended: { at, ending: TurnDone.make({}) } })

    const started = (turnId: string) =>
      TurnStarted.make({ turnId, message: "", images: [], context: null, feedback: [], sentAt: at })

    const { journal, report } = yield* budgeted((reportTo) => ({
      ...session(exit),
      stopTurn: Effect.fnUntraced(function* (turnId: string, ending: StopEnding) {
        stops++
        yield* reportTo(TurnEnded.make({ turnId, ended: { at, ending } }))

        return []
      }),
    }))

    yield* report(started("turn-1"))
    yield* report(wrote("turn-1", BUDGET * 2))

    const kept = yield* journal.watch(journal.host, 0).pipe(Stream.take(3), Stream.runCollect)

    assert.deepStrictEqual(
      kept.map(({ event }) => event),
      [
        started("turn-1"),
        wrote("turn-1", BUDGET * 2),
        TurnEnded.make({ turnId: "turn-1", ended: { at, ending: overBudget } }),
      ],
    )

    yield* journal.acknowledge(journal.host, 3)
    yield* report(started("turn-2"))
    yield* report(wrote("turn-2", BUDGET / 2))
    yield* report(ended("turn-2"))

    const next = yield* journal.watch(journal.host, 3).pipe(Stream.take(3), Stream.runCollect)

    assert.deepStrictEqual(next.at(-1)?.event, ended("turn-2"))
    assert.equal(stops, 1)
  }).pipe(Effect.scoped),
)

it.effect("keeps to the budget for a later Turn after going over it while idle", () =>
  Effect.gen(function* () {
    const exit = yield* Deferred.make<void>()
    const stopped: Array<string> = []

    const { conversations, report } = yield* budgeted(() => ({
      ...session(exit),
      stopTurn: (turnId) =>
        Effect.sync(() => {
          stopped.push(turnId)

          return []
        }),
    }))

    yield* report(ExtensionStatusesChanged.make({ extensionStatuses: ["a".repeat(BUDGET * 2)] }))
    yield* conversations.startTurn(
      "a",
      "turn-1",
      { message: "Go", images: [], context: null, prompt: "Go" },
      { model: null, effort: null, permissionMode: null },
    )
    yield* report(wrote("turn-1", 1))

    yield* eventually(Effect.sync(() => assert.deepStrictEqual(stopped, ["turn-1"])))
  }).pipe(Effect.scoped),
)
