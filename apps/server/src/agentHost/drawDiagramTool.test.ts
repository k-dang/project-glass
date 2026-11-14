import { type Diagram, DRAW_DIAGRAM_TOOL, drawnDiagramOf, ToolCallPart } from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import { drawDiagram } from "./drawDiagramTool"

const callWith = (input: typeof Diagram.Encoded) =>
  ToolCallPart.make({
    toolCallId: "call",
    name: DRAW_DIAGRAM_TOOL,
    inputSummary: "",
    input: JSON.stringify(input),
    output: null,
    status: "done",
    parentToolCallId: null,
  })

it("saves only what Glass can read back as a Diagram", () => {
  const padded: typeof Diagram.Encoded = {
    title: " Auth flow ",
    kind: "existing",
    mermaid: "graph TD; A-->B",
  }

  const blank = { ...padded, title: "  " }

  expect(drawDiagram(padded).accepted).toBe(true)
  expect(drawnDiagramOf(callWith(padded))?.title).toBe("Auth flow")
  expect(drawDiagram(blank).accepted).toBe(false)
  expect(drawnDiagramOf(callWith(blank))).toBeNull()
})
