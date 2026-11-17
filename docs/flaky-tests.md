# Flaky tests

A flaky test fails in a run, then passes on rerun with no code change. Fix the ones with the most sightings first.

When a test flakes, add 1 to its sightings and update the last-seen date, or add a row with 1 for a test not listed yet. Keep the table sorted by sightings, highest first. Delete a test's row once it is fixed or deleted.

| Sightings | Last seen  | Test                                                                                                                                       | Notes                                                              |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 1         | 2026-11-16 | `apps/desktop/src/renderer/ConversationView.test.tsx` › shows the Conversation's unsent message from before and saves what the user writes | In a full `pnpm test` run; passed when rerun on its own. Skipped.  |
| 1         | 2026-11-16 | `apps/server/src/Queue.test.ts` › refreshes queued PRs from GitHub, keeping the last known row of one GitHub won't give                    | In a full server test run; passed three times on its own. Skipped. |
