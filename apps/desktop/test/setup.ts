import { configure } from "@testing-library/react"

configure({ asyncUtilTimeout: 25_000 })

if ("document" in globalThis && !("startViewTransition" in document))
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (options: StartViewTransitionOptions) => {
      const updateCallbackDone = Promise.resolve().then(() => options.update?.())
      const finished = updateCallbackDone.then(() => undefined)

      return {
        updateCallbackDone,
        ready: finished,
        finished,
        skipTransition: () => {},
        types: new Set(),
      }
    },
  })

if (!("requestIdleCallback" in globalThis)) {
  globalThis.requestIdleCallback = (callback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }))
  globalThis.cancelIdleCallback = (handle) => window.clearTimeout(handle)
}
