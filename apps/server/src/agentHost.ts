import { NodeServices } from "@effect/platform-node"
import { Config, Effect } from "effect"
import { claudeAdapter } from "./agentHost/claudeAdapter"
import { piAdapter } from "./agentHost/piAdapter"
import { openCodeAdapter } from "./agentHost/openCodeAdapter"
import { serveAgentHost } from "./agentHost/serve"
import { jsonLogsToStdout, runMain } from "./wideEvents"

const programs = Effect.gen(function* () {
  const piCommand = yield* Config.String("GLASS_PI_COMMAND").pipe(Config.withDefault("pi"))

  const opencodeCommand = yield* Config.String("GLASS_OPENCODE_COMMAND").pipe(
    Config.withDefault("opencode"),
  )

  const claudeCommand = yield* Config.String("GLASS_CLAUDE_COMMAND").pipe(
    Config.withDefault("claude"),
  )

  return {
    "claude-code": claudeAdapter(claudeCommand),
    pi: yield* piAdapter(piCommand),
    opencode: yield* openCodeAdapter(opencodeCommand),
  }
})

serveAgentHost(programs).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  runMain(jsonLogsToStdout("agent-host")),
)
