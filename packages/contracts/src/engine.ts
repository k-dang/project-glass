import { Schema } from "effect"
import { AgentHarness } from "./conversation"

export const AgentRunnerIdentity = Schema.Struct({
  harness: AgentHarness,
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

export const EngineSettings = Schema.Struct({ harness: AgentHarness, models: EngineModels })

export type EngineSettings = typeof EngineSettings.Type

export const runnerIdentity = ({ harness, models }: EngineSettings): AgentRunnerIdentity => {
  if (harness === "claude-code") return { harness, model: `anthropic/${models["claude-code"]}` }

  const { provider, modelId } = models[harness]

  return { harness, model: `${provider}/${modelId}` }
}

export const agentModelOf = (settings: EngineSettings) =>
  settings.harness === "claude-code"
    ? settings.models["claude-code"]
    : runnerIdentity(settings).model

export const EngineFeature = Schema.Literals(["tours", "agentReviews"])

export type EngineFeature = typeof EngineFeature.Type
