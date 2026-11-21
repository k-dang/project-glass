import { ThreadError } from "@glass/contracts"
import { Duration, Effect } from "effect"

export const HOST_CONTROL_DEADLINE = Duration.seconds(30)

export const HOST_DIDNT_ANSWER = "The process that runs Threads took too long to answer. Try again."

export const boundHostCall = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  call.pipe(
    Effect.timeoutOrElse({
      duration: HOST_CONTROL_DEADLINE,
      orElse: () => Effect.fail(new ThreadError({ message: HOST_DIDNT_ANSWER })),
    }),
  )
