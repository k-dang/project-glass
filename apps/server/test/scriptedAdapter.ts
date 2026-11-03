import {
  AgentModels,
  PartSet,
  PermissionRequestPart,
  type RequestPart,
  RequestNotWaiting,
  type SentMessage,
  SteerPart,
  SUGGEST_DRAFT_TOOL,
  TextPart,
  ToolCallPart,
  TurnDone,
  TurnEnded,
  type TurnEnding,
  TurnStopped,
} from "@glass/contracts"
import { DateTime, Deferred, Effect, Fiber, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { AgentAdapter, AgentSession } from "../src/agentHost/adapter"
import { notRunning } from "../src/agentHost/protocol"
import { settleWith } from "../src/agentHost/requests"
import { placeSuggestedDraft } from "../src/agentHost/suggestDraftTool"
import { whenExists } from "./whenExists"

interface Waiting {
  readonly part: RequestPart
  readonly index: number
  readonly answered: Deferred.Deferred<void>
}

export const scriptedAdapter = (gates: string): AgentAdapter => ({
  models: Effect.succeed(
    new AgentModels({
      defaultModel: null,
      models: [{ id: "scripted", name: "Scripted", efforts: [] }],
    }),
  ),
  start: ({ folder, review, report }) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope

      let turn: {
        readonly id: string
        readonly fiber: Fiber.Fiber<void>
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
            yield* Effect.promise((signal) => whenExists(join(gates, hold), signal))

            for (const steer of turn!.steers.splice(0)) {
              yield* part(turnId, SteerPart.make({ message: steer.message, images: steer.images }))
              yield* part(turnId, TextPart.make({ text: `Reply to: ${steer.message}` }))
            }
          }

          const suggestion = /^suggest (new|old):(\S+):(\d+) (.+)$/.exec(message)

          if (suggestion !== null && review !== null) {
            const [, side, path, line, body] = suggestion

            const draft = {
              path: path!,
              side: side === "old" ? ("old" as const) : ("new" as const),
              line: Number(line),
              body: body!,
            }

            const { placed, text } = placeSuggestedDraft(review, draft)

            yield* part(
              turnId,
              ToolCallPart.make({
                toolCallId: randomUUID(),
                name: SUGGEST_DRAFT_TOOL,
                inputSummary: path!,
                input: JSON.stringify(draft),
                output: text,
                status: placed ? "done" : "failed",
                parentToolCallId: null,
              }),
            )
          }

          if (message === "show the review" && review !== null) {
            yield* part(turnId, TextPart.make({ text: review.instructions }))
            yield* part(turnId, TextPart.make({ text: readdirSync(folder).toSorted().join(",") }))
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
            const fiber = yield* run(turnId, message).pipe(Effect.forkIn(scope))
            turn = { id: turnId, fiber, steers: [], index: 0, waiting: null }
          }),
        steer: (message) =>
          turn === null ? notRunning : Effect.sync(() => void turn!.steers.push(message)),
        stopTurn: Effect.gen(function* () {
          if (turn === null) return null

          const { id, fiber, steers } = turn

          yield* Fiber.interrupt(fiber)
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
        closed: Effect.never,
        stopped: Effect.succeed(false),
      } satisfies AgentSession
    }),
})
