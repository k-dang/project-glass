import { FilePage, WebPage } from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import { addressOf, isLoopback, pageOf, threadFileAddress } from "./browserAddress"

it("reads what the user typed as an address, plain http only for this device", () => {
  expect(addressOf("localhost:3000/settings")).toBe("http://localhost:3000/settings")
  expect(addressOf("127.0.0.1:5173")).toBe("http://127.0.0.1:5173/")
  expect(addressOf("app.localhost")).toBe("http://app.localhost/")
  expect(addressOf("[::1]:3000")).toBe("http://[::1]:3000/")
  expect(addressOf("example.com/docs")).toBe("https://example.com/docs")
  expect(addressOf(" http://example.com ")).toBe("http://example.com/")
  expect(addressOf("about:blank")).toBe("about:blank")
  expect(addressOf("file:///C:/Users/me/.ssh/id_rsa")).toBeNull()
  expect(addressOf("javascript:alert(1)")).toBeNull()
  expect(addressOf("how do I")).toBeNull()
  expect(addressOf("")).toBeNull()
})

it("counts only http addresses on this device as loopback", () => {
  expect(isLoopback("http://localhost:3000/")).toBe(true)
  expect(isLoopback("https://127.0.0.1/")).toBe(true)
  expect(isLoopback("http://127.1.2.3:8080/")).toBe(true)
  expect(isLoopback("http://[::1]:8080/")).toBe(true)
  expect(isLoopback("http://api.localhost/")).toBe(true)
  expect(isLoopback("http://localhost.:3000/")).toBe(true)
  expect(isLoopback("http://[::ffff:127.0.0.1]/")).toBe(true)
  expect(isLoopback("http://0.0.0.0:8080/")).toBe(true)
  expect(isLoopback("https://localhost.example.com/")).toBe(false)
  expect(isLoopback("glass-file://thread-1/index.html")).toBe(false)
})

it("names a page by its file path in this Thread's folder, or by its address without the fragment", () => {
  expect(pageOf("thread-1", threadFileAddress("thread-1", "docs\\my plan.html"))).toEqual(
    FilePage.make({ path: "docs/my plan.html" }),
  )
  expect(pageOf("thread-1", threadFileAddress("thread-2", "docs/plan.html"))).toBeNull()
  expect(pageOf("thread-1", "http://localhost:3000/settings#billing")).toEqual(
    WebPage.make({ url: "http://localhost:3000/settings" }),
  )
  expect(pageOf("thread-1", "about:blank")).toBeNull()
})
