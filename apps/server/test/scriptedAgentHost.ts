import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect } from "effect"
import { writeFileSync } from "node:fs"
import { serveAgentHost } from "../src/agentHost/serve"
import { hostPidPath } from "./agentHostProcesses"
import { scriptedAdapter } from "./scriptedAdapter"

const hostRecord = process.env["GLASS_HOST_RECORD"]

if (hostRecord !== undefined) writeFileSync(hostPidPath(hostRecord), String(process.pid))

const harnesses = Config.String("GLASS_SCRIPTED_GATES").pipe(
  Effect.map((gates) => {
    const adapter = scriptedAdapter(gates)

    return { "claude-code": adapter, pi: adapter }
  }),
)

serveAgentHost(harnesses).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
