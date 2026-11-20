# Flaky tests

A flaky test fails in a run, then passes on rerun with no code change. Every test listed here is skipped so it doesn't block development. Fix the ones with the most sightings first.

When a test flakes, add 1 to its sightings and update the last-seen date, or add a row with 1 for a test not listed yet. Keep the table sorted by sightings, highest first. Delete a test's row once it is fixed and unskipped, or deleted.

| Sightings | Last seen  | Test                                                                                                                                        | Notes                                                                   |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1         | 2026-11-19 | `apps/server/src/PullRequestLists.test.ts` > Watching > tells watchers why a sync failed, until one succeeds                                | Timed out at 30 s in a full `pnpm test`; passed alone on rerun.         |
| 1         | 2026-11-19 | `apps/desktop/src/renderer/NewConversation.test.tsx` > starts a Conversation with the Skill packs picked, and picks the same ones next time | Failed once in a full desktop run; passed alone on rerun.               |
| 1         | 2026-11-19 | `apps/desktop/src/renderer/AgentWork.test.tsx` > shows a running review's elapsed time on the trigger and cancels it from the menu          | Read 1:06 instead of 1:05 in a full desktop run; passed alone on rerun. |
