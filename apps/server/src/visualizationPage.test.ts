import { expect, it } from "vite-plus/test"
import { viewportHeightUnitIn, withBootstrap } from "./visualizationPage"

const bootstrapAt = (html: string) => withBootstrap(html).indexOf("<style id=")

it("puts the bootstrap in the page's real head, never inside a comment or script", () => {
  const html =
    "<!doctype html><!-- <head> --><html><head><script>'<head>'</script></head><body></body></html>"

  expect(bootstrapAt(html)).toBe(html.indexOf("<head><script>") + "<head>".length)
  expect(withBootstrap("<!doctype html><p>Hi</p>")).toMatch(
    /^<!doctype html><head><style id=.*<\/head><p>Hi<\/p>$/s,
  )
})

it("finds viewport height units only in the page's CSS", () => {
  expect(viewportHeightUnitIn("<style>main { min-height: 50dvh }</style>")).toBe("50dvh")
  expect(viewportHeightUnitIn(`<div style="height:100vh"></div>`)).toBe("100vh")
  expect(
    viewportHeightUnitIn(
      `<script>const h = "100vh"</script><img src="data:image/png;base64,ab1vh"><!-- <style>a{height:1vh}</style> -->`,
    ),
  ).toBeNull()
})
