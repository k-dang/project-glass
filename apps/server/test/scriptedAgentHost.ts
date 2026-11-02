import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect } from "effect"
import { serveAgentHost } from "../src/agentHost/serve"
import { scriptedAdapter } from "./scriptedAdapter"

const programs = Config.String("GLASS_SCRIPTED_GATES").pipe(
  Effect.map((gates) => {
    const adapter = scriptedAdapter(gates)

    return { "claude-code": adapter, pi: adapter }
  }),
)

serveAgentHost(programs).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
