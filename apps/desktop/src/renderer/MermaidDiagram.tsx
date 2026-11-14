import DOMPurify from "dompurify"
import { mount } from "pele"
import { useCallback } from "react"

const sanitize = (svg: string) =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true },
    ADD_ATTR: ["role"],
    RETURN_DOM_FRAGMENT: true,
  })

export function MermaidDiagram(props: { source: string; onInvalid: () => void }) {
  const { source, onInvalid } = props

  const draw = useCallback(
    (element: HTMLDivElement) => {
      const diagram = mount(element, source, {
        links: false,
        images: false,
        fontSize: 14,
        sanitize,
        onError: onInvalid,
      })

      return () => diagram.destroy()
    },
    [source, onInvalid],
  )

  return <div ref={draw} className="pele" />
}
