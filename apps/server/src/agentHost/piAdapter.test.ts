import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { AgentModels } from "@glass/contracts"
import { Deferred, Effect, Fiber, Queue, Schema, Scope, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { isolatedHome, stubHome } from "../../test/harness"
import { playedHandle } from "../../test/replay"
import { piAdapter } from "./piAdapter"
import { lineFramer } from "./piRpc"

const readTypes = ["get_available_models", "get_state"] as const

type ReadType = (typeof readTypes)[number]

const PiRead = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(readTypes),
})

const opus = { provider: "anthropic", id: "claude-opus", name: "Opus" }

const sonnet = { provider: "anthropic", id: "claude-sonnet", name: "Sonnet" }

const payloads = {
  get_available_models: { models: [opus, sonnet] },
  get_state: { model: opus, isStreaming: false, isCompacting: false },
}

const expectedModels = new AgentModels({
  defaultModel: { id: "anthropic/claude-opus", name: "Opus", efforts: [] },
  models: [
    { id: "anthropic/claude-opus", name: "Opus", efforts: [] },
    { id: "anthropic/claude-sonnet", name: "Sonnet", efforts: [] },
  ],
})

const scriptedPi = Effect.gen(function* () {
  const scope = yield* Scope.Scope
  const stdout = yield* Queue.unbounded<Uint8Array>()
  const malformed = yield* Deferred.make<string>()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const frame = lineFramer()

  const arrived = {
    get_available_models: yield* Deferred.make<void>(),
    get_state: yield* Deferred.make<void>(),
  }

  const release = {
    get_available_models: yield* Deferred.make<void>(),
    get_state: yield* Deferred.make<void>(),
  }

  const submitted: Array<ReadType> = []

  const accept = (line: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(PiRead))(line).pipe(
      Effect.matchEffect({
        onFailure: () => Deferred.succeed(malformed, line),
        onSuccess: (command) =>
          Effect.gen(function* () {
            submitted.push(command.type)

            yield* Deferred.await(release[command.type]).pipe(
              Effect.andThen(
                Queue.offer(
                  stdout,
                  encoder.encode(
                    `${JSON.stringify({
                      type: "response",
                      id: command.id,
                      success: true,
                      data: payloads[command.type],
                    })}\n`,
                  ),
                ),
              ),
              Effect.forkIn(scope, { startImmediately: true }),
              Effect.asVoid,
            )

            yield* Deferred.succeed(arrived[command.type], undefined)
          }),
      }),
    )

  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      playedHandle({
        stdout: Stream.fromQueue(stdout),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.forEach(frame(decoder.decode(chunk, { stream: true })), accept, { discard: true }),
        ),
      }),
    ),
  )

  return { spawner, arrived, release, malformed, submitted }
})

it.live("submits get_state while get_available_models is still unanswered, and the reverse", () =>
  Effect.gen(function* () {
    stubHome(yield* isolatedHome)
    const script = yield* scriptedPi

    const adapter = yield* piAdapter("pi").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, script.spawner),
    )

    const pending = yield* adapter.models.pipe(Effect.forkChild({ startImmediately: true }))

    yield* Effect.raceFirst(
      Deferred.await(script.arrived.get_available_models).pipe(
        Effect.andThen(Deferred.await(script.arrived.get_state)),
      ),
      Deferred.await(script.malformed).pipe(
        Effect.andThen((line) => Effect.die(`pi sent an unexpected command: ${line}`)),
      ),
    )

    assert.deepStrictEqual(script.submitted.toSorted(), [...readTypes].toSorted())

    yield* Deferred.succeed(script.release.get_available_models, undefined)
    yield* Deferred.succeed(script.release.get_state, undefined)
    assert.deepStrictEqual(yield* Fiber.join(pending), expectedModels)
  }).pipe(Effect.provide(NodeServices.layer)),
)
