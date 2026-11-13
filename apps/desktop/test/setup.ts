import { configure } from "@testing-library/react"

configure({ asyncUtilTimeout: 25_000 })

// happy-dom has no View Transitions; run the update at once, as Chromium does without animating.
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
