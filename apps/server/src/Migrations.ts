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
import mermaidTourDiagrams from "./migrations/0011_mermaid_tour_diagrams"
import conversations from "./migrations/0012_conversations"
import journalHost from "./migrations/0013_journal_host"
import conversationBranch from "./migrations/0014_conversation_branch"
import feedbackNotes from "./migrations/0015_feedback_notes"
import turnRetriesDelivery from "./migrations/0016_turn_retries_delivery"
import startedWork from "./migrations/0017_started_work"
import conversationKeptGoing from "./migrations/0018_conversation_kept_going"
import globalChatSessions from "./migrations/0019_global_chat_sessions"
import pageNotes from "./migrations/0020_page_notes"
import conversationToDos from "./migrations/0021_conversation_to_dos"
import reviewThreadReplies from "./migrations/0022_review_thread_replies"
import threads from "./migrations/0023_threads"
import pageLocations from "./migrations/0024_page_locations"
import journalTurn from "./migrations/0025_journal_turn"
import visualizations from "./migrations/0026_visualizations"
import dropFeedbackNoteStaged from "./migrations/0027_drop_feedback_note_staged"
import questions from "./migrations/0028_questions"
import checkIns from "./migrations/0029_check_ins"

const migrations = {
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
  "0011_mermaid_tour_diagrams": mermaidTourDiagrams,
  "0012_conversations": conversations,
  "0013_journal_host": journalHost,
  "0014_conversation_branch": conversationBranch,
  "0015_feedback_notes": feedbackNotes,
  "0016_turn_retries_delivery": turnRetriesDelivery,
  "0017_started_work": startedWork,
  "0018_conversation_kept_going": conversationKeptGoing,
  "0019_global_chat_sessions": globalChatSessions,
  "0020_page_notes": pageNotes,
  "0021_conversation_to_dos": conversationToDos,
  "0022_review_thread_replies": reviewThreadReplies,
  "0023_threads": threads,
  "0024_page_locations": pageLocations,
  "0025_journal_turn": journalTurn,
  "0026_visualizations": visualizations,
  "0027_drop_feedback_note_staged": dropFeedbackNoteStaged,
  "0028_questions": questions,
  "0029_check_ins": checkIns,
}

export const migrationLoader = SqliteMigrator.fromRecord(migrations)
