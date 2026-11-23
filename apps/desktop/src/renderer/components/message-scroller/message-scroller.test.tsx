// @vitest-environment happy-dom

import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import {
  MessageScroller as MessageScrollerPrimitive,
  useHoldScrollPosition,
  useMessageScrollerScrollable,
} from "."

const MessageScrollerProvider = MessageScrollerPrimitive.Provider

const MessageScroller = MessageScrollerPrimitive.Root

const MessageScrollerViewport = MessageScrollerPrimitive.Viewport

const MessageScrollerContent = MessageScrollerPrimitive.Content

const MessageScrollerItem = MessageScrollerPrimitive.Item

const MessageScrollerButton = MessageScrollerPrimitive.Button

type TestMessage = {
  height?: number
  id: string
  scrollAnchor?: boolean
}

type TestScrollerOptions = {
  autoScroll?: React.ComponentProps<typeof MessageScrollerProvider>["autoScroll"]
  messages: TestMessage[]
}

type TestScrollerApi = {
  holdPosition: ReturnType<typeof useHoldScrollPosition>
}

type TestScrollerState = ReturnType<typeof useMessageScrollerScrollable>

type RenderedTestScroller = {
  api: () => TestScrollerApi
  button: () => HTMLButtonElement
  container: HTMLDivElement
  content: () => HTMLDivElement
  message: (messageId: string) => HTMLDivElement
  rerender: (
    messages: TestMessage[],
    options?: Partial<Omit<TestScrollerOptions, "messages">>,
  ) => Promise<void>
  root: Root
  scroller: () => HTMLDivElement
  state: () => TestScrollerState
  stateRenderCount: () => number
  viewport: () => HTMLDivElement
}

const viewportHeight = 100

let containers: HTMLDivElement[] = []

let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect

let originalGetComputedStyle: typeof window.getComputedStyle

let originalScrollTo: typeof HTMLElement.prototype.scrollTo

let animationFrameTime = 0

let resizeObservers: TestResizeObserver[] = []

class TestResizeObserver {
  private callback: ResizeObserverCallback
  private elements = new Set<Element>()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    resizeObservers.push(this)
  }

  disconnect() {
    this.elements.clear()
    resizeObservers = resizeObservers.filter((observer) => observer !== this)
  }

  has(element: Element) {
    return this.elements.has(element)
  }

  observe(element: Element) {
    this.elements.add(element)
    window.requestAnimationFrame(() => this.trigger())
  }

  trigger() {
    this.callback([], this)
  }

  unobserve(element: Element) {
    this.elements.delete(element)
  }
}

beforeEach(() => {
  animationFrameTime = 0
  resizeObservers = []
  vi.useFakeTimers()
  ;(
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean
    }
  ).IS_REACT_ACT_ENVIRONMENT = true

  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  originalGetComputedStyle = window.getComputedStyle
  originalScrollTo = HTMLElement.prototype.scrollTo

  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => {
      animationFrameTime += 16
      callback(animationFrameTime)
    }, 16)
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle)
  window.ResizeObserver = TestResizeObserver
  ;(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = undefined

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement && this.dataset.testHeight) {
        return Number(this.dataset.testHeight)
      }

      if (this instanceof HTMLElement && this.dataset.testid === "viewport") {
        return viewportHeight
      }

      return 0
    },
  })

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (
        this instanceof HTMLElement &&
        (this.dataset.testid === "viewport" || this.dataset.testid === "content")
      ) {
        return getContentHeight(this)
      }

      return this.clientHeight
    },
  })

  HTMLElement.prototype.scrollTo = function scrollTo(
    optionsOrX?: ScrollToOptions | number,
    y?: number,
  ) {
    const top = typeof optionsOrX === "number" ? y : optionsOrX?.top

    if (typeof top === "number") {
      this.scrollTop = Math.max(0, top)
    }
  }

  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (!(this instanceof HTMLElement)) {
      return originalGetBoundingClientRect.call(this)
    }

    return getTestRect(this)
  }

  window.getComputedStyle = (element: Element) => {
    const style = originalGetComputedStyle(element)

    if (element instanceof HTMLElement && element.dataset.testid === "content") {
      return {
        ...style,
        gap: "0px",
        paddingBlockEnd: "0px",
        paddingBlockStart: "0px",
        paddingBottom: "0px",
        paddingTop: "0px",
        rowGap: "0px",
      }
    }

    return style
  }
})

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
  HTMLElement.prototype.scrollTo = originalScrollTo
  window.getComputedStyle = originalGetComputedStyle

  containers.forEach((container) => {
    container.remove()
  })
  containers = []

  vi.useRealTimers()
})

