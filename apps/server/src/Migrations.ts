import { SqliteMigrator } from "@effect/sql-sqlite-node"
import baseline from "./migrations/0001_baseline"
import agentReviewHotspots from "./migrations/0002_agent_review_hotspots"
import agentReviewDone from "./migrations/0003_agent_review_done"
import outsideAgent from "./migrations/0004_outside_agent"
import conversationStartedWork from "./migrations/0005_conversation_started_work"
import turnSeen from "./migrations/0006_turn_seen"
import workReports from "./migrations/0007_work_reports"
import pastGlobalConversations from "./migrations/0008_past_global_conversations"
import globalConversationUpdates from "./migrations/0009_global_conversation_updates"
import toDoImages from "./migrations/0010_to_do_images"
import journalHost from "./migrations/0011_journal_host"

export const migrationLoader = SqliteMigrator.fromRecord({
  "0001_baseline": baseline,
  "0002_agent_review_hotspots": agentReviewHotspots,
  "0003_agent_review_done": agentReviewDone,
  "0004_outside_agent": outsideAgent,
  "0005_conversation_started_work": conversationStartedWork,
  "0006_turn_seen": turnSeen,
  "0007_work_reports": workReports,
  "0008_past_global_conversations": pastGlobalConversations,
  "0009_global_conversation_updates": globalConversationUpdates,
  "0010_to_do_images": toDoImages,
  "0011_journal_host": journalHost,
})
