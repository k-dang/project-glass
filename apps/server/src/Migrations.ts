import { SqliteMigrator } from "@effect/sql-sqlite-node"
import baseline from "./migrations/0001_baseline"
import agentReviewHotspots from "./migrations/0002_agent_review_hotspots"

export const migrationLoader = SqliteMigrator.fromRecord({
  "0001_baseline": baseline,
  "0002_agent_review_hotspots": agentReviewHotspots,
})
