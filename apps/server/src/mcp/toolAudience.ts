import { Context } from "effect"
import { McpSchema } from "effect/ai"

export const RELAY_CLIENT_NAME = "glass-agent-host"

export const ThisDeviceOnly = Context.Reference<boolean>("@glass/server/mcp/ThisDeviceOnly", {
  defaultValue: () => false,
})

export const forThreadsOnThisDevice = Context.make(
  McpSchema.EnabledWhen,
  ({ clientInfo }) => clientInfo?.name === RELAY_CLIENT_NAME,
).pipe(Context.add(ThisDeviceOnly, true))
