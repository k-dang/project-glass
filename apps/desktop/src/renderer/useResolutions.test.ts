import { Effect } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { expect, it, vi } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { backendRuntime } from "./backend"
import { createResolutions } from "./useResolutions"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"

it("lets a resolve finish after its workspace is evicted, then releases its atom state", async () => {
  const calls: Array<Held<{ discussionId: string; resolved: boolean }, boolean, never>> = []
  const finished = vi.fn<() => void>()
  const interrupted = vi.fn<() => void>()

  const registry = testRegistry({
    SetDiscussionResolved: (payload) =>
      hold(calls)(payload).pipe(
        Effect.tap(() => Effect.sync(finished)),
        Effect.onInterrupt(() => Effect.sync(interrupted)),
      ),
  })

  try {
    await Effect.runPromise(AtomRegistry.getResult(registry, backendRuntime))
    const baseline = registry.getNodes().size
    const resolutions = createResolutions(registry)

    resolutions.set("T1", true)
    const call = await next(calls)
    resolutions.dispose()
    await Promise.resolve()

    expect(interrupted).not.toHaveBeenCalled()
    call.answer(Effect.succeed(true))

    await eventually(() => expect(finished).toHaveBeenCalledOnce())
    await eventually(() => expect(registry.getNodes().size).toBe(baseline))
  } finally {
    registry.dispose()
  }
})
