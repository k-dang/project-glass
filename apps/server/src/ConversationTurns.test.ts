import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  ConversationError,
  ConversationOutcome,
  TurnDone,
  TurnCutOff,
  TurnInterrupted,
  TurnEnded,
  PartSet,
  TextPart,
  TurnFailed,
  TurnStopped,
  GlobalConversationUpdate,
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
import {
  type ClaimedConversation,
  type ConversationHost,
  ConversationTurns,
  conversationLock,
} from "./ConversationTurns"
import { HOST_CONTROL_DEADLINE, HOST_DIDNT_ANSWER } from "./hostControl"
import { migrationLoader } from "./Migrations"
import { ToDos } from "./ToDos"
import { Transcripts } from "./Transcripts"
import { wideEvents } from "./wideEvents"
import { HostConversationError, type SteersNotTakenIn } from "./agentHost/protocol"

type StopRequest = Parameters<ConversationHost["StopTurn"]>[0]

interface Script {
  readonly startTurn?: (turnId: string) => Effect.Effect<void, HostConversationError>
  readonly stopTurn?: (
    request: StopRequest,
  ) => Effect.Effect<SteersNotTakenIn | null, ConversationError>
  readonly steer?: () => Effect.Effect<void, HostConversationError>
  readonly running?: boolean
  readonly started?: Deferred.Deferred<void>
}

class OpenTurn {
  id: string | null = null
}

const unused = (method: string) => () => Effect.die(`This test does not call ${method}`)

const hostThatStarts = (
  record: (turnId: string) => Effect.Effect<void, HostConversationError>,
): ConversationHost => ({
  StartConversation: unused("StartConversation"),
  StartTurn: ({ turnId }) => record(turnId),
  AnswerRequest: unused("AnswerRequest"),
  Steer: unused("Steer"),
  StopTurn: unused("StopTurn"),
})

const scriptedHost = (
  script: Script,
  dispatched: Array<{ conversationId: string; turnId: string }>,
): ConversationHost => ({
  StartConversation: unused("StartConversation"),
  StartTurn: ({ conversationId, turnId }) =>
    (script.startTurn?.(turnId) ?? Effect.void).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          dispatched.push({ conversationId, turnId })
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
})

const layer = ConversationTurns.layer.pipe(
  Layer.provideMerge(Transcripts.layer),
  Layer.provideMerge(Layer.mock(ToDos)({})),
  Layer.provideMerge(SqliteMigrator.layer({ loader: migrationLoader })),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)

const UnitLine = Schema.Struct({ event: Schema.String, delivery: Schema.optional(Schema.String) })

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(UnitLine))

const sent = (message: string) => ({ message, images: [], context: null })

const globalConversationUpdate = GlobalConversationUpdate.make({
  work: [
    ConversationOutcome.make({
      conversationId: "started",
      name: "Started",
      askedWith: "Build it",
      outcome: "finished",
      reason: null,
    }),
  ],
})

const harness = (
  ensureStarted: ClaimedConversation["ensureStarted"],
  startTurn: (turnId: string) => Effect.Effect<void, HostConversationError> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const turns = yield* ConversationTurns
    const transcripts = yield* Transcripts
    const dispatched: Array<string> = []
    const deliveries: Array<string | undefined> = []

    const client = hostThatStarts((turnId) =>
      startTurn(turnId).pipe(Effect.tap(() => Effect.sync(() => dispatched.push(turnId)))),
    )

    const conversation: ClaimedConversation = {
      id: "agent-1",
      ensureStarted,
      settings: { model: null, effort: null, permissionMode: null },
      host: Effect.succeed(client),
      runningHost: Effect.succeedNone,
    }

    yield* turns
      .serve({
        claim: () => Effect.succeed(Option.some(conversation)),
        lost: Stream.empty,
        interrupted: Effect.succeed(["agent-1"]),
      })
      .pipe(
        Effect.provide(
          wideEvents("backend", (line) => {
            const { event, delivery } = decodeLine(line)

            if (event === "ConversationTurns.deliver") deliveries.push(delivery)
          }),
        ),
      )

    const delivered = (count: number) =>
      eventually(Effect.sync(() => assert.lengthOf(deliveries, count))).pipe(Effect.as(deliveries))

    const transcript = transcripts.read("agent-1")

    return { turns, conversation, dispatched, transcript, delivered }
  })

