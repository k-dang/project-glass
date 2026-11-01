# GitHub monitoring: Glass and T3 Code

Source review on 2026-11-01. Glass commit: `2ef491786d6b61fdfefe0439e9ad540f27dd0a31`. T3 Code evidence and pinned source links are in [the upstream research note](t3code-github-monitoring.md). This is a source review, not a runtime reproduction or a proposed architecture decision.

## Glass today

- [watched.ts](../../apps/desktop/src/renderer/watched.ts) refreshes subscribed data every 30 seconds while visible, on window focus, and on entry/visibility restoration when stale. It skips a refresh already waiting and removes timers/listeners when released. This is view-driven refresh, not an always-running server monitor.
- [PullRequestMirror.ts](../../apps/server/src/PullRequestMirror.ts) keeps a disk-backed mirror scoped to the viewer. It performs a full read on the next sync after ten minutes, otherwise catches up through updated-since search with a five-minute overlap. It syncs up to four repositories concurrently and keeps failed repositories' previous rows. Its semaphore serializes entire syncs; it does not share one in-flight result between independent callers.
- [PullRequestLists.ts](../../apps/server/src/PullRequestLists.ts) classifies that mirror into Needs review, My PRs, and Reviewing. Checks are requested only for the deduplicated union of PRs belonging to these lists, not every PR in every followed repository. This union includes lists/tabs not currently displayed.
- [GitHubClient.ts](../../apps/server/src/github/GitHubClient.ts) batches checks by 100 PR IDs and Queue lookups by 50 references. Batch requests can run with unbounded concurrency. Its central `send` function applies a 30-second deadline and classifies HTTP failures, but does not inspect rate-limit or Retry-After headers, coordinate a quota budget, or implement cooldowns.
- [Queue.ts](../../apps/server/src/Queue.ts) independently refreshes Queue entries. [reviewsArea.ts](../../apps/desktop/src/renderer/reviewsArea.ts) checks whether a workspace changed when reopening its cached value; it does not continuously monitor the open workspace. A workspace remains pinned to its Revision until Reload.
- [PullRequestListPage.tsx](../../apps/desktop/src/renderer/PullRequestListPage.tsx) renders saved rows while refreshing and retains rows with a visible Not refreshed state after a list/repository failure. This is already a useful design to preserve.

## Recommended adaptations

### 1. Give GitHub traffic one shared request policy

Borrow T3 Code's separation between interactive and background traffic, its global request bound, and its shared rate-limit cooldown. Put the policy at the common GitHub request boundary so Queue refreshes, list reads, workspace reads, and writes cannot each assume they own the budget.

Start with the current single-host Connection rather than introducing a host/account framework. Track REST and GraphQL quotas separately; honor Retry-After/reset signals, defer background refreshes when quota is scarce, and leave headroom for interactive reads and feedback writes. A small bounded policy is enough; T3 Code's exact concurrency and reserve constants are not requirements for Glass. A hard GitHub cooldown still applies to interactive requests.

