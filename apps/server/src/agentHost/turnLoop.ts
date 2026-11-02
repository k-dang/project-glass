import type { AgentEvent, SentMessage } from "@glass/contracts"
import { type Cause, DateTime, Deferred, Effect, Queue, Scope, Stream } from "effect"
import { HostAgentError } from "./protocol"

export interface Steer extends SentMessage {
  readonly id: string
}

export interface Steering {
  /** Steers sent to the program and not yet taken in, oldest first. */
  readonly steers: ReadonlyArray<Steer>
  /** The user stopped the Turn, so however the program finishes it, it ends stopped. */
  readonly stopping: boolean
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
  readonly begin: (turnId: string, message: SentMessage, at: DateTime.Utc) => State
  readonly exitInput: Input
  readonly stoppedReason: string
}

export const runTurns = Effect.fnUntraced(function* <
  State extends Steering,
  Input,
  Command,
  E,
>(options: {
  readonly program: string
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

  const offer = (input: Input) => Queue.offer(inputs, input).pipe(Effect.asVoid)

  const handle = Effect.fnUntraced(function* (input: Input) {
    const next = machine.step(state, input, yield* DateTime.now)
    state = next.state
    yield* Effect.forEach(next.events, report, { discard: true })

    if (run !== undefined)
      yield* Effect.forEach(next.commands ?? [], (command) => run(command, offer), {
        discard: true,
      })
  })

  yield* options.events.pipe(
    Stream.runForEach((input) => Queue.offer(inputs, input)),
    Effect.catchCause((cause) => Effect.logWarning(`${options.program} stopped`, cause)),
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
        if (state === null) return false
        state = { ...state, steers: [...state.steers, steer] }

        return true
      }),
    dropSteer: (id: string) =>
      Effect.sync(() => {
        if (state !== null)
          state = { ...state, steers: state.steers.filter((steer) => steer.id !== id) }
      }),
    /** Marks the running Turn stopping, answering its Steers not taken in, or `null` between Turns. */
    stop: Effect.sync(() => {
      if (state === null) return null
      state = { ...state, stopping: true }

      return state.steers
    }),
    offer,
    begin: Effect.fnUntraced(function* (turnId: string, message: SentMessage) {
      const at = yield* DateTime.now

      if (exited) return yield* new HostAgentError({ message: machine.stoppedReason })

      if (state !== null)
        return yield* new HostAgentError({ message: "The Agent is still working on a Turn." })

      state = machine.begin(turnId, message, at)

      return undefined
    }),
  }
})
