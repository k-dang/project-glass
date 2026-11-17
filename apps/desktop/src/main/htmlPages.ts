import { HTML_PAGE_SANDBOX, HTML_PAGE_SCHEME } from "@glass/contracts/desktop"
import { randomUUID } from "node:crypto"

// An opaque origin keeps the page from Glass's storage and window; t3code serves agent HTML the
// same way.
const PAGE_CONTENT_SECURITY_POLICY = `sandbox ${HTML_PAGE_SANDBOX}`

const idOf = (url: string) => new URL(url).pathname.slice(1)

export const htmlPages = () => {
  const pages = new Map<string, string>()

  return {
    open: (html: string) => {
      const id = randomUUID()

      pages.set(id, html)

      return `${HTML_PAGE_SCHEME}://page/${id}`
    },
    close: (url: string) => void pages.delete(idOf(url)),
    clear: () => pages.clear(),
    serve: (request: Request) => {
      const html = pages.get(idOf(request.url))

      return html === undefined
        ? new Response("Not found", { status: 404 })
        : new Response(html, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": PAGE_CONTENT_SECURITY_POLICY,
              "x-content-type-options": "nosniff",
            },
          })
    },
  }
}
