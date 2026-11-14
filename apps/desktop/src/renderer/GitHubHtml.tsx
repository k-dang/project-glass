import { cn } from "cn"
import DOMPurify from "dompurify"
import { type KeyboardEvent, type MouseEvent, useCallback, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { ImageViewer, type PreviewImage } from "./ImageViewer"
import { MermaidDiagram } from "./MermaidDiagram"

function imagePreviewSource(image: HTMLImageElement): string | null {
  const href = image.closest("a")?.href

  if (!href) return image.src
  const url = URL.parse(href)

  if (!url) return null

  // GitHub file and directory pages are HTML, even when their paths end with an image extension.
  if (url.hostname === "github.com" && /^\/[^/]+\/[^/]+\/(?:blob|tree)(?:\/|$)/.test(url.pathname))
    return null

  if (
    href === image.src ||
    /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(url.pathname) ||
    (url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/assets/"))
  )
    return href

  return null
}

function prepareHtml(source: string) {
  const container = document.createElement("div")
  container.append(
    DOMPurify.sanitize(source, {
      RETURN_DOM_FRAGMENT: true,
    }),
  )

  for (const element of container.querySelectorAll("[data-image-preview], [data-mermaid]")) {
    element.removeAttribute("data-image-preview")
    element.removeAttribute("data-mermaid")
  }

  const diagrams: string[] = []

  // GitHub leaves these sections for its own page scripts to draw.
  for (const section of container.querySelectorAll("section.render-needs-enrichment")) {
    const code = section.querySelector("pre")

    if (!code) continue

    if (section.getAttribute("data-type") !== "mermaid") {
      section.replaceWith(code)
      continue
    }

    const placeholder = document.createElement("div")
    placeholder.dataset.mermaid = String(diagrams.length)
    section.replaceWith(placeholder)
    diagrams.push(code.textContent)
  }

  const images: PreviewImage[] = []

  for (const image of container.querySelectorAll("img")) {
    if (!image.getAttribute("src")) continue
    const src = imagePreviewSource(image)

    if (src === null) continue
    const link = image.closest("a")

    const name = image.alt.trim() || `Image ${images.length + 1}`
    const target = link ?? image
    target.dataset.imagePreview = String(images.length)
    target.setAttribute("role", "button")
    target.setAttribute("tabindex", "0")
    target.setAttribute("aria-haspopup", "dialog")
    target.setAttribute("aria-label", `Preview ${name}`)
    images.push({ src, name })
  }

  return { html: container.innerHTML, images, diagrams }
}

export function GitHubHtml(props: { html: string; className?: string }) {
  const content = useMemo(() => prepareHtml(props.html), [props.html])

  return <HtmlContent key={props.html} content={content} className={props.className} />
}

function HtmlContent(props: {
  content: ReturnType<typeof prepareHtml>
  className: string | undefined
}) {
  const [preview, setPreview] = useState<{ index: number; opener: HTMLElement } | null>(null)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)

  const openImage = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
      return

    if (!(event.target instanceof Element)) return
    const opener = event.target.closest<HTMLElement>("[data-image-preview]")

    if (!opener) return
    const index = Number(opener.dataset.imagePreview)

    event.preventDefault()
    event.stopPropagation()
    setPreview({ index, opener })
  }

  return (
    <>
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Delegated image controls. */}
      <div
        ref={setRoot}
        className={cn("markdown-body", props.className)}
        dangerouslySetInnerHTML={{ __html: props.content.html }}
        onClick={openImage}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") openImage(event)
        }}
      />
      {root &&
        props.content.diagrams.map((source, index) => {
          const target = root.querySelector(`[data-mermaid="${index}"]`)

          return target && createPortal(<GitHubMermaid source={source} />, target, index)
        })}
      {preview && (
        <ImageViewer
          images={props.content.images}
          index={preview.index}
          opener={preview.opener}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  )
}

function GitHubMermaid(props: { source: string }) {
  const [invalid, setInvalid] = useState(false)
  const onInvalid = useCallback(() => setInvalid(true), [])

  return invalid ? (
    <pre lang="mermaid">{props.source}</pre>
  ) : (
    <MermaidDiagram source={props.source} onInvalid={onInvalid} />
  )
}
