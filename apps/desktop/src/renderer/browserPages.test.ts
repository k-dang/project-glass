// @vitest-environment happy-dom
import { BROWSER_PARTITION } from "@glass/contracts/desktop"
import { expect, it } from "vite-plus/test"
import { holdBrowserPage, releaseBrowserPage, remembered } from "./browserPages"

it("remembers the last address of a page the agent drives with no Browser pane showing it", () => {
  const page = holdBrowserPage("thread-away", "agent", BROWSER_PARTITION)

  page.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "http://localhost:3000/" }))
  page.dispatchEvent(
    Object.assign(new Event("did-navigate-in-page"), {
      url: "http://localhost:3000/#billing",
      isMainFrame: true,
    }),
  )
  page.dispatchEvent(
    Object.assign(new Event("did-navigate-in-page"), {
      url: "http://localhost:3000/frame#inner",
      isMainFrame: false,
    }),
  )
  releaseBrowserPage("thread-away", "agent")

  expect(remembered("thread-away")).toBe("http://localhost:3000/#billing")
})
