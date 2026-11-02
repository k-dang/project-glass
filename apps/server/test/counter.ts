import { Effect } from "effect"

export const counter = () => {
  let seen = 0
  const waiting = new Set<{ readonly count: number; readonly wake: () => void }>()

  return {
    add: () => {
      seen++

      for (const waiter of waiting)
        if (seen >= waiter.count) {
          waiting.delete(waiter)
          waiter.wake()
        }
    },
    reached: (count: number) =>
      Effect.callback<void>((resume) => {
        if (seen >= count) return resume(Effect.void)

        const waiter = { count, wake: () => resume(Effect.void) }
        waiting.add(waiter)

        return Effect.sync(() => waiting.delete(waiter))
      }),
  }
}
