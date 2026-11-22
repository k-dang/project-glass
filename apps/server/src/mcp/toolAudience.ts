import { Context } from "effect"
import { McpSchema } from "effect/ai"

export const RELAY_CLIENT_NAME = "glass-agent-host"

export const SANDBOX_RELAY_CLIENT_NAME = "glass-sandbox-agent-host"

export const forThreadsOnThisDevice = Context.make(
  McpSchema.EnabledWhen,
  ({ clientInfo }) => clientInfo?.name === RELAY_CLIENT_NAME,
)
