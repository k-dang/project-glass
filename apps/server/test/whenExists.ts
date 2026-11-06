import { Effect } from "effect"
import { existsSync } from "node:fs"
import { eventually } from "./eventually.ts"

// Checks again until the file exists, since fs.watch can miss a file made just after it starts
// watching when the machine is busy, leaving the wait stuck.
export const whenExists = (path: string, signal?: AbortSignal) =>
  Effect.runPromise(
    eventually(Effect.suspend(() => (existsSync(path) ? Effect.void : Effect.fail(path)))),
    { signal },
  )
