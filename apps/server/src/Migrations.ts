import { SqliteMigrator } from "@effect/sql-sqlite-node"
import createActivity from "./migrations/0001_create_activity"
import indexTouchedPrs from "./migrations/0002_index_touched_prs"
import indexActivityByLogin from "./migrations/0003_index_activity_by_login"
import createToDo from "./migrations/0004_create_to_do"
import nestPullRequestInActivity from "./migrations/0005_nest_pull_request_in_activity"
import createQueuedPullRequest from "./migrations/0006_create_queued_pull_request"
import createTours from "./migrations/0007_create_tours"
import addRevisionToQueuedPullRequest from "./migrations/0008_add_revision_to_queued_pull_request"
import createSavedPlace from "./migrations/0009_create_saved_place"
import createAgentReviews from "./migrations/0010_create_agent_reviews"
import createAgents from "./migrations/0011_create_agents"
import agentModels from "./migrations/0012_agent_models"
import imagesQueuedAndUnsentMessages from "./migrations/0013_images_queued_and_unsent_messages"
import agentPermissionMode from "./migrations/0014_agent_permission_mode"
import agentReviewsAsMarkdown from "./migrations/0015_agent_reviews_as_markdown"
import agentSandboxes from "./migrations/0016_agent_sandboxes"
import agentPlace from "./migrations/0017_agent_place"
import savedPlacePerArea from "./migrations/0018_saved_place_per_area"
import agentJournalSaved from "./migrations/0019_agent_journal_saved"
import createAgentReviewFollowUps from "./migrations/0020_create_agent_review_follow_ups"
import agentReviewFollowUpsAsAgent from "./migrations/0021_agent_review_follow_ups_as_agent"
import indexActivityByKind from "./migrations/0022_index_activity_by_kind"
import createGlobalConversation from "./migrations/0023_create_global_conversation"
import nameLocalPlace from "./migrations/0024_name_local_place"
import globalConversationOnPi from "./migrations/0025_global_conversation_on_pi"
import createSkillPacks from "./migrations/0026_create_skill_packs"
import createAgentFeedbackNotes from "./migrations/0027_create_agent_feedback_notes"
import agentSkillPacks from "./migrations/0028_agent_skill_packs"

export const migrations = {
  "0001_create_activity": createActivity,
  "0002_index_touched_prs": indexTouchedPrs,
  "0003_index_activity_by_login": indexActivityByLogin,
  "0004_create_to_do": createToDo,
  "0005_nest_pull_request_in_activity": nestPullRequestInActivity,
  "0006_create_queued_pull_request": createQueuedPullRequest,
  "0007_create_tours": createTours,
  "0008_add_revision_to_queued_pull_request": addRevisionToQueuedPullRequest,
  "0009_create_saved_place": createSavedPlace,
  "0010_create_agent_reviews": createAgentReviews,
  "0011_create_agents": createAgents,
  "0012_agent_models": agentModels,
  "0013_images_queued_and_unsent_messages": imagesQueuedAndUnsentMessages,
  "0014_agent_permission_mode": agentPermissionMode,
  "0015_agent_reviews_as_markdown": agentReviewsAsMarkdown,
  "0016_agent_sandboxes": agentSandboxes,
  "0017_agent_place": agentPlace,
  "0018_saved_place_per_area": savedPlacePerArea,
  "0019_agent_journal_saved": agentJournalSaved,
  "0020_create_agent_review_follow_ups": createAgentReviewFollowUps,
  "0021_agent_review_follow_ups_as_agent": agentReviewFollowUpsAsAgent,
  "0022_index_activity_by_kind": indexActivityByKind,
  "0023_create_global_conversation": createGlobalConversation,
  "0024_name_local_place": nameLocalPlace,
  "0025_global_conversation_on_pi": globalConversationOnPi,
  "0026_create_skill_packs": createSkillPacks,
  "0027_create_agent_feedback_notes": createAgentFeedbackNotes,
  "0028_agent_skill_packs": agentSkillPacks,
}

export const migrationLoader = SqliteMigrator.fromRecord(migrations)
