import { expect, it } from "vite-plus/test"
import { htmlPages } from "./htmlPages"

it("serves an open page sandboxed, and nothing once it closes", async () => {
  const pages = htmlPages()
  const url = pages.open("<h1>Hi</h1>")

  const served = pages.serve(new Request(url))

  expect(await served.text()).toBe("<h1>Hi</h1>")
  expect(served.headers.get("content-security-policy")).toBe(
    "sandbox allow-scripts allow-forms allow-popups",
  )

  pages.close(url)

  expect(pages.serve(new Request(url)).status).toBe(404)
})
