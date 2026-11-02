import { existsSync, watch } from "node:fs"
import { dirname } from "node:path"

/** Resolves once `path` exists, watching its folder rather than polling. */
export const whenExists = (path: string, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return
      watcher.close()
      resolve()
    })

    signal?.addEventListener("abort", () => watcher.close(), { once: true })

    if (existsSync(path)) {
      watcher.close()
      resolve()
    }
  })
