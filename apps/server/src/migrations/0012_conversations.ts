import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent RENAME TO conversation`
  yield* sql`ALTER TABLE conversation RENAME COLUMN engine TO harness`

  for (const table of [
    "feedback_note",
    "queued_message",
    "skill_pack",
    "turn",
    "turn_part",
    "unsent_message",
  ])
    yield* sql`ALTER TABLE ${sql(`agent_${table}`)} RENAME TO ${sql(`conversation_${table}`)}`

  for (const table of [
    "conversation_feedback_note",
    "conversation_queued_message",
    "conversation_skill_pack",
    "conversation_turn",
    "conversation_unsent_message",
    "agent_reviews",
  ])
    yield* sql`ALTER TABLE ${sql(table)} RENAME COLUMN agent_id TO conversation_id`

  yield* sql`DROP INDEX agent_queued_message_by_agent`
  yield* sql`
    CREATE INDEX conversation_queued_message_by_conversation
    ON conversation_queued_message (conversation_id, position)
  `
  yield* sql`DROP INDEX agent_turn_by_agent`
  yield* sql`CREATE INDEX conversation_turn_by_conversation ON conversation_turn (conversation_id)`

  yield* sql`ALTER TABLE conversation_agent RENAME TO global_started_conversation`
  yield* sql`
    ALTER TABLE global_started_conversation RENAME COLUMN conversation_id TO global_conversation_id
  `
  yield* sql`ALTER TABLE global_started_conversation RENAME COLUMN agent_id TO conversation_id`
  yield* sql`ALTER TABLE conversation_agent_review RENAME TO global_started_agent_review`
  yield* sql`
    ALTER TABLE global_started_agent_review RENAME COLUMN conversation_id TO global_conversation_id
  `

  for (const table of ["conversation_turn", "conversation_queued_message"]) {
    yield* sql`
      UPDATE ${sql(table)} SET context = json_set(
        json_remove(json_set(context, '$._tag', 'Conversation'), '$.agentId'),
        '$.conversationId', json_extract(context, '$.agentId')
      )
      WHERE json_extract(context, '$._tag') = 'Agent'
    `
    yield* sql`
      UPDATE ${sql(table)} SET context = json_set(context, '$.work', (
        SELECT json_group_array(CASE json_extract(work.value, '$._tag')
          WHEN 'Agent' THEN json_set(
            json_remove(json_set(work.value, '$._tag', 'Conversation'), '$.agentId'),
            '$.conversationId', json_extract(work.value, '$.agentId')
          )
          ELSE json(work.value)
        END)
        FROM json_each(context, '$.work') AS work
      ))
      WHERE json_extract(context, '$._tag') = 'GlobalConversationUpdate'
    `
  }

  yield* sql`
    UPDATE conversation_turn_part SET part = json_set(part, '$.context', json_set(
      json_remove(json_set(json_extract(part, '$.context'), '$._tag', 'Conversation'), '$.agentId'),
      '$.conversationId', json_extract(part, '$.context.agentId')
    ))
    WHERE json_extract(part, '$._tag') = 'Steer' AND json_extract(part, '$.context._tag') = 'Agent'
  `

  yield* sql`
    UPDATE activity SET kind = 'ConversationStarted', payload = json_set(
      json_remove(json_set(payload, '$._tag', 'ConversationStarted'), '$.agentId', '$.engine'),
      '$.conversationId', json_extract(payload, '$.agentId'),
      '$.harness', json_extract(payload, '$.engine')
    )
    WHERE kind = 'AgentStarted'
  `
  yield* sql`
    UPDATE saved_place SET area = 'conversations', destination = json_object(
      'area', 'conversations', 'conversationId', json_extract(destination, '$.agentId')
    )
    WHERE area = 'agents'
  `
})
