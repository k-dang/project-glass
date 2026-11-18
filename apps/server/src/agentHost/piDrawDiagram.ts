import { DRAW_DIAGRAM_TOOL } from "@glass/contracts"
import { drawDiagram, drawDiagramDescription, drawDiagramParameters } from "./drawDiagramTool"
import { type PiExtensionApi, registerHostTool } from "./piHostTool"

export default function piDrawDiagram(pi: PiExtensionApi) {
  registerHostTool(
    pi,
    {
      name: DRAW_DIAGRAM_TOOL,
      label: "Draw diagram",
      description: drawDiagramDescription,
      parameters: drawDiagramParameters,
    },
    drawDiagram,
  )
}
