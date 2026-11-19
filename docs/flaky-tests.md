# Flaky tests

A flaky test fails in a run, then passes on rerun with no code change. Every test listed here is skipped so it doesn't block development. Fix the ones with the most sightings first.

When a test flakes, add 1 to its sightings and update the last-seen date, or add a row with 1 for a test not listed yet. Keep the table sorted by sightings, highest first. Delete a test's row once it is fixed and unskipped, or deleted.

| Sightings | Last seen  | Test                                                                                                   | Notes                                                                     |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1         | 2026-11-17 | `apps/desktop/src/renderer/reviews.test.tsx` › opens only full URLs or repository-qualified references | In a full `pnpm test` run after 26 seconds; passed when rerun on its own. |
