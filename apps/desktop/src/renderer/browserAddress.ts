import { FilePage, type PageLocation, type ThreadPlace, WebPage } from "@glass/contracts"
import { isLoopbackHost, THREAD_FILE_SCHEME } from "@glass/contracts/desktop"
import { Predicate } from "effect"

export const threadFileAddress = (threadId: string, path: string) =>
  `${THREAD_FILE_SCHEME}://${threadId}/${path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`

const threadFileOf = (url: URL) => {
  try {
    return { threadId: url.hostname, path: decodeURIComponent(url.pathname.slice(1)) }
  } catch {
    return null
  }
}

export const webAddress = (address: string | null) => {
  const url = address === null ? null : URL.parse(address)

  return url !== null && (url.protocol === "http:" || url.protocol === "https:") ? url : null
}

export const isLoopback = (address: string) => {
  const url = webAddress(address)

  return url !== null && isLoopbackHost(url.hostname)
}

export const addressOf = (typed: string) => {
  const text = typed.trim()

  if (text === "" || /\s/.test(text)) return null

  if (/^[a-z][\w+.-]*:/i.test(text) && !/^[^/]+:\d+(?:[/?#]|$)/.test(text)) {
    const url = URL.parse(text)

    return url !== null &&
      (webAddress(url.href) !== null ||
        url.protocol === `${THREAD_FILE_SCHEME}:` ||
        url.href === "about:blank")
      ? url.href
      : null
  }

  const host = text.split(/[/?#:]/)[0]?.toLowerCase() ?? ""

  return URL.parse(`${isLoopbackHost(host) ? "http" : "https"}://${text}`)?.href ?? null
}

export const pageOf = (threadId: string, address: string): PageLocation | null => {
  const url = URL.parse(address)

  if (url === null || url.href === "about:blank") return null

  if (url.protocol === `${THREAD_FILE_SCHEME}:`) {
    const file = threadFileOf(url)

    return file?.threadId === threadId ? FilePage.make({ path: file.path }) : null
  }

  url.hash = ""

  return WebPage.make({ url: url.href })
}

export interface BrowserPolicy {
  readonly local: boolean
  readonly allows: (address: string) => boolean
  readonly opensLink: (href: string) => boolean
}

export const browserPolicyOf = (place: ThreadPlace): BrowserPolicy => {
  const local = Predicate.isTagged(place, "local")

  return {
    local,
    allows: (address) => local || !isLoopback(address),
    opensLink: (href) => local && isLoopback(href),
  }
}
