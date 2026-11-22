import type { Schema } from "effect"
import { expect, it } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import type { KeyboardInputEvent } from "electron"
import { relayTo } from "./cdpRelay"

const relayed = (
  answer = (method: string): Promise<Schema.Json> => Promise.resolve({ from: method }),
) => {
  const sent: Array<{ method: string; sessionId: string | undefined }> = []
  const written: Array<Schema.Json> = []
  const keys: Array<KeyboardInputEvent> = []

  const relay = relayTo(
    {
      send: (method, _params, sessionId) => {
        sent.push({ method, sessionId })

        return answer(method)
      },
      key: (key) => void keys.push(key),
      targetId: () => Promise.resolve("page-target"),
      url: () => "http://localhost:3000/",
      title: () => "Demo",
      userAgent: () => "Electron",
    },
    // SAFETY: The relay only writes JSON it built from Schema.Json values.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any.
    (message) => void written.push(JSON.parse(message) as Schema.Json),
  )

  return { relay, sent, written, keys }
}

it("answers Playwright's browser-level handshake itself and announces the one page", async () => {
  const { relay, sent, written } = relayed()

  relay.receive(JSON.stringify({ id: 1, method: "Browser.getVersion" }))
  relay.receive(
    JSON.stringify({ id: 2, method: "Target.setAutoAttach", params: { flatten: true } }),
  )

  await eventually(() =>
    expect(written).toEqual([
      {
        id: 1,
        result: {
          protocolVersion: "1.3",
          product: "Electron",
          revision: "",
          userAgent: "Electron",
          jsVersion: "",
        },
      },
      { id: 2, result: {} },
      {
        method: "Target.attachedToTarget",
        params: {
          sessionId: "glass-browser-pane-page",
          targetInfo: {
            targetId: "page-target",
            type: "page",
            title: "Demo",
            url: "http://localhost:3000/",
            attached: true,
            canAccessOpener: false,
            browserContextId: "glass-browser-pane",
          },
          waitingForDebugger: false,
        },
      },
    ]),
  )
  expect(sent).toEqual([])
})

it("sends the page's commands to its debugger, keeping child frames' sessions, and resets Runtime once", async () => {
  const { relay, sent, written } = relayed()
  const page = "glass-browser-pane-page"

  relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach" }))
  relay.receive(JSON.stringify({ id: 2, method: "Runtime.enable", sessionId: page }))
  relay.receive(JSON.stringify({ id: 3, method: "Runtime.enable", sessionId: page }))
  relay.receive(JSON.stringify({ id: 4, method: "DOM.enable", sessionId: "frame-1" }))

  await eventually(() =>
    expect(written).toContainEqual({ id: 4, result: { from: "DOM.enable" }, sessionId: "frame-1" }),
  )
  await eventually(() =>
    expect(sent).toEqual([
      { method: "Runtime.disable", sessionId: undefined },
      { method: "DOM.enable", sessionId: "frame-1" },
      { method: "Runtime.enable", sessionId: undefined },
      { method: "Runtime.enable", sessionId: undefined },
    ]),
  )

  relay.event("Page.loadEventFired", { timestamp: 1 }, "")
  relay.event("DOM.documentUpdated", {}, "frame-1")

  expect(written.slice(-2)).toEqual([
    { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: page },
    { method: "DOM.documentUpdated", params: {}, sessionId: "frame-1" },
  ])
})

it("is sending input only while a relayed Input command waits for its answer", async () => {
  const answered = Promise.withResolvers<Schema.Json>()

  const { relay, sent } = relayed((method) =>
    method.startsWith("Input.") ? answered.promise : Promise.resolve({}),
  )

  const page = "glass-browser-pane-page"
  relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach" }))
  relay.receive(JSON.stringify({ id: 2, method: "DOM.enable", sessionId: page }))
  await eventually(() => expect(sent).toHaveLength(1))
  expect(relay.sendingInput()).toBe(false)

  relay.receive(
    JSON.stringify({
      id: 3,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 10, y: 10 },
      sessionId: page,
    }),
  )
  await eventually(() => expect(relay.sendingInput()).toBe(true))

  answered.resolve({})
  await eventually(() => expect(relay.sendingInput()).toBe(false))
})

it("presses keys and types text through the page's own input rather than its debugger", async () => {
  const { relay, sent, written, keys } = relayed()
  const page = "glass-browser-pane-page"

  relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach" }))
  relay.receive(
    JSON.stringify({
      id: 2,
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Enter" },
      sessionId: page,
    }),
  )
  relay.receive(
    JSON.stringify({ id: 3, method: "Input.insertText", params: { text: "Al" }, sessionId: page }),
  )

  await eventually(() => expect(written).toContainEqual({ id: 3, result: {}, sessionId: page }))
  expect(keys).toEqual([
    { type: "keyDown", keyCode: "Enter", modifiers: [] },
    { type: "char", keyCode: "A", modifiers: [] },
    { type: "char", keyCode: "l", modifiers: [] },
  ])
  expect(sent).toEqual([])
})
