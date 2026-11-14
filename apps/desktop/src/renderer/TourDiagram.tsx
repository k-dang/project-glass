import type { TourDiagram as Diagram, TourDiagramNode } from "@glass/contracts"
import { cn } from "cn"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { fileName } from "./fileName"
import { diagramEdgeText, layOutTourDiagram, type DiagramSize } from "./tourDiagramLayout"
import { twoDigits } from "./tourProgress"

const colors = {
  unchanged: "var(--muted-foreground)",
  added: "var(--added)",
  removed: "var(--deleted)",
}

const roomForFocusOutlines = "-m-1.5 p-1.5"

const changes = { unchanged: "Unchanged", added: "Added", removed: "Removed" }

const signs = { unchanged: "", added: "+ ", removed: "− " }

export function TourDiagram(props: {
  diagram: Diagram
  chapterTitle: string
  chapterOf?: ReadonlyMap<string, number>
  className?: string
  onSelect: (node: TourDiagramNode) => void
}) {
  const { diagram } = props
  const marker = useId().replaceAll(":", "")
  const container = useRef<HTMLDivElement>(null)

  const [sizes, setSizes] = useState<{
    nodes: ReadonlyMap<string, DiagramSize>
    edges: ReadonlyArray<DiagramSize>
  }>({ nodes: new Map(), edges: [] })

  const drawing = useMemo(
    () => layOutTourDiagram(diagram, sizes.nodes, sizes.edges),
    [diagram, sizes],
  )

  const [selected, setSelected] = useState<string | null>(null)
  const [stepIndex, setStepIndex] = useState(-1)
  const steps = diagram.steps ?? []
  const step = steps[stepIndex] ?? null

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
      const nodeSizes = new Map<string, DiagramSize>(
        diagram.nodes.map((node) => {
          const button = buttons.get(node.id)!

          return [node.id, { width: button.offsetWidth || 184, height: button.offsetHeight || 88 }]
        }),
      )

      const edgeSizes = diagram.edges.map((edge, index) => {
        const label = diagramEdgeText(edge)
        const text = root.querySelector<SVGTextElement>(`[data-edge-label="${index}"]`)
        const box = text?.getBoundingClientRect()

        return {
          width: box?.width || label.length * 7,
          height: label === "" ? 0 : 18,
        }
      })

      setSizes({ nodes: nodeSizes, edges: edgeSizes })
    }

    measure()
    const observer = new ResizeObserver(measure)

    for (const button of buttons.values()) observer.observe(button)

    return () => observer.disconnect()
  }, [diagram])

  const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]))

  return (
    <figure
      className={cn("flex min-h-0 shrink-0 flex-col", props.className)}
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
      <div className={cn(roomForFocusOutlines, "min-h-0 overflow-auto [scrollbar-width:thin]")}>
        <div
          className="relative mx-auto"
          ref={container}
          style={{ width: drawing.width, height: drawing.height }}
        >
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
            {drawing.edges.map((edge, edgeIndex) => (
              <g
                key={`${edge.from}-${edge.to}`}
                className="transition-opacity duration-200 ease-out motion-reduce:transition-none"
                opacity={step === null || step.edges.includes(edgeIndex) ? 1 : 0.25}
              >
                <path
                  d={edge.path}
                  fill="none"
                  stroke={colors[edge.change]}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeDasharray={edge.change === "removed" ? "4 3" : undefined}
                  markerEnd={`url(#${marker}-${edge.change})`}
                />
                {edge.text !== "" && (
                  <text
                    data-edge-label={edgeIndex}
                    x={edge.x}
                    y={edge.y}
                    fill={colors[edge.change]}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="font-mono text-[11px]"
                    style={{
                      paintOrder: "stroke",
                      stroke: "var(--background)",
                      strokeWidth: 5,
                      strokeLinejoin: "round",
                    }}
                  >
                    {edge.text}
                  </text>
                )}
              </g>
            ))}
          </svg>
          <ol>
            {drawing.nodes.map((node) => {
              const { target } = node

              const range =
                target.startLine === target.endLine
                  ? `${target.startLine}`
                  : `${target.startLine}–${target.endLine}`

              const chapter = props.chapterOf?.get(target.path)

              return (
                <li
                  key={node.id}
                  className="absolute w-46"
                  style={{ left: node.left, top: node.top }}
                >
                  <button
                    type="button"
                    data-diagram-node={node.id}
                    data-change={node.change}
                    aria-pressed={selected === node.id}
                    data-flow-active={step?.nodes.includes(node.id) || undefined}
                    aria-label={`${node.label}, ${changes[node.change]}. Show ${target.path}, ${target.side} lines ${range}`}
                    title={`${node.label}\n${target.path}:${range} (${target.side})`}
                    onClick={() => {
                      setSelected(node.id)
                      props.onSelect(node)
                    }}
                    className="w-full cursor-pointer rounded-[7px] border bg-background px-3 py-2.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] data-[change=added]:border-added/50 data-[change=added]:bg-[color-mix(in_oklch,var(--added)_5%,var(--background))] data-[change=removed]:border-deleted/50 data-[change=removed]:bg-[color-mix(in_oklch,var(--deleted)_5%,var(--background))] aria-pressed:border-(--viewed) aria-pressed:outline-2 aria-pressed:outline-(--viewed) data-flow-active:border-(--viewed)"
                  >
                    <span className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span style={{ color: colors[node.change] }}>
                        {signs[node.change]}
                        {changes[node.change]}
                      </span>
                      {chapter !== undefined && (
                        <span className="font-mono">Chapter {twoDigits(chapter + 1)} ↗</span>
                      )}
                    </span>
                    <span className="block text-xs leading-4.5 font-medium wrap-anywhere">
                      {node.label}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
                      {fileName(target.path)}:{range}
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
            {edge.label !== undefined && `, ${edge.label}`}
          </li>
        ))}
      </ul>
    </figure>
  )
}
