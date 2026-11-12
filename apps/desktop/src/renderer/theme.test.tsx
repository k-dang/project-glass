// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { AtomRegistry } from "effect/reactivity"
import type { PropsWithChildren } from "react"
import type { Appearance } from "@glass/contracts"
import type { DetachedWindowAPI } from "happy-dom"
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { savedAppearance, useAppearance } from "./theme"

declare global {
  interface Window {
    readonly happyDOM: DetachedWindowAPI
  }
}

let registry = AtomRegistry.make()

const wrapper = ({ children }: PropsWithChildren) => (
  <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
)

const stubViewTransitions = () => {
  const updates: Array<Promise<void>> = []

  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: ({ update }: { update: () => Promise<void> }) => {
      updates.push(update())
    },
  })

  return updates
}

afterEach(() => {
  cleanup()
  registry.dispose()
  registry = AtomRegistry.make()
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, "startViewTransition")
  window.happyDOM.settings.device.prefersColorScheme = "light"
  vi.useRealTimers()
})

it("keeps native appearance and mounted consumers aligned with the saved appearance", () => {
  const nativeAppearances: Array<Appearance> = []
  vi.stubGlobal("glass", {
    setAppearance: async (appearance: Appearance) => {
      nativeAppearances.push(appearance)

      return "light"
    },
  })
  void stubViewTransitions()

  const settings = renderHook(useAppearance, { wrapper })
  const observer = renderHook(useAppearance, { wrapper })

  act(() => settings.result.current.setTheme("charcoal"))

  expect(observer.result.current.theme).toBe("charcoal")
  expect(document.documentElement.dataset.theme).toBe("charcoal")
  expect(savedAppearance()).toEqual({ theme: "charcoal", colorScheme: "system" })

  act(() => settings.result.current.setColorScheme("dark"))

  expect(observer.result.current).toMatchObject({ theme: "charcoal", colorScheme: "dark" })

  settings.unmount()
  const reopened = renderHook(useAppearance, { wrapper })
  expect(reopened.result.current).toMatchObject({ theme: "charcoal", colorScheme: "dark" })
  expect(nativeAppearances).toEqual([
    { theme: "charcoal", colorScheme: "system" },
    { theme: "charcoal", colorScheme: "dark" },
  ])
})

it("finishes an appearance transition only once the window's color scheme follows", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("glass", { setAppearance: async () => "dark" })
  const updates = stubViewTransitions()
  const { result } = renderHook(useAppearance, { wrapper })

  act(() => result.current.setColorScheme("dark"))
  let finished = false
  void updates[0]!.then(() => (finished = true))
  await vi.advanceTimersByTimeAsync(0)

  expect(finished).toBe(false)

  window.happyDOM.settings.device.prefersColorScheme = "dark"
  window.dispatchEvent(new Event("resize"))
  await vi.advanceTimersByTimeAsync(0)

  expect(finished).toBe(true)
})

it("uses the Glass theme and the system color scheme when nothing valid is saved", () => {
  expect(savedAppearance()).toEqual({ theme: "glass", colorScheme: "system" })
  localStorage.setItem("glass.theme", "catppuccin-mocha")
  localStorage.setItem("glass.colorScheme", "sepia")
  expect(savedAppearance()).toEqual({ theme: "glass", colorScheme: "system" })
})