const scripted = (scripts: { readonly [id: string]: Script }) =>
  Effect.gen(function* () {
    const turns = yield* ConversationTurns
    const transcripts = yield* Transcripts
    const dispatched: Array<{ conversationId: string; turnId: string }> = []
    const conversations = new Map<string, ClaimedConversation>()

    for (const [id, script] of Object.entries(scripts)) {
      const client = scriptedHost(script, dispatched)

      conversations.set(id, {
        id,
        ensureStarted: () => Effect.void,
        settings: { model: null, effort: null, permissionMode: null },
        host: Effect.succeed(client),
        runningHost: script.running ? Effect.succeed(Option.some(client)) : Effect.succeedNone,
      })
    }

    yield* turns
      .serve({
        claim: (id) =>
          Effect.sync(() => {
            const conversation = conversations.get(id)

            return conversation === undefined ? Option.none() : Option.some(conversation)
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

    const started = (conversationId: string) =>
      dispatched.filter((call) => call.conversationId === conversationId)

    return { turns, transcripts, conversations, started }
  })

const hostStall = 5_000

const stopRunningTurn = (
  conversationId: string,
  running: OpenTurn,
  request: StopRequest,
  transcripts: Transcripts["Service"],
) =>
  Effect.gen(function* () {
    if (running.id === null || request.turnId !== running.id) return null

    const turnId = running.id
    running.id = null

    yield* transcripts.save(conversationId, [
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

    yield* h.turns.send("agent-1", sent("Build it"))
    yield* h.turns.stop(h.conversation)
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
      ++starts === 1
        ? Effect.fail(new ConversationError({ message: "No such folder" }))
        : Effect.void,
    )

    yield* h.turns.send("agent-1", sent("First"))
    yield* h.turns.send("agent-1", sent("Second"))

    assert.deepStrictEqual(yield* h.delivered(2), ["failed", "dispatched"])
    assert.lengthOf(h.dispatched, 1)

    const { turns } = yield* h.transcript
    assert.deepStrictEqual(turns[0]?.ended?.ending, TurnFailed.make({ reason: "No such folder" }))
    assert.equal(turns[1]?.id, h.dispatched[0])
  }).pipe(Effect.provide(layer)),
)

it.live(
  "recovers the same saved Global conversation update before advancing Queued messages, and leaves a completed Global conversation update alone",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts

      let savedId = ""

      // No delivery subscriber exists when the transaction commits, as in a crash before dispatch.
      yield* transcripts.startGlobalConversationUpdate(
        "agent-1",
        globalConversationUpdate,
        (turnId) =>
          Effect.sync(() => {
            savedId = turnId
          }),
      )
      yield* transcripts.startOrQueue("agent-1", sent("After"))
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
  "keeps a Global conversation update pending after a recovery read fails, then retries the same Turn on restart",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts
      yield* transcripts.startGlobalConversationUpdate(
        "agent-1",
        globalConversationUpdate,
        () => Effect.void,
      )
      const savedId = yield* transcripts.runningTurn("agent-1")
      yield* transcripts.startOrQueue("agent-1", sent("After"))
      const firstScope = yield* Scope.make()
      const reason = "Couldn't recover pi's Global conversation update. Restart Glass to try again."

      const first = yield* harness(
        () => Effect.void,
        () => Effect.fail(new HostConversationError({ message: reason })),
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

    const held = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Hold the host")))
    yield* Deferred.await(entered)
    const other = yield* Effect.forkChild(desk.turns.send(otherId, sent("Hello from elsewhere")))
    yield* Deferred.await(otherStarted)
    assert.equal(yield* Fiber.join(other), "started")
    assert.lengthOf(desk.started("agent-a"), 0)
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(heldStarted)
    assert.lengthOf(desk.started("agent-a"), 1)
    assert.equal(yield* Fiber.join(held), "started")
  }).pipe(Effect.provide(layer))

it.live(
  "accepts and dispatches another Conversation's message while StartTurn is still unanswered",
  () => acceptsWhileStartIsHeld("agent-b"),
  hostStall,
)

it.live(
  "accepts and dispatches another Conversation's message while StopTurn is still unanswered",
  () =>
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

      const conversation = desk.conversations.get("agent-a")
      assert.isDefined(conversation)

      assert.equal(yield* desk.turns.send("agent-a", sent("Working")), "started")
      yield* Deferred.await(heldStarted)

      const stopping = yield* Effect.forkChild(desk.turns.stop(conversation))
      yield* Deferred.await(entered)

      const other = yield* Effect.forkChild(desk.turns.send("agent-b", sent("Hello from B")))
      yield* Deferred.await(otherStarted)
      assert.equal(yield* Fiber.join(other), "started")
      assert.lengthOf(desk.started("agent-b"), 1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopping)
    }).pipe(Effect.provide(layer)),
  hostStall,
)

it.live(
  "runs idle work and a queued send for other conversations while StartTurn is still unanswered",
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

      const held = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Hold the host")))
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
  hostStall,
)

it.live("dispatches a Queued message sent after the running Turn stops", () =>
  Effect.gen(function* () {
    const h = yield* harness(() => Effect.void)

    yield* h.turns.send("agent-1", sent("First"))
    assert.deepStrictEqual(yield* h.delivered(1), ["dispatched"])
    yield* h.turns.send("agent-1", sent("Second"))

    const queued = (yield* h.transcript).queued[0]
    assert.isDefined(queued)
    yield* h.turns.stop(h.conversation)

    const stopped = yield* h.transcript
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
    assert.lengthOf(stopped.queued, 1)
    yield* h.turns.sendQueued("agent-1", queued.id)
    assert.deepStrictEqual(yield* h.delivered(2), ["dispatched", "dispatched"])
    assert.lengthOf((yield* h.transcript).queued, 0)
    assert.equal((yield* h.transcript).turns[1]?.id, h.dispatched[1])
  }).pipe(Effect.provide(layer)),
)

it.live("starts an idle update only while that conversation has nothing running or Queued", () =>
  Effect.gen(function* () {
    const h = yield* harness(() => Effect.void)
    let started = 0

    yield* h.turns.whenIdle("agent-1", (start) =>
      start(globalConversationUpdate, () =>
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
    assert.equal((yield* h.transcript).turns[0]?.context?._tag, "GlobalConversationUpdate")
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
    const turns = yield* ConversationTurns
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

    const held = conversationLock(turns, "agent-a")
    assert.isDefined(held)
    yield* leave(holder, release)
    yield* Deferred.await(waiterIn)
    assert.strictEqual(conversationLock(turns, "agent-a"), held)

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
    assert.isUndefined(conversationLock(turns, "agent-a"))
  }).pipe(Effect.provide(layer))

it.live("keeps a queued operation holding the conversation after the holder finishes", () =>
  queuedBehind(
    (holder, release) =>
      Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(holder))),
    false,
  ),
)

it.live("keeps a queued operation holding the conversation after the holder is interrupted", () =>
  queuedBehind((holder) => Fiber.interrupt(holder).pipe(Effect.asVoid), false),
)

it.live("keeps a queued operation holding the conversation after the holder fails", () =>
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

it.effect("fails a Turn the host never accepts, so Stop can return", () =>
  withWatchedClock(HOST_CONTROL_DEADLINE, (deadlineSet) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const desk = yield* scripted({
        "agent-a": { startTurn: hold(entered, release) },
      })

      const conversation = desk.conversations.get("agent-a")
      assert.isDefined(conversation)

      const sending = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Build it")))
      yield* Deferred.await(entered)
      yield* deadlineSet
      assert.equal(yield* Fiber.join(sending), "started")
      yield* TestClock.adjust(Duration.millis(30_000))

      const stopping = yield* Effect.forkChild(desk.turns.stop(conversation), {
        startImmediately: true,
      })

      yield* Fiber.join(stopping)

      const { turns } = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(turns[0]?.ended?.ending, failedToAnswer)
      assert.isUndefined(conversationLock(desk.turns, "agent-a"))
    }),
  ).pipe(Effect.provide(layer)),
)

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

        const first = yield* Effect.forkChild(desk.turns.send("agent-a", sent("First")))
        yield* Deferred.await(entered)
        yield* deadlineSet
        assert.equal(yield* Fiber.join(first), "started")

        const second = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Second")), {
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

      const conversation = desk.conversations.get("agent-a")
      assert.isDefined(conversation)

      assert.equal(yield* desk.turns.send("agent-a", sent("Working")), "started")
      const stopping = yield* Effect.forkChild(desk.turns.stop(conversation))
      yield* Deferred.await(entered)
      yield* deadlineSet
      assert.isUndefined(stopping.pollUnsafe())

      yield* TestClock.adjust(HOST_CONTROL_DEADLINE)
      yield* Fiber.join(stopping)

      const next = yield* desk.turns.send("agent-a", sent("After"))
      assert.equal(next, "started")
      yield* Deferred.await(nextAccepted)

      const { turns } = yield* desk.transcripts.read("agent-a")
      assert.deepStrictEqual(turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.equal(turns[1]?.message, "After")
      assert.equal(turns[1]?.ended, null)
    }),
  ).pipe(Effect.provide(layer)),
)

