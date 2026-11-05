import type { TourDiagram as Diagram, TourDiagramNode } from "@glass/contracts"
import { useId, useLayoutEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { fileName } from "./fileName"

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

// Edges to the next node run straight across the rail; any other edge routes
// below it in its own lane so skips and loops never cross the nodes.
const connection = (from: Box, to: Box, lane: number) => {
  const direct = lane === -1
  const startX = direct ? from.left + from.width : from.left + from.width / 2
  const endX = direct ? to.left : to.left + to.width / 2
  const center = from.top + from.height / 2
  const y = from.top + from.height + 12 + lane * 10

  return {
    path: direct
      ? `M ${startX} ${center} L ${endX - 3} ${to.top + to.height / 2}`
      : `M ${startX} ${from.top + from.height} V ${y} H ${endX} V ${to.top + to.height + 3}`,
    labelX: (startX + endX) / 2,
    labelY: direct ? center - 8 : y - 4,
  }
}

export function TourDiagram(props: {
  diagram: Diagram
  chapterTitle: string
  path: string | undefined
  onSelect: (node: TourDiagramNode) => void
}) {
  const { diagram } = props
  const marker = useId().replaceAll(":", "")
  const container = useRef<HTMLDivElement>(null)
  const [boxes, setBoxes] = useState<ReadonlyMap<string, Box>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [stepIndex, setStepIndex] = useState(-1)
  const steps = diagram.steps ?? []
  const step = stepIndex < 0 ? null : steps[stepIndex]!

  const selectStep = (index: number) => {
    setStepIndex(index)

    if (index < 0) return

    const node = diagram.nodes.find((entry) => entry.id === steps[index]!.nodes[0])!
    setSelected(node.id)
    props.onSelect(node)
    container.current
      ?.querySelector(`[data-diagram-node="${CSS.escape(node.id)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }

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
    <figure
      className="mb-3 shrink-0 border-b pb-3"
      aria-label={`Change diagram for ${props.chapterTitle}`}
    >
      {steps.length > 0 && (
        <fieldset className="mb-2 flex min-w-0 items-start gap-2" aria-label="Flow steps">
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous flow step"
              disabled={stepIndex < 0}
              onClick={() => selectStep(stepIndex - 1)}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Next flow step"
              disabled={stepIndex === steps.length - 1}
              onClick={() => selectStep(stepIndex + 1)}
            >
              <ChevronRight aria-hidden />
            </Button>
            <span className="ml-1 font-mono text-[11px] text-muted-foreground tabular-nums">
              {stepIndex < 0 ? "Overview" : `${stepIndex + 1} / ${steps.length}`}
            </span>
          </div>
          <div className="min-w-0 flex-1 pt-0.5 text-xs leading-5" aria-live="polite">
            <p className="wrap-anywhere">
              {step?.caption ?? "Follow the flow through the changed code."}
            </p>
            {step !== null && step.stateChanges.length > 0 && (
              <dl className="flex flex-wrap gap-x-4 text-[11px]">
                {step.stateChanges.map((change, index) => (
                  <div key={index} className="flex min-w-0 gap-x-2">
                    <dt className="min-w-0 text-muted-foreground wrap-anywhere">{change.label}</dt>
                    <dd className="font-mono wrap-anywhere">
                      <del className="text-muted-foreground">{change.before}</del> → {change.after}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </fieldset>
      )}
      {/* The padding leaves room for focus outlines the scroller would otherwise clip. */}
      <div className="-m-1.5 overflow-x-auto p-1.5 [scrollbar-width:thin]">
        <div className="relative min-w-min" ref={container}>
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

              const { path, labelX, labelY } = connection(from, to, routed.indexOf(edge))

              return (
                <g
                  key={`${edge.from}-${edge.to}`}
                  className="transition-opacity duration-200 ease-out"
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
                      x={labelX}
                      y={labelY}
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
          <ol className="relative flex gap-7" style={{ paddingBottom: gutter }}>
            {diagram.nodes.map((node) => {
              const { target } = node
              const name = fileName(target.path)

              const range =
                target.startLine === target.endLine
                  ? `${target.startLine}`
                  : `${target.startLine}–${target.endLine}`

              return (
                <li key={node.id} className="max-w-80 min-w-40 flex-1">
                  <button
                    type="button"
                    data-diagram-node={node.id}
                    aria-pressed={selected === node.id && props.path === target.path}
                    data-flow-active={step?.nodes.includes(node.id) || undefined}
                    aria-label={`${node.label}, ${changes[node.change]}. Show ${target.path}, ${target.side} lines ${range}`}
                    title={`${node.label}\n${target.path}:${range} (${target.side})`}
                    onClick={() => {
                      setSelected(node.id)
                      props.onSelect(node)
                    }}
                    className="h-full w-full cursor-pointer rounded-[7px] border bg-background px-2.5 py-2 text-left transition-transform duration-150 ease-out hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] aria-pressed:border-(--viewed) aria-pressed:bg-[color-mix(in_oklch,var(--viewed)_10%,var(--background))] data-flow-active:border-(--viewed)"
                  >
                    <span className="line-clamp-2 text-xs leading-4.5 font-medium wrap-anywhere">
                      {node.label}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 text-[10px] leading-4">
                      {node.change !== "unchanged" && (
                        <span
                          className={node.change === "added" ? "text-added" : "text-deleted"}
                          aria-hidden
                        >
                          {node.change === "added" ? "+" : "−"}
                        </span>
                      )}
                      <span className="min-w-0 truncate font-mono text-muted-foreground">
                        {name}:{range}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      </div>
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
