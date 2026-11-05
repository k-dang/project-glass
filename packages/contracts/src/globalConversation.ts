import { Schema } from "effect"
import { AgentEngine, ModelChoice } from "./agent"

export class GlobalConversationProgram extends Schema.Class<GlobalConversationProgram>(
  "GlobalConversationProgram",
)({
  engine: AgentEngine,
  ...ModelChoice.fields,
}) {}
