import { type ConnectionError, GitHubUnavailable, Revision, StaleRevision } from "@glass/contracts"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"
import { ViewedFilesStore } from "./useViewedFiles"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"

const revision = new Revision({ base: "b0", head: "h1" })

const viewedStore = () => {
  const calls: Array<
    Held<
      { pullRequestId: string; revision: Revision; path: string; viewed: boolean },
      void,
      StaleRevision | ConnectionError
    >
  > = []

  const registry = testRegistry({ SetFileViewed: hold(calls) })

  const store = new ViewedFilesStore(
    { pullRequest: { id: "PR_1" }, revision, viewedPaths: ["already.ts"] },
    registry,
  )

  return { store, calls, registry }
}

describe("ViewedFilesStore", () => {
  it("updates immediately during a save and coalesces rapid toggles into the latest choice", async () => {
    const { store, calls, registry } = viewedStore()

    store.set("new.ts", true)
    const call = await next(calls)

    store.set("new.ts", false)
    store.set("new.ts", true)
    store.set("new.ts", false)

    expect(store.snapshot().viewed).toEqual(new Set(["already.ts"]))
    expect(calls).toHaveLength(0)
    expect(call.payload).toEqual({ pullRequestId: "PR_1", revision, path: "new.ts", viewed: true })
    call.answer(Effect.void)

    const latest = await next(calls)

    expect(latest.payload).toMatchObject({ path: "new.ts", viewed: false })
    latest.answer(Effect.void)

    await vi.waitFor(() => expect(store.snapshot().saving.size).toBe(0))
    expect(calls).toHaveLength(0)
    registry.dispose()
  })

  it("keeps the latest choice when an earlier write fails and can retry it if both writes fail", async () => {
    const { store, calls, registry } = viewedStore()

    store.set("new.ts", true)
    const earlier = await next(calls)

    store.set("new.ts", false)
    earlier.answer(Effect.fail(new GitHubUnavailable({ message: "Offline" })))
    const latest = await next(calls)

    expect(latest.payload.viewed).toBe(false)
    expect(store.snapshot().viewed.has("new.ts")).toBe(false)
    expect(store.snapshot().failures.size).toBe(0)
    latest.answer(Effect.fail(new GitHubUnavailable({ message: "Offline" })))

    await vi.waitFor(() => expect(store.snapshot().failures.has("new.ts")).toBe(true))
    store.retry("new.ts")
    const retry = await next(calls)

    expect(retry.payload.viewed).toBe(false)
    retry.answer(Effect.void)

    await vi.waitFor(() => expect(store.snapshot().saving.size).toBe(0))
    expect(store.snapshot().viewed.has("new.ts")).toBe(false)
    expect(store.snapshot().failures.size).toBe(0)
    registry.dispose()
  })

  it("restores the last confirmed choice if a queued write fails and retries the latest choice", async () => {
    const { store, calls, registry } = viewedStore()

    store.set("new.ts", true)
    const earlier = await next(calls)

    store.set("new.ts", false)
    earlier.answer(Effect.void)
    const latest = await next(calls)

    latest.answer(Effect.fail(new GitHubUnavailable({ message: "Offline" })))
    await vi.waitFor(() => expect(store.snapshot().failures.has("new.ts")).toBe(true))
    expect(store.snapshot().viewed.has("new.ts")).toBe(true)

    store.retry("new.ts")
    const retry = await next(calls)

    expect(retry.payload.viewed).toBe(false)
    retry.answer(Effect.void)

    await vi.waitFor(() => expect(store.snapshot().saving.size).toBe(0))
    expect(store.snapshot().viewed.has("new.ts")).toBe(false)
    expect(store.snapshot().failures.size).toBe(0)
    registry.dispose()
  })

  it("rolls back only the failed file and retries the intended value", async () => {
    const { store, calls, registry } = viewedStore()

    store.set("already.ts", false)
    const failing = await next(calls)

    store.set("other.ts", true)
    const other = await next(calls)

    other.answer(Effect.void)
    failing.answer(Effect.fail(new GitHubUnavailable({ message: "Offline" })))

    await vi.waitFor(() => expect(store.snapshot().failures.has("already.ts")).toBe(true))
    expect(store.snapshot().viewed).toEqual(new Set(["already.ts", "other.ts"]))

    store.retry("already.ts")
    const retry = await next(calls)

    expect(retry.payload.viewed).toBe(false)
    retry.answer(Effect.void)

    await vi.waitFor(() => expect(store.snapshot().saving.size).toBe(0))
    expect(store.snapshot().failures.size).toBe(0)
    expect(store.snapshot().viewed).toEqual(new Set(["other.ts"]))
    registry.dispose()
  })

  it("retains concurrent failures until each file is retried successfully", async () => {
    const { store, calls, registry } = viewedStore()

    store.set("a.ts", true)
    store.set("b.ts", true)

    const a = await next(calls)
    const b = await next(calls)
    const offline = Effect.fail(new GitHubUnavailable({ message: "Offline" }))

    a.answer(offline)
    b.answer(offline)

    await vi.waitFor(() => expect(store.snapshot().failures.size).toBe(2))
    expect(store.snapshot().viewed).toEqual(new Set(["already.ts"]))

    store.retry("a.ts")
    const retryA = await next(calls)

    expect(retryA.payload).toMatchObject({ path: "a.ts", viewed: true })
    expect([...store.snapshot().failures.keys()]).toEqual(["b.ts"])
    retryA.answer(Effect.void)

    await vi.waitFor(() => expect(store.snapshot().saving.size).toBe(0))
    expect([...store.snapshot().failures.keys()]).toEqual(["b.ts"])

    store.retry("b.ts")
    const retryB = await next(calls)

    expect(retryB.payload).toMatchObject({ path: "b.ts", viewed: true })
    retryB.answer(Effect.void)

    await vi.waitFor(() => expect(store.snapshot().saving.size).toBe(0))
    expect(store.snapshot().failures.size).toBe(0)
    expect(store.snapshot().viewed).toEqual(new Set(["already.ts", "a.ts", "b.ts"]))
    registry.dispose()
  })

  it("waits for in-flight writes before reload and blocks further toggles while locked", async () => {
    const { store, calls, registry } = viewedStore()

    store.set("new.ts", true)
    const call = await next(calls)

    store.set("new.ts", false)
    const finished = vi.fn<() => void>()
    const locking = store.lock().then(finished)

    store.set("ignored.ts", true)

    expect(finished).not.toHaveBeenCalled()
    expect(store.snapshot().locked).toBe(true)
    expect(store.snapshot().viewed.has("ignored.ts")).toBe(false)

    call.answer(Effect.void)
    const latest = await next(calls)

    expect(finished).not.toHaveBeenCalled()
    expect(latest.payload.viewed).toBe(false)
    latest.answer(Effect.void)
    await locking
    store.unlock()

    expect(store.snapshot().viewed.has("new.ts")).toBe(false)
    expect(store.snapshot().locked).toBe(false)
    registry.dispose()
  })
})
