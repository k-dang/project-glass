import { DRAW_DIAGRAM_TOOL } from "@glass/contracts"
import type { ToolInput } from "./toolCalls"
import { drawDiagram, drawDiagramDescription, drawDiagramParameters } from "./drawDiagramTool"

interface PiExtensionApi {
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: object
    execute: (
      toolCallId: string,
      params: ToolInput,
    ) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string }>; details: undefined }>
  }): void
}

/** pi loads this module as an extension in its own process, built beside the agent host. */
export default function piDrawDiagram(pi: PiExtensionApi) {
  pi.registerTool({
    name: DRAW_DIAGRAM_TOOL,
    label: "Draw diagram",
    description: drawDiagramDescription,
    parameters: drawDiagramParameters,
    execute: (_toolCallId, params) => {
      const { accepted, text } = drawDiagram(params)

      return accepted
        ? Promise.resolve({ content: [{ type: "text", text }], details: undefined })
        : Promise.reject(new Error(text))
    },
  })
}
