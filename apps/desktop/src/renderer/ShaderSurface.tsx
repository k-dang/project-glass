import { cn } from "cn"
import { useEffect, useRef, useSyncExternalStore } from "react"
import { darkScheme } from "./theme"
import { useWindowFocused } from "./useWindowFocused"

const vertexShader = `#version 300 es
in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`

export interface ShaderSize {
  readonly width: number
  readonly height: number
  readonly deviceWidth: number
  readonly deviceHeight: number
  readonly pixelRatio: number
}

export interface ShaderCanvas {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  readonly uniform: (name: string) => WebGLUniformLocation | null
  readonly paint: () => void
}

export interface ShaderDrawing {
  readonly resize: (size: ShaderSize) => void
  readonly restyle: () => void
  readonly draw: (seconds: number) => void
}

export interface ShaderDefinition {
  readonly canvasClassName: string
  readonly fragmentShader: string
  readonly framesPerSecond: number
  readonly stillSeconds: number
  readonly setup: (shader: ShaderCanvas, host: HTMLElement) => ShaderDrawing
}

interface Surface {
  readonly play: () => void
  readonly pause: () => void
  readonly dispose: () => void
}

const compile = (gl: WebGL2RenderingContext, type: GLenum, source: string) => {
  const shader = gl.createShader(type)

  if (shader === null) return null

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  return shader
}

const linkProgram = (gl: WebGL2RenderingContext, fragmentShader: string) => {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexShader)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentShader)

  if (vertex === null || fragment === null) return null

  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)

  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) return null

  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const corner = gl.getAttribLocation(program, "corner")
  gl.enableVertexAttribArray(corner)
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)

  return program
}

const runFrames = (framesPerSecond: number, advance: (seconds: number) => void) => {
  const interval = 1000 / framesPerSecond
  let frame = 0
  let due = performance.now()
  let drawn = due

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick)
    const late = now - due

    if (late < interval) return

    due = now - (late % interval)
    advance(Math.min(now - drawn, 100) / 1000)
    drawn = now
  }

  frame = requestAnimationFrame(tick)

  return () => cancelAnimationFrame(frame)
}

const startSurface = (
  host: HTMLElement,
  definition: ShaderDefinition,
  startSeconds: number,
): Surface | null => {
  const canvas = document.createElement("canvas")
  canvas.className = definition.canvasClassName
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true })

  if (gl === null) return null

  const program = linkProgram(gl, definition.fragmentShader)

  if (program === null) return null

  host.append(canvas)

  const drawing = definition.setup(
    {
      canvas,
      gl,
      uniform: (name) => gl.getUniformLocation(program, name),
      paint: () => {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      },
    },
    host,
  )

  let seconds = startSeconds
  let wanted = false
  let shown = false
  let disposed = false
  let stop: (() => void) | null = null
  const redraw = () => drawing.draw(seconds)

  const restyle = () => {
    drawing.restyle()
    redraw()
  }

  const sync = () => {
    if (wanted && shown && !disposed) {
      stop ??= runFrames(definition.framesPerSecond, (elapsed) => {
        seconds += elapsed
        redraw()
      })
    } else {
      stop?.()
      stop = null
    }
  }

  const resized = new ResizeObserver(([entry]) => {
    const box = entry?.devicePixelContentBoxSize[0]

    if (entry === undefined || box === undefined) return

    shown = entry.contentRect.width > 0 && entry.contentRect.height > 0
    sync()

    if (!shown) return

    drawing.resize({
      width: entry.contentRect.width,
      height: entry.contentRect.height,
      deviceWidth: box.inlineSize,
      deviceHeight: box.blockSize,
      pixelRatio: box.inlineSize / entry.contentRect.width,
    })
    redraw()
  })

  resized.observe(host, { box: "device-pixel-content-box" })
  const rethemed = new MutationObserver(restyle)
  rethemed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  darkScheme.addEventListener("change", restyle)
  drawing.restyle()

  const dispose = () => {
    if (disposed) return

    disposed = true
    sync()
    resized.disconnect()
    rethemed.disconnect()
    darkScheme.removeEventListener("change", restyle)
    gl.getExtension("WEBGL_lose_context")?.loseContext()
    canvas.remove()
  }

  canvas.addEventListener("webglcontextlost", dispose)

  return {
    play: () => {
      wanted = true
      sync()
    },
    pause: () => {
      wanted = false
      sync()
    },
    dispose,
  }
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

const subscribeToMotion = (onChange: () => void) => {
  reducedMotion.addEventListener("change", onChange)

  return () => reducedMotion.removeEventListener("change", onChange)
}

const prefersReducedMotion = () => reducedMotion.matches

export function ShaderSurface(props: { definition: ShaderDefinition; className?: string }) {
  const { definition } = props
  const host = useRef<HTMLDivElement>(null)
  const surface = useRef<Surface | null>(null)
  const focused = useWindowFocused()
  const reduced = useSyncExternalStore(subscribeToMotion, prefersReducedMotion)
  const moving = focused && !reduced
  const movingAtMount = useRef(moving)

  useEffect(() => {
    if (host.current === null) return undefined

    const started = startSurface(
      host.current,
      definition,
      movingAtMount.current ? 0 : definition.stillSeconds,
    )

    surface.current = started

    return () => {
      started?.dispose()
      surface.current = null
    }
  }, [definition])

  useEffect(() => {
    const current = surface.current

    if (current === null || !moving) return undefined

    current.play()

    return current.pause
  }, [moving])

  return <div ref={host} aria-hidden className={cn("pointer-events-none", props.className)} />
}
