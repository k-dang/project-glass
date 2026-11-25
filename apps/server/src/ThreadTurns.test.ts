import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  ThreadError,
  ThreadOutcome,
  TurnDone,
  TurnCutOff,
  TurnInterrupted,
  TurnEnded,
  PartSet,
  TextPart,
  TurnFailed,
  TurnStopped,
  StartedWorkUpdate,
} from "@glass/contracts"
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { eventually } from "../test/eventually"
import { withWatchedClock } from "../test/deadlines"
import { type ClaimedThread, type ThreadHost, ThreadTurns } from "./ThreadTurns"
import { HOST_CONTROL_DEADLINE, HOST_DIDNT_ANSWER } from "./hostControl"
import { migrationLoader } from "./Migrations"
import { ToDos } from "./ToDos"
import { Transcripts } from "./Transcripts"
import { wideEvents } from "./wideEvents"
import { HostThreadError, notRunning, type SteersNotTakenIn } from "./agentHost/protocol"

type StopRequest = Parameters<ThreadHost["StopTurn"]>[0]

interface Script {
  readonly startTurn?: (turnId: string) => Effect.Effect<void, HostThreadError>
  readonly stopTurn?: (request: StopRequest) => Effect.Effect<SteersNotTakenIn | null, ThreadError>
  readonly steer?: () => Effect.Effect<void, HostThreadError>
  readonly running?: boolean
  readonly started?: Deferred.Deferred<void>
}

class OpenTurn {
  id: string | null = null
}

const unused = (method: string) => () => Effect.die(`This test does not call ${method}`)

const hostThatStarts = (
  record: (turnId: string) => Effect.Effect<void, HostThreadError>,
): ThreadHost => ({
  StartThread: unused("StartThread"),
  StartTurn: ({ turnId }) => record(turnId),
  AnswerRequest: unused("AnswerRequest"),
  Steer: unused("Steer"),
  StopTurn: unused("StopTurn"),
  StopBackgroundTask: unused("StopBackgroundTask"),
})

const scriptedHost = (
  script: Script,
  dispatched: Array<{ threadId: string; turnId: string }>,
): ThreadHost => ({
  StartThread: unused("StartThread"),
  StartTurn: ({ threadId, turnId }) =>
    (script.startTurn?.(turnId) ?? Effect.void).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          dispatched.push({ threadId, turnId })
        }).pipe(
          Effect.andThen(
            script.started === undefined
              ? Effect.void
              : Deferred.succeed(script.started, undefined),
          ),
        ),
      ),
    ),
  AnswerRequest: unused("AnswerRequest"),
  Steer: () => (script.steer ?? unused("Steer"))(),
  StopTurn: (request) => (script.stopTurn?.(request) ?? Effect.succeed(null)).pipe(Effect.orDie),
  StopBackgroundTask: unused("StopBackgroundTask"),
})

const layer = ThreadTurns.layer.pipe(
  Layer.provideMerge(Transcripts.layer),
  Layer.provideMerge(Layer.mock(ToDos)({})),
  Layer.provideMerge(SqliteMigrator.layer({ loader: migrationLoader })),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)

const UnitLine = Schema.Struct({ event: Schema.String, delivery: Schema.optional(Schema.String) })

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(UnitLine))

const sent = (message: string) => ({ message, images: [], context: null })

const startedWorkUpdate = StartedWorkUpdate.make({
  work: [
    ThreadOutcome.make({
      threadId: "started",
      name: "Started",
      askedWith: "Build it",
      outcome: "finished",
      reason: null,
    }),
  ],
})

const startedWorkUpdateTurn = {
  message: "",
  images: [],
  context: startedWorkUpdate,
  retriesDelivery: true,
}

const harness = (
  ensureStarted: ClaimedThread["ensureStarted"],
  startTurn: (turnId: string) => Effect.Effect<void, HostThreadError> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const turns = yield* ThreadTurns
    const transcripts = yield* Transcripts
    const dispatched: Array<string> = []
    const deliveries: Array<string | undefined> = []

    const client = hostThatStarts((turnId) =>
      startTurn(turnId).pipe(Effect.tap(() => Effect.sync(() => dispatched.push(turnId)))),
    )

    const thread: ClaimedThread = {
      id: "agent-1",
      ensureStarted,
      settings: { model: null, effort: null, permissionMode: null },
      prepareHost: Effect.succeed(client),
      connectedHost: Effect.succeedNone,
    }

    yield* turns
      .serve({
        claim: () => Effect.succeed(Option.some(thread)),
        lost: Stream.empty,
        interrupted: Effect.succeed(["agent-1"]),
      })
      .pipe(
        Effect.provide(
          wideEvents("backend", (line) => {
            const { event, delivery } = decodeLine(line)

            if (event === "ThreadTurns.deliver") deliveries.push(delivery)
          }),
        ),
      )

    const delivered = (count: number) =>
      eventually(Effect.sync(() => assert.lengthOf(deliveries, count))).pipe(Effect.as(deliveries))

    const transcript = transcripts.read("agent-1")

    return { turns, thread, dispatched, transcript, delivered }
  })

