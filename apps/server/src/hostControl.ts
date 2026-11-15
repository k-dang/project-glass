import { Duration } from "effect"

// StartTurn and StopTurn return when the Agent host accepts them, not when the
// model finishes. Thirty seconds covers a slow Sandbox round trip. Past that,
// one host must not keep its conversation's lock. Sandbox provider calls can
// share this bound.
export const HOST_CONTROL_DEADLINE = Duration.seconds(30)

export const HOST_DIDNT_ANSWER =
  "The process that runs Agents took too long to answer. Try again."
