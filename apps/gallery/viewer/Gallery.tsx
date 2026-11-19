import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import type { GalleryData } from "../shot.ts"
import { Canvas, type CanvasHandle } from "./Canvas.tsx"
import {
  alt,
  framingOptions,
  matches,
  openOnClick,
  schemeOptions,
  src,
  viewOptions,
  type Framing,
  type SchemeChoice,
  type View,
} from "./model.ts"
import { Sidebar } from "./Sidebar.tsx"
import { SingleStage } from "./SingleStage.tsx"

const nextScheme = { light: "dark", dark: "both", both: "light" } as const

interface SegmentProps<T extends string> {
  readonly options: ReadonlyArray<readonly [T, string]>
  readonly value: T
  readonly onChange: (value: T) => void
}

const Segment = <T extends string>({ options, value, onChange }: SegmentProps<T>) => (
  <div className="seg">
    {options.map(([choice, label]) => (
      <button
        key={choice}
        type="button"
        aria-pressed={choice === value}
        onClick={() => onChange(choice)}
      >
        {label}
      </button>
    ))}
  </div>
)

export const Gallery = ({ shots, capturedAt }: GalleryData) => {
  const exists = (id: string) => shots.some((shot) => shot.id === id)
  const [filter, setFilter] = useState("")
  const [scheme, setScheme] = useState<SchemeChoice>("light")
  const [framing, setFraming] = useState<Framing>("focus")
  const [view, setView] = useState<View>("single")

  const [currentId, setCurrentId] = useState(() => {
    const linked = location.hash.slice(1)

    return exists(linked) ? linked : shots[0]?.id
  })

  const filterRef = useRef<HTMLInputElement>(null)
  const canvas = useRef<CanvasHandle>(null)

  // The list, j/k stepping and the canvas lanes all share this grouped order.
  const areas = useMemo(
    () =>
      Map.groupBy(
        shots.filter((shot) => matches(shot, filter)),
        (shot) => shot.area,
      ),
    [shots, filter],
  )

  const shown = useMemo(() => [...areas.values()].flat(), [areas])
  const current = shots.find((shot) => shot.id === currentId)
  const index = current === undefined ? -1 : shown.indexOf(current)

  const show = (id: string) => {
    if (!exists(id)) return

    setCurrentId(id)
    setView("single")
  }

  // j/k replace the history entry, so Back skips the shots stepped through.
  const open = (id: string, entry: "push" | "replace" = "push") => {
    if (entry === "push") history.pushState(null, "", `#${id}`)
    else history.replaceState(null, "", `#${id}`)

    show(id)
  }

  const onPopState = useEffectEvent(() => show(location.hash.slice(1)))

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.isComposing) return

    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (view === "canvas" && canvas.current?.key(event) === true) return event.preventDefault()

    const step = (by: number) => {
      const next = shown[(index + by + shown.length) % shown.length]

      if (next !== undefined) open(next.id, "replace")
    }

    if (event.key === "c") setView(view === "canvas" ? "single" : "canvas")
    else if (event.key === "g") setView(view === "grid" ? "single" : "grid")
    else if (event.key === "d") setScheme(nextScheme[scheme])
    else if (event.key === "w") setFraming(framing === "whole" ? "focus" : "whole")
    else if (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "j") step(1)
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "k") step(-1)
    else if (event.key === "/") filterRef.current?.focus()
    else return

    event.preventDefault()
  })

  useEffect(() => {
    window.addEventListener("popstate", onPopState)
    document.addEventListener("keydown", onKey)

    return () => {
      window.removeEventListener("popstate", onPopState)
      document.removeEventListener("keydown", onKey)
    }
  }, [])

  const gridScheme = scheme === "dark" ? "dark" : "light"

  // The canvas lays out its world once per mount, so a new layout remounts it.
  const canvasLayout = `${scheme}|${framing}|${filter}`

  return (
    <>
      <Sidebar
        total={shots.length}
        capturedAt={capturedAt}
        areas={areas}
        current={view === "grid" ? undefined : current}
        filter={filter}
        onFilter={setFilter}
        filterRef={filterRef}
        onOpen={open}
      />
      <main>
        <div className="bar">
          <div className="title">
            {view === "single" ? (
              current !== undefined && (
                <>
                  {current.area} <span>/ {current.name}</span>
                </>
              )
            ) : (
              <>
                {view === "grid" ? "All states" : "Canvas"} <span>· {shown.length}</span>
              </>
            )}
          </div>
          <span className="keys">j k move · d theme · w whole window · g grid · c canvas</span>
          <Segment options={viewOptions} value={view} onChange={setView} />
          <Segment options={framingOptions} value={framing} onChange={setFraming} />
          <Segment options={schemeOptions} value={scheme} onChange={setScheme} />
        </div>
        {view === "single" && current !== undefined && (
          <SingleStage
            shot={current}
            previous={shown[index - 1]}
            next={shown[index + 1]}
            scheme={scheme}
            framing={framing}
          />
        )}
        {view === "grid" && (
          <div className="stage grid">
            {shown.map((shot) => (
              <a key={shot.id} href={`#${shot.id}`} onClick={openOnClick(open, shot.id)}>
                <figure>
                  <img
                    loading="lazy"
                    src={src(shot, gridScheme, framing, "thumb")}
                    alt={alt(shot, gridScheme)}
                  />
                  <figcaption>
                    {shot.area} · {shot.name}
                  </figcaption>
                </figure>
              </a>
            ))}
          </div>
        )}
        {view === "canvas" && (
          <Canvas
            key={canvasLayout}
            ref={canvas}
            areas={areas}
            current={current}
            scheme={scheme}
            framing={framing}
            onOpen={open}
          />
        )}
      </main>
    </>
  )
}
