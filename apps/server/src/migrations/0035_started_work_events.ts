import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const latest = sql`(SELECT COALESCE(MAX(id), 0) FROM event)`

  yield* sql`
    INSERT OR IGNORE INTO subscription
      (id, subscriber, source, subject, subject_key, kinds, note, delivered_through, created_at)
    SELECT lower(hex(randomblob(16))), started_by, 'glass',
      json_object('_tag', 'Thread', 'threadId', thread_id), thread_id,
      '["ThreadFinished","ThreadFailed","ThreadWaiting"]', COALESCE(asked_with, ''), ${latest},
      COALESCE(started_work_update_outcome_at, started_at)
    FROM started_thread
  `

  yield* sql`
    INSERT OR IGNORE INTO subscription
      (id, subscriber, source, subject, subject_key, kinds, note, delivered_through, created_at)
    SELECT lower(hex(randomblob(16))), started_by, 'glass',
      json_object(
        '_tag', 'AgentReview',
        'pullRequest', json_object('owner', owner, 'repo', repo, 'number', number)
      ),
      lower(owner) || '/' || lower(repo) || '#' || number,
      '["AgentReviewFinished","AgentReviewFailed"]', COALESCE(asked_with, ''), ${latest},
      started_at
    FROM started_agent_review WHERE started_work_update_outcome_at IS NULL
  `

  yield* sql`
    UPDATE thread_turn SET context = json_object('_tag', 'Update', 'subscriptions', json((
      SELECT json_group_array(json_object(
        'subscriptionId', thread_turn.id || '-' || work.key,
        'subject', CASE json_extract(work.value, '$._tag')
          WHEN 'AgentReview' THEN json_object(
            '_tag', 'AgentReview', 'pullRequest', json(json_extract(work.value, '$.pullRequest'))
          )
          ELSE json_object('_tag', 'Thread', 'threadId', json_extract(work.value, '$.threadId'))
        END,
        'note', COALESCE(json_extract(work.value, '$.askedWith'), ''),
        'events', json_array(json_object(
          'id', 0,
          'source', 'glass',
          'occurredAt', thread_turn.sent_at,
          'event', CASE
            WHEN json_extract(work.value, '$._tag') = 'AgentReview'
              AND json_extract(work.value, '$.outcome') = 'finished'
            THEN json_object(
              '_tag', 'AgentReviewFinished',
              'pullRequest', json(json_extract(work.value, '$.pullRequest')),
              'writtenAt', thread_turn.sent_at
            )
            WHEN json_extract(work.value, '$._tag') = 'AgentReview' THEN json_object(
              '_tag', 'AgentReviewFailed',
              'pullRequest', json(json_extract(work.value, '$.pullRequest')),
              'reason', COALESCE(json_extract(work.value, '$.reason'), '')
            )
            WHEN json_extract(work.value, '$.outcome') = 'waiting' THEN json_object(
              '_tag', 'ThreadWaiting',
              'threadId', json_extract(work.value, '$.threadId'),
              'name', json_extract(work.value, '$.name'),
              'requestId', ''
            )
            WHEN json_extract(work.value, '$.outcome') = 'finished' THEN json_object(
              '_tag', 'ThreadFinished',
              'threadId', json_extract(work.value, '$.threadId'),
              'name', json_extract(work.value, '$.name'),
              'endedAt', thread_turn.sent_at
            )
            ELSE json_object(
              '_tag', 'ThreadFailed',
              'threadId', json_extract(work.value, '$.threadId'),
              'name', json_extract(work.value, '$.name'),
              'endedAt', thread_turn.sent_at,
              'reason', COALESCE(json_extract(work.value, '$.reason'), '')
            )
          END
        ))
      ))
      FROM json_each(thread_turn.context, '$.work') AS work
    )))
    WHERE json_extract(context, '$._tag') = 'StartedWorkUpdate'
  `

  yield* sql`
    CREATE TABLE started_thread_next (
      started_by TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      asked_with TEXT,
      started_at TEXT NOT NULL,
      PRIMARY KEY (started_by, thread_id)
    )
  `
  yield* sql`
    INSERT INTO started_thread_next
    SELECT started_by, thread_id, asked_with, started_at FROM started_thread
  `
  yield* sql`DROP TABLE started_thread`
  yield* sql`ALTER TABLE started_thread_next RENAME TO started_thread`

  yield* sql`
    CREATE TABLE started_agent_review_next (
      started_by TEXT NOT NULL,
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL,
      asked_with TEXT,
      started_at TEXT NOT NULL,
      PRIMARY KEY (started_by, owner, repo, number)
    )
  `
  yield* sql`
    INSERT INTO started_agent_review_next
    SELECT started_by, owner, repo, number, asked_with, started_at FROM started_agent_review
  `
  yield* sql`DROP TABLE started_agent_review`
  yield* sql`ALTER TABLE started_agent_review_next RENAME TO started_agent_review`
})
