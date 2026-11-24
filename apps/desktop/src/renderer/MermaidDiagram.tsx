import { cn } from "cn"
import DOMPurify from "dompurify"
import type * as Pele from "pele"
import { useCallback } from "react"

const sanitize = (svg: string) =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true },
    ADD_ATTR: ["role"],
    RETURN_DOM_FRAGMENT: true,
  })

export function MermaidDiagram(props: {
  source: string
  onInvalid?: () => void
  zoom?: "always" | "auto" | "off"
  className?: string
}) {
  const { source, onInvalid, zoom = "auto" } = props

  const draw = useCallback(
    (element: HTMLDivElement) => {
      let diagram: ReturnType<typeof Pele.mount> | undefined
      let removed = false

      void import("pele").then(({ mount }) => {
        if (removed) return

        diagram = mount(element, source, {
          links: false,
          images: false,
          fontSize: 14,
          sanitize,
          zoom: zoom === "always" ? { always: true, controls: true } : zoom === "auto" && "auto",
          onError: () => onInvalid?.(),
        })
      })

      return () => {
        removed = true
        diagram?.destroy()
      }
    },
    [source, onInvalid, zoom],
  )

  return (
    <div
      ref={draw}
      className={cn(
        "pele",
        zoom === "always" &&
          "overflow-hidden [--pele-zoom-bottom:0] [--pele-zoom-right:0] [--pele-zoom-top:auto] [&>svg]:max-h-full [&>svg]:w-auto",
        props.className,
      )}
    />
  )
}
