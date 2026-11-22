import { useEffect, useSyncExternalStore } from "react"

export type PageHolder = "pane" | "agent"

interface LivePage {
  readonly view: HTMLWebViewElement
  readonly holders: Set<PageHolder>
  readonly ready: Promise<void>
  slot: HTMLElement | null
  size: { readonly width: number; readonly height: number }
}

const OFFSCREEN = -100_000

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

const place = ({ view, slot, size }: LivePage) => {
  const rect = slot?.isConnected === true ? slot.getBoundingClientRect() : null
  const shown = rect !== null && rect.width > 0 && rect.height > 0
  const { left, top, width, height } = shown ? rect : { left: OFFSCREEN, top: 0, ...size }

  view.style.left = `${left}px`
  view.style.top = `${top}px`
  view.style.width = `${width}px`
  view.style.height = `${height}px`

  return shown ? { width, height } : null
}

const placeAll = () => {
  if (pages.size === 0) {
    placing = false

    return
  }

  for (const page of pages.values()) {
    const shown = place(page)

    if (shown !== null) page.size = shown
  }

  requestAnimationFrame(placeAll)
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
  view.style.cssText = `position:absolute;pointer-events:auto;background:white;left:${OFFSCREEN}px`

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
    size: { width: 1280, height: 800 },
  })
  layerElement().append(view)
  keepPlacing()
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

  if (page !== undefined) page.slot = slot
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

export const useAgentHoldsBrowserPage = (threadId: string) =>
  useSyncExternalStore(subscribe, () => pages.get(threadId)?.holders.has("agent") ?? false)

export const usePaneBrowserPage = (threadId: string, partition: string) => {
  useEffect(() => {
    holdBrowserPage(threadId, "pane", partition)

    return () => releaseBrowserPage(threadId, "pane")
  }, [threadId, partition])

  return useSyncExternalStore(subscribe, () => pages.get(threadId)?.view ?? null)
}