const scripted = (scripts: { readonly [id: string]: Script }) =>
  Effect.gen(function* () {
    const turns = yield* ThreadTurns
    const transcripts = yield* Transcripts
    const dispatched: Array<{ threadId: string; turnId: string }> = []
    const threads = new Map<string, ClaimedThread>()

    for (const [id, script] of Object.entries(scripts)) {
      const client = scriptedHost(script, dispatched)

      threads.set(id, {
        id,
        ensureStarted: () => Effect.void,
        settings: { model: null, effort: null, permissionMode: null },
        prepareHost: Effect.succeed(client),
        connectedHost: script.running ? Effect.succeed(Option.some(client)) : Effect.succeedNone,
      })
    }

    yield* turns
      .serve({
        claim: (id) =>
          Effect.sync(() => {
            const thread = threads.get(id)

            return thread === undefined ? Option.none() : Option.some(thread)
          }),
        lost: Stream.empty,
        interrupted: Effect.succeed(Object.keys(scripts)),
      })
      .pipe(
        Effect.provide(
          wideEvents("backend", (line) => {
            decodeLine(line)
          }),
        ),
      )

    const started = (threadId: string) => dispatched.filter((call) => call.threadId === threadId)

    return { turns, transcripts, threads, started }
  })

const stopRunningTurn = (
  threadId: string,
  running: OpenTurn,
  request: StopRequest,
  transcripts: Transcripts["Service"],
) =>
  Effect.gen(function* () {
    if (running.id === null || request.turnId !== running.id) return null

    const turnId = running.id
    running.id = null

    yield* transcripts.save(threadId, [
      TurnEnded.make({
        turnId,
        ended: { at: yield* DateTime.now, ending: TurnStopped.make({}) },
      }),
    ])

    return null
  })

const hold = (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) => () =>
  Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined)
    yield* Deferred.await(release)
  })

it.live("ends a Turn stopped before its harness starts without ever dispatching it", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const h = yield* harness(() => Deferred.await(gate))

    yield* h.turns.send("agent-1", sent("Build it"), "user")
    yield* h.turns.stop(h.thread)
    yield* Deferred.succeed(gate, undefined)

    assert.deepStrictEqual(yield* h.delivered(1), ["superseded"])
    assert.deepStrictEqual(h.dispatched, [])

    const { turns } = yield* h.transcript
    assert.deepStrictEqual(turns[0]?.ended?.ending, TurnStopped.make({}))
  }).pipe(Effect.provide(layer)),
)

it.live("fails a Turn whose harness won't start, then starts the next queued message", () =>
  Effect.gen(function* () {
    let starts = 0

    const h = yield* harness(() =>
      ++starts === 1 ? Effect.fail(new ThreadError({ message: "No such folder" })) : Effect.void,
    )

    yield* h.turns.send("agent-1", sent("First"), "user")
    yield* h.turns.send("agent-1", sent("Second"), "user")

    assert.deepStrictEqual(yield* h.delivered(2), ["failed", "dispatched"])
    assert.lengthOf(h.dispatched, 1)

    const { turns } = yield* h.transcript
    assert.deepStrictEqual(turns[0]?.ended?.ending, TurnFailed.make({ reason: "No such folder" }))
    assert.equal(turns[1]?.id, h.dispatched[0])
  }).pipe(Effect.provide(layer)),
)

it.live(
  "redelivers the same saved Turn that retries delivery before advancing Queued messages, and leaves a completed one alone",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts

      let savedId = ""

      yield* transcripts.startIfIdle("agent-1", startedWorkUpdateTurn, (turnId) =>
        Effect.sync(() => {
          savedId = turnId
        }),
      )
      yield* transcripts.startOrQueue("agent-1", sent("After"), "user")
      const firstScope = yield* Scope.make()
      const first = yield* harness(() => Effect.void).pipe(Scope.provide(firstScope))

      assert.deepStrictEqual(yield* first.delivered(1), ["dispatched"])
      assert.deepStrictEqual(first.dispatched, [savedId])

      yield* transcripts.save("agent-1", [
        TurnEnded.make({
          turnId: savedId,
          ended: { at: yield* DateTime.now, ending: TurnDone.make({}) },
        }),
      ])
      yield* first.delivered(2)
      yield* Scope.close(firstScope, Exit.void)

      const second = yield* harness(() => Effect.void)
      const { turns } = yield* second.transcript

      assert.lengthOf(turns, 2)
      assert.equal(turns[0]?.id, savedId)
      assert.deepStrictEqual(turns[0]?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(second.dispatched, [])
    }).pipe(Effect.provide(layer)),
)

it.live(
  "keeps a Turn that retries delivery pending after the host refuses it, then retries the same Turn on restart",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts
      yield* transcripts.startIfIdle("agent-1", startedWorkUpdateTurn, () => Effect.void)
      const savedId = yield* transcripts.runningTurn("agent-1")
      yield* transcripts.startOrQueue("agent-1", sent("After"), "user")
      const firstScope = yield* Scope.make()
      const reason = "Couldn't recover pi's Started work update. Restart Glass to try again."

      const first = yield* harness(
        () => Effect.void,
        () => Effect.fail(new HostThreadError({ message: reason })),
      ).pipe(Scope.provide(firstScope))

      assert.deepStrictEqual(yield* first.delivered(1), ["pending"])
      const waiting = yield* first.transcript
      assert.equal(waiting.turns[0]?.ended, null)
      assert.equal(waiting.status, reason)
      assert.lengthOf(waiting.queued, 1)
      yield* transcripts.endRunning(TurnCutOff.make({}), ["agent-1"])
      yield* transcripts.endRunning(TurnInterrupted.make({}), ["agent-1"])
      assert.equal((yield* first.transcript).turns[0]?.ended, null)
      yield* Scope.close(firstScope, Exit.void)

      const second = yield* harness(() => Effect.void)
      assert.deepStrictEqual(yield* second.delivered(1), ["dispatched"])
      assert.deepStrictEqual(second.dispatched, [savedId])
      const recovered = yield* second.transcript
      assert.lengthOf(recovered.turns, 1)
      assert.equal(recovered.turns[0]?.id, savedId)
    }).pipe(Effect.provide(layer)),
)

