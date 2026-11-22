import { Effect, Semaphore } from "effect"

interface KeyedLock {
  readonly withLock: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly activeKeys: Effect.Effect<ReadonlyArray<string>>
}

export const keyedLock = (): KeyedLock => {
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  const acquire = (key: string) =>
    Effect.sync(() => {
      const lock = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }

      lock.users += 1
      locks.set(key, lock)

      return lock
    })

  const release = (key: string, lock: { users: number }) =>
    Effect.sync(() => {
      lock.users -= 1

      if (lock.users === 0) locks.delete(key)
    })

  return {
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        acquire(key),
        (lock) => lock.semaphore.withPermit(effect),
        (lock) => release(key, lock),
      ),
    activeKeys: Effect.sync(() => Array.from(locks.keys())),
  }
}
