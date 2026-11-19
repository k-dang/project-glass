import { Effect } from "effect"
import { existsSync } from "node:fs"
import { eventually } from "./eventually.ts"

// WARNING: fs.watch can miss a file made just after it starts watching on a busy machine, so this checks until it exists.
export const whenExists = (path: string, signal?: AbortSignal) =>
  Effect.runPromise(
    eventually(Effect.suspend(() => (existsSync(path) ? Effect.void : Effect.fail(path)))),
    { signal },
  )
