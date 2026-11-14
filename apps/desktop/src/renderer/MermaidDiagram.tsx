import { cn } from "cn"
import DOMPurify from "dompurify"
import { mount } from "pele"
import { useCallback } from "react"

const sanitize = (svg: string) =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true },
    ADD_ATTR: ["role"],
    RETURN_DOM_FRAGMENT: true,
  })

/** `zoomable` fills its box and adds pan, zoom, and fit controls; otherwise it zooms only when shrunk. */
export function MermaidDiagram(props: {
  source: string
  onInvalid?: () => void
  zoomable?: boolean
  className?: string
}) {
  const { source, onInvalid, zoomable = false } = props

  const draw = useCallback(
    (element: HTMLDivElement) => {
      const diagram = mount(element, source, {
        links: false,
        images: false,
        fontSize: 14,
        sanitize,
        zoom: zoomable ? { always: true, controls: true } : "auto",
        onError: () => onInvalid?.(),
      })

      return () => diagram.destroy()
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
