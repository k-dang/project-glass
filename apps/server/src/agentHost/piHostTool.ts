import type { ToolReply, toolParameters } from "./hostTool"
import type { ToolInput } from "./toolCalls"

export interface PiExtensionApi {
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

export const registerHostTool = (
  pi: PiExtensionApi,
  tool: {
    readonly name: string
    readonly label: string
    readonly description: string
    readonly parameters: ReturnType<typeof toolParameters>
  },
  reply: (params: ToolInput) => ToolReply,
) =>
  pi.registerTool({
    ...tool,
    execute: (_toolCallId, params) => {
      const { accepted, text } = reply(params)

      return accepted
        ? Promise.resolve({ content: [{ type: "text", text }], details: undefined })
        : Promise.reject(new Error(text))
    },
  })