it.live("fails a Turn started when idle that doesn't retry delivery once the host refuses it", () =>
  Effect.gen(function* () {
    const reason = "pi refused the Turn"

    const h = yield* harness(
      () => Effect.void,
      () => Effect.fail(new HostThreadError({ message: reason })),
    )

    yield* h.turns.whenIdle("agent-1", (start) =>
      start({ ...startedWorkUpdateTurn, retriesDelivery: false }, () => Effect.void),
    )

    assert.deepStrictEqual(yield* h.delivered(1), ["failed"])
    const { turns, status } = yield* h.transcript
    assert.deepStrictEqual(turns[0]?.ended?.ending, TurnFailed.make({ reason }))
    assert.isNull(status)
    assert.lengthOf(yield* (yield* Transcripts).retryDeliveries(["agent-1"]), 0)
  }).pipe(Effect.provide(layer)),
)

const acceptsWhileStartIsHeld = (otherId: string) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const otherStarted = yield* Deferred.make<void>()
    const heldStarted = yield* Deferred.make<void>()

    const desk = yield* scripted({
      "agent-a": { startTurn: hold(entered, release), started: heldStarted },
      [otherId]: { started: otherStarted },
    })

    const held = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Hold the host"), "user"))
    yield* Deferred.await(entered)

    const other = yield* Effect.forkChild(
      desk.turns.send(otherId, sent("Hello from elsewhere"), "user"),
    )

    yield* Deferred.await(otherStarted)
    assert.equal(yield* Fiber.join(other), "started")
    assert.lengthOf(desk.started("agent-a"), 0)
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(heldStarted)
    assert.lengthOf(desk.started("agent-a"), 1)
    assert.equal(yield* Fiber.join(held), "started")
  }).pipe(Effect.provide(layer))

it.live("accepts and dispatches another Thread's message while StartTurn is still unanswered", () =>
  acceptsWhileStartIsHeld("agent-b"),
)

it.live("accepts and dispatches another Thread's message while StopTurn is still unanswered", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()

    const otherStarted = yield* Deferred.make<void>()
    const heldStarted = yield* Deferred.make<void>()

    const desk = yield* scripted({
      "agent-a": {
        running: true,
        started: heldStarted,
        stopTurn: () => hold(entered, release)().pipe(Effect.as(null)),
      },
      "agent-b": { started: otherStarted },
    })

    const thread = desk.threads.get("agent-a")
    assert.isDefined(thread)

    assert.equal(yield* desk.turns.send("agent-a", sent("Working"), "user"), "started")
    yield* Deferred.await(heldStarted)

    const stopping = yield* Effect.forkChild(desk.turns.stop(thread))
    yield* Deferred.await(entered)

    const other = yield* Effect.forkChild(desk.turns.send("agent-b", sent("Hello from B"), "user"))
    yield* Deferred.await(otherStarted)
    assert.equal(yield* Fiber.join(other), "started")
    assert.lengthOf(desk.started("agent-b"), 1)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(stopping)
  }).pipe(Effect.provide(layer)),
)

it.live(
  "runs idle work and a queued send for other Threads while StartTurn is still unanswered",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const heldStarted = yield* Deferred.make<void>()
      let idle = false
      let update = false
      let sentQueued = false

      const desk = yield* scripted({
        "agent-a": { startTurn: hold(entered, release), started: heldStarted },
        "agent-c": {},
        "global-session": {},
      })

      const held = yield* Effect.forkChild(
        desk.turns.send("agent-a", sent("Hold the host"), "user"),
      )

      yield* Deferred.await(entered)
      yield* Fiber.join(
        yield* Effect.forkChild(
          desk.turns.whileIdle(
            "agent-c",
            Effect.sync(() => {
              idle = true
            }),
          ),
        ),
      )
      yield* Fiber.join(
        yield* Effect.forkChild(
          desk.turns.whenIdle("global-session", () =>
            Effect.sync(() => {
              update = true
            }),
          ),
        ),
      )
      yield* Fiber.join(
        yield* Effect.forkChild(
          desk.turns.sendQueued("agent-c", "absent").pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                sentQueued = true
              }),
            ),
          ),
        ),
      )
      assert.isTrue(idle)
      assert.isTrue(update)
      assert.isTrue(sentQueued)
      assert.lengthOf(desk.started("agent-a"), 0)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(heldStarted)
      yield* Fiber.join(held)
    }).pipe(Effect.provide(layer)),
)

it.live("dispatches a Queued message sent after the running Turn stops", () =>
  Effect.gen(function* () {
    const h = yield* harness(() => Effect.void)

    yield* h.turns.send("agent-1", sent("First"), "user")
    assert.deepStrictEqual(yield* h.delivered(1), ["dispatched"])
    yield* h.turns.send("agent-1", sent("Second"), "user")

    const queued = (yield* h.transcript).queued[0]
    assert.isDefined(queued)
    yield* h.turns.stop(h.thread)

    const stopped = yield* h.transcript
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
    assert.lengthOf(stopped.queued, 1)
    yield* h.turns.sendQueued("agent-1", queued.id)
    assert.deepStrictEqual(yield* h.delivered(2), ["dispatched", "dispatched"])
    assert.lengthOf((yield* h.transcript).queued, 0)
    assert.equal((yield* h.transcript).turns[1]?.id, h.dispatched[1])
  }).pipe(Effect.provide(layer)),
)

