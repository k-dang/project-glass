import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  AgentStatusesChanged,
  PartSet,
  TextPart,
  TurnDone,
  TurnEnded,
  TurnStarted,
} from "@glass/contracts"
import { Context, DateTime, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { eventually } from "../../test/eventually"
import type { HarnessAdapter, HarnessSession } from "./adapter"
import { HostThreads, overBudget } from "./HostThreads"
import { HostGlassTools } from "./HostGlassTools"
import { Journal, JournalBudget } from "./Journal"
import {
  HostThreadError,
  WorkRole,
  type ThreadStart,
  type HostEvent,
  type StartOutcome,
} from "./protocol"
import type { StopEnding } from "./turnLoop"

const startupFailed = new HostThreadError({
  message: "The Thread's Agent harness did not start.",
})

interface Handshake {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  readonly cleaning: Deferred.Deferred<void>
  readonly finishCleanup: Deferred.Deferred<void>
  readonly closed: Deferred.Deferred<void>
  readonly exit: Deferred.Deferred<void>
  readonly failure?: HostThreadError
}

const handshake = ({
  failure,
  holdCleanup = false,
}: { readonly failure?: HostThreadError | undefined; readonly holdCleanup?: boolean } = {}) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const cleaning = yield* Deferred.make<void>()
    const finishCleanup = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const exit = yield* Deferred.make<void>()
    const gates = { entered, release, cleaning, finishCleanup, closed, exit }

    if (!holdCleanup) yield* Deferred.succeed(finishCleanup, undefined)

    if (failure === undefined) return gates satisfies Handshake

    return { ...gates, failure } satisfies Handshake
  })

const request = (threadId: string): ThreadStart => ({
  threadId,
  harness: "pi",
  folder: threadId,
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
  let live = 0
  let peak = 0

  const adapter = {
    models: Effect.die("This test does not list models"),
    commands: () => Effect.die("This test does not list commands"),
    start: () =>
      Effect.gen(function* () {
        const next = yield* Queue.take(pending)

        opened += 1
        live += 1
        peak = Math.max(peak, live)

        yield* Effect.addFinalizer(() =>
          Deferred.succeed(next.cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(next.finishCleanup)),
            Effect.andThen(
              Effect.sync(() => {
                live -= 1
              }),
            ),
            Effect.andThen(Deferred.succeed(next.closed, undefined)),
            Effect.asVoid,
          ),
        )
        yield* Deferred.succeed(next.entered, undefined)
        yield* Deferred.await(next.release)

        if (next.failure !== undefined) return yield* Effect.fail(next.failure)

        return session(next.exit)
      }),
  } satisfies HarnessAdapter

  const context = yield* Layer.build(
    HostThreads.make({ "claude-code": adapter, pi: adapter }).pipe(
      Layer.provideMerge(HostGlassTools.layer),
      Layer.provideMerge(Journal.layer),
      Layer.provide(NodeFileSystem.layer),
    ),
  )

  const threads = yield* HostThreads.pipe(Effect.provideContext(context))
  yield* Context.get(context, HostGlassTools).listening(0)

  return {
    threads,
    offer: (next: Handshake) => Queue.offer(pending, next).pipe(Effect.asVoid),
    opened: () => opened,
    peak: () => peak,
  }
})

const release = (gate: Handshake) => Deferred.succeed(gate.release, undefined)

it.live("starts another Thread while one's Agent harness is still starting", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const held = yield* handshake()
    const other = yield* handshake()

    yield* host.offer(held)

    const starting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(held.entered)

    yield* host.offer(other)
    yield* release(other)

    const otherStart = yield* Effect.forkChild(host.threads.start(request("b")), {
      startImmediately: true,
    })

    yield* Deferred.await(other.entered)
    assert.equal(yield* Fiber.join(otherStart), "started")
    assert.equal(host.peak(), 2)

    yield* release(held)
    assert.equal(yield* Fiber.join(starting), "started")
    assert.equal(host.opened(), 2)
  }),
)

