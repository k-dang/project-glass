import {
  type AgentEvent,
  isRequestPart,
  isWaiting,
  PartSet,
  type RequestAnswer,
  type RequestPart,
  settleRequest,
  type Turn,
} from "@glass/contracts"
import { Effect } from "effect"
import { HostAgentError } from "./protocol"

/** The event that settles a request the Turn holds, if it still waits and the answer fits it. */
export const settledEvent = (
  turn: Turn,
  requestId: string,
  answer: RequestAnswer | null,
): AgentEvent | undefined => {
  const index = turn.parts.findIndex((part) => isRequestPart(part) && part.requestId === requestId)
  const part = turn.parts[index]
  const settled = part !== undefined && isWaiting(part) ? settleRequest(part, answer) : undefined

  return settled === undefined ? undefined : PartSet.make({ turnId: turn.id, index, part: settled })
}

/** The request as the answer settles it, failing when the answer doesn't fit it. */
export const settleWith = (part: RequestPart, answer: RequestAnswer) =>
  Effect.suspend(() => {
    const settled = settleRequest(part, answer)

    return settled === undefined
      ? Effect.fail(new HostAgentError({ message: "That answer doesn't fit the request." }))
      : Effect.succeed(settled)
  })