it.live("starts an idle update only while that Thread has nothing running or Queued", () =>
  Effect.gen(function* () {
    const h = yield* harness(() => Effect.void)
    let started = 0

    yield* h.turns.whenIdle("agent-1", (start) =>
      start(startedWorkUpdateTurn, () =>
        Effect.sync(() => {
          started += 1
        }),
      ),
    )
    assert.equal(started, 1)
    yield* h.delivered(1)

    let again = false
    yield* h.turns.whenIdle("agent-1", () =>
      Effect.sync(() => {
        again = true
      }),
    )
    assert.isFalse(again)
    assert.equal((yield* h.transcript).turns[0]?.context?._tag, "StartedWorkUpdate")
  }).pipe(Effect.provide(layer)),
)

const occupy = () => {
  let current = 0
  let highest = 0

  const around = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.sync(() => {
      current += 1
      highest = Math.max(highest, current)
    }).pipe(
      Effect.andThen(effect),
      Effect.ensuring(
        Effect.sync(() => {
          current -= 1
        }),
      ),
    )

  return { around, current: () => current, highest: () => highest }
}

const queuedBehind = (
  leave: <A, E>(
    holder: Fiber.Fiber<A, E>,
    release: Deferred.Deferred<void>,
  ) => Effect.Effect<void, E>,
  fails: boolean,
) =>
  Effect.gen(function* () {
    const turns = yield* ThreadTurns
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const waiterIn = yield* Deferred.make<void>()
    const releaseWaiter = yield* Deferred.make<void>()
    const usage = occupy()
    let thirdIn = false

    const holder = yield* Effect.forkChild(
      turns.whileIdle(
        "agent-a",
        usage.around(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)

            if (fails) yield* Effect.fail("The holder failed")
          }),
        ),
      ),
    )

    yield* Deferred.await(entered)

    const waiter = yield* Effect.forkChild(
      turns.whileIdle(
        "agent-a",
        usage.around(
          Deferred.succeed(waiterIn, undefined).pipe(Effect.andThen(Deferred.await(releaseWaiter))),
        ),
      ),
      { startImmediately: true },
    )

    yield* leave(holder, release)
    yield* Deferred.await(waiterIn)

    const third = yield* Effect.forkChild(
      turns.whileIdle(
        "agent-a",
        usage.around(
          Effect.sync(() => {
            thirdIn = true
          }),
        ),
      ),
      { startImmediately: true },
    )

    assert.isFalse(thirdIn)
    assert.equal(usage.highest(), 1)
    yield* Deferred.succeed(releaseWaiter, undefined)
    yield* Fiber.join(waiter)
    yield* Fiber.join(third)
    assert.isTrue(thirdIn)
    assert.equal(usage.highest(), 1)
    assert.equal(usage.current(), 0)
  }).pipe(Effect.provide(layer))

it.live("keeps a queued operation holding the Thread after the holder finishes", () =>
  queuedBehind(
    (holder, release) =>
      Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(holder))),
    false,
  ),
)

it.live("keeps a queued operation holding the Thread after the holder is interrupted", () =>
  queuedBehind((holder) => Fiber.interrupt(holder).pipe(Effect.asVoid), false),
)

it.live("keeps a queued operation holding the Thread after the holder fails", () =>
  queuedBehind(
    (holder, release) =>
      Deferred.succeed(release, undefined).pipe(
        Effect.andThen(Fiber.await(holder)),
        Effect.andThen((exit) => {
          assert.isTrue(Exit.isFailure(exit))

          return Effect.void
        }),
      ),
    true,
  ),
)

const failedToAnswer = TurnFailed.make({ reason: HOST_DIDNT_ANSWER })

it.effect(
  "accepts the next message after StartTurn times out, once the stalled Turn has failed",
  () =>
    withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const secondAccepted = yield* Deferred.make<void>()
        const transcripts = yield* Transcripts
        let calls = 0

        const desk = yield* scripted({
          "agent-a": {
            startTurn: () =>
              Effect.gen(function* () {
                calls += 1

                if (calls === 1) {
                  yield* hold(entered, release)()

                  return
                }

                const { turns } = yield* transcripts.read("agent-a").pipe(Effect.orDie)
                assert.deepStrictEqual(turns[0]?.ended?.ending, failedToAnswer)
                yield* Deferred.succeed(secondAccepted, undefined)
              }),
          },
        })

        const first = yield* Effect.forkChild(desk.turns.send("agent-a", sent("First"), "user"))
        yield* Deferred.await(entered)
        yield* deadlineSet
        assert.equal(yield* Fiber.join(first), "started")

        const second = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Second"), "user"), {
          startImmediately: true,
        })

        assert.equal(yield* Fiber.join(second), "queued")
        yield* TestClock.adjust(HOST_CONTROL_DEADLINE)
        yield* Deferred.await(secondAccepted)

        const { turns } = yield* desk.transcripts.read("agent-a")
        assert.deepStrictEqual(
          turns.map(({ message, ended }) => ({ message, ending: ended?.ending ?? null })),
          [
            { message: "First", ending: failedToAnswer },
            { message: "Second", ending: null },
          ],
        )
        assert.deepStrictEqual(
          desk.started("agent-a").map(({ turnId }) => turnId),
          [turns[1]?.id],
        )
      }),
    ).pipe(Effect.provide(layer)),
)

