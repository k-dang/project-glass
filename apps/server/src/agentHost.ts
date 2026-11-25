import { NodeServices } from "@effect/platform-node"
import { Config, Effect } from "effect"
import { claudeAdapter } from "./agentHost/claudeAdapter"
import { piAdapter } from "./agentHost/piAdapter"
import { serveAgentHost } from "./agentHost/serve"
import { takeGlassVariables } from "./glassVariables"
import { jsonLogsToStdout, runMain } from "./wideEvents"

const harnesses = Effect.gen(function* () {
  const piCommand = yield* Config.String("GLASS_PI_COMMAND").pipe(Config.withDefault("pi"))

  const claudeCommand = yield* Config.String("GLASS_CLAUDE_COMMAND").pipe(
    Config.withDefault("claude"),
  )

  return {
    "claude-code": claudeAdapter(claudeCommand),
    pi: yield* piAdapter(piCommand),
  }
})

serveAgentHost(harnesses).pipe(
  Effect.scoped,
  Effect.provide([NodeServices.layer, takeGlassVariables()]),
  runMain(jsonLogsToStdout("agent-host")),
)
