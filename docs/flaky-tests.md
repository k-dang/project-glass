# Flaky tests

A flaky test fails in a run, then passes on rerun with no code change. Every test listed here is skipped so it doesn't block development. Fix the ones with the most sightings first.

When a test flakes, add 1 to its sightings and update the last-seen date, or add a row with 1 for a test not listed yet. Keep the table sorted by sightings, highest first. Delete a test's row once it is fixed and unskipped, or deleted.

| Sightings | Last seen  | Test                                                                                                                                           | Notes                                                                              |
| --------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 3         | 2026-11-17 | `apps/server/src/PullRequestLists.test.ts` › Needs review › fails the lists when the user's teams can't be read                                | Failed in 3 of 6 runs of the file, on main and on a branch; passed on rerun.       |
| 2         | 2026-11-17 | `apps/server/src/PullRequestLists.test.ts` › Watching › tells watchers why a sync failed, until one succeeds                                   | Failed in 1 of 6 runs of the file, and once in a full server run; passed on rerun. |
| 1         | 2026-11-18 | `apps/server/src/PullRequestLists.test.ts` › Watching › clears a failed sync once a sync succeeds with nothing followed                        | In a full server test run; passed three times on its own.                          |
| 1         | 2026-11-16 | `apps/desktop/src/renderer/ConversationView.test.tsx` › shows the Conversation's unsent message from before and saves what the user writes     | In a full `pnpm test` run; passed when rerun on its own.                           |
| 1         | 2026-11-17 | `apps/desktop/src/renderer/reviews.test.tsx` › opens only full URLs or repository-qualified references                                         | In a full `pnpm test` run after 26 seconds; passed when rerun on its own.          |
| 1         | 2026-11-16 | `apps/server/src/Queue.test.ts` › refreshes queued PRs from GitHub, keeping the last known row of one GitHub won't give                        | In a full server test run; passed three times on its own.                          |
| 1         | 2026-11-17 | `apps/server/src/PullRequestLists.test.ts` › Needs review › lists open PRs awaiting the user's or their team's review in followed repositories | Failed in 1 of 3 runs of the file on main; passed on rerun.                        |
| 1         | 2026-11-18 | `apps/desktop/src/renderer/ToDos.test.tsx` › adds, edits, completes, reopens, and deletes to-dos                                               | In a full `pnpm test` run after 3.5 seconds; passed when rerun on its own.         |