it.effect("stops a Turn when StopTurn never answers, then accepts the next message", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const nextAccepted = yield* Deferred.make<void>()
      const transcripts = yield* Transcripts

      const desk = yield* scripted({
        "agent-a": {
          running: true,
          startTurn: () =>
            Effect.gen(function* () {
              const { turns } = yield* transcripts.read("agent-a").pipe(Effect.orDie)
              const latest = turns.at(-1)

              if (latest?.ended !== null || turns.length < 2) return

              assert.deepStrictEqual(turns[0]?.ended?.ending, TurnStopped.make({}))
              yield* Deferred.succeed(nextAccepted, undefined)
            }),
          stopTurn: () => hold(entered, release)().pipe(Effect.as(null)),
        },
      })

      const thread = desk.threads.get("agent-a")
      assert.isDefined(thread)

      assert.equal(yield* desk.turns.send("agent-a", sent("Working"), "user"), "started")
      const stopping = yield* Effect.forkChild(desk.turns.stop(thread))
      yield* Deferred.await(entered)
      yield* deadlineSet
      assert.isUndefined(stopping.pollUnsafe())

      yield* TestClock.adjust(HOST_CONTROL_DEADLINE)
      yield* Fiber.join(stopping)

      const next = yield* desk.turns.send("agent-a", sent("After"), "user")
      assert.equal(next, "started")
      yield* Deferred.await(nextAccepted)

      const { turns } = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.equal(turns[1]?.message, "After")
      assert.equal(turns[1]?.ended, null)
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("leaves a Turn that retries delivery pending when StartTurn never answers", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const transcripts = yield* Transcripts

      const desk = yield* scripted({
        "agent-1": {
          running: true,
          startTurn: hold(entered, release),
          stopTurn: () => Effect.succeed([]),
        },
      })

      yield* desk.turns.whenIdle("agent-1", (start) =>
        start(startedWorkUpdateTurn, () => Effect.void),
      )
      yield* Deferred.await(entered)
      yield* deadlineSet

      const followed = yield* Effect.forkChild(desk.turns.whenIdle("agent-1", () => Effect.void))
      yield* TestClock.adjust(Duration.millis(30_000))
      yield* Fiber.join(followed)

      const open = yield* desk.transcripts.read("agent-1")
      const update = open.turns[0]
      assert.isDefined(update)

      yield* transcripts.save("agent-1", [
        TurnEnded.make({
          turnId: update.id,
          ended: { at: yield* DateTime.now, ending: TurnStopped.make({}) },
        }),
      ])

      const waiting = yield* desk.transcripts.read("agent-1")
      assert.equal(waiting.turns[0]?.ended, null)
      assert.equal(waiting.status, HOST_DIDNT_ANSWER)
      assert.equal(waiting.turns[0]?.context?._tag, "StartedWorkUpdate")

      const retryable = yield* desk.transcripts.retryDeliveries(["agent-1"])
      assert.lengthOf(retryable, 1)
    }),
  ).pipe(Effect.provide(layer)),
)

const reportStopped = (threadId: string, turnId: string) =>
  Effect.gen(function* () {
    const transcripts = yield* Transcripts

    yield* transcripts.save(threadId, [
      TurnEnded.make({
        turnId,
        ended: { at: yield* DateTime.now, ending: TurnStopped.make({}) },
      }),
    ])
  })

it.effect(
  "ends a Turn that retries delivery when the user stops it and the host has nothing running",
  () =>
    Effect.gen(function* () {
      const begun = yield* Deferred.make<void>()

      const desk = yield* scripted({
        "agent-1": {
          running: true,
          startTurn: () => Deferred.succeed(begun, undefined).pipe(Effect.asVoid),
          stopTurn: () => Effect.succeed(null),
        },
      })

      const thread = desk.threads.get("agent-1")
      assert.isDefined(thread)

      yield* desk.turns.whenIdle("agent-1", (start) =>
        start(startedWorkUpdateTurn, () => Effect.void),
      )
      yield* Deferred.await(begun)
      yield* desk.turns.stop(thread)

      const stopped = yield* desk.transcripts.read("agent-1")
      assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.lengthOf(yield* desk.transcripts.retryDeliveries(["agent-1"]), 0)
    }).pipe(Effect.provide(layer)),
)

it.effect(
  "ends a Turn that retries delivery when the user stops it, once the host reports Stopped",
  () =>
    Effect.gen(function* () {
      const begun = yield* Deferred.make<void>()

      const desk = yield* scripted({
        "agent-1": {
          running: true,
          startTurn: () => Deferred.succeed(begun, undefined).pipe(Effect.asVoid),
          stopTurn: () => Effect.succeed([]),
        },
      })

      const thread = desk.threads.get("agent-1")
      assert.isDefined(thread)

      yield* desk.turns.whenIdle("agent-1", (start) =>
        start(startedWorkUpdateTurn, () => Effect.void),
      )
      yield* Deferred.await(begun)
      yield* desk.turns.stop(thread)

      const open = yield* desk.transcripts.read("agent-1")
      const turn = open.turns[0]
      assert.isDefined(turn)
      assert.equal(turn.ended, null)

      yield* reportStopped("agent-1", turn.id)

      const stopped = yield* desk.transcripts.read("agent-1")
      assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.lengthOf(yield* desk.transcripts.retryDeliveries(["agent-1"]), 0)
    }).pipe(Effect.provide(layer)),
)

