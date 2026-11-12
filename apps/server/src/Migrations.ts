import { SqliteMigrator } from "@effect/sql-sqlite-node"
import baseline from "./migrations/0001_baseline"
import agentReviewHotspots from "./migrations/0032_agent_review_hotspots"
import agentReviewDone from "./migrations/0033_agent_review_done"

export const migrationLoader = SqliteMigrator.fromRecord({
  "0001_baseline": baseline,
  "0032_agent_review_hotspots": agentReviewHotspots,
  "0033_agent_review_done": agentReviewDone,
})
