import { useAtom } from "@effect/atom-react"
import type { Atom } from "effect/reactivity"
import { X } from "lucide-react"
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from "react"
import { Button } from "@/components/ui/button"

const minWidth = 320

const widthStep = 32

const maxWidth = () => Math.max(minWidth, Math.round(window.innerWidth * 0.6))

const clampWidth = (width: number) => Math.min(maxWidth(), Math.max(minWidth, width))

function ResizeHandle(props: { name: string; width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, width: props.width }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return

    props.onResize(drag.current.width + drag.current.x - event.clientX)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: widthStep, ArrowRight: -widthStep }[event.key]

    if (step === undefined) return

    event.preventDefault()
    props.onResize(props.width + step)
  }

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- A focusable separator is the ARIA window splitter, which `hr` can't be.
      role="separator"
      aria-label={`Resize the ${props.name}`}
      aria-orientation="vertical"
      aria-valuenow={props.width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth()}
      tabIndex={0}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 hover:after:bg-ring focus-visible:after:bg-ring"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={onKeyDown}
    />
  )
}

/**
 * A panel on the right of a view, at a width the user can drag and that `width` keeps. Its content
 * comes in as `children`, so a drag re-renders only the frame.
 */
export function SidePanel(props: {
  name: string
  heading: ReactNode
  width: Atom.Writable<number>
  onClose: () => void
  children: ReactNode
}) {
  const [stored, setWidth] = useAtom(props.width)
  const width = clampWidth(stored)

  return (
    <aside
      aria-label={props.name}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l bg-background"
    >
      <ResizeHandle
        name={props.name}
        width={width}
        onResize={(next) => setWidth(clampWidth(next))}
      />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-5">
        <h2 className="min-w-0 flex-1 truncate font-medium">{props.heading}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Close the ${props.name}`}
          onClick={props.onClose}
        >
          <X aria-hidden />
        </Button>
      </header>
      {props.children}
    </aside>
  )
}