describe("MessageScroller", () => {
  it("exposes derived state, a labelled viewport, and button state", async () => {
    const rendered = await renderTestScroller({
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    await act(async () => {
      rendered.viewport().scrollTop = 0
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    expect(rendered.viewport().tabIndex).toBe(0)
    expect(rendered.viewport().getAttribute("role")).toBe("region")
    expect(rendered.viewport().getAttribute("aria-label")).toBe("Messages")
    expect(rendered.content().getAttribute("role")).toBe("log")
    expect(rendered.content().getAttribute("aria-relevant")).toBe("additions")
    expect(rendered.scroller().dataset.scrollable).toBe("end")
    expect(rendered.state()).toMatchObject({
      start: false,
      end: true,
    })
    expect(rendered.button().dataset.active).toBe("true")
    expect(rendered.button().hasAttribute("inert")).toBe(false)
    expect(rendered.button().hidden).toBe(false)
    expect(rendered.button().tabIndex).toBe(0)
  })

  it("opens at the end by default", async () => {
    const rendered = await renderTestScroller({
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)
    expect(rendered.state()).toMatchObject({
      start: true,
      end: false,
    })
    expect(rendered.button().dataset.active).toBe("false")
    expect(rendered.button().hidden).toBe(false)
    expect(rendered.viewport().hasAttribute("data-pending-scroll")).toBe(false)
    expect(rendered.scroller().hasAttribute("data-pending-scroll")).toBe(false)
  })

  it("drops data-pending-scroll when the transcript is empty", async () => {
    const rendered = await renderTestScroller({
      messages: [],
    })

    expect(rendered.viewport().hasAttribute("data-pending-scroll")).toBe(false)
    expect(rendered.scroller().hasAttribute("data-pending-scroll")).toBe(false)
  })

  it("opens at the end when autoScroll starts engaged", async () => {
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined

    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)
    expect(rendered.state()).toMatchObject({
      start: true,
      end: false,
    })
  })

  it("follows later appends while resting at the end with autoScroll", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 80 },
      ],
      { autoScroll: true },
    )

    expect(rendered.viewport().scrollTop).toBe(220)
    expect(rendered.state()).toMatchObject({
      start: true,
      end: false,
    })
  })

  it("follows the end before the next frame paints when content above grows", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    rendered.message("message-1").dataset.testHeight = "200"

    await triggerResize(rendered.content(), 0)

    expect(rendered.viewport().scrollTop).toBe(260)
  })

  it("holds a newly appended anchor at the reading line while the reply streams with autoScroll", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 40, scrollAnchor: true },
      ],
      { autoScroll: true },
    )

    expect(rendered.viewport().scrollTop).toBe(176)
    expect(rendered.message("message-4").getBoundingClientRect().top).toBe(64)

    // The anchored turn was placed with no tail spacer (the content already
    // fills the viewport), so growth must keep holding it at the reading line
    // instead of yanking the reader to the live edge.
    rendered.message("message-4").dataset.testHeight = "160"
    await triggerResize(rendered.content())

    expect(rendered.message("message-4").getBoundingClientRect().top).toBe(64)
  })

  it("hands off from the anchor hold to following once the streamed reply fills the viewport", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    // The submitted turn anchors at the reading line with tail spacer room
    // below for the reply to stream into.
    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 20, scrollAnchor: true },
      ],
      { autoScroll: true },
    )

    expect(rendered.viewport().scrollTop).toBe(176)
    expect(rendered.message("message-4").getBoundingClientRect().top).toBe(64)

    // The reply streams in below the anchor. While it still fits in the
    // spacer room the anchor holds and following stays off.
    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 20, scrollAnchor: true },
        { id: "message-5", height: 8 },
      ],
      { autoScroll: true },
    )
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(176)
    expect(rendered.message("message-4").getBoundingClientRect().top).toBe(64)

    // Growth past the spacer means the reply has filled the viewport and the
    // reader is at the live edge, so autoScroll takes over from the anchor.
    rendered.message("message-5").dataset.testHeight = "60"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(220)
    expect(rendered.state().end).toBe(false)

    // Follow-output stays engaged for the rest of the stream.
    rendered.message("message-5").dataset.testHeight = "100"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(260)
    expect(rendered.state().end).toBe(false)
  })

  it("keeps the reader in place when they scroll up into a released tail spacer", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 20, scrollAnchor: true },
      ],
      { autoScroll: true },
    )

    expect(rendered.viewport().scrollTop).toBe(176)
    expect(rendered.viewport().scrollHeight).toBe(276)

    await act(async () => {
      await flushAnimationFrames(12)
    })
    await act(async () => {
      rendered.viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
      rendered.viewport().scrollTop = 170
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    expect(rendered.viewport().scrollTop).toBe(170)
    expect(rendered.viewport().scrollHeight).toBe(270)
  })

  it("drops the tail spacer below a reader who scrolled up, and follows again from the live edge", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    // The submitted turn anchors at the reading line with tail spacer room
    // below for the reply to stream into.
    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 20, scrollAnchor: true },
      ],
      { autoScroll: true },
    )

    expect(rendered.viewport().scrollTop).toBe(176)
    expect(rendered.message("message-4").getBoundingClientRect().top).toBe(64)

    await act(async () => {
      await flushAnimationFrames(12)
    })
    await act(async () => {
      rendered.viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
      rendered.viewport().scrollTop = 150
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    const spacer = rendered.content().querySelector<HTMLElement>("[data-message-scroller-spacer]")
    expect(spacer?.hidden).toBe(true)

    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 20, scrollAnchor: true },
        { id: "message-5", height: 8 },
      ],
      { autoScroll: true },
    )
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(150)

    await act(async () => {
      rendered.viewport().scrollTop = 168
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    // Follow-output stays engaged for the rest of the stream.
    rendered.message("message-5").dataset.testHeight = "60"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(220)
    expect(rendered.state().end).toBe(false)
  })

  it("applies the default end target after async messages mount", async () => {
    const rendered = await renderTestScroller({
      messages: [],
    })

    expect(rendered.viewport().scrollTop).toBe(0)

    await rendered.rerender([
      { id: "message-1", height: 80 },
      { id: "message-2", height: 80 },
      { id: "message-3", height: 80 },
    ])

    expect(rendered.viewport().scrollTop).toBe(140)
    expect(rendered.state()).toMatchObject({
      start: true,
      end: false,
    })
  })

  it("follows content growth while autoScroll remains engaged", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 140 },
      ],
      { autoScroll: true },
    )
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(200)
    expect(rendered.scroller().hasAttribute("data-autoscrolling")).toBe(true)
  })

  it("follows late content resize while autoScroll remains engaged", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    rendered.message("message-3").dataset.testHeight = "140"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(200)
    expect(rendered.state()).toMatchObject({
      start: true,
      end: false,
    })
  })

  it("holds position while content grows in place, until the reader scrolls", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    rendered.api().holdPosition()
    rendered.message("message-3").dataset.testHeight = "82"
    await triggerResize(rendered.content())
    rendered.message("message-3").dataset.testHeight = "140"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(140)
    expect(rendered.state().end).toBe(true)

    await act(async () => {
      rendered.viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
      rendered.viewport().scrollTop = 200
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })
    rendered.message("message-3").dataset.testHeight = "200"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(260)
  })

  it("ends the hold when the reader drags the scrollbar back to the end", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    rendered.api().holdPosition()
    rendered.message("message-3").dataset.testHeight = "140"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(140)

    await act(async () => {
      rendered.viewport().scrollTop = 200
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })
    rendered.message("message-3").dataset.testHeight = "200"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(260)
  })

  it("holds position and the tail spacer while an anchored reply streams, until the reader scrolls", async () => {
    const messages = [
      { id: "message-1", height: 80 },
      { id: "message-2", height: 80 },
      { id: "message-3", height: 80 },
      { id: "message-4", height: 20, scrollAnchor: true },
    ]

    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: messages.slice(0, 3),
    })

    await rendered.rerender(messages, { autoScroll: true })

    expect(rendered.viewport().scrollTop).toBe(176)

    const spacer = rendered.content().querySelector<HTMLElement>("[data-message-scroller-spacer]")
    const spacerHeight = spacer?.style.height

    rendered.api().holdPosition()
    await rendered.rerender([...messages, { id: "message-5", height: 8 }], { autoScroll: true })
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(176)
    expect(spacer?.style.height).toBe(spacerHeight)

    await act(async () => {
      rendered.viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
      rendered.viewport().scrollTop = 150
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    expect(rendered.viewport().scrollTop).toBe(150)
    expect(spacer?.hidden).toBe(true)
  })

  it("releases autoScroll after user scroll intent", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    await act(async () => {
      rendered.viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
      rendered.viewport().scrollTop = 60
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 80 },
      ],
      { autoScroll: true },
    )

    expect(rendered.viewport().scrollTop).toBe(60)
    expect(rendered.state().end).toBe(true)
  })

  it("releases follow-bottom on a bare scroll-away so later appends do not snap back", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    // Let the opening scroll-to-end settle so the autoscrolling flag clears.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // A scrollbar drag fires only a scroll event — no wheel, touch, or keydown,
    // so it never reaches userScrollIntent. It must still release follow-bottom.
    await act(async () => {
      rendered.viewport().scrollTop = 0
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    expect(rendered.viewport().scrollTop).toBe(0)

    await rendered.rerender([
      { id: "message-1", height: 80 },
      { id: "message-2", height: 80 },
      { id: "message-3", height: 80 },
      { id: "message-4", height: 80 },
    ])

    expect(rendered.viewport().scrollTop).toBe(0)
  })

  it("leaves the reader in place when a new anchor arrives after they scroll away with autoScroll", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    await act(async () => {
      rendered.viewport().dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
      rendered.viewport().scrollTop = 60
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    await rendered.rerender(
      [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
        { id: "message-4", height: 40, scrollAnchor: true },
      ],
      { autoScroll: true },
    )

    expect(rendered.viewport().scrollTop).toBe(60)
    expect(rendered.button().dataset.active).toBe("true")
  })

  it("releases follow-bottom on a bare scroll-away so later resizes do not snap back", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    await act(async () => {
      rendered.viewport().scrollTop = 0
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    expect(rendered.viewport().scrollTop).toBe(0)

    rendered.message("message-3").dataset.testHeight = "200"
    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(0)
  })

  it("keeps following when a state commit sees growth before the coalesced resize handler", async () => {
    const rendered = await renderTestScroller({
      autoScroll: true,
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(140)

    // Let the opening scroll-to-end settle so the autoscrolling flag clears.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // A large streamed chunk grows the content past the live edge, and a
    // scroll event commits state before the frame-coalesced resize handler has
    // caught follow-output up. The reader did not move, so the commit must not
    // release follow-bottom, and the gap it observed must not be published —
    // that would strobe the scroll button once per chunk.
    rendered.message("message-3").dataset.testHeight = "160"
    await act(async () => {
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
    })

    expect(rendered.state().end).toBe(false)
    expect(rendered.button().dataset.active).toBe("false")

    await triggerResize(rendered.content())

    expect(rendered.viewport().scrollTop).toBe(220)
    expect(rendered.state().end).toBe(false)
  })

  it("places appended scroll anchors near the top with previous peek", async () => {
    const rendered = await renderTestScroller({
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    await rendered.rerender([
      { id: "message-1", height: 80 },
      { id: "message-2", height: 80 },
      { id: "message-3", height: 80 },
      { id: "message-4", height: 40, scrollAnchor: true },
    ])

    expect(rendered.viewport().scrollTop).toBe(176)
  })

  it("anchors a replaced row when item count stays the same", async () => {
    const rendered = await renderTestScroller({
      messages: [
        { id: "message-1", height: 80 },
        { id: "placeholder", height: 80, scrollAnchor: false },
      ],
    })

    expect(rendered.viewport().scrollTop).toBe(60)

    await rendered.rerender([
      { id: "message-1", height: 80 },
      { id: "message-2", height: 40, scrollAnchor: true },
    ])

    expect(rendered.viewport().scrollTop).toBe(16)
  })

  it("does not reconcile scroll position when only the parent re-renders", async () => {
    const rendered = await renderTestScrollerWithParent({
      messages: [
        { id: "message-1", height: 80 },
        { id: "message-2", height: 80 },
        { id: "message-3", height: 80 },
      ],
    })

    const scrollTop = rendered.viewport().scrollTop

    await rendered.bumpParent()

    expect(rendered.viewport().scrollTop).toBe(scrollTop)
  })

  it("does not show the end button for spacer-only overflow", async () => {
    const rendered = await renderTestScroller({
      messages: [
        { id: "message-1", height: 60 },
        { id: "message-2", height: 20 },
      ],
    })

    await rendered.rerender([
      { id: "message-1", height: 60 },
      { id: "message-2", height: 20 },
      { id: "message-3", height: 20, scrollAnchor: true },
    ])

    expect(rendered.viewport().scrollHeight).toBeGreaterThan(viewportHeight)
    expect(rendered.state().end).toBe(false)
    expect(rendered.button().dataset.active).toBe("false")
    expect(rendered.button().hidden).toBe(false)
  })

  it("does not rerender state subscribers when derived state is unchanged", async () => {
    const rendered = await renderTestScroller({
      messages: [{ id: "message-1", height: 40 }],
    })

    const renderCount = rendered.stateRenderCount()

    await act(async () => {
      rendered.viewport().dispatchEvent(new Event("scroll", { bubbles: true }))
      await flushAnimationFrames()
    })

    expect(rendered.stateRenderCount()).toBe(renderCount)
  })
})

async function renderTestScroller(options: TestScrollerOptions) {
  const container = document.createElement("div")
  const root = createRoot(container)
  const apiRef = React.createRef<TestScrollerApi>()
  const stateRef = React.createRef<TestScrollerState>()
  const stateRenderCountRef = React.createRef<number>()
  let currentOptions = options

  containers.push(container)
  document.body.appendChild(container)

  await act(async () => {
    root.render(
      <TestScroller
        {...currentOptions}
        apiRef={apiRef}
        stateRef={stateRef}
        stateRenderCountRef={stateRenderCountRef}
      />,
    )
  })
  await act(async () => {
    await flushAnimationFrames()
  })

  return {
    api: () => {
      if (!apiRef.current) {
        throw new Error("MessageScroller API was not captured.")
      }

      return apiRef.current
    },
    button: () => container.querySelector<HTMLButtonElement>("[data-testid=button]")!,
    container,
    content: () => container.querySelector<HTMLDivElement>("[data-testid=content]")!,
    message: (messageId) =>
      container.querySelector<HTMLDivElement>(`[data-message-id="${messageId}"]`)!,
    rerender: async (messages, nextOptions = {}) => {
      currentOptions = {
        ...currentOptions,
        ...nextOptions,
        messages,
      }

      await act(async () => {
        root.render(
          <TestScroller
            {...currentOptions}
            apiRef={apiRef}
            stateRef={stateRef}
            stateRenderCountRef={stateRenderCountRef}
          />,
        )
      })
      await act(async () => {
        await flushAnimationFrames()
      })
    },
    root,
    scroller: () => container.querySelector<HTMLDivElement>("[data-testid=scroller]")!,
    state: () => {
      if (!stateRef.current) {
        throw new Error("MessageScroller state was not captured.")
      }

      return stateRef.current
    },
    stateRenderCount: () => stateRenderCountRef.current ?? 0,
    viewport: () => container.querySelector<HTMLDivElement>("[data-testid=viewport]")!,
  } satisfies RenderedTestScroller
}

async function renderTestScrollerWithParent(options: TestScrollerOptions): Promise<
  RenderedTestScroller & {
    bumpParent: () => Promise<void>
  }
> {
  const container = document.createElement("div")
  const root = createRoot(container)
  const apiRef = React.createRef<TestScrollerApi>()
  const stateRef = React.createRef<TestScrollerState>()
  const stateRenderCountRef = React.createRef<number>()
  let currentOptions = options
  let bumpParent = async () => {}

  containers.push(container)
  document.body.appendChild(container)

  function ParentScroller() {
    const [, bump] = React.useState(0)

    bumpParent = async () => {
      await act(async () => {
        bump((value) => value + 1)
        await flushAnimationFrames()
      })
    }

    return (
      <TestScroller
        {...currentOptions}
        apiRef={apiRef}
        stateRef={stateRef}
        stateRenderCountRef={stateRenderCountRef}
      />
    )
  }

  await act(async () => {
    root.render(<ParentScroller />)
  })
  await act(async () => {
    await flushAnimationFrames()
  })

  const rendered = {
    api: () => {
      if (!apiRef.current) {
        throw new Error("MessageScroller API was not captured.")
      }

      return apiRef.current
    },
    button: () => container.querySelector<HTMLButtonElement>("[data-testid=button]")!,
    bumpParent,
    container,
    content: () => container.querySelector<HTMLDivElement>("[data-testid=content]")!,
    message: (messageId: string) =>
      container.querySelector<HTMLDivElement>(`[data-message-id="${messageId}"]`)!,
    rerender: async (
      messages: TestMessage[],
      nextOptions: Partial<Omit<TestScrollerOptions, "messages">> = {},
    ) => {
      currentOptions = {
        ...currentOptions,
        ...nextOptions,
        messages,
      }

      await act(async () => {
        root.render(<ParentScroller />)
      })
      await act(async () => {
        await flushAnimationFrames()
      })
    },
    root,
    scroller: () => container.querySelector<HTMLDivElement>("[data-testid=scroller]")!,
    state: () => {
      if (!stateRef.current) {
        throw new Error("MessageScroller state was not captured.")
      }

      return stateRef.current
    },
    stateRenderCount: () => stateRenderCountRef.current ?? 0,
    viewport: () => container.querySelector<HTMLDivElement>("[data-testid=viewport]")!,
  }

  return rendered
}

async function triggerResize(element: Element, frames?: number) {
  await act(async () => {
    resizeObservers.forEach((observer) => {
      if (observer.has(element)) {
        observer.trigger()
      }
    })
    await flushAnimationFrames(frames)
  })
}

function TestScroller({
  apiRef,
  autoScroll,
  messages,
  stateRef,
  stateRenderCountRef,
}: TestScrollerOptions & {
  apiRef: React.RefObject<TestScrollerApi | null>
  stateRef: React.RefObject<TestScrollerState | null>
  stateRenderCountRef: React.RefObject<number | null>
}) {
  return (
    <MessageScrollerProvider autoScroll={autoScroll}>
      <MessageScroller data-testid="scroller">
        <MessageScrollerViewport data-testid="viewport">
          <MessageScrollerContent data-testid="content">
            {messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                data-testid="message"
                data-test-height={message.height ?? 40}
                messageId={message.id}
                scrollAnchor={message.scrollAnchor}
              >
                {message.id}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton data-testid="button">Scroll</MessageScrollerButton>
        <MessageScrollerApiProbe apiRef={apiRef} />
        <MessageScrollerStateProbe stateRef={stateRef} stateRenderCountRef={stateRenderCountRef} />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

function MessageScrollerApiProbe({ apiRef }: { apiRef: React.RefObject<TestScrollerApi | null> }) {
  apiRef.current = { holdPosition: useHoldScrollPosition() }

  return null
}

function MessageScrollerStateProbe({
  stateRef,
  stateRenderCountRef,
}: {
  stateRef: React.RefObject<TestScrollerState | null>
  stateRenderCountRef: React.RefObject<number | null>
}) {
  stateRenderCountRef.current = (stateRenderCountRef.current ?? 0) + 1
  stateRef.current = useMessageScrollerScrollable()

  return null
}

async function flushAnimationFrames(count = 4) {
  for (let index = 0; index < count; index++) {
    await vi.advanceTimersByTimeAsync(20)
  }
}

function getContentHeight(element: HTMLElement) {
  const content =
    element.dataset.testid === "content"
      ? element
      : element.querySelector<HTMLElement>("[data-testid=content]")

  if (!content) {
    return 0
  }

  const messagesHeight = getMessageElements(content).reduce(
    (height, message) => height + getElementHeight(message),
    0,
  )

  const spacer = content.querySelector<HTMLElement>("[data-message-scroller-spacer]")
  const spacerHeight = spacer && !spacer.hidden ? Number.parseFloat(spacer.style.height) || 0 : 0

  return messagesHeight + spacerHeight
}

function getTestRect(element: HTMLElement) {
  const viewport =
    element.dataset.testid === "viewport"
      ? element
      : element
          .closest("[data-testid=scroller]")
          ?.querySelector<HTMLElement>("[data-testid=viewport]")

  if (element.dataset.testid === "viewport") {
    return createRect(0, element.clientHeight)
  }

  if (!viewport) {
    return createRect(0, 0)
  }

  if (element.dataset.testid === "content") {
    const top = -viewport.scrollTop

    return createRect(top, getContentHeight(element))
  }

  if (element.dataset.testid === "message") {
    const content = element.parentElement as HTMLElement
    const top = getElementOffset(content, element) - viewport.scrollTop

    return createRect(top, getElementHeight(element))
  }

  return createRect(0, 0)
}

function getElementOffset(content: HTMLElement, element: HTMLElement) {
  let offset = 0

  for (const message of getMessageElements(content)) {
    if (message === element) {
      return offset
    }

    offset += getElementHeight(message)
  }

  return offset
}

function getMessageElements(content: HTMLElement) {
  return Array.from(content.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.testid === "message",
  )
}

function getElementHeight(element: HTMLElement) {
  return Number(element.dataset.testHeight ?? 0)
}

function createRect(top: number, height: number) {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON() {
      return {}
    },
  } as DOMRect
}
