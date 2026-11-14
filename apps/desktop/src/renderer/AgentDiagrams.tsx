import {
  type Diagram,
  diagramIn,
  type DiagramKind,
  DRAW_DIAGRAM_TOOL,
  drawnDiagramOf,
  type ToolCallPart,
  type Turn,
} from "@glass/contracts"
import { cn } from "cn"
import { Predicate } from "effect"
import { Atom } from "effect/reactivity"
import { LoaderCircle, Workflow } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { MermaidDiagram } from "./MermaidDiagram"
import { SidePanel } from "./SidePanel"

const kindLabel: Record<DiagramKind, string> = {
  existing: "Existing behavior",
  proposed: "Proposed design",
  uncertain: "Uncertain inference",
}

const drawingsIn = (turn: Turn) =>
  turn.parts.flatMap((part) => {
    if (!Predicate.isTagged(part, "ToolCall")) return []

    const diagram = drawnDiagramOf(part)

    return diagram === null ? [] : [{ toolCallId: part.toolCallId, diagram }]
  })

export const diagramsOf = (turns: ReadonlyArray<Turn>) => {
  const drawings = turns.flatMap(drawingsIn)

  const diagrams = new Map(drawings.map(({ diagram }) => [diagram.title, diagram] as const))

  return { diagrams, latestDrawing: drawings.at(-1) ?? null }
}

const cardStatus = (call: typeof ToolCallPart.Type, diagram: Diagram | null) => {
  if (call.status === "failed")
    return { text: "Glass couldn't draw this version, so the last one stays.", refused: true }

  if (call.status === "running" || diagram === null) return { text: "Drawing…", refused: false }

  return { text: kindLabel[diagram.kind], refused: false }
}

function DiagramCard(props: { call: typeof ToolCallPart.Type; onOpen: (title: string) => void }) {
  const { call } = props
  const diagram = diagramIn(call)
  const { text, refused } = cardStatus(call, diagram)

  return (
    <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
      {call.status === "running" ? (
        <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Workflow aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm font-medium">{diagram?.title ?? "Diagram"}</p>
        <p className={cn("text-xs", refused ? "text-destructive" : "text-muted-foreground")}>
          {text}
        </p>
      </div>
      {call.status === "done" && diagram !== null && (
        <Button size="sm" variant="outline" onClick={() => props.onOpen(diagram.title)}>
          Open
        </Button>
      )}
    </div>
  )
}

const paneWidthAtom = Atom.make(560).pipe(Atom.keepAlive)

export function DiagramPane(props: { diagram: Diagram; onClose: () => void }) {
  return (
    <SidePanel
      name="Diagram"
      heading={props.diagram.title}
      width={paneWidthAtom}
      onClose={props.onClose}
    >
      <p className="px-5 pt-3 text-xs text-muted-foreground">{kindLabel[props.diagram.kind]}</p>
      <MermaidDiagram source={props.diagram.mermaid} zoomable className="m-4 min-h-0 flex-1" />
    </SidePanel>
  )
}

export function useDiagrams(turns: ReadonlyArray<Turn>, loaded: boolean) {
  const { diagrams, latestDrawing } = useMemo(() => diagramsOf(turns), [turns])
  const [open, setOpen] = useState<string | null>(null)
  const [seenDrawing, setSeenDrawing] = useState(latestDrawing?.toolCallId ?? null)
  const [baselined, setBaselined] = useState(loaded)

  if (loaded && !baselined) {
    setBaselined(true)
    setSeenDrawing(latestDrawing?.toolCallId ?? null)
  } else if (baselined && latestDrawing !== null && latestDrawing.toolCallId !== seenDrawing) {
    setSeenDrawing(latestDrawing.toolCallId)
    setOpen(latestDrawing.diagram.title)
  }

  const cardOf = useCallback(
    (call: typeof ToolCallPart.Type) =>
      call.name === DRAW_DIAGRAM_TOOL ? <DiagramCard call={call} onOpen={setOpen} /> : null,
    [],
  )

  return {
    opened: open === null ? null : (diagrams.get(open) ?? null),
    close: () => setOpen(null),
    cardOf,
  }
}
