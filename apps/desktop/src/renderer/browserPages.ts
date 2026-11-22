import { useEffect, useSyncExternalStore } from "react"

export type PageHolder = "pane" | "agent"

interface PageFrame {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

interface LivePage {
  readonly view: HTMLWebViewElement
  readonly holders: Set<PageHolder>
  readonly ready: Promise<void>
  slot: HTMLElement | null
  frame: PageFrame | null
}

const OFFSCREEN = -100_000

const rememberedKey = (threadId: string) => `glass.browserPane.${threadId}`

export const remembered = (threadId: string) => localStorage.getItem(rememberedKey(threadId))

export const remember = (threadId: string, address: string) =>
  localStorage.setItem(rememberedKey(threadId), address)

const pages = new Map<string, LivePage>()

const listeners = new Set<() => void>()

let layer: HTMLDivElement | null = null

let placing = false

const changed = () => {
  for (const listener of listeners) listener()
}

const layerElement = () => {
  if (layer !== null && layer.isConnected) return layer

  layer = document.createElement("div")
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:10;overflow:hidden"
  document.body.append(layer)

  return layer
}

const frameOf = (slot: HTMLElement | null): PageFrame | null => {
  const rect = slot?.isConnected === true ? slot.getBoundingClientRect() : null

  return rect === null || rect.width === 0 || rect.height === 0
    ? null
    : { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

const sameFrame = (a: PageFrame | null, b: PageFrame | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height)

const place = (page: LivePage) => {
  const frame = frameOf(page.slot)

  if (sameFrame(frame, page.frame)) return false

  page.frame = frame

  if (frame === null) {
    page.view.style.left = `${OFFSCREEN}px`

    return true
  }

  page.view.style.left = `${frame.left}px`
  page.view.style.top = `${frame.top}px`
  page.view.style.width = `${frame.width}px`
  page.view.style.height = `${frame.height}px`

  return true
}

const placeAll = () => {
  let moved = false

  for (const page of pages.values()) moved = place(page) || moved

  if (moved) changed()

  placing = [...pages.values()].some(({ slot }) => slot !== null)

  if (placing) requestAnimationFrame(placeAll)
}

const keepPlacing = () => {
  if (placing) return

  placing = true
  requestAnimationFrame(placeAll)
}

export const holdBrowserPage = (threadId: string, holder: PageHolder, partition: string) => {
  const known = pages.get(threadId)

  if (known !== undefined) {
    if (!known.holders.has(holder)) {
      known.holders.add(holder)
      changed()
    }

    return known.view
  }

  const view: HTMLWebViewElement = document.createElement("webview")
  view.setAttribute("partition", partition)
  view.setAttribute("src", "about:blank")
  view.style.cssText = `position:absolute;pointer-events:auto;background:white;left:${OFFSCREEN}px;top:0;width:1280px;height:800px`

  const ready = new Promise<void>((resolve) => {
    const onReady = () => {
      view.removeEventListener("dom-ready", onReady)
      resolve()
    }

    view.addEventListener("dom-ready", onReady)
  })

  pages.set(threadId, {
    view,
    holders: new Set([holder]),
    ready,
    slot: null,
    frame: null,
  })
  layerElement().append(view)
  changed()

  return view
}

export const releaseBrowserPage = (threadId: string, holder: PageHolder) => {
  const page = pages.get(threadId)

  if (page === undefined || !page.holders.delete(holder)) return

  if (page.holders.size === 0) {
    page.view.remove()
    pages.delete(threadId)
  }

  changed()
}

export const browserPageReady = (threadId: string) =>
  pages.get(threadId)?.ready ?? Promise.reject(new Error("This Thread has no Browser page"))

export const showBrowserPage = (threadId: string, slot: HTMLElement | null) => {
  const page = pages.get(threadId)

  if (page === undefined) return

  page.slot = slot
  keepPlacing()
}

export const liveBrowserPage = (threadId: string) => pages.get(threadId)?.view ?? null

export const agentHeldThreads = () =>
  [...pages].flatMap(([threadId, page]) => (page.holders.has("agent") ? [threadId] : []))

const subscribe = (listener: () => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export const useBrowserPageFrame = (threadId: string) =>
  useSyncExternalStore(subscribe, () => pages.get(threadId)?.frame ?? null)

export const useAgentHoldsBrowserPage = (threadId: string) =>
  useSyncExternalStore(subscribe, () => pages.get(threadId)?.holders.has("agent") ?? false)

export const usePaneBrowserPage = (threadId: string, partition: string) => {
  useEffect(() => {
    holdBrowserPage(threadId, "pane", partition)

    return () => releaseBrowserPage(threadId, "pane")
  }, [threadId, partition])

  return useSyncExternalStore(subscribe, () => pages.get(threadId)?.view ?? null)
}
