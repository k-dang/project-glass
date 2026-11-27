import { Schema } from "effect"

export const burstCounter = (limit: number, windowMs: number) => {
  const windows = new Map<string, { start: number; count: number }>()

  return (key: string, atMs: number): boolean => {
    let current = windows.get(key)

    if (current === undefined || atMs - current.start >= windowMs) {
      for (const [other, { start }] of windows) if (atMs - start >= windowMs) windows.delete(other)

      current = { start: atMs, count: 0 }
      windows.set(key, current)
    }

    current.count++

    return current.count === limit
  }
}

// WARNING: backend.log takes these, so fields hold only names, IDs and counts, plus an error's own name, message and stack.
export const Remounting = Schema.TaggedStruct("Remounting", {
  component: Schema.String,
  key: Schema.NullOr(Schema.String),
  mounts: Schema.Int,
  windowMs: Schema.Int,
})

export const RendererError = Schema.TaggedStruct("RendererError", {
  kind: Schema.Literals(["error", "unhandledrejection"]),
  name: Schema.String,
  message: Schema.String,
  stack: Schema.NullOr(Schema.String),
})

export const RendererEvent = Schema.Union([Remounting, RendererError])

export type RendererEvent = typeof RendererEvent.Type
