// @vitest-environment happy-dom
import { AtomRegistry } from "effect/reactivity"
import { afterEach, expect, it } from "vite-plus/test"
import { defaultListSearch, listSearchAtom, targetAtom } from "./reviewsArea"
import { createAppRouter } from "./routes"

afterEach(() => {
  window.history.replaceState(null, "", "#/")
})

it("leaves the open list and PR alone when a link is only hovered", async () => {
  window.history.replaceState(null, "", "#/reviews")
  const registry = AtomRegistry.make()
  const router = createAppRouter(registry)
  await router.load()

  await router.preloadRoute({ to: "/reviews", search: { ...defaultListSearch, list: "queue" } })
  await router.preloadRoute({
    to: "/reviews/$owner/$repo/$number",
    params: { owner: "octo-org", repo: "glass", number: 42 },
  })

  expect(registry.get(listSearchAtom)).toEqual(defaultListSearch)
  expect(registry.get(targetAtom)).toBeNull()
})
