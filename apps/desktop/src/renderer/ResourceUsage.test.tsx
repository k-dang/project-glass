// @vitest-environment happy-dom
import type { ResourceUsage } from "@glass/contracts/desktop"
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { ResourceUsage as ResourceUsageFooter, useResourceUsage } from "./ResourceUsage"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it("serializes samples, retries after failure, and stops even with a request in flight", async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<ResourceUsage>()
  const last = Promise.withResolvers<ResourceUsage>()
  const sample: ResourceUsage = { cpuPercent: 2, memoryBytes: 248 * 1024 ** 2, processes: [] }

  const resourceUsage = vi
    .fn<() => Promise<ResourceUsage>>()
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(new Error("IPC unavailable"))
    .mockReturnValueOnce(last.promise)

  vi.stubGlobal("glass", { resourceUsage })
  const hook = renderHook(useResourceUsage)

  await act(() => vi.advanceTimersByTimeAsync(10000))
  expect(resourceUsage).toHaveBeenCalledTimes(1)

  await act(async () => {
    first.resolve(sample)
    await first.promise
  })
  expect(hook.result.current).toEqual(sample)
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(hook.result.current).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(resourceUsage).toHaveBeenCalledTimes(3)

  hook.unmount()
  await act(async () => {
    last.resolve(sample)
    await last.promise
  })
  await vi.advanceTimersByTimeAsync(10000)
  expect(resourceUsage).toHaveBeenCalledTimes(3)
})

it("shows the latest reading in the footer and per process in the popover", async () => {
  const sample: ResourceUsage = {
    cpuPercent: 2.5,
    memoryBytes: 1.5 * 1024 ** 3,
    processes: [{ name: "Backend", cpuPercent: 1, memoryBytes: 248 * 1024 ** 2 }],
  }

  vi.stubGlobal("glass", { resourceUsage: () => Promise.resolve(sample) })
  render(<ResourceUsageFooter />)

  const button = screen.getByRole("button", { name: "Show Glass resource usage" })
  await vi.waitFor(() =>
    expect(button.getAttribute("aria-description")).toBe("CPU 2.5%, RAM 1.5 GB"),
  )
  fireEvent.click(button)
  const backend = await screen.findByRole("row", { name: /^Backend / })
  expect(
    within(backend)
      .getAllByRole("cell")
      .map(({ textContent }) => textContent),
  ).toEqual(["1%", "248 MB"])
})
