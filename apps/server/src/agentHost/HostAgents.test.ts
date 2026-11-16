import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Queue } from "effect"
import type { AgentAdapter, AgentSession } from "./adapter"
import { HostAgents, agentLock } from "./HostAgents"
import { Journal } from "./Journal"
import { HostAgentError, WorkRole, type ConversationStart, type StartOutcome } from "./protocol"

const stall = 5_000

const startupFailed = new HostAgentError({
  message: "The Agent's program did not start.",
})

interface Handshake {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  readonly closed: Deferred.Deferred<void>
  readonly exit: Deferred.Deferred<void>
  readonly failure?: HostAgentError
}

const handshake = (failure?: HostAgentError) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const exit = yield* Deferred.make<void>()

    if (failure === undefined) return { entered, release, closed, exit } satisfies Handshake

    return { entered, release, closed, exit, failure } satisfies Handshake
  })

const request = (agentId: string): ConversationStart => ({
  agentId,
  engine: "pi",
  folder: agentId,
  role: WorkRole.make({}),
  skills: [],
})

const session = (exit: Deferred.Deferred<void>): AgentSession => ({
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
  } satisfies AgentAdapter

  const context = yield* Layer.build(
    HostAgents.make({ "claude-code": adapter, pi: adapter }).pipe(
      Layer.provideMerge(Journal.layer),
      Layer.provide(NodeFileSystem.layer),
    ),
  )

  const agents = yield* HostAgents.pipe(Effect.provideContext(context))

  return {
    agents,
    offer: (next: Handshake) => Queue.offer(pending, next).pipe(Effect.asVoid),
    opened: () => opened,
    peak: () => peak,
  }
})

const release = (gate: Handshake) => Deferred.succeed(gate.release, undefined)

it.live(
  "starts another Agent while one's program is still starting",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const held = yield* handshake()
      const other = yield* handshake()

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)

      yield* host.offer(other)
      yield* release(other)

      const otherStart = yield* Effect.forkChild(host.agents.start(request("b")), {
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
  "removes a running Agent while another's program is still starting",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const running = yield* handshake()
      const held = yield* handshake()

      yield* host.offer(running)
      yield* release(running)
      assert.equal(yield* host.agents.start(request("b")), "started")

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)

      const stopping = yield* Effect.forkChild(host.agents.stop("b"), { startImmediately: true })
      yield* Deferred.await(running.closed)
      yield* Fiber.join(stopping)

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
    }),
  stall,
)

it.live(
  "closes a running Agent's program while another's is still starting",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const running = yield* handshake()
      const held = yield* handshake()

      yield* host.offer(running)
      yield* release(running)
      assert.equal(yield* host.agents.start(request("b")), "started")

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)

      yield* Deferred.succeed(running.exit, undefined)
      yield* Deferred.await(running.closed)

      const again = yield* handshake()
      yield* host.offer(again)
      yield* release(again)
      assert.equal(yield* host.agents.start(request("b")), "started")
      assert.equal(host.opened(), 3)

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
    }),
  stall,
)

it.live(
  "starts one program when the same Agent is started twice",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const first = yield* handshake()
      const second = yield* handshake()

      yield* host.offer(first)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(first.entered)

      yield* host.offer(second)

      const again = yield* Effect.forkChild(host.agents.start(request("a")), {
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
  "removes an Agent only after its startup has registered the program",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const first = yield* handshake()

      yield* host.offer(first)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(first.entered)

      const stopping = yield* Effect.forkChild(host.agents.stop("a"), { startImmediately: true })
      yield* Effect.yieldNow
      assert.isFalse(yield* Deferred.isDone(first.closed))

      yield* release(first)
      assert.equal(yield* Fiber.join(starting), "started")
      yield* Fiber.join(stopping)
      yield* Deferred.await(first.closed)

      const again = yield* handshake()
      yield* host.offer(again)
      yield* release(again)
      assert.equal(yield* host.agents.start(request("a")), "started")
      assert.equal(host.opened(), 2)
    }),
  stall,
)

