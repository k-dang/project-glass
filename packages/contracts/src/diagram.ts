import { Option, Schema } from "effect"
import type { ToolCallPart } from "./agent"

export const DiagramKind = Schema.Literals(["existing", "proposed", "uncertain"])

export type DiagramKind = typeof DiagramKind.Type

export const Diagram = Schema.Struct({
  title: Schema.Trim.check(Schema.isNonEmpty()),
  kind: DiagramKind,
  mermaid: Schema.String,
})

export type Diagram = typeof Diagram.Type

export const DRAW_DIAGRAM_TOOL = "draw_diagram"

const decodeDiagram = Schema.decodeUnknownOption(Schema.fromJsonString(Diagram))

export const diagramIn = (call: typeof ToolCallPart.Type): Diagram | null =>
  call.name === DRAW_DIAGRAM_TOOL ? Option.getOrNull(decodeDiagram(call.input)) : null

export const drawnDiagramOf = (call: typeof ToolCallPart.Type): Diagram | null =>
  call.status === "done" ? diagramIn(call) : null
