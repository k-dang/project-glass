// @vitest-environment happy-dom
import {
  VISUALIZATION_THEME_PARAM,
  visualizationBootstrap,
  VisualizationLinkOpened,
  VisualizationSized,
} from "@glass/contracts"
import { waitFor } from "@testing-library/react"
import { expect, it } from "vite-plus/test"

it("themes the page from its address, and tells Glass its height and clicked links", async () => {
  document.head.innerHTML = `<style id="theme"></style>`
  document.body.innerHTML = `<a href="https://example.com/report">Report</a>`
  location.hash = `#${VISUALIZATION_THEME_PARAM}=${encodeURIComponent(JSON.stringify({ "--background": "red; color: blue", "not-a-variable": "x" }))}`

  const sent: Array<unknown> = []
  window.addEventListener("message", (event) => sent.push(event.data))

  visualizationBootstrap(window, {
    styleId: "theme",
    baseCss: "body{margin:0}",
    themeParam: VISUALIZATION_THEME_PARAM,
    sizedTag: "VisualizationSized",
    linkOpenedTag: "VisualizationLinkOpened",
  })

  const theme = document.getElementById("theme")
  expect(theme?.textContent).toBe(":root{--background:red color: blue;}body{margin:0}")

  window.dispatchEvent(new Event("load"))
  document.querySelector("a")?.click()

  await waitFor(() =>
    expect(sent).toEqual(
      expect.arrayContaining([
        VisualizationSized.make({ height: 0 }),
        VisualizationLinkOpened.make({ url: "https://example.com/report" }),
      ]),
    ),
  )
})