it.effect("leaves a Global conversation update pending when StartTurn never answers", () =>
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
        start(globalConversationUpdate, () => Effect.void),
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
      assert.equal(waiting.turns[0]?.context?._tag, "GlobalConversationUpdate")

      const retryable = yield* desk.transcripts.recoverGlobalConversationUpdates(["agent-1"])
      assert.lengthOf(retryable, 1)
    }),
  ).pipe(Effect.provide(layer)),
)

const reportStopped = (conversationId: string, turnId: string) =>
  Effect.gen(function* () {
    const transcripts = yield* Transcripts

    yield* transcripts.save(conversationId, [
      TurnEnded.make({
        turnId,
        ended: { at: yield* DateTime.now, ending: TurnStopped.make({}) },
      }),
    ])
  })

it.effect(
  "ends a Global conversation update the user stops when the host has nothing running",
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

      const conversation = desk.conversations.get("agent-1")
      assert.isDefined(conversation)

      yield* desk.turns.whenIdle("agent-1", (start) =>
        start(globalConversationUpdate, () => Effect.void),
      )
      yield* Deferred.await(begun)
      yield* desk.turns.stop(conversation)

      const stopped = yield* desk.transcripts.read("agent-1")
      assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.lengthOf(yield* desk.transcripts.recoverGlobalConversationUpdates(["agent-1"]), 0)
    }).pipe(Effect.provide(layer)),
)

