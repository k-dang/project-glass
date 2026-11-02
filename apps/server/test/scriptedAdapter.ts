import {
  AgentModels,
  PartSet,
  PermissionRequestPart,
  type RequestPart,
  RequestNotWaiting,
  type SentMessage,
  SteerPart,
  TextPart,
  TurnDone,
  TurnEnded,
  type TurnEnding,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Deferred, Effect, Fiber, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, watch } from "node:fs"
import { join } from "node:path"
import type { AgentAdapter, AgentSession } from "../src/agentHost/adapter"
import { notRunning } from "../src/agentHost/protocol"
import { settleWith } from "../src/agentHost/requests"

const untilFile = (path: string) =>
  Effect.callback<void>((resume) => {
    if (existsSync(path)) return resume(Effect.void)

    const watcher = watch(join(path, ".."), () => {
      if (existsSync(path)) resume(Effect.void)
    })

    if (existsSync(path)) resume(Effect.void)

    return Effect.sync(() => watcher.close())
  })

interface Waiting {
  readonly part: RequestPart
  readonly index: number
  readonly answered: Deferred.Deferred<void>
}

/**
 * Runs each Turn the way its message says, for tests of Glass's own host:
 * `hold:<name>` says "Holding." and waits for the file `<name>` in `gates` before it takes in its
 * Steers; `ask permission` waits on a Permission request; every Turn ends replying to its message.
 */
export const scriptedAdapter = (gates: string): AgentAdapter => ({
  models: Effect.succeed(
    new AgentModels({
      defaultModel: null,
      models: [{ id: "scripted", name: "Scripted", efforts: [] }],
    }),
  ),
  start: ({ report }) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const closed = yield* Deferred.make<void>()

      let turn: {
        readonly id: string
        fiber: Fiber.Fiber<void> | null
        steers: Array<SentMessage>
        index: number
        waiting: Waiting | null
      } | null = null

      const part = (turnId: string, set: typeof PartSet.Type.part) =>
        Effect.suspend(() => {
          const index = turn!.index++

          return report(PartSet.make({ turnId, index, part: set })).pipe(Effect.as(index))
        })

      const end = (turnId: string, ending: TurnEnding) =>
        Effect.gen(function* () {
          turn = null
          yield* report(TurnEnded.make({ turnId, ended: { at: yield* DateTime.now, ending } }))
        })

      const run = (turnId: string, { message }: SentMessage) =>
        Effect.gen(function* () {
          const hold = /^hold:(\S+)/.exec(message)?.[1]

          if (hold !== undefined) {
            yield* part(turnId, TextPart.make({ text: "Holding." }))
            yield* untilFile(join(gates, hold))

            for (const steer of turn!.steers.splice(0)) {
              yield* part(turnId, SteerPart.make(steer))
              yield* part(turnId, TextPart.make({ text: `Reply to: ${steer.message}` }))
            }
          }

          if (/ask permission/i.test(message)) {
            const request = PermissionRequestPart.make({
              requestId: randomUUID(),
              toolName: "Bash",
              inputSummary: "touch notes.txt",
              input: JSON.stringify({ command: "touch notes.txt" }),
              status: "waiting",
              reason: null,
            })

            const answered = yield* Deferred.make<void>()
            const index = yield* part(turnId, request)
            turn!.waiting = { part: request, index, answered }
            yield* Deferred.await(answered)
          }

          yield* part(turnId, TextPart.make({ text: `Reply to: ${message}` }))
          yield* end(turnId, TurnDone.make({}))
        })

      return {
        configure: () => Effect.void,
        startTurn: (turnId, message) =>
          Effect.gen(function* () {
            turn = { id: turnId, fiber: null, steers: [], index: 0, waiting: null }
            turn.fiber = yield* run(turnId, message).pipe(Effect.forkIn(scope))
          }),
        steer: (message) =>
          turn === null ? notRunning : Effect.sync(() => void turn!.steers.push(message)),
        stopTurn: Effect.gen(function* () {
          if (turn === null) return null

          const { id, fiber, steers } = turn

          if (fiber !== null) yield* Fiber.interrupt(fiber)
          yield* end(id, TurnStopped.make({}))

          return steers
        }),
        answer: (requestId, answer) =>
          Effect.gen(function* () {
            const waiting = turn?.waiting

            if (waiting == null || waiting.part.requestId !== requestId)
              return yield* new RequestNotWaiting()

            const settled = yield* settleWith(waiting.part, answer)
            turn!.waiting = null
            yield* report(PartSet.make({ turnId: turn!.id, index: waiting.index, part: settled }))
            yield* Deferred.succeed(waiting.answered, undefined)

            return undefined
          }),
        closed: Deferred.await(closed),
        stopped: Effect.succeed(false),
      } satisfies AgentSession
    }),
})
