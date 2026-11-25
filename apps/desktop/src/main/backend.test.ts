import { describe, expect, it } from "vite-plus/test"
import { threadFileUrl, visualizationUrl } from "./backend"
import { threadFileOf } from "./browserPanes"

const endpoint = { url: "ws://127.0.0.1:4000/rpc", token: "secret" }

const THREAD = "5633ec51-c031-4536-9a4e-a6663268a894"

const backendUrlOf = (address: string, initiator: { initiatorOrigin?: string } = {}) => {
  const file = threadFileOf(Object.assign(new Request(address), initiator))

  return file === null ? null : threadFileUrl(endpoint, "sandbox", file)
}

describe("a Thread file's backend URL", () => {
  it("names the pane's place, the Thread and each path segment", () => {
    expect(backendUrlOf(`glass-file://${THREAD}/docs/my%20plan/index.html`)).toBe(
      `http://127.0.0.1:4000/thread-files/sandbox/${THREAD}/docs/my%20plan/index.html?token=secret`,
    )
  })

  it("keeps the path inside the Thread's files", () => {
    expect([
      backendUrlOf(`glass-file://${THREAD}/a%2F..%2F..%2Fb`),
      backendUrlOf(`glass-file://${THREAD}/%2e%2e/%2E%2e/health`),
    ]).toEqual([
      `http://127.0.0.1:4000/thread-files/sandbox/${THREAD}/a%2F..%2F..%2Fb?token=secret`,
      `http://127.0.0.1:4000/thread-files/sandbox/${THREAD}/health?token=secret`,
    ])
  })

  it("serves a page only its own Thread's files", () => {
    expect([
      backendUrlOf(`glass-file://${THREAD}/notes.md`, {
        initiatorOrigin: `glass-file://${THREAD}`,
      }),
      backendUrlOf(`glass-file://${THREAD}/notes.md`, {
        initiatorOrigin: "glass-file://9f6e95a4-990e-4067-b2ef-6f284d5d1adb",
      }),
      backendUrlOf(`glass-file://${THREAD}/notes.md`, { initiatorOrigin: "https://example.com" }),
    ]).toEqual([
      `http://127.0.0.1:4000/thread-files/sandbox/${THREAD}/notes.md?token=secret`,
      null,
      null,
    ])
  })

  it.each([
    "glass-file://../visualizations/x",
    "glass-file://./health",
    "glass-file://not-a-thread/index.html",
    `glass-file://${THREAD}/`,
    `glass-file://${THREAD}/%E0%A4%A`,
  ])("refuses %s", (address) => expect(backendUrlOf(address)).toBeNull())
})

describe("visualizationUrl", () => {
  it.each(["..", ".", "health"])("refuses the id %s", (id) =>
    expect(visualizationUrl(endpoint, id)).toBeNull(),
  )
})
