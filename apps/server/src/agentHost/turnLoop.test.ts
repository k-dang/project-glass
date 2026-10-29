import { assert, it } from "@effect/vitest"
import { type TurnEnd, TurnStopped } from "@glass/contracts"
import { Deferred, Effect, Predicate, Stream } from "effect"
import { Input, machine } from "./piTurn"
import { runTurns } from "./turnLoop"

it.live(
  "ends a Turn stopped when Stop comes after the program's ending but before Glass takes it",
  () =>
    Effect.gen(function* () {
      const busy = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const ended = yield* Deferred.make<TurnEnd>()

      const turns = yield* runTurns({
        program: "pi",
        machine,
        events: Stream.never,
        report: (event) =>
          Predicate.isTagged(event, "TurnEnded")
            ? Deferred.succeed(ended, event.ended).pipe(Effect.asVoid)
            : Deferred.succeed(busy, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      })

      yield* turns.begin("turn-1", { message: "Build it", images: [] })
      yield* turns.offer(
        Input.Event({
          event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} },
        }),
      )
      yield* Deferred.await(busy)

      yield* turns.offer(Input.Accepted({ turnId: "turn-1", handled: true }))
      assert.deepStrictEqual(yield* turns.stop, [])
      yield* Deferred.succeed(resume, undefined)

      assert.deepStrictEqual((yield* Deferred.await(ended)).ending, TurnStopped.make({}))
    }).pipe(Effect.scoped),
)
