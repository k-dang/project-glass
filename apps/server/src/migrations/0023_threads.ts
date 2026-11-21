import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation RENAME TO thread`

  for (const table of [
    "queued_message",
    "skill_pack",
    "to_do",
    "turn",
    "turn_part",
    "unsent_message",
  ])
    yield* sql`ALTER TABLE ${sql(`conversation_${table}`)} RENAME TO ${sql(`thread_${table}`)}`

  yield* sql`ALTER TABLE started_conversation RENAME TO started_thread`

  for (const table of [
    "thread_queued_message",
    "thread_skill_pack",
    "thread_to_do",
    "thread_turn",
    "thread_unsent_message",
    "started_thread",
    "agent_reviews",
  ])
    yield* sql`ALTER TABLE ${sql(table)} RENAME COLUMN conversation_id TO thread_id`

  yield* sql`DROP INDEX conversation_queued_message_by_conversation`
  yield* sql`CREATE INDEX thread_queued_message_by_thread ON thread_queued_message (thread_id, position)`
  yield* sql`DROP INDEX conversation_turn_by_conversation`
  yield* sql`CREATE INDEX thread_turn_by_thread ON thread_turn (thread_id)`

  for (const table of ["thread_turn", "thread_queued_message"]) {
    yield* sql`
      UPDATE ${sql(table)} SET context = json_set(
        json_remove(json_set(context, '$._tag', 'Thread'), '$.conversationId'),
        '$.threadId', json_extract(context, '$.conversationId')
      )
      WHERE json_extract(context, '$._tag') = 'Conversation'
    `
    yield* sql`
      UPDATE ${sql(table)} SET context = json_set(context, '$.work', (
        SELECT json_group_array(CASE json_extract(work.value, '$._tag')
          WHEN 'Conversation' THEN json_set(
            json_remove(json_set(work.value, '$._tag', 'Thread'), '$.conversationId'),
            '$.threadId', json_extract(work.value, '$.conversationId')
          )
          ELSE json(work.value)
        END)
        FROM json_each(context, '$.work') AS work
      ))
      WHERE json_extract(context, '$._tag') = 'StartedWorkUpdate'
    `
  }

  yield* sql`
    UPDATE thread_turn_part SET part = json_set(part, '$.context', json_set(
      json_remove(
        json_set(json_extract(part, '$.context'), '$._tag', 'Thread'),
        '$.conversationId'
      ),
      '$.threadId', json_extract(part, '$.context.conversationId')
    ))
    WHERE json_extract(part, '$._tag') = 'Steer'
      AND json_extract(part, '$.context._tag') = 'Conversation'
  `

  yield* sql`
    UPDATE activity SET kind = 'ThreadStarted', payload = json_set(
      json_remove(json_set(payload, '$._tag', 'ThreadStarted'), '$.conversationId'),
      '$.threadId', json_extract(payload, '$.conversationId')
    )
    WHERE kind = 'ConversationStarted'
  `

  yield* sql`
    UPDATE feedback_note SET owner = 'thread:' || substr(owner, length('conversation:') + 1)
    WHERE owner LIKE 'conversation:%'
  `

  yield* sql`
    UPDATE saved_place SET area = 'threads', destination = json_object(
      'area', 'threads', 'threadId', json_extract(destination, '$.conversationId')
    )
    WHERE area = 'conversations'
  `
})
