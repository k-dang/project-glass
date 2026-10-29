import { Schema } from "effect"

export const Engine = Schema.Literals(["claude-code", "pi", "pi-cli"])

export type Engine = typeof Engine.Type

/** Whether an engine can read a PR's files, which every Agent review needs. */
export const readsFiles: Record<Engine, boolean> = {
  "claude-code": true,
  pi: false,
  "pi-cli": true,
}

export const AgentRunnerIdentity = Schema.Struct({
  engine: Engine,
  model: Schema.String,
})

export type AgentRunnerIdentity = typeof AgentRunnerIdentity.Type

const ModelSetting = Schema.Trimmed.check(Schema.isNonEmpty())

export const PiModel = Schema.Struct({ provider: ModelSetting, modelId: ModelSetting })

export type PiModel = typeof PiModel.Type

/** Claude Code takes a bare model ID; pi and the pi CLI select a provider and model ID. */
export const EngineModels = Schema.Struct({
  "claude-code": ModelSetting,
  pi: PiModel,
  "pi-cli": PiModel,
})

export type EngineModels = typeof EngineModels.Type

/** The Tour engine and the Agent review engine are chosen apart; each keeps a model per engine. */
export const EngineSettings = Schema.Struct({ engine: Engine, models: EngineModels })

export type EngineSettings = typeof EngineSettings.Type

export const runnerIdentity = ({ engine, models }: EngineSettings): AgentRunnerIdentity => {
  if (engine === "claude-code") return { engine, model: `anthropic/${models["claude-code"]}` }

  const { provider, modelId } = models[engine]

  return { engine, model: `${provider}/${modelId}` }
}

export const EngineFeature = Schema.Literals(["tours", "agentReviews"])

export type EngineFeature = typeof EngineFeature.Type
