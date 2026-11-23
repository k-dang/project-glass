import { useLayoutEffect, useRef } from "react"
import { fadeIn } from "./fadeIn"

export function ThreadName(props: { name: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(props.name)

  useLayoutEffect(() => {
    if (shown.current === props.name || ref.current === null) return

    shown.current = props.name
    fadeIn(ref.current, { filter: "blur(2px)" }, 150)
  }, [props.name])

  return (
    <span ref={ref} className={props.className}>
      {props.name}
    </span>
  )
}
