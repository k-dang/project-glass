// @vitest-environment happy-dom
import {
  type Diagram,
  DRAW_DIAGRAM_TOOL,
  ToolCallPart,
  type Turn,
  TurnDone,
} from "@glass/contracts"
import { renderHook } from "@testing-library/react"
import { DateTime } from "effect"
import { expect, it } from "vite-plus/test"
import { diagramsOf, useDiagrams } from "./AgentDiagrams"

const sentAt = DateTime.makeUnsafe("2026-11-14T12:00:00Z")

const drawing = (
  toolCallId: string,
  diagram: Diagram,
  status: (typeof ToolCallPart.Type)["status"] = "done",
) =>
  ToolCallPart.make({
    toolCallId,
    name: DRAW_DIAGRAM_TOOL,
    inputSummary: diagram.title,
    input: JSON.stringify(diagram),
    output: null,
    status,
    parentToolCallId: null,
  })

const turn = (id: string, parts: Turn["parts"]): Turn => ({
  id,
  message: "Diagram it",
  images: [],
  context: null,
  feedback: [],
  sentAt,
  ended: { at: sentAt, ending: TurnDone.make({}) },
  parts,
})

const flow = { title: "Flow", kind: "existing", mermaid: "flowchart LR\n  A --> B" } as const

const queued = { ...flow, kind: "proposed", mermaid: "flowchart LR\n  A --> Q --> B" } as const

it("keeps each Diagram as last drawn, skipping drawings Glass refused", () => {
  const { diagrams, latestDrawing } = diagramsOf([
    turn("turn-1", [drawing("draw-1", flow)]),
    turn("turn-2", [
      drawing("draw-2", queued),
      drawing("draw-3", { ...flow, mermaid: "" }, "failed"),
    ]),
  ])

  expect([...diagrams.values()]).toEqual([queued])
  expect(latestDrawing).toEqual({ toolCallId: "draw-2", diagram: queued })
})

it("opens a Diagram drawn while the Agent is on screen, however fast its Turn ends", () => {
  const { result, rerender } = renderHook(({ turns }) => useDiagrams(turns), {
    initialProps: { turns: [turn("turn-1", [drawing("draw-1", flow)])] },
  })

  expect(result.current.opened).toBeNull()

  rerender({
    turns: [turn("turn-1", [drawing("draw-1", flow)]), turn("turn-2", [drawing("draw-2", queued)])],
  })

  expect(result.current.opened).toEqual(queued)
})
