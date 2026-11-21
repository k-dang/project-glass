import { Effect, Predicate } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hostRecordPath } from "../src/agentHost/hostAddress"
import { eventually } from "./eventually"

export const hostPidPath = (hostRecord: string) => `${hostRecord}.pid`

export const runningHost = (home: string) =>
  Number(readFileSync(hostPidPath(hostRecordPath(join(home, ".project-glass"))), "utf8"))

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    if (Predicate.hasProperty(error, "code") && error.code === "ESRCH") return false
    throw error
  }
}

export const hostExited = (pid: number) =>
  eventually(
    Effect.suspend(() =>
      isRunning(pid)
        ? Effect.fail(new Error(`The agent host ${pid} is still running`))
        : Effect.void,
    ),
  )