it.live(
  "starts an Agent again after its program fails to start",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const failed = yield* handshake(startupFailed)
      const again = yield* handshake()

      yield* host.offer(failed)
      yield* release(failed)
      const error = yield* host.agents.start(request("a")).pipe(Effect.flip)
      assert.strictEqual(error, startupFailed)
      yield* Deferred.await(failed.closed)

      yield* host.offer(again)
      yield* release(again)
      assert.equal(yield* host.agents.start(request("a")), "started")
      assert.equal(host.opened(), 2)
    }),
  stall,
)

it.live(
  "starts another Agent while one's program is failing to start",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const failing = yield* handshake(startupFailed)
      const other = yield* handshake()

      yield* host.offer(failing)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(failing.entered)

      yield* host.offer(other)
      yield* release(other)
      assert.equal(yield* host.agents.start(request("b")), "started")
      assert.equal(host.peak(), 2)

      yield* release(failing)
      const error = yield* Fiber.join(starting).pipe(Effect.flip)
      assert.strictEqual(error, startupFailed)
      yield* Deferred.await(failing.closed)
    }),
  stall,
)

it.live(
  "starts an Agent again after its startup is interrupted",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const held = yield* handshake()
      const again = yield* handshake()

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)
      yield* Fiber.interrupt(starting)

      yield* host.offer(again)
      yield* release(again)
      assert.equal(yield* host.agents.start(request("a")), "started")
      assert.equal(host.opened(), 2)
    }),
  stall,
)

it.live(
  "drops one Agent's lock while another's program is still starting",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const held = yield* handshake()
      const other = yield* handshake()

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)
      assert.isDefined(agentLock(host.agents, "a"))

      yield* host.offer(other)
      yield* release(other)
      assert.equal(yield* host.agents.start(request("b")), "started")
      assert.isUndefined(agentLock(host.agents, "b"))
      assert.isDefined(agentLock(host.agents, "a"))

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
      assert.isUndefined(agentLock(host.agents, "a"))
    }),
  stall,
)

const queuedStart = (
  failure: HostAgentError | undefined,
  leave: (
    starting: Fiber.Fiber<StartOutcome, HostAgentError>,
    gate: Handshake,
  ) => Effect.Effect<void, HostAgentError | StartOutcome>,
) =>
  Effect.gen(function* () {
    const host = yield* hosted
    const held = yield* handshake(failure)
    const waiter = yield* handshake()

    yield* host.offer(held)

    const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
      startImmediately: true,
    })

    yield* Deferred.await(held.entered)

    yield* host.offer(waiter)

    const waiting = yield* Effect.forkChild(host.agents.start(request("a")), {
      startImmediately: true,
    })

    yield* Effect.yieldNow
    const entry = agentLock(host.agents, "a")
    assert.isDefined(entry)

    yield* leave(starting, held)
    yield* Deferred.await(waiter.entered)
    assert.strictEqual(agentLock(host.agents, "a"), entry)

    yield* release(waiter)
    assert.equal(yield* Fiber.join(waiting), "started")
    assert.isUndefined(agentLock(host.agents, "a"))
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
  "drops an Agent's lock after startup and a queued removal both finish",
  () =>
    Effect.gen(function* () {
      const host = yield* hosted
      const held = yield* handshake()

      yield* host.offer(held)

      const starting = yield* Effect.forkChild(host.agents.start(request("a")), {
        startImmediately: true,
      })

      yield* Deferred.await(held.entered)

      const stopping = yield* Effect.forkChild(host.agents.stop("a"), { startImmediately: true })
      yield* Effect.yieldNow
      assert.isDefined(agentLock(host.agents, "a"))

      yield* release(held)
      assert.equal(yield* Fiber.join(starting), "started")
      yield* Fiber.join(stopping)
      yield* Deferred.await(held.closed)
      assert.isUndefined(agentLock(host.agents, "a"))
    }),
  stall,
)
