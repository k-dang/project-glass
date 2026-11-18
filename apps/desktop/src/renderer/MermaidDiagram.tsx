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
  zoomable?: boolean
  className?: string
}) {
  const { source, onInvalid, zoomable = false } = props

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
          zoom: zoomable ? { always: true, controls: true } : "auto",
          onError: () => onInvalid?.(),
        })
      })

      return () => {
        removed = true
        diagram?.destroy()
      }
    },
    [source, onInvalid, zoomable],
  )

  return (
    <div
      ref={draw}
      className={cn(
        "pele",
        zoomable && "[--pele-zoom-bottom:0] [--pele-zoom-right:0] [--pele-zoom-top:auto]",
        props.className,
      )}
    />
  )
}
