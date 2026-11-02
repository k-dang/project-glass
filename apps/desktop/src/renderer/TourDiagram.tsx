import type { TourDiagram as Diagram, TourDiagramNode } from "@glass/contracts"
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const colors = {
  unchanged: "var(--muted-foreground)",
  added: "var(--added)",
  removed: "var(--deleted)",
}

const changes = { unchanged: "Unchanged", added: "Added", removed: "Removed" }

export function TourDiagram(props: {
  diagram: Diagram
  chapterTitle: string
  path: string | undefined
  onSelect: (node: TourDiagramNode) => void
}) {
  const { diagram } = props
  const marker = useId().replaceAll(":", "")
  const playback = useRef<HTMLFieldSetElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const [boxes, setBoxes] = useState<ReadonlyMap<string, Box>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [stepIndex, setStepIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const steps = diagram.steps ?? []
  const step = stepIndex < 0 ? null : steps[stepIndex]!

  const selectStep = (index: number) => {
    setStepIndex(index)

    if (index < 0) return

    const node = diagram.nodes.find((entry) => entry.id === steps[index]!.nodes[0])!
    setSelected(node.id)
    props.onSelect(node)
  }

  const advance = useEffectEvent(() => {
    const next = stepIndex + 1
    selectStep(next)

    if (next === steps.length - 1) setPlaying(false)
  })

  useEffect(() => {
    if (!playing) return undefined
    const timer = window.setInterval(advance, 2500)

    return () => window.clearInterval(timer)
  }, [playing])

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden) setPlaying(false)
    }

    document.addEventListener("visibilitychange", pauseWhenHidden)

    return () => document.removeEventListener("visibilitychange", pauseWhenHidden)
  }, [])

  useEffect(() => {
    const element = playback.current

    if (element === null) return undefined

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) setPlaying(false)
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [])
  const order = new Map(diagram.nodes.map((node, index) => [node.id, index]))
  const routed = diagram.edges.filter((edge) => order.get(edge.to)! !== order.get(edge.from)! + 1)
  const gutter = routed.length === 0 ? 0 : 16 + routed.length * 10

  useLayoutEffect(() => {
    const root = container.current

    if (root === null) return undefined

    const buttons = new Map(
      [...root.querySelectorAll<HTMLButtonElement>("[data-diagram-node]")].map((button) => [
        button.dataset.diagramNode!,
        button,
      ]),
    )

    const measure = () => {
      const origin = root.getBoundingClientRect()

      setBoxes(
        new Map(
          diagram.nodes.map((node) => {
            const box = buttons.get(node.id)!.getBoundingClientRect()

            return [
              node.id,
              {
                left: box.left - origin.left,
                top: box.top - origin.top,
                width: box.width,
                height: box.height,
              },
            ]
          }),
        ),
      )
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)

    for (const button of buttons.values()) observer.observe(button)

    return () => observer.disconnect()
  }, [diagram])

  const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]))

  return (
    <figure className="my-5" aria-label={`Change diagram for ${props.chapterTitle}`}>
      {steps.length > 0 && (
        <fieldset ref={playback} className="mb-4 min-w-0" aria-label="Flow playback">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous flow step"
              disabled={stepIndex < 0}
              onClick={() => {
                setPlaying(false)
                selectStep(stepIndex - 1)
              }}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="xs"
              aria-label={playing ? "Pause flow" : "Play flow"}
              onClick={() => {
                if (playing) setPlaying(false)
                else {
                  if (stepIndex < 0 || stepIndex === steps.length - 1) selectStep(0)
                  setPlaying(true)
                }
              }}
            >
              {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
              {playing ? "Pause" : "Play"}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Next flow step"
              disabled={stepIndex === steps.length - 1}
              onClick={() => {
                setPlaying(false)
                selectStep(stepIndex + 1)
              }}
            >
              <ChevronRight aria-hidden />
            </Button>
            <span className="ml-1 font-mono text-[11px] text-muted-foreground">
              {stepIndex < 0 ? "Overview" : `${stepIndex + 1} / ${steps.length}`}
            </span>
          </div>
          <p className="text-xs leading-5 wrap-anywhere" aria-live="polite">
            {step?.caption ?? "Follow the flow through the changed code."}
          </p>
          {step !== null && step.stateChanges.length > 0 && (
            <dl className="mt-2 space-y-1 text-[11px]">
              {step.stateChanges.map((change, index) => (
                <div key={index} className="flex flex-wrap gap-x-2">
                  <dt className="min-w-0 text-muted-foreground wrap-anywhere">{change.label}</dt>
                  <dd className="font-mono wrap-anywhere">
                    <del className="text-muted-foreground">{change.before}</del> → {change.after}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </fieldset>
      )}
      <div className="relative" ref={container}>
        <svg
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
          aria-hidden
        >
          <defs>
            {Object.entries(colors).map(([change, color]) => (
              <marker
                key={change}
                id={`${marker}-${change}`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 1 1 L 7 4 L 1 7" fill="none" stroke={color} strokeWidth="1.5" />
              </marker>
            ))}
          </defs>
          {diagram.edges.map((edge, edgeIndex) => {
            const from = boxes.get(edge.from)
            const to = boxes.get(edge.to)

            if (from === undefined || to === undefined) return null

            const lane = routed.indexOf(edge)
            const direct = lane === -1
            const x = from.left + from.width + 12 + lane * 10
            const startY = direct ? from.top + from.height : from.top + from.height / 2
            const endY = direct ? to.top : to.top + to.height / 2
            const center = from.left + from.width / 2

            const path = direct
              ? `M ${center} ${startY} V ${endY - 3}`
              : `M ${from.left + from.width} ${startY} H ${x} V ${endY} H ${to.left + to.width + 3}`

            return (
              <g
                key={`${edge.from}-${edge.to}`}
                opacity={step === null || step.edges.includes(edgeIndex) ? 1 : 0.25}
              >
                <path
                  d={path}
                  fill="none"
                  stroke={colors[edge.change]}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeDasharray={edge.change === "removed" ? "4 3" : undefined}
                  markerEnd={`url(#${marker}-${edge.change})`}
                />
                {edge.change !== "unchanged" && (
                  <text
                    x={direct ? center + 8 : x + 3}
                    y={(startY + endY) / 2 + 4}
                    fill={colors[edge.change]}
                    className="font-mono text-[11px]"
                  >
                    {edge.change === "added" ? "+" : "−"}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        <ol className="relative flex flex-col gap-7" style={{ paddingRight: gutter }}>
          {diagram.nodes.map((node) => {
            const { target } = node
            const name = target.path.slice(target.path.lastIndexOf("/") + 1)

            const range =
              target.startLine === target.endLine
                ? `${target.startLine}`
                : `${target.startLine}–${target.endLine}`

            return (
              <li key={node.id}>
                <button
                  type="button"
                  data-diagram-node={node.id}
                  aria-pressed={selected === node.id && props.path === target.path}
                  data-flow-active={step?.nodes.includes(node.id) || undefined}
                  aria-label={`${node.label}, ${changes[node.change]}. Show ${target.path}, ${target.side} lines ${range}`}
                  title={`${target.path}:${range} (${target.side})`}
                  onClick={() => {
                    setSelected(node.id)
                    setPlaying(false)
                    props.onSelect(node)
                  }}
                  className="w-full cursor-pointer rounded-[7px] border bg-background px-3 py-2.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ring aria-pressed:border-(--viewed) aria-pressed:bg-[color-mix(in_oklch,var(--viewed)_10%,var(--background))] data-flow-active:border-(--viewed)"
                >
                  <span className="block text-[13px] leading-5 font-medium wrap-anywhere">
                    {node.label}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4">
                    {node.change !== "unchanged" && (
                      <span className={node.change === "added" ? "text-added" : "text-deleted"}>
                        {node.change === "added" ? "+ Added" : "− Removed"}
                      </span>
                    )}
                    <span className="min-w-0 font-mono text-muted-foreground wrap-anywhere">
                      {name}:{range}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </div>
      <figcaption className="mt-3 text-[11px] leading-4 text-muted-foreground">
        Select a node to show its diff. + added · − removed
      </figcaption>
      <ul className="sr-only">
        {diagram.edges.map((edge) => (
          <li key={`${edge.from}-${edge.to}`}>
            {labels.get(edge.from)} → {labels.get(edge.to)}: {changes[edge.change]}
          </li>
        ))}
      </ul>
    </figure>
  )
}
