import { Schema } from "effect"
import { AgentEngine, ModelChoice } from "./agent"

/** The Agent program, model, and Effort the Global conversation runs on. */
export class GlobalConversationProgram extends Schema.Class<GlobalConversationProgram>(
  "GlobalConversationProgram",
)({
  engine: AgentEngine,
  ...ModelChoice.fields,
}) {}
