import type * as Plugin from "@glass/plugin"
import type { AgentModel, AgentModels } from "./agent"

type Assert<T extends true> = T

type Extends<A, B> = [A] extends [B] ? true : false

export type PluginModelConformance = [
  Assert<Extends<AgentModel, Plugin.AgentModel>>,
  Assert<Extends<Plugin.AgentModel, AgentModel>>,
  Assert<Extends<AgentModels, Plugin.AgentModels>>,
  Assert<Extends<Plugin.AgentModels, AgentModels>>,
]