it.live("removes a running Thread while another's Agent harness is still starting", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const running = yield* handshake()
    const held = yield* handshake()

    yield* host.offer(running)
    yield* release(running)
    assert.equal(yield* host.threads.start(request("b")), "started")

    yield* host.offer(held)

    const starting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(held.entered)

    const stopping = yield* Effect.forkChild(host.threads.stop("b"), {
      startImmediately: true,
    })

    yield* Deferred.await(running.closed)
    yield* Fiber.join(stopping)

    yield* release(held)
    assert.equal(yield* Fiber.join(starting), "started")
  }),
)

it.live("closes a running Thread's Agent harness while another's is still starting", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const running = yield* handshake()
    const held = yield* handshake()

    yield* host.offer(running)
    yield* release(running)
    assert.equal(yield* host.threads.start(request("b")), "started")

    yield* host.offer(held)

    const starting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(held.entered)

    yield* Deferred.succeed(running.exit, undefined)
    yield* Deferred.await(running.closed)

    const again = yield* handshake()
    yield* host.offer(again)
    yield* release(again)
    assert.equal(yield* host.threads.start(request("b")), "started")
    assert.equal(host.opened(), 3)

    yield* release(held)
    assert.equal(yield* Fiber.join(starting), "started")
  }),
)

it.live("starts one Agent harness when the same Thread is started twice", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const first = yield* handshake()
    const second = yield* handshake()

    yield* host.offer(first)

    const starting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(first.entered)

    yield* host.offer(second)

    const again = yield* Effect.forkChild(host.threads.start(request("a")), {
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
)

it.live("removes a Thread only after its startup has registered the Agent harness", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const first = yield* handshake()

    yield* host.offer(first)

    const starting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(first.entered)

    const stopping = yield* Effect.forkChild(host.threads.stop("a"), {
      startImmediately: true,
    })

    yield* release(first)
    assert.equal(yield* Fiber.join(starting), "started")
    yield* Fiber.join(stopping)
    yield* Deferred.await(first.closed)

    const again = yield* handshake()
    yield* host.offer(again)
    yield* release(again)
    assert.equal(yield* host.threads.start(request("a")), "started")
    assert.equal(host.opened(), 2)
  }),
)

it.live("starts a Thread again after its Agent harness fails to start", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const failed = yield* handshake({ failure: startupFailed })
    const again = yield* handshake()

    yield* host.offer(failed)
    yield* release(failed)
    const error = yield* host.threads.start(request("a")).pipe(Effect.flip)
    assert.strictEqual(error, startupFailed)
    yield* Deferred.await(failed.closed)

    yield* host.offer(again)
    yield* release(again)
    assert.equal(yield* host.threads.start(request("a")), "started")
    assert.equal(host.opened(), 2)
  }),
)

it.live("starts a Thread again after its startup is interrupted", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const held = yield* handshake()
    const again = yield* handshake()

    yield* host.offer(held)

    const starting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(held.entered)
    yield* Fiber.interrupt(starting)

    yield* host.offer(again)
    yield* release(again)
    assert.equal(yield* host.threads.start(request("a")), "started")
    assert.equal(host.opened(), 2)
  }),
)

const queuedStart = (
  failure: HostThreadError | undefined,
  leave: (
    starting: Fiber.Fiber<StartOutcome, HostThreadError>,
    gate: Handshake,
  ) => Effect.Effect<void, HostThreadError | StartOutcome>,
) =>
  Effect.gen(function* () {
    const host = yield* hosted
    const held = yield* handshake({ failure })
    const waiter = yield* handshake()

    yield* host.offer(held)

    const starting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(held.entered)

    yield* host.offer(waiter)

    const waiting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* leave(starting, held)
    yield* Deferred.await(waiter.entered)

    const third = yield* handshake()
    yield* host.offer(third)

    const again = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Effect.yieldNow
    assert.isFalse(yield* Deferred.isDone(third.entered))

    yield* release(waiter)
    assert.equal(yield* Fiber.join(waiting), "started")
    assert.equal(yield* Fiber.join(again), "alreadyRunning")
    assert.equal(host.peak(), 1)
  })

it.live("runs a startup queued behind a failed one alone, starting no second Agent harness", () =>
  queuedStart(startupFailed, (starting, gate) =>
    release(gate).pipe(
      Effect.andThen(Fiber.join(starting).pipe(Effect.flip)),
      Effect.tap((error) => Effect.sync(() => assert.strictEqual(error, startupFailed))),
      Effect.asVoid,
    ),
  ),
)

