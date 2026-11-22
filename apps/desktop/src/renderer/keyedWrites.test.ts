import { Effect } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { expect, it, vi } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { Backend, backendRuntime } from "./backend"
import { createKeyedWrites } from "./keyedWrites"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"

it("lets a write finish after its store is disposed, then releases its atom state", async () => {
  const calls: Array<Held<{ reviewThreadId: string; resolved: boolean }, boolean, never>> = []
  const finished = vi.fn<() => void>()
  const interrupted = vi.fn<() => void>()

  const registry = testRegistry({
    SetReviewThreadResolved: (payload) =>
      hold(calls)(payload).pipe(
        Effect.tap(() => Effect.sync(finished)),
        Effect.onInterrupt(() => Effect.sync(interrupted)),
      ),
  })

  try {
    await Effect.runPromise(AtomRegistry.getResult(registry, backendRuntime))
    const baseline = registry.getNodes().size

    const writes = createKeyedWrites(registry, (reviewThreadId, resolved: boolean) =>
      Backend.use((backend) => backend.SetReviewThreadResolved({ reviewThreadId, resolved })),
    )

    writes.set("T1", true)
    const call = await next(calls)
    writes.dispose()
    await Promise.resolve()

    expect(interrupted).not.toHaveBeenCalled()
    call.answer(Effect.succeed(true))

    await eventually(() => expect(finished).toHaveBeenCalledOnce())
    await eventually(() => expect(registry.getNodes().size).toBe(baseline))
  } finally {
    registry.dispose()
  }
})
