import {
  type AgentEvent,
  answerRequest,
  expireRequest,
  isRequestPart,
  isWaiting,
  PartSet,
  type RequestAnswer,
  type RequestPart,
  type Turn,
} from "@glass/contracts"
import { Effect } from "effect"
import { HostAgentError } from "./protocol"

const settledEvent = (
  turn: Turn,
  requestId: string,
  settle: (part: RequestPart) => RequestPart | undefined,
): AgentEvent | undefined => {
  const index = turn.parts.findIndex((part) => isRequestPart(part) && part.requestId === requestId)
  const part = turn.parts[index]
  const settled = part !== undefined && isWaiting(part) ? settle(part) : undefined

  return settled === undefined ? undefined : PartSet.make({ turnId: turn.id, index, part: settled })
}

export const answeredEvent = (turn: Turn, requestId: string, answer: RequestAnswer) =>
  settledEvent(turn, requestId, (part) => answerRequest(part, answer))

export const expiredEvent = (turn: Turn, requestId: string) =>
  settledEvent(turn, requestId, expireRequest)

export const settleWith = (part: RequestPart, answer: RequestAnswer) =>
  Effect.suspend(() => {
    const settled = answerRequest(part, answer)

    return settled === undefined
      ? Effect.fail(new HostAgentError({ message: "That answer doesn't fit the request." }))
      : Effect.succeed(settled)
  })
