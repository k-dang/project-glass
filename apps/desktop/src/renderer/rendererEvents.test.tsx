// @vitest-environment happy-dom
import { Remounting, type RendererEvent } from "@glass/contracts"
import { cleanup, render, waitFor } from "@testing-library/react"
import { Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { testLayer } from "../../test/testBackend"
import { RegistryProvider } from "../../test/registry"
import { backendLayerAtom } from "./backend"
import { REMOUNT_LIMIT, useMountWatch, useRendererEvents } from "./rendererEvents"

afterEach(cleanup)

function Watched(props: { threadId: string }) {
  useMountWatch("Watched", props.threadId)

  return null
}

function Reporter() {
  useRendererEvents()

  return null
}

const mountReporter = () => {
  const reported: Array<RendererEvent> = []

  const backend = testLayer({
    ReportRendererEvents: ({ events }) => Effect.sync(() => void reported.push(...events)),
  })

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <Reporter />
    </RegistryProvider>,
  )

  return reported
}

it("reports a view that keeps remounting, once, with its key", async () => {
  const reported = mountReporter()

  for (let mount = 0; mount < REMOUNT_LIMIT * 1.5; mount++)
    render(<Watched threadId="thread-1" />).unmount()

  render(<Watched threadId="thread-2" />)

  await waitFor(
    () =>
      expect(reported).toEqual([
        Remounting.make({
          component: "Watched",
          key: "thread-1",
          mounts: REMOUNT_LIMIT,
          windowMs: 5000,
        }),
      ]),
    { timeout: 10_000 },
  )
})

it("reports what the renderer throws with nothing to catch it", async () => {
  const reported = mountReporter()

  window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("x is undefined") }))

  await waitFor(
    () =>
      expect(reported).toMatchObject([
        { kind: "error", name: "TypeError", message: "x is undefined" },
      ]),
    { timeout: 10_000 },
  )
})
