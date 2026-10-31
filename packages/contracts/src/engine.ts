import { Schema } from "effect"
import { AgentEngine } from "./agent"

export const AgentRunnerIdentity = Schema.Struct({
  engine: AgentEngine,
  model: Schema.String,
})

export type AgentRunnerIdentity = typeof AgentRunnerIdentity.Type

const ModelSetting = Schema.Trimmed.check(Schema.isNonEmpty())

export const PiModel = Schema.Struct({ provider: ModelSetting, modelId: ModelSetting })

export type PiModel = typeof PiModel.Type

/** Claude Code takes a bare model ID; the pi CLI selects a provider and model ID. */
export const EngineModels = Schema.Struct({
  "claude-code": ModelSetting,
  "pi-cli": PiModel,
})

export type EngineModels = typeof EngineModels.Type

/** The Tour engine and the Agent review engine are chosen apart; each keeps a model per engine. */
export const EngineSettings = Schema.Struct({ engine: AgentEngine, models: EngineModels })

export type EngineSettings = typeof EngineSettings.Type

export const runnerIdentity = ({ engine, models }: EngineSettings): AgentRunnerIdentity => {
  if (engine === "claude-code") return { engine, model: `anthropic/${models["claude-code"]}` }

  const { provider, modelId } = models[engine]

  return { engine, model: `${provider}/${modelId}` }
}

export const EngineFeature = Schema.Literals(["tours", "agentReviews"])

export type EngineFeature = typeof EngineFeature.Type
