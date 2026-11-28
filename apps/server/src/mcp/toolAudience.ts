import { Context } from "effect"
import { McpSchema } from "effect/ai"
import { PI_CLIENT_NAME } from "../agentHost/piGlassTools"

export const RELAY_CLIENT_NAME = "glass-agent-host"

export const SANDBOX_RELAY_CLIENT_NAME = "glass-sandbox-agent-host"

export const forThreadsOnThisDevice = Context.make(
  McpSchema.EnabledWhen,
  ({ clientInfo }) => clientInfo?.name === RELAY_CLIENT_NAME,
)

const agentsGlassRuns = new Set([RELAY_CLIENT_NAME, SANDBOX_RELAY_CLIENT_NAME, PI_CLIENT_NAME])

export const forThreadsAndTheGlobalChat = Context.make(
  McpSchema.EnabledWhen,
  ({ clientInfo }) => clientInfo !== undefined && agentsGlassRuns.has(clientInfo.name),
)
