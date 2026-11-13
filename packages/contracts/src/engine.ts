import { Schema } from "effect"

export const RunnerEngine = Schema.Literals(["claude-code", "pi"])

export type RunnerEngine = typeof RunnerEngine.Type

export const AgentRunnerIdentity = Schema.Struct({
  engine: RunnerEngine,
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

export const EngineSettings = Schema.Struct({ engine: RunnerEngine, models: EngineModels })

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