This matches [GitHub's REST guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately). [GraphQL can report rate-limit errors in HTTP 200 responses](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#exceeding-the-rate-limit), so looking only at HTTP status is insufficient. Do not automatically replay a mutation with an ambiguous result; preserve Glass's existing Reload-before-resubmission behavior.

### 2. Separate summary refresh from detailed monitoring

T3 Code refreshes cheap summaries separately from detailed watched-PR activity. Glass already separates list candidates, checks, and full workspace reads; keep that separation.

If continuous open-PR monitoring is wanted, fetch a small summary/fingerprint while the workspace is visible and mark it changed. Keep the pinned Revision, Drafts, and Reload behavior intact. Track the information each consumer needs: head/base changes, checks, and discussion/review changes do not all have the same invalidation rules. Do not treat unchanged updatedAt as proof nothing changed; Glass's full-read test explicitly covers changes that skip it.

Share overlapping summary/status reads by PR identity when an actual duplicate consumer needs them. Avoid replacing the existing efficient repository-wide catch-up with a full request per PR.

### 3. Let attention and activity determine polling cost

Borrow T3 Code's distinction between active and quiet monitoring. Keep Glass's current visible-view and subscription gates. Consider a slower cadence for settled checks and a faster cadence for running checks or the open workspace, within the shared budget. Retain periodic reconciliation because checks can be rerun without a new head commit and not all membership changes update updatedAt.

Exact intervals should follow a freshness requirement. A persistent backend scheduler becomes justified when Glass has an explicit requirement to watch PRs or wake Agents while Reviews is closed; the current UI freshness requirement does not by itself justify porting T3 Code's durable watch subsystem.

### 4. Preserve cached information with explicit freshness and commit identity

This is a Glass finding, not a T3 Code feature claim. `mirrored()` retains `known?.checks` by PR ID. `withLatestChecks()` catches a checks-read failure, substitutes an empty map, then falls back to `pr.checks`. The mirror's candidate query does not include head SHA. Therefore a newly pushed PR can retain a previous head's passing checks when the separate checks fetch fails, while the repository sync itself reports success.

Associate checks with the head commit and retain enough read health to distinguish fresh results from held values. A previous head's result must not become the current head's result. This matters more than a sophisticated polling scheduler.

T3 provides useful building blocks here: [its check/detail merge compares observation timestamps](https://github.com/pingdotgg/t3code/blob/5732bbee397f0a2b0e61d0c2e432f01dca6df3dc/packages/client-runtime/src/pullRequestChecks.ts#L3-L19), and [its conditional checks reader clears validators on head changes](https://github.com/pingdotgg/t3code/blob/5732bbee397f0a2b0e61d0c2e432f01dca6df3dc/packages/source-control-github/src/server/gitHubConditionalChecks.ts#L124-L145). These are separate from showing stale/error state to the user.

T3 Code also has transient-error fallbacks; its existence is not evidence that every held value is visibly marked stale. Preserve Glass's existing explicit Not refreshed behavior rather than blindly copying upstream fallback semantics.

## Ideas to defer

- **A wholesale REST/ETag migration.** T3 Code uses conditional REST requests, but Glass's monitoring path is predominantly GraphQL. ETags can help recurring REST GETs; they do not directly optimize GraphQL POSTs. [GitHub documents authenticated 304 savings for conditional GETs](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests).
- **The full persistent watch/activity subsystem.** T3 Code needs it for agent wakeups and monitoring that survives view changes. Adopt it only with the corresponding Glass product requirement. GitHub changes are not automatically Glass Activities: [the glossary](../../GLOSSARY.md) defines Activity as a meaningful thing the user did in Glass.
- **Copying exact tuning values.** T3 Code's batch sizes, intervals, queue limits, and quota reserve reflect its workload. Glass already has larger lightweight check batches and efficient repository synchronization.

## Suggested order

1. Make check badges truthful across failed refreshes and head changes.
2. Add a common concurrency bound and GitHub rate-limit cooldown, with background deferral and interactive headroom.
3. Add a cheap visible-workspace change check and activity-sensitive cadence if the freshness requirement calls for it.
4. Add durable backend watches only when a background agent/notification feature requires them.

The initial research pass changed no application behavior. Existing evidence includes the Keeping up with GitHub and Saved lists cases in [PullRequestLists.test.ts](../../apps/server/src/PullRequestLists.test.ts), the visibility/cache refresh cases in [reviews.test.tsx](../../apps/desktop/src/renderer/reviews.test.tsx), and request deadline cases in [requests.test.ts](../../apps/server/src/github/requests.test.ts).

## Implemented follow-up

The follow-up adds a common four-request bound, credential-scoped cooldowns, separate REST/GraphQL quota tracking and a ten-percent reserve for interactive work. List refreshes, Queue refreshes and workspace change checks defer at the reserve; opening workspaces and sending feedback may use it. Explicit GitHub cooldowns apply to both classes. Mutations are never automatically replayed.

Identical pending reads share their result within the same credential and traffic class. Readers cancel independently, completed responses are not retained, writes invalidate the sharing lookup before and after sending, and a later reader cannot extend the shared request's deadline. This is request sharing, not a persistent summary cache across different list and Queue queries.

Checks now carry head identity; failed refreshes retain same-head results with Not refreshed reporting and discard previous-head badges. The visible workspace polls its existing lightweight revision/updatedAt query and keeps the changed hint until Reload without replacing its pinned Revision or feedback. Broader fingerprints, activity-sensitive intervals and persistent backend watches remain deferred; the existing query still misses changes GitHub makes without updating updatedAt.

Validation: static checks, all 291 backend tests and all 253 renderer tests passed. An isolated Electron run proved list loading, failed refresh retention and workspace opening against fake GitHub, and a separate isolated run proved real GitHub sign-in and read-only loading of the probe PR. Follow-up test-fixture fixes replaced the Plugins test's Unix permissions assumption with a filesystem service denial and made Windows sandbox cleanup wait for process-tree termination before deleting working directories. The plugin deadline test waits for factory startup before advancing the TestClock. Verification evidence is local under `.verify/github-monitoring/evidence/`, `.verify/github-monitoring-real/evidence/` and `.verify/backend-failure-fixes.log`.
