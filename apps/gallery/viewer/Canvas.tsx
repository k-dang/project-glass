import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react"
import type { Shot } from "../shot.ts"
import {
  alt,
  schemesShown,
  sizeOf,
  src,
  type Detail,
  type Framing,
  type SchemeChoice,
} from "./model.ts"

interface Camera {
  x: number
  y: number
  z: number
}

// The page holds one canvas, and its camera outlives each mount: leaving for One view and coming
// back keeps the zoom. Null until the first mount fits the world.
let saved: Camera | null = null

// Zoomed out, every shot is on screen at once and Chromium can't keep them all decoded at full
// size, so show the 320px thumbnails until a shot would be drawn wider than they are.
const detailAt = (z: number): Detail => (z * devicePixelRatio <= 0.25 ? "thumb" : "full")

const pans = new Map<string, readonly [number, number]>([
  ["ArrowLeft", [1, 0]],
  ["ArrowRight", [-1, 0]],
  ["ArrowUp", [0, 1]],
  ["ArrowDown", [0, -1]],
])

// The camera moves every frame while panning, so it writes styles straight to the DOM instead of
// going through React state.
const cameraOn = (
  canvas: HTMLElement,
  world: HTMLElement,
  label: HTMLOutputElement,
  camera: Camera,
  onDetail: (detail: Detail) => void,
) => {
  let settle = 0

  const apply = () => {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`
    let dots = 32 * camera.z

    while (dots < 16) dots *= 2
    canvas.style.backgroundSize = `${dots}px ${dots}px`
    canvas.style.backgroundPosition = `${camera.x}px ${camera.y}px`
    label.textContent = `${Math.round(camera.z * 100)}%`
    onDetail(detailAt(camera.z))
    // Promote the world to its own layer only while it moves, so it re-rasterizes sharp once it stops.
    world.classList.add("moving")
    clearTimeout(settle)
    settle = window.setTimeout(() => world.classList.remove("moving"), 150)
  }

  const pan = (dx: number, dy: number) => {
    camera.x += dx
    camera.y += dy
    apply()
  }

  const zoomAt = (x: number, y: number, z: number) => {
    const next = Math.min(2, Math.max(0.02, z))
    camera.x = x - ((x - camera.x) / camera.z) * next
    camera.y = y - ((y - camera.y) / camera.z) * next
    camera.z = next
    apply()
  }

  const zoomBy = (factor: number) =>
    zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, camera.z * factor)

  const fit = () => {
    const width = world.offsetWidth
    const height = world.offsetHeight
    camera.z = Math.min(canvas.clientWidth / width, canvas.clientHeight / height)
    camera.x = (canvas.clientWidth - width * camera.z) / 2
    camera.y = (canvas.clientHeight - height * camera.z) / 2
    apply()
  }

  return {
    apply,
    pan,
    zoomBy,
    fit,
    zoomAtPointer: (clientX: number, clientY: number, factor: number) => {
      const box = canvas.getBoundingClientRect()
      zoomAt(clientX - box.left, clientY - box.top, camera.z * factor)
    },
    center: (figure: Element) => {
      const box = figure.getBoundingClientRect()
      const frame = canvas.getBoundingClientRect()
      pan(
        frame.left + frame.width / 2 - (box.left + box.width / 2),
        frame.top + frame.height / 2 - (box.top + Math.min(box.height, frame.height) / 2),
      )
    },
    key: (event: KeyboardEvent) => {
      const step = pans.get(event.key)

      if (step !== undefined) pan(step[0] * 120, step[1] * 120)
      else if (event.key === "=" || event.key === "+") zoomBy(1.25)
      else if (event.key === "-") zoomBy(0.8)
      else if (event.key === "0" || event.key === "f") fit()
      else return false

      return true
    },
    stop: () => clearTimeout(settle),
  }
}

type Controls = ReturnType<typeof cameraOn>

export interface CanvasHandle {
  readonly key: (event: KeyboardEvent) => boolean
}

const figureId = (target: EventTarget | null) =>
  target instanceof Element ? target.closest("figure")?.dataset["id"] : undefined

interface Drag {
  readonly id: number
  x: number
  y: number
  moved: boolean
  readonly figure: string | undefined
}

interface CanvasProps {
  readonly ref: Ref<CanvasHandle>
  readonly areas: ReadonlyMap<string, ReadonlyArray<Shot>>
  readonly current: Shot | undefined
  readonly scheme: SchemeChoice
  readonly framing: Framing
  readonly onOpen: (id: string) => void
}

export const Canvas = ({ ref, areas, current, scheme, framing, onOpen }: CanvasProps) => {
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLOutputElement>(null)
  const controls = useRef<Controls | null>(null)
  const drag = useRef<Drag | null>(null)
  const [detail, setDetail] = useState(() => detailAt(saved?.z ?? 0))
  const schemes = schemesShown(scheme)
  // Short lanes share a row: wrap at the widest lane's width.
  const widest = Math.max(1, ...[...areas.values()].map((lane) => lane.length)) * schemes.length

  useImperativeHandle(ref, () => ({ key: (event) => controls.current?.key(event) ?? false }), [])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const world = worldRef.current
    const label = labelRef.current

    if (canvas === null || world === null || label === null) return undefined

    const seen = saved
    saved ??= { x: 0, y: 0, z: 1 }
    const control = cameraOn(canvas, world, label, saved, setDetail)
    controls.current = control
    const at = world.querySelector("figure[aria-current]")

    if (seen === null) control.fit()
    else {
      // Centering measures the figure on screen, so the saved camera has to be in place first.
      control.apply()

      if (at !== null) control.center(at)
    }

    const wheel = (event: WheelEvent) => {
      event.preventDefault()

      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? canvas.clientHeight
            : 1

      // A pinch sends small deltas and a mouse wheel notch about 100, so cap each event's step.
      const delta = Math.max(-30, Math.min(30, event.deltaY * unit))

      if (event.ctrlKey || event.metaKey)
        return control.zoomAtPointer(event.clientX, event.clientY, Math.exp(-delta * 0.01))

      const sideways = event.shiftKey && event.deltaX === 0

      return control.pan(
        -(sideways ? event.deltaY : event.deltaX) * unit,
        -(sideways ? 0 : event.deltaY) * unit,
      )
    }

    canvas.addEventListener("wheel", wheel, { passive: false })

    return () => {
      canvas.removeEventListener("wheel", wheel)
      control.stop()
      controls.current = null
    }
  }, [])

  const endDrag = () => {
    drag.current = null
    canvasRef.current?.classList.remove("dragging")
  }

  return (
    <div
      className="canvas"
      ref={canvasRef}
      aria-label="Canvas of every state"
      onPointerDown={(event) => {
        if (event.button !== 0 && event.button !== 1) return

        if (event.target instanceof Element && event.target.closest(".zoom") !== null) return

        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          moved: false,
          figure: figureId(event.target),
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const held = drag.current

        if (held === null || held.id !== event.pointerId) return

        const dx = event.clientX - held.x
        const dy = event.clientY - held.y

        if (!held.moved) {
          if (Math.hypot(dx, dy) < 4) return

          held.moved = true
          event.currentTarget.classList.add("dragging")
        }

        held.x = event.clientX
        held.y = event.clientY
        controls.current?.pan(dx, dy)
      }}
      onPointerUp={(event) => {
        const held = drag.current

        if (held === null || held.id !== event.pointerId) return

        endDrag()

        if (!held.moved && held.figure !== undefined) onOpen(held.figure)
      }}
      onPointerCancel={endDrag}
    >
      <div className="world" ref={worldRef} style={{ width: `${widest * 1400}px` }}>
        {[...areas].map(([area, lane]) => (
          <section className="lane" key={area}>
            <h3>{area}</h3>
            <div className="lane-shots">
              {lane.map((shot) => {
                const { width, height } = sizeOf(shot, framing)

                return (
                  <figure
                    key={shot.id}
                    data-id={shot.id}
                    aria-current={shot === current ? "true" : undefined}
                  >
                    <div className="pair">
                      {schemes.map((tone) => (
                        <img
                          key={tone}
                          decoding="async"
                          draggable={false}
                          width={width}
                          height={height}
                          src={src(shot, tone, framing, detail)}
                          alt={alt(shot, tone)}
                        />
                      ))}
                    </div>
                    <figcaption>{shot.name}</figcaption>
                  </figure>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      <div className="zoom">
        <button type="button" aria-label="Zoom out" onClick={() => controls.current?.zoomBy(0.8)}>
          −
        </button>
        <output ref={labelRef}>100%</output>
        <button type="button" aria-label="Zoom in" onClick={() => controls.current?.zoomBy(1.25)}>
          +
        </button>
        <button type="button" onClick={() => controls.current?.fit()}>
          Fit
        </button>
      </div>
    </div>
  )
}
