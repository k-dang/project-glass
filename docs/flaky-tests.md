# Flaky tests

A flaky test fails in a run, then passes on rerun with no code change. Every test listed here is skipped so it doesn't block development. Fix the ones with the most sightings first.

When a test flakes, add 1 to its sightings and update the last-seen date, or add a row with 1 for a test not listed yet. Keep the table sorted by sightings, highest first. Delete a test's row once it is fixed and unskipped, or deleted.

| Sightings | Last seen  | Test                                                                                                                                          | Notes                                                                          |
| --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1         | 2026-11-25 | `apps/server/src/mcp/glassThreadTools.test.ts` › Glass's Agent review tools over MCP › starts an Agent review, then reads it once written     | Failed in a full server run; passed on rerun with the same seed and alone      |
| 1         | 2026-11-24 | `apps/server/src/StartedWorkUpdates.test.ts` › sends one Started work update for Threads that finished during its own Turn, marking them seen | Saw 1 of 2 started Threads in a full server run; passed alone on the same seed |
| 1         | 2026-11-21 | `apps/server/src/mcp/checkIn.test.ts` › check_in › returns NoChanges without asking the user when nothing changed                             | `fetch failed` with `ECONNRESET` in a full server run; passed alone on rerun   |