it.effect("ends a Global conversation update the user stops once the host reports Stopped", () =>
  Effect.gen(function* () {
    const begun = yield* Deferred.make<void>()

    const desk = yield* scripted({
      "agent-1": {
        running: true,
        startTurn: () => Deferred.succeed(begun, undefined).pipe(Effect.asVoid),
        stopTurn: () => Effect.succeed([]),
      },
    })

    const conversation = desk.conversations.get("agent-1")
    assert.isDefined(conversation)

    yield* desk.turns.whenIdle("agent-1", (start) =>
      start(globalConversationUpdate, () => Effect.void),
    )
    yield* Deferred.await(begun)
    yield* desk.turns.stop(conversation)

    const open = yield* desk.transcripts.read("agent-1")
    const turn = open.turns[0]
    assert.isDefined(turn)
    assert.equal(turn.ended, null)

    yield* reportStopped("agent-1", turn.id)

    const stopped = yield* desk.transcripts.read("agent-1")
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
    assert.lengthOf(yield* desk.transcripts.recoverGlobalConversationUpdates(["agent-1"]), 0)
  }).pipe(Effect.provide(layer)),
)

it.effect(
  "ends a Global conversation update the user stops after a timeout, when the host reports Stopped",
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

        const conversation = desk.conversations.get("agent-1")
        assert.isDefined(conversation)

        yield* desk.turns.whenIdle("agent-1", (start) =>
          start(globalConversationUpdate, () => Effect.void),
        )
        yield* Deferred.await(entered)
        yield* deadlineSet
        yield* TestClock.adjust(Duration.millis(30_000))

        const waiting = yield* desk.transcripts.read("agent-1")
        const turn = waiting.turns[0]
        assert.isDefined(turn)
        yield* reportStopped("agent-1", turn.id)
        assert.equal((yield* desk.transcripts.read("agent-1")).turns[0]?.ended, null)

        yield* desk.turns.stop(conversation)
        yield* reportStopped("agent-1", turn.id)

        const stopped = yield* desk.transcripts.read("agent-1")
        assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
        assert.lengthOf(yield* desk.transcripts.recoverGlobalConversationUpdates(["agent-1"]), 0)
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

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("Build it")))
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

      const conversation = desk.conversations.get("agent-a")
      assert.isDefined(conversation)

      askStop = Effect.forkDetach(
        desk.turns.stop(conversation).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              stopRan = true
            }),
          ),
        ),
        { startImmediately: false },
      ).pipe(Effect.asVoid)

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("Build it")))
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

      const conversation = desk.conversations.get("agent-a")
      assert.isDefined(conversation)

      const first = yield* Effect.forkChild(desk.turns.send("agent-a", sent("First")), {
        startImmediately: true,
      })

      yield* Deferred.await(entered)
      yield* deadlineSet
      assert.equal(yield* Fiber.join(first), "started")

      const second = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Second")), {
        startImmediately: true,
      })

      const queued = second.pollUnsafe()
      assert.isDefined(queued)
      assert.equal(Exit.isSuccess(queued) ? queued.value : undefined, "queued")

      yield* desk.turns.stop(conversation)

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
                yield* new HostConversationError({
                  message: "The Conversation is still working on a Turn.",
                })
            }),
          stopTurn: () =>
            Effect.sync(() => {
              stopped = true
            }).pipe(Effect.as(null)),
        },
      })

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("First")))
      yield* Deferred.await(entered)
      yield* deadlineSet
      yield* TestClock.adjust(HOST_CONTROL_DEADLINE)

      const second = yield* Effect.forkChild(desk.turns.send("agent-a", sent("Second")))
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

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("First")))
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
                yield* new HostConversationError({
                  message: "The Conversation is still working on a Turn.",
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

    const conversation = desk.conversations.get("agent-a")
    assert.isDefined(conversation)

    yield* Effect.forkChild(desk.turns.send("agent-a", sent("First")))
    yield* Deferred.await(entered)
    yield* desk.turns.stop(conversation)
    yield* desk.turns.send("agent-a", sent("Second"))
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

      const conversation = desk.conversations.get("agent-a")
      assert.isDefined(conversation)

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("First")))
      yield* Deferred.await(entered)
      yield* deadlineSet
      yield* desk.turns.stop(conversation)
      yield* desk.turns.send("agent-a", sent("Second"))
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

      const conversation = desk.conversations.get("agent-a")
      assert.isDefined(conversation)

      yield* desk.turns.send("agent-a", sent("Build it"))
      yield* Deferred.await(begun)

      const steered = yield* Effect.forkChild(desk.turns.steer(conversation, sent("nudge")))
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

    const conversation = desk.conversations.get("agent-a")
    assert.isDefined(conversation)

    yield* desk.turns.send("agent-a", sent("First"))
    yield* desk.turns.stop(conversation)

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

    yield* desk.turns.send("agent-a", sent("Second"))
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

      const conversation = desk.conversations.get("agent-a")
      assert.isDefined(conversation)

      yield* desk.turns.send("agent-a", sent("Work"))
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

      const stopping = yield* Effect.forkChild(desk.turns.stop(conversation))
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
