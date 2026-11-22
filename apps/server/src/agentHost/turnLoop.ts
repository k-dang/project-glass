import {
  type AgentEvent,
  type BackgroundWork,
  BackgroundWorkEnded,
  type TurnFailed,
  type TurnMessage,
  TurnStarted,
  type TurnStopped,
} from "@glass/contracts"
import type { DeliveredMessage } from "./deliveredMessage"
import { type Cause, DateTime, Deferred, Effect, Queue, Scope, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { HostThreadError } from "./protocol"

export interface Steer extends DeliveredMessage {
  readonly id: string
}

export type StopEnding = typeof TurnStopped.Type | typeof TurnFailed.Type

export interface Steering {
  readonly steers: ReadonlyArray<Steer>
  readonly stopping: StopEnding | null
  readonly turn: { readonly id: string }
}

export interface TurnMachine<State extends Steering, Input, Command> {
  readonly step: (
    state: State | null,
    input: Input,
    now: DateTime.Utc,
  ) => {
    readonly state: State | null
    readonly events: ReadonlyArray<AgentEvent>
    readonly commands?: ReadonlyArray<Command>
  }
  readonly begin: (turnId: string, message: TurnMessage, at: DateTime.Utc) => State
  readonly startsRun: (input: Input) => boolean
  readonly endsBackgroundWork?: (input: Input) => BackgroundWork | null
  readonly exitInput: Input
  readonly stoppedReason: string
}

export const runTurns = Effect.fnUntraced(function* <
  State extends Steering,
  Input,
  Command,
  E,
>(options: {
  readonly harness: string
  readonly machine: TurnMachine<State, Input, Command>
  readonly events: Stream.Stream<Input, E>
  readonly report: (event: AgentEvent) => Effect.Effect<void>
  readonly run?: (
    command: Command,
    offer: (input: Input) => Effect.Effect<void>,
  ) => Effect.Effect<void>
}) {
  const { machine, report, run } = options
  const scope = yield* Scope.Scope
  const inputs = yield* Queue.unbounded<Input, Cause.Done>()
  const closed = yield* Deferred.make<void>()
  let state: State | null = null
  let exited = false
  let endedWhileIdle: Array<BackgroundWork> = []

  const offer = (input: Input) => Queue.offer(inputs, input).pipe(Effect.asVoid)

  const handle = Effect.fnUntraced(function* (input: Input) {
    const now = yield* DateTime.now

    const work = state === null ? (machine.endsBackgroundWork?.(input) ?? null) : null

    if (work !== null) endedWhileIdle.push(work)

    if (state === null && machine.startsRun(input)) {
      const [first, ...rest] = endedWhileIdle

      const unprompted = {
        message: "",
        images: [],
        context: first === undefined ? null : BackgroundWorkEnded.make({ work: [first, ...rest] }),
      }

      endedWhileIdle = []
      state = machine.begin(randomUUID(), unprompted, now)
      yield* report(
        TurnStarted.make({ turnId: state.turn.id, ...unprompted, feedback: [], sentAt: now }),
      )
    }

    const next = machine.step(state, input, now)
    state = next.state
    yield* Effect.forEach(next.events, report, { discard: true })

    if (run !== undefined)
      yield* Effect.forEach(next.commands ?? [], (command) => run(command, offer), {
        discard: true,
      })
  })

  yield* options.events.pipe(
    Stream.runForEach((input) => Queue.offer(inputs, input)),
    Effect.catchCause((cause) => Effect.logWarning(`${options.harness} stopped`, cause)),
    Effect.andThen(
      Effect.sync(() => {
        exited = true
      }),
    ),
    Effect.andThen(Queue.offer(inputs, machine.exitInput)),
    Effect.andThen(Queue.end(inputs)),
    Effect.forkIn(scope),
  )

  yield* Stream.fromQueue(inputs).pipe(
    Stream.runForEach(handle),
    Effect.andThen(Deferred.succeed(closed, undefined)),
    Effect.forkIn(scope),
  )

  return {
    closed: Deferred.await(closed),
    stopped: Effect.sync(() => exited),
    steer: (steer: Steer) =>
      Effect.sync(() => {
        if (state === null || state.stopping !== null) return false
        state = { ...state, steers: [...state.steers, steer] }

        return true
      }),
    dropSteer: (id: string) =>
      Effect.sync(() => {
        if (state === null) return false

        const kept = state.steers.filter((steer) => steer.id !== id)
        const dropped = kept.length < state.steers.length
        state = { ...state, steers: kept }

        return dropped
      }),
    stop: (turnId: string, ending: StopEnding) =>
      Effect.sync(() => {
        if (state === null || state.turn.id !== turnId) return null

        state = { ...state, stopping: ending }

        return state.steers
      }),
    offer,
    begin: Effect.fnUntraced(function* (turnId: string, message: TurnMessage) {
      const at = yield* DateTime.now

      if (exited) return yield* new HostThreadError({ message: machine.stoppedReason })

      if (state !== null)
        return yield* new HostThreadError({
          message: "The Thread is still working on a Turn.",
        })

      state = machine.begin(turnId, message, at)
      endedWhileIdle = []

      return undefined
    }),
  }
})
