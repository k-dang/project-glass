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

export const EngineModels = Schema.Struct({
  "claude-code": ModelSetting,
  pi: PiModel,
})

export type EngineModels = typeof EngineModels.Type

export const EngineSettings = Schema.Struct({ engine: AgentEngine, models: EngineModels })

export type EngineSettings = typeof EngineSettings.Type

export const runnerIdentity = ({ engine, models }: EngineSettings): AgentRunnerIdentity => {
  if (engine === "claude-code") return { engine, model: `anthropic/${models["claude-code"]}` }

  const { provider, modelId } = models[engine]

  return { engine, model: `${provider}/${modelId}` }
}

export const agentModelOf = (settings: EngineSettings) =>
  settings.engine === "claude-code"
    ? settings.models["claude-code"]
    : runnerIdentity(settings).model

export const EngineFeature = Schema.Literals(["tours", "agentReviews"])

export type EngineFeature = typeof EngineFeature.Type