it.live(
  "runs a startup queued behind an interrupted one alone, starting no second Agent harness",
  () => queuedStart(undefined, (starting) => Fiber.interrupt(starting)),
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
      HostThreads.make({ "claude-code": adapter, pi: adapter }).pipe(
        Layer.provideMerge(HostGlassTools.layer),
        Layer.provideMerge(Journal.layer),
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(Layer.succeed(JournalBudget, BUDGET)),
      ),
    )

    const threads = yield* HostThreads.pipe(Effect.provideContext(context))
    const journal = yield* Journal.pipe(Effect.provideContext(context))
    yield* Context.get(context, HostGlassTools).listening(0)

    yield* threads.start(request("a"))

    return { threads, journal, report: yield* Deferred.await(reporting) }
  })

it.effect("stops a Turn once the journal passes its budget, keeping everything it wrote", () =>
  Effect.gen(function* () {
    const at = yield* DateTime.now
    const exit = yield* Deferred.make<void>()
    const stopping = yield* Deferred.make<StopEnding>()
    let stops = 0

    const ended = (turnId: string) =>
      TurnEnded.make({ turnId, ended: { at, ending: TurnDone.make({}) } })

    const started = (turnId: string) =>
      TurnStarted.make({ turnId, message: "", images: [], context: null, feedback: [], sentAt: at })

    const { journal, report } = yield* budgeted(() => ({
      ...session(exit),
      stopTurn: (_turnId, ending) =>
        Effect.sync(() => stops++).pipe(
          Effect.andThen(Deferred.succeed(stopping, ending)),
          Effect.as([]),
        ),
    }))

    yield* report(started("turn-1"))
    yield* report(wrote("turn-1", BUDGET * 2))
    const ending = yield* Deferred.await(stopping)
    yield* report(TurnEnded.make({ turnId: "turn-1", ended: { at, ending } }))

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

    const { threads, report } = yield* budgeted(() => ({
      ...session(exit),
      stopTurn: (turnId) =>
        Effect.sync(() => {
          stopped.push(turnId)

          return []
        }),
    }))

    yield* report(AgentStatusesChanged.make({ agentStatuses: ["a".repeat(BUDGET * 2)] }))
    yield* threads.startTurn(
      "a",
      "turn-1",
      { message: "Go", images: [], context: null, prompt: "Go" },
      { model: null, effort: null, permissionMode: null },
    )
    yield* report(wrote("turn-1", 1))

    yield* eventually(Effect.sync(() => assert.deepStrictEqual(stopped, ["turn-1"])))
  }).pipe(Effect.scoped),
)

it.live("starts a stopped Thread again only after its old Agent harness is cleaned up", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const old = yield* handshake({ holdCleanup: true })
    const again = yield* handshake()

    yield* host.offer(old)
    yield* release(old)
    assert.equal(yield* host.threads.start(request("a")), "started")

    const stopping = yield* Effect.forkChild(host.threads.stop("a"), {
      startImmediately: true,
    })

    yield* Deferred.await(old.cleaning)

    yield* host.offer(again)
    yield* release(again)

    const starting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.succeed(old.finishCleanup, undefined)
    yield* Fiber.join(stopping)
    assert.equal(yield* Fiber.join(starting), "started")
    assert.equal(host.peak(), 1)
  }),
)

it.live("starts an exited Thread again only after its old Agent harness is cleaned up", () =>
  Effect.gen(function* () {
    const host = yield* hosted
    const old = yield* handshake({ holdCleanup: true })
    const again = yield* handshake()

    yield* host.offer(old)
    yield* release(old)
    assert.equal(yield* host.threads.start(request("a")), "started")

    yield* host.offer(again)
    yield* release(again)
    yield* Deferred.succeed(old.exit, undefined)

    const restarting = yield* Effect.forkChild(host.threads.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(old.cleaning)
    assert.isFalse(yield* Deferred.isDone(again.entered))

    yield* Deferred.succeed(old.finishCleanup, undefined)
    assert.equal(yield* Fiber.join(restarting), "started")
    assert.equal(host.peak(), 1)
  }),
)
