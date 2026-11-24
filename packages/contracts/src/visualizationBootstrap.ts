import type { VisualizationLinkOpened, VisualizationSized } from "./visualization"

interface Box {
  readonly scrollHeight: number
  readonly clientHeight: number
  getBoundingClientRect(): { readonly height: number }
}

interface Link {
  getAttribute(name: string): string | null
}

interface Clicked {
  readonly target: { closest?: (selector: string) => Link | null } | null
  preventDefault(): void
}

export interface PageWindow {
  readonly document: {
    readonly documentElement: Box
    readonly body: Box | null
    readonly baseURI: string
    getElementById(id: string): { textContent: string | null } | null
    addEventListener(type: "DOMContentLoaded", listener: () => void): void
    addEventListener(type: "click", listener: (event: Clicked) => void, capture: boolean): void
  }
  readonly location: { readonly hash: string }
  readonly parent: {
    postMessage(
      message: typeof VisualizationSized.Type | typeof VisualizationLinkOpened.Type,
      targetOrigin: string,
    ): void
  }
  readonly ResizeObserver: new (callback: () => void) => { observe(target: Box): void }
  readonly URL: new (
    url: string,
    base: string,
  ) => { readonly protocol: string; readonly href: string }
  addEventListener(type: "load", listener: () => void): void
}

export interface BootstrapOptions {
  readonly styleId: string
  readonly baseCss: string
  readonly themeParam: string
  readonly sizedTag: (typeof VisualizationSized.Type)["_tag"]
  readonly linkOpenedTag: (typeof VisualizationLinkOpened.Type)["_tag"]
}

export function visualizationBootstrap(page: PageWindow, options: BootstrapOptions) {
  const style = page.document.getElementById(options.styleId)
  let height: number | undefined

  const fromHash = new RegExp(`[#&]${options.themeParam}=([^&]*)`).exec(page.location.hash)

  try {
    const theme: unknown =
      fromHash === null ? null : JSON.parse(decodeURIComponent(fromHash[1] ?? ""))

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The page can't load Schema to decode it.
    if (style !== null && typeof theme === "object" && theme !== null) {
      const declarations = Object.entries(theme).flatMap(([name, value]) =>
        /^--[a-z0-9-]+$/.test(name) ? [`${name}:${String(value).replace(/[;{}<>]/g, "")};`] : [],
      )

      style.textContent = `:root{${declarations.join("")}}${options.baseCss}`
    }
  } catch {}

  const size = () => {
    const root = page.document.documentElement

    const next = Math.ceil(
      root.scrollHeight > root.clientHeight
        ? root.scrollHeight
        : root.getBoundingClientRect().height,
    )

    if (next === height) return

    height = next
    page.parent.postMessage({ _tag: options.sizedTag, height: next }, "*")
  }

  new page.ResizeObserver(size).observe(page.document.documentElement)

  page.document.addEventListener("DOMContentLoaded", () => {
    if (page.document.body !== null) new page.ResizeObserver(size).observe(page.document.body)

    size()
  })

  page.addEventListener("load", size)

  const linkUrl = (href: string) => {
    try {
      return new page.URL(href, page.document.baseURI)
    } catch {
      return null
    }
  }

  page.document.addEventListener(
    "click",
    (event) => {
      const link = event.target?.closest?.("a[href]") ?? null
      const href = link?.getAttribute("href") ?? null

      if (href === null) return

      const url = linkUrl(href)

      if (url === null || !/^https?:$/.test(url.protocol)) return

      event.preventDefault()
      page.parent.postMessage({ _tag: options.linkOpenedTag, url: url.href }, "*")
    },
    true,
  )
}
