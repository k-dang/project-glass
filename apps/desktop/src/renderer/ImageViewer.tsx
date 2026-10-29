import { ChevronLeft, ChevronRight, Maximize, Minus, Plus } from "lucide-react"
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"

export interface PreviewImage {
  readonly src: string
  readonly name: string
}

interface ImageCanvasHandle {
  readonly element: HTMLButtonElement | null
  readonly zoom: (factor: number) => void
  readonly fit: () => void
  readonly pan: (key: string) => boolean
}

export function ImageViewer(props: {
  images: ReadonlyArray<PreviewImage>
  index: number
  opener: HTMLElement
  onClose: () => void
}) {
  const [index, setIndex] = useState(props.index)
  const canvasRef = useRef<ImageCanvasHandle>(null)
  const refocusCanvas = useRef(false)
  const image = props.images[index]!

  const navigate = (direction: number) => {
    if (props.images.length < 2) return
    refocusCanvas.current = document.activeElement === canvasRef.current?.element
    setIndex((current) => (current + direction + props.images.length) % props.images.length)
  }

  useLayoutEffect(() => {
    if (refocusCanvas.current) {
      canvasRef.current?.element?.focus({ preventScroll: true })
      refocusCanvas.current = false
    }
  })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <DialogContent
        className="h-[90vh] w-[94vw] max-w-none grid-rows-[auto_minmax(0,1fr)] sm:max-w-none"
        initialFocus={() => canvasRef.current?.element ?? false}
        finalFocus={() => props.opener}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
          const canvas = canvasRef.current

          if (!canvas) return

          if (event.key === "+" || event.key === "=") canvas.zoom(1.5)
          else if (event.key === "-") canvas.zoom(1 / 1.5)
          else if (event.key === "0") canvas.fit()
          else if (canvas.pan(event.key)) {
            event.preventDefault()

            return
          } else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
            navigate(event.key === "ArrowLeft" ? -1 : 1)
          else return
          event.preventDefault()
        }}
      >
        <header className="flex min-w-0 items-center gap-3 pr-8">
          <DialogTitle className="min-w-0 flex-1 truncate">{image.name}</DialogTitle>
          {props.images.length > 1 && (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous image"
                onClick={() => navigate(-1)}
              >
                <ChevronLeft aria-hidden />
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                {index + 1} / {props.images.length}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next image"
                onClick={() => navigate(1)}
              >
                <ChevronRight aria-hidden />
              </Button>
            </div>
          )}
        </header>
        <DialogDescription className="sr-only">
          Click to zoom, scroll to zoom around the pointer, and drag to pan. Use plus and minus to
          zoom, 0 to fit, arrow keys to pan or change images, and Escape to close.
        </DialogDescription>
        <ImageCanvas key={index} image={image} ref={canvasRef} />
      </DialogContent>
    </Dialog>
  )
}