const database = Layer.provideMerge(
  SqliteMigrator.layer({ loader: migrationLoader }),
  SqliteClient.layer({ filename: ":memory:" }),
)

const glassRun = ThreadTurns.layer.pipe(
  Layer.provideMerge(Transcripts.layer),
  Layer.provideMerge(Layer.mock(ToDos)({})),
)

const stopStartedWorkUpdate = Effect.gen(function* () {
  const begun = yield* Deferred.make<void>()

  const desk = yield* scripted({
    "agent-1": {
      running: true,
      startTurn: () => Deferred.succeed(begun, undefined).pipe(Effect.asVoid),
      stopTurn: () => Effect.succeed([]),
    },
  })

  const thread = desk.threads.get("agent-1")
  assert.isDefined(thread)

  yield* desk.turns.whenIdle("agent-1", (start) => start(startedWorkUpdateTurn, () => Effect.void))
  yield* Deferred.await(begun)
  yield* desk.turns.stop(thread)

  const turn = (yield* desk.transcripts.read("agent-1")).turns[0]
  assert.isDefined(turn)
  assert.equal(turn.ended, null)

  return turn.id
})

it.effect(
  "ends a Turn that retries delivery when Glass restarts after the user stops it and before the host's Stopped is saved",
  () =>
    Effect.gen(function* () {
      const turnId = yield* stopStartedWorkUpdate.pipe(Effect.provide(glassRun))

      yield* Effect.gen(function* () {
        const transcripts = yield* Transcripts

        yield* reportStopped("agent-1", turnId)

        const stopped = yield* transcripts.read("agent-1")
        assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
        assert.lengthOf(yield* transcripts.retryDeliveries(["agent-1"]), 0)
      }).pipe(Effect.provide(glassRun))
    }).pipe(Effect.provide(database)),
)

it.effect(
  "ends a Turn that retries delivery when the agent host is replaced after the user stops it",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts

      yield* stopStartedWorkUpdate
      yield* transcripts.endRunning(TurnCutOff.make({}), ["agent-1"])

      const cutOff = yield* transcripts.read("agent-1")
      assert.deepStrictEqual(cutOff.turns[0]?.ended?.ending, TurnCutOff.make({}))
      assert.lengthOf(yield* transcripts.retryDeliveries(["agent-1"]), 0)
    }).pipe(Effect.provide(layer)),
)

it.effect(
  "ends a Turn that retries delivery when the user stops it after a timeout, once the host reports Stopped",
  () =>
    withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const desk = yield* scripted({
          "agent-1": {
            running: true,
            startTurn: hold(entered, release),
            stopTurn: () => Effect.succeed([]),
          },
        })

        const thread = desk.threads.get("agent-1")
        assert.isDefined(thread)

        yield* desk.turns.whenIdle("agent-1", (start) =>
          start(startedWorkUpdateTurn, () => Effect.void),
        )
        yield* Deferred.await(entered)
        yield* deadlineSet
        yield* TestClock.adjust(Duration.millis(30_000))

        const waiting = yield* desk.transcripts.read("agent-1")
        const turn = waiting.turns[0]
        assert.isDefined(turn)
        yield* reportStopped("agent-1", turn.id)
        assert.equal((yield* desk.transcripts.read("agent-1")).turns[0]?.ended, null)

        yield* desk.turns.stop(thread)
        yield* reportStopped("agent-1", turn.id)

        const stopped = yield* desk.transcripts.read("agent-1")
        assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
        assert.lengthOf(yield* desk.transcripts.retryDeliveries(["agent-1"]), 0)
      }),
    ).pipe(Effect.provide(layer)),
)

