// @vitest-environment happy-dom
import { localPlace, SandboxPlace, type ThreadPlace } from "@glass/contracts"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vite-plus/test"
import { backendLayerAtom } from "./backend"
import { browserPolicyOf } from "./browserAddress"
import { holdBrowserPage } from "./browserPages"
import { BrowserPane } from "./BrowserPane"
import { testLayer } from "../../test/testBackend"
import { RegistryProvider } from "../../test/registry"

const browserPane = (threadId: string, place: ThreadPlace, address: string) => {
  const page = holdBrowserPage(threadId, "pane", "test")
  let url = "about:blank"

  const navigate = (next: string) => {
    url = next
    page.dispatchEvent(Object.assign(new Event("did-navigate"), { url: next }))
  }

  Object.assign(page, {
    loadURL: async (next: string) => navigate(next),
    getURL: () => url,
    getTitle: () => "",
    canGoBack: () => false,
    canGoForward: () => false,
    send: () => undefined,
  })

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, testLayer({})]]}>
      <BrowserPane
        threadId={threadId}
        policy={browserPolicyOf(place)}
        opening={{ address, seq: 0 }}
        lastEnded={null}
        onClose={() => undefined}
      />
    </RegistryProvider>,
  )

  page.dispatchEvent(new Event("dom-ready"))

  return { agentNavigates: (next: string) => act(() => navigate(next)) }
}

const addressBar = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Address" })

const pickElement = () => screen.getByRole<HTMLButtonElement>("button", { name: "Pick element" })

it("turns Pick element off when you open an address the pane blocks", async () => {
  browserPane("thread-pick", SandboxPlace.make({ providerId: "upstash" }), "https://example.com/")
  const user = userEvent.setup()

  await waitFor(() => expect(pickElement().disabled).toBe(false))
  await user.click(pickElement())
  await user.clear(addressBar())
  await user.type(addressBar(), "localhost:3000{Enter}")

  expect(screen.queryByText(/would open this device's, not the Sandbox's/)).not.toBeNull()
  expect(pickElement().getAttribute("aria-pressed")).toBe("false")
})

it("keeps what you are typing in the address bar while the agent navigates", async () => {
  const pane = browserPane("thread-typing", localPlace, "http://localhost:3000/")
  const user = userEvent.setup()

  await waitFor(() => expect(pickElement().disabled).toBe(false))
  await user.clear(addressBar())
  await user.type(addressBar(), "localhost:51")
  pane.agentNavigates("http://localhost:3000/settings")

  expect(addressBar().value).toBe("localhost:51")

  await user.click(pickElement())

  expect(addressBar().value).toBe("http://localhost:3000/settings")
})
