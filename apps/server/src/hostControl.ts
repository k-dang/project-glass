import { Duration } from "effect"

export const HOST_CONTROL_DEADLINE = Duration.seconds(30)

export const HOST_DIDNT_ANSWER = "The process that runs Agents took too long to answer. Try again."
