// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { AtomRegistry } from "effect/reactivity"
import type { PropsWithChildren } from "react"
import type { Theme } from "@glass/contracts"
import type { DetachedWindowAPI } from "happy-dom"
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { savedTheme, useTheme } from "./theme"

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

it("keeps native appearance and mounted consumers aligned with the saved theme", () => {
  const nativeThemes: Array<Theme> = []
  vi.stubGlobal("glass", {
    setTheme: async (theme: Theme) => {
      nativeThemes.push(theme)

      return "light"
    },
  })
  void stubViewTransitions()

  const settings = renderHook(useTheme, { wrapper })
  const observer = renderHook(useTheme, { wrapper })

  act(() => settings.result.current.setTheme("charcoal"))

  expect(settings.result.current.theme).toBe("charcoal")
  expect(observer.result.current.theme).toBe("charcoal")
  expect(document.documentElement.dataset.theme).toBe("charcoal")
  expect(savedTheme()).toBe("charcoal")

  settings.unmount()
  const reopened = renderHook(useTheme, { wrapper })
  expect(reopened.result.current.theme).toBe("charcoal")

  act(() => reopened.result.current.setTheme("system"))

  expect(observer.result.current.theme).toBe("system")
  expect(document.documentElement.dataset.theme).toBe("system")
  expect(savedTheme()).toBe("system")
  expect(nativeThemes).toEqual(["charcoal", "system"])
})

it("finishes a theme transition only once the window's color scheme follows", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("glass", { setTheme: async () => "dark" })
  const updates = stubViewTransitions()
  const { result } = renderHook(useTheme, { wrapper })

  act(() => result.current.setTheme("dark"))
  let finished = false
  void updates[0]!.then(() => (finished = true))
  await vi.advanceTimersByTimeAsync(0)

  expect(finished).toBe(false)

  window.happyDOM.settings.device.prefersColorScheme = "dark"
  window.dispatchEvent(new Event("resize"))
  await vi.advanceTimersByTimeAsync(0)

  expect(finished).toBe(true)
})

it("uses the system appearance when the saved theme is missing or unrecognized", () => {
  expect(savedTheme()).toBe("system")
  localStorage.setItem("glass.theme", "unknown-theme")
  expect(savedTheme()).toBe("system")
})