it.effect("fails the Turn at 30 seconds, and not a millisecond sooner", () =>
  withWatchedClock(Duration.seconds(30), (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const desk = yield* scripted({
        "agent-a": { startTurn: hold(entered, release) },
      })

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("Build it"), "user"))
      yield* Deferred.await(entered)
      yield* deadlineSet
      yield* TestClock.adjust(Duration.millis(29_999))

      const early = yield* desk.transcripts.read("agent-a")
      assert.equal(early.turns[0]?.ended, null)

      yield* TestClock.adjust(Duration.millis(1))

      const { turns } = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(turns[0]?.ended?.ending, failedToAnswer)
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("fails a timed-out Turn before a waiting Stop can end it as Stopped", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let stopRan = false
      let askStop: Effect.Effect<void> = Effect.void

      const desk = yield* scripted({
        "agent-a": {
          running: true,
          startTurn: () => hold(entered, release)().pipe(Effect.onInterrupt(() => askStop)),
          stopTurn: () => Effect.succeed(null),
        },
      })

      const thread = desk.threads.get("agent-a")
      assert.isDefined(thread)

      askStop = Effect.forkDetach(
        desk.turns.stop(thread).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              stopRan = true
            }),
          ),
        ),
        { startImmediately: false },
      ).pipe(Effect.asVoid)

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("Build it"), "user"))
      yield* Deferred.await(entered)
      yield* deadlineSet
      yield* TestClock.adjust(Duration.millis(30_000))

      assert.isTrue(stopRan)

      const { turns } = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(turns[0]?.ended?.ending, failedToAnswer)
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("queues a message sent during a stalled StartTurn, and Stop stops that Turn", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const desk = yield* scripted({
        "agent-a": {
          running: true,
          startTurn: hold(entered, release),
          stopTurn: () => Effect.succeed(null),
        },
      })

      const thread = desk.threads.get("agent-a")
      assert.isDefined(thread)

      const first = yield* Effect.forkChild(desk.turns.send("agent-a", sent("First"), "user"), {
        startImmediately: true,
      })

      yield* Deferred.await(entered)
      yield* deadlineSet
      assert.equal(yield* Fiber.join(first), "started")

      assert.equal(yield* desk.turns.send("agent-a", sent("Second"), "user"), "queued")

      yield* desk.turns.stop(thread)

      const { turns, queued: waiting } = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(
        turns.map(({ message, ended }) => ({ message, ending: ended?.ending ?? null })),
        [{ message: "First", ending: TurnStopped.make({}) }],
      )
      assert.deepStrictEqual(
        waiting.map(({ message }) => message),
        ["Second"],
      )
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("tells the host to stop when StartTurn times out so the next message can start", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const outcome = yield* Deferred.make<"accepted" | "working">()
      let stopped = false
      let calls = 0

      const desk = yield* scripted({
        "agent-a": {
          running: true,
          startTurn: () =>
            Effect.gen(function* () {
              calls += 1

              if (calls === 1) {
                yield* hold(entered, release)()

                return
              }

              yield* Deferred.succeed(outcome, stopped ? "accepted" : "working")

              if (!stopped)
                yield* new HostThreadError({
                  message: "The Thread is still working on a Turn.",
                })
            }),
          stopTurn: () =>
            Effect.sync(() => {
              stopped = true
            }).pipe(Effect.as(null)),
        },
      })

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("First"), "user"))
      yield* Deferred.await(entered)
      yield* deadlineSet
      yield* TestClock.adjust(HOST_CONTROL_DEADLINE)

      const second = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Second"), "user"))
      assert.equal(yield* Deferred.await(outcome), "accepted")
      assert.equal(yield* Fiber.join(second), "started")
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("drops a late reply on a Turn the host never accepted", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const desk = yield* scripted({
        "agent-a": { startTurn: hold(entered, release) },
      })

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("First"), "user"))
      yield* Deferred.await(entered)
      yield* deadlineSet
      yield* TestClock.adjust(HOST_CONTROL_DEADLINE)

      const { turns } = yield* desk.transcripts.read("agent-a")
      const first = turns[0]
      assert.isDefined(first)

      yield* desk.transcripts.save("agent-a", [
        PartSet.make({
          turnId: first.id,
          index: 0,
          part: TextPart.make({ text: "late reply" }),
        }),
      ])

      const after = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(after.turns[0]?.parts, [])
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("does not stop the next Turn when an earlier StartTurn answers late", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    const secondBegun = yield* Deferred.make<void>()
    const cleaned = yield* Deferred.make<void>()
    const running = new OpenTurn()
    const transcripts = yield* Transcripts
    let calls = 0
    let stops = 0

    const desk = yield* scripted({
      "agent-a": {
        running: true,
        startTurn: (turnId) =>
          Effect.gen(function* () {
            calls += 1

            if (calls === 1) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(gate)

              if (running.id !== null)
                yield* new HostThreadError({
                  message: "The Thread is still working on a Turn.",
                })
            }

            running.id = turnId
            yield* Deferred.succeed(secondBegun, undefined)
          }),
        stopTurn: (request) =>
          Effect.gen(function* () {
            const left = yield* stopRunningTurn("agent-a", running, request, transcripts)
            stops += 1

            if (stops === 2) yield* Deferred.succeed(cleaned, undefined)

            return left
          }),
      },
    })

    const thread = desk.threads.get("agent-a")
    assert.isDefined(thread)

    yield* Effect.forkChild(desk.turns.send("agent-a", sent("First"), "user"))
    yield* Deferred.await(entered)
    yield* desk.turns.stop(thread)
    yield* desk.turns.send("agent-a", sent("Second"), "user")
    yield* Deferred.await(secondBegun)
    yield* Deferred.succeed(gate, undefined)
    yield* Deferred.await(cleaned)

    const { turns } = yield* desk.transcripts.read("agent-a")
    assert.deepStrictEqual(
      turns.map(({ message, ended }) => ({ message, ending: ended?.ending ?? null })),
      [
        { message: "First", ending: TurnStopped.make({}) },
        { message: "Second", ending: null },
      ],
    )
  }).pipe(Effect.provide(layer)),
)