function ImageCanvas({
  image: previewImage,
  ref: canvasHandleRef,
}: {
  image: PreviewImage
  ref: Ref<ImageCanvasHandle>
}) {
  const viewportRef = useRef<HTMLButtonElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  const [failed, setFailed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null)
  const suppressClick = useRef(false)
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null)

  const fit =
    natural.width && size.width
      ? Math.min(1, size.width / natural.width, size.height / natural.height)
      : 1

  const width = natural.width * fit * zoom
  const height = natural.height * fit * zoom

  const changeZoom = useCallback((value: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current
    const image = imageRef.current
    const next = Math.min(8, Math.max(1, value))

    if (!viewport || !image || next === zoomRef.current) return
    const bounds = viewport.getBoundingClientRect()
    const rect = image.getBoundingClientRect()

    if (!rect.width || !rect.height) return
    const x = clientX ?? bounds.left + viewport.clientWidth / 2
    const y = clientY ?? bounds.top + viewport.clientHeight / 2
    anchor.current = {
      x: (x - rect.left) / rect.width,
      y: (y - rect.top) / rect.height,
      clientX: x,
      clientY: y,
    }
    zoomRef.current = next
    setZoom(next)
  }, [])

  useImperativeHandle(
    canvasHandleRef,
    () => ({
      element: viewportRef.current,
      zoom: (factor) => changeZoom(zoomRef.current * factor),
      fit: () => changeZoom(1),
      pan(key) {
        const viewport = viewportRef.current

        if (!viewport) return false

        switch (key) {
          case "ArrowLeft":
          case "ArrowRight":
            if (viewport.scrollWidth <= viewport.clientWidth) return false
            viewport.scrollLeft += key === "ArrowLeft" ? -40 : 40
            break
          case "ArrowUp":
            viewport.scrollTop -= 40
            break
          case "ArrowDown":
            viewport.scrollTop += 40
            break
          default:
            return false
        }

        return true
      },
    }),
    [changeZoom],
  )

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const point = anchor.current
    const rect = imageRef.current?.getBoundingClientRect()

    if (!viewport) return

    if (zoom === 1) viewport.scrollTo(0, 0)
    else if (point && rect)
      viewport.scrollBy(
        rect.left + point.x * rect.width - point.clientX,
        rect.top + point.y * rect.height - point.clientY,
      )
    anchor.current = null
  }, [zoom])

  useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport) return undefined

    const observer = new ResizeObserver(() => {
      setSize({ width: viewport.offsetWidth, height: viewport.offsetHeight })
    })

    observer.observe(viewport, { box: "border-box" })

    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return
      event.preventDefault()

      let unit = 1

      if (event.deltaMode === 1) unit = 16
      else if (event.deltaMode === 2) unit = viewport.clientHeight
      const delta = event.deltaY * unit

      changeZoom(
        zoomRef.current * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)),
        event.clientX,
        event.clientY,
      )
    }

    viewport.addEventListener("wheel", wheel, { passive: false })

    return () => {
      observer.disconnect()
      viewport.removeEventListener("wheel", wheel)
    }
  }, [changeZoom])

  return (
    <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3">
      <button
        type="button"
        ref={viewportRef}
        aria-label={`${previewImage.name}, zoomable image`}
        aria-pressed={zoom > 1}
        className="block min-h-0 overscroll-contain rounded-md bg-muted/40 p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          cursor: failed ? undefined : zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
          overflow: zoom === 1 ? "hidden" : "auto",
        }}
        onClick={(event) => {
          if (!suppressClick.current && event.detail <= 1)
            changeZoom(
              zoomRef.current > 1 ? 1 : 2,
              event.detail ? event.clientX : undefined,
              event.detail ? event.clientY : undefined,
            )
        }}
        onPointerDown={(event) => {
          if (drag.current || event.button !== 0) return
          suppressClick.current = false

          if (event.pointerType !== "mouse" || zoomRef.current <= 1) return
          const viewport = event.currentTarget
          const rect = viewport.getBoundingClientRect()

          if (
            event.clientX - rect.left >= viewport.clientWidth ||
            event.clientY - rect.top >= viewport.clientHeight
          )
            return
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
          }
          viewport.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current

          if (!start || start.id !== event.pointerId) return

          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)
            suppressClick.current = true
          event.currentTarget.scrollLeft = start.left - (event.clientX - start.x)
          event.currentTarget.scrollTop = start.top - (event.clientY - start.y)
        }}
        onPointerUp={(event) => {
          if (drag.current?.id !== event.pointerId) return
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={() => {
          drag.current = null
          setDragging(false)
        }}
      >
        <span className="flex min-h-full w-max min-w-full items-center justify-center">
          {failed ? (
            <span role="alert" className="p-6 text-muted-foreground">
              This image could not be loaded.
            </span>
          ) : (
            <img
              ref={imageRef}
              src={previewImage.src}
              alt={previewImage.name}
              draggable={false}
              className="block max-w-none shrink-0 select-none"
              style={natural.width ? { width, height } : { maxWidth: "100%", maxHeight: "70vh" }}
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(true)}
            />
          )}
        </span>
      </button>
      <div className="flex items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          disabled={failed || !natural.width || zoom <= 1}
          onClick={() => changeZoom(zoomRef.current / 1.5)}
        >
          <Minus aria-hidden />
        </Button>
        <span
          className="w-12 text-center text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {Math.round(fit * zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          disabled={failed || !natural.width || zoom >= 8}
          onClick={() => changeZoom(zoomRef.current * 1.5)}
        >
          <Plus aria-hidden />
        </Button>
        <Button variant="ghost" disabled={failed || !natural.width} onClick={() => changeZoom(1)}>
          <Maximize data-icon="inline-start" aria-hidden /> Fit
        </Button>
      </div>
    </div>
  )
}
