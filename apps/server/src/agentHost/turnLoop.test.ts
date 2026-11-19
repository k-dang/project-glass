import { assert, it } from "@effect/vitest"
import { type AgentEvent, type TurnEnd, TurnStopped } from "@glass/contracts"
import { Deferred, Effect, Predicate, Stream } from "effect"
import { Input, machine } from "./piTurn"
import { runTurns } from "./turnLoop"

it.live(
  "ends a Turn stopped when Stop comes after the harness's ending but before Glass takes it",
  () =>
    Effect.gen(function* () {
      const busy = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const ended = yield* Deferred.make<TurnEnd>()

      const turns = yield* runTurns({
        harness: "pi",
        machine,
        events: Stream.never,
        report: (event) =>
          Predicate.isTagged(event, "TurnEnded")
            ? Deferred.succeed(ended, event.ended).pipe(Effect.asVoid)
            : Deferred.succeed(busy, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      })

      yield* turns.begin("turn-1", { message: "Build it", images: [], context: null })
      yield* turns.offer(
        Input.Event({
          event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} },
        }),
      )
      yield* Deferred.await(busy)

      yield* turns.offer(Input.Accepted({ turnId: "turn-1", handled: true }))
      assert.deepStrictEqual(yield* turns.stop("turn-1", TurnStopped.make({})), [])
      yield* Deferred.succeed(resume, undefined)

      assert.deepStrictEqual((yield* Deferred.await(ended)).ending, TurnStopped.make({}))
    }).pipe(Effect.scoped),
)

it.effect("stops only the Turn it names", () =>
  Effect.gen(function* () {
    const turns = yield* runTurns({
      harness: "pi",
      machine,
      events: Stream.never,
      report: () => Effect.void,
    })

    yield* turns.begin("turn-1", { message: "Build it", images: [], context: null })

    assert.equal(yield* turns.stop("turn-2", TurnStopped.make({})), null)
    assert.deepStrictEqual(yield* turns.stop("turn-1", TurnStopped.make({})), [])
  }).pipe(Effect.scoped),
)

it.effect("opens a Turn with no message for a run the harness starts with no Turn open", () =>
  Effect.gen(function* () {
    const reported = yield* Deferred.make<AgentEvent>()

    const turns = yield* runTurns({
      harness: "pi",
      machine,
      events: Stream.make(Input.Event({ event: { type: "agent_start" } })).pipe(
        Stream.concat(Stream.never),
      ),
      report: (event) => Deferred.succeed(reported, event).pipe(Effect.asVoid),
    })

    const started = yield* Deferred.await(reported)
    assert.ok(Predicate.isTagged(started, "TurnStarted"))
    assert.equal(started.message, "")

    const refused = yield* turns
      .begin("turn-1", { message: "Build it", images: [], context: null })
      .pipe(Effect.flip)

    assert.equal(refused.message, "The Conversation is still working on a Turn.")
  }).pipe(Effect.scoped),
)