it.effect("does not stop the next Turn when an earlier StartTurn times out", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const secondBegun = yield* Deferred.make<void>()
      const cleaned = yield* Deferred.make<void>()
      const running = new OpenTurn()
      const transcripts = yield* Transcripts
      let calls = 0
      let stops = 0

      const desk = yield* scripted({
        "agent-a": {
          running: true,
          startTurn: (turnId) =>
            Effect.gen(function* () {
              calls += 1

              if (calls === 1) {
                yield* Deferred.succeed(entered, undefined)
                yield* Effect.never
              }

              running.id = turnId
              yield* Deferred.succeed(secondBegun, undefined)
            }),
          stopTurn: (request) =>
            Effect.gen(function* () {
              const left = yield* stopRunningTurn("agent-a", running, request, transcripts)
              stops += 1

              if (stops === 2) yield* Deferred.succeed(cleaned, undefined)

              return left
            }),
        },
      })

      const thread = desk.threads.get("agent-a")
      assert.isDefined(thread)

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("First"), "user"))
      yield* Deferred.await(entered)
      yield* deadlineSet
      yield* desk.turns.stop(thread)
      yield* desk.turns.send("agent-a", sent("Second"), "user")
      yield* Deferred.await(secondBegun)
      yield* TestClock.adjust(Duration.millis(30_000))
      yield* Deferred.await(cleaned)

      const { turns } = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(
        turns.map(({ message, ended }) => ({ message, ending: ended?.ending ?? null })),
        [
          { message: "First", ending: TurnStopped.make({}) },
          { message: "Second", ending: null },
        ],
      )
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("fails a Steer the host never acknowledges instead of sending it again", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const begun = yield* Deferred.make<void>()
      const steerEntered = yield* Deferred.make<void>()

      const desk = yield* scripted({
        "agent-a": {
          running: true,
          startTurn: () => Deferred.succeed(begun, undefined).pipe(Effect.asVoid),
          steer: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(steerEntered, undefined)
              yield* Effect.never
            }),
        },
      })

      const thread = desk.threads.get("agent-a")
      assert.isDefined(thread)

      yield* desk.turns.send("agent-a", sent("Build it"), "user")
      yield* Deferred.await(begun)

      const steered = yield* Effect.forkChild(desk.turns.steer(thread, sent("nudge")))
      yield* Deferred.await(steerEntered)
      yield* deadlineSet
      yield* TestClock.adjust(Duration.millis(30_000))

      const { queued } = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(
        queued.map(({ message }) => message),
        [],
      )

      const error = yield* Fiber.join(steered).pipe(Effect.flip)
      assert.equal(error.message, HOST_DIDNT_ANSWER)
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("keeps a late reply on a Stopped Turn and one on the next Turn", () =>
  Effect.gen(function* () {
    const desk = yield* scripted({
      "agent-a": {
        running: true,
        stopTurn: () => Effect.succeed(null),
      },
    })

    const thread = desk.threads.get("agent-a")
    assert.isDefined(thread)

    yield* desk.turns.send("agent-a", sent("First"), "user")
    yield* desk.turns.stop(thread)

    const stopped = yield* desk.transcripts.read("agent-a")
    const first = stopped.turns[0]
    assert.isDefined(first)
    assert.deepStrictEqual(first.ended?.ending, TurnStopped.make({}))

    yield* desk.transcripts.save("agent-a", [
      PartSet.make({
        turnId: first.id,
        index: 0,
        part: TextPart.make({ text: "late" }),
      }),
    ])

    yield* desk.turns.send("agent-a", sent("Second"), "user")
    const running = yield* desk.transcripts.read("agent-a")
    const second = running.turns[1]
    assert.isDefined(second)

    yield* desk.transcripts.save("agent-a", [
      PartSet.make({
        turnId: second.id,
        index: 0,
        part: TextPart.make({ text: "kept" }),
      }),
    ])

    const after = yield* desk.transcripts.read("agent-a")
    assert.deepStrictEqual(after.turns[0]?.parts, [TextPart.make({ text: "late" })])
    assert.deepStrictEqual(after.turns[1]?.parts, [TextPart.make({ text: "kept" })])
  }).pipe(Effect.provide(layer)),
)

it.effect("keeps a part that arrives after StopTurn times out", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const begun = yield* Deferred.make<void>()
      const stalled = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const desk = yield* scripted({
        "agent-a": {
          running: true,
          startTurn: () => Deferred.succeed(begun, undefined).pipe(Effect.asVoid),
          stopTurn: () => hold(stalled, release)().pipe(Effect.as(null)),
        },
      })

      const thread = desk.threads.get("agent-a")
      assert.isDefined(thread)

      yield* desk.turns.send("agent-a", sent("Work"), "user")
      yield* Deferred.await(begun)

      const running = yield* desk.transcripts.read("agent-a")
      const turn = running.turns[0]
      assert.isDefined(turn)

      yield* desk.transcripts.save("agent-a", [
        PartSet.make({
          turnId: turn.id,
          index: 0,
          part: TextPart.make({ text: "edited src/a.ts" }),
        }),
      ])

      const stopping = yield* Effect.forkChild(desk.turns.stop(thread))
      yield* Deferred.await(stalled)
      yield* deadlineSet
      yield* TestClock.adjust(Duration.millis(30_000))
      yield* Fiber.join(stopping)

      yield* desk.transcripts.save("agent-a", [
        PartSet.make({
          turnId: turn.id,
          index: 1,
          part: TextPart.make({ text: "ran the tests" }),
        }),
      ])

      const stopped = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.deepStrictEqual(stopped.turns[0]?.parts, [
        TextPart.make({ text: "edited src/a.ts" }),
        TextPart.make({ text: "ran the tests" }),
      ])
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("queues a Steer the host refuses, as it does once the Turn is stopping", () =>
  Effect.gen(function* () {
    const desk = yield* scripted({
      "agent-a": { running: true, steer: () => Effect.fail(notRunning) },
    })

    const thread = desk.threads.get("agent-a")
    assert.isDefined(thread)

    yield* desk.turns.send("agent-a", sent("Build it"), "user")
    yield* desk.turns.steer(thread, sent("nudge"))

    const { queued } = yield* desk.transcripts.read("agent-a")
    assert.deepStrictEqual(
      queued.map(({ message }) => message),
      ["nudge"],
    )
  }).pipe(Effect.provide(layer)),
)
