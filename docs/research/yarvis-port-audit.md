# Yarvis features worth adapting for Glass

Audit date: 2026-11-04. **Prioritize re-review interdiffs, local feedback on Agent Changes, and Agent–PR links.** These close gaps between Glass's two central workflows: reviewing PRs and directing Agents. Rankings below express product fit and durability, not implementation cost. All proposed scopes are recommendations inferred from inspected source; they are not implementation commitments.

## Baseline and method

Glass: `006d8373cc05949cccd66635601f7c5343a9ae5c`, initially clean. Yarvis: [`05da29dabb11fd2597f3ec0bc32db31d83f1c0a8`][commit], committed 2026-11-03 02:05:57 UTC and still `main` when checked through GitHub's API. Read [AGENTS.md](../../AGENTS.md), [GLOSSARY.md](../../GLOSSARY.md), source, and relevant ADRs. Used opensrc 0.7.3's cached source at:

```text
C:/Users/kevin/.opensrc/repos/github.com/bennettaur/yarvis/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8
```

Repeat the acquisition and identity checks with:

```powershell
opensrc --version
gh api repos/bennettaur/yarvis/commits/main --jq .sha
opensrc fetch github:bennettaur/yarvis@05da29dabb11fd2597f3ec0bc32db31d83f1c0a8
gh api 'repos/bennettaur/yarvis/git/trees/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8?recursive=1'
```

**Fetch caveat:** the initial cached `main` was stale. The SHA-qualified fetch warned that it could not find the ref and cloned the default branch instead; the cache directory name alone does not establish identity. Independently compared LF-normalized Git blob SHA-1s against GitHub's tree for 13 central files, including README, interdiff/checkpoints, re-review, comments, poller, insights, definitions, attention, digest, recap, GitHub client, and issues documentation: all matched. For a repeat audit, verify fetched contents rather than trusting the requested ref.

This is source inspection only: no apps, tests, model runs, databases, or production systems were accessed. Implemented upstream means code exists, not that behavior or portability was demonstrated. GitHub's complete tree contained no files named LICENSE/COPYING/LICENCE; adapt ideas and independently implement them rather than assuming permission for wholesale source copying.

## What Glass already has

Avoid recommending duplicates. Glass already has a Revision-pinned [repository browser](../../apps/desktop/src/renderer/RepositoryBrowser.tsx), whole-file reads, file-tree search, [Agent Changes](../../apps/desktop/src/renderer/AgentChanges.tsx), [waiting-Agent streams](../../apps/desktop/src/renderer/agentsArea.ts), Queued messages and Steer, and durable [transcripts](../../apps/server/src/Transcripts.ts). Its [Dashboard](../../apps/desktop/src/renderer/Dashboard.tsx) already combines Saved places, Queue, Activity, and To-dos.

[To-do Mentions](../../apps/server/src/Agents.ts) already resolve current title/notes at delivery through [prompt construction](../../apps/server/src/prompt.ts). [Agent review Follow-ups](../adr/0009-agent-review-follow-ups-are-turns-of-an-agent.md) already provide a persistent conversation and Suggested drafts. These differ from individual line questions, whose answers currently live in renderer memory. Glass's [glossary](../../GLOSSARY.md) reserves Drafts for GitHub pending-review comments and says Agent reviews never suggest a Review decision.

## Ranked ports

| Tier | Rank | Port | Smallest useful outcome |
| --- | --- | --- | --- |
| Core | 1 | Since last review | Trustworthy deterministic interdiff and explicit checkpoint |
| Core | 2 | Local Agent Changes annotations | Collect feedback and send one message to the same Agent |
| Core | 3 | Agent–PR linkage | Navigate both ways and inspect Checks/Approval |
| Next | 4 | Global needs-you surface | Reach the exact waiting Permission request or Question |
| Next | 5 | Durable line questions | Recover private answers after restart and Revision changes |
| Next | 6 | To-do → Agent | Start work with existing Mention context and a durable source link |
| Selective | 7 | Repository content/symbol search | Follow relevant code beyond changed files |
| Selective | 8 | Work recap and retrieval | Resume work using evidence linked to its source |

### 1. Since last review

**Upstream:** [sinceReview.ts][since] compares old and new PR-only changes from their respective merge-bases, matches rebased commits through stable patch IDs, and carries reviewed file contents onto today's base with a three-way merge. Conflicts explicitly fall back to including upstream changes. [Review marks][marks] preserve reviewed commits with refs; marks can originate from manual checkpoints, submitted reviews, and comments. This goes substantially beyond `oldHead..newHead`.

**Port:** record an explicit checkpoint and submitted Review's Revision; show changed-again, newly changed, and reverted files, with base-movement/conflict/unavailable-history indicators. Preserve the original checkpoint while reading. This directly reduces repeat reading without hiding upstream changes.

**Start:** [Checkouts.ts](../../apps/server/src/Checkouts.ts), [GitHubClient.ts](../../apps/server/src/github/GitHubClient.ts), [Workspace.tsx](../../apps/desktop/src/renderer/Workspace.tsx), [FinishReview.tsx](../../apps/desktop/src/renderer/FinishReview.tsx), and contracts/storage for the checkpoint.

**Traps:** one inline comment does not prove the whole PR was reviewed; do not automatically advance a global checkpoint on every comment. Handle renames, missing force-pushed objects, binary/large files, and retention. Add explanatory re-review later: Yarvis validates citations and coverage but also emits [“ready to approve”][rereview], which Glass should omit.

### 2. Local annotations on Agent Changes

**Upstream:** [reviewComments.ts][comments] stores local line-range notes with resolution and user/report provenance. Its [formatter][format-comments] collects unresolved comments into one agent-readable message; the UI offers [Copy for Claude][comments-ui]. This is a feedback loop before publishing a PR.

**Port:** persist notes on the displayed Agent Changes, allow explicit resolution, then preview/send the unresolved set as **one** message to that same Agent. Reuse Queued message and Steer behavior, with an explicit send action. A separate conversation or review agent is unnecessary.

**Start:** [AgentChanges.tsx](../../apps/desktop/src/renderer/AgentChanges.tsx), [ChangedFilesView.tsx](../../apps/desktop/src/renderer/ChangedFilesView.tsx), [Changes.ts](../../apps/server/src/agentHost/Changes.ts), [AgentView.tsx](../../apps/desktop/src/renderer/AgentView.tsx).

**Traps:** upstream records current HEAD, possibly null; that cannot identify uncommitted line drift. Glass already builds an isolated-index working-tree tree, but returns only ChangedFiles: expose immutable tree/content identity and preserve selected text. Mark stale placements visibly. Call these local notes, never Drafts; distinguish model findings from the user's instructions.

### 3. Connect Agents and PRs

**Upstream:** [workspace polling][poller] maintains cached PR/Checks state with batched reads, approximately one-minute foreground refresh and fifteen-minute background refresh, including rate-limit handling. It is not a once-per-minute scan of every workspace.

**Port:** explicit PR linkage first; show title, Checks, Approval, and navigation from Agent to PR and back. Offer a user-sent message containing selected failed Checks or feedback. Automatic discovery can follow using validated repository/head-owner/head-ref identity, with ambiguity surfaced.

**Start:** [agent.ts](../../packages/contracts/src/agent.ts), [Agents.ts](../../apps/server/src/Agents.ts), [AgentView.tsx](../../apps/desktop/src/renderer/AgentView.tsx), [pullRequestStatus.ts](../../apps/server/src/github/pullRequestStatus.ts), [PullRequestMirror.ts](../../apps/server/src/PullRequestMirror.ts), [GitHubRequestPolicy.ts](../../apps/server/src/github/GitHubRequestPolicy.ts).

**Traps:** the Agent schema currently lacks a PR relation. Reuse Glass's cache/request policy; show stale/unavailable observations. “Start Agent on existing PR” also needs deliberate branch ownership: [LocalPlacement.ts](../../apps/server/src/LocalPlacement.ts) currently creates a new named branch. Merely selecting the PR branch as base does not resume that branch.

### 4. A global needs-you surface

**Upstream:** [attention storage][attention] coalesces pending items; its [panel][attention-panel] groups them and its [client][attention-client] suppresses notifications for visible work. [OS notification delivery][notify] is best-effort. Opening a scope can mark items read, while questions remain pending.

**Port:** a globally reachable list of waiting Permission requests and Questions, deep-linked to the exact Agent/Turn/request. This extends Glass's existing Agents-list “Waiting on you,” not a new generic event system. Add completion/failure notices only if actual use justifies them.

**Start:** [agentsArea.ts](../../apps/desktop/src/renderer/agentsArea.ts), [Agents.tsx](../../apps/desktop/src/renderer/Agents.tsx), [AgentView.tsx](../../apps/desktop/src/renderer/AgentView.tsx), [Transcripts.ts](../../apps/server/src/Transcripts.ts).

**Traps:** derive actionable state from authoritative transcript/request streams. Viewing is not answering; dismissing a notification must not resolve a Permission request. Preserve request identity through reconnects and suppress redundant notifications while focused.

### 5. Persist private line questions and answers

**Upstream:** [insights.ts][insights] stores question, answer, path/range and head SHA, retains them beyond a review, and searches by substring. Its [cards][insight-cards] label older answers outdated and require explicit publication.

**Port:** persist each completed answer with PR, full Revision, AskPlace, question, answer and runner identity; restore after restart and retain older answers as outdated. Add literal text search once retrieval has a concrete reader.

**Start:** [Asks.ts](../../apps/server/src/Asks.ts), [useAsks.ts](../../apps/desktop/src/renderer/useAsks.ts), [Asks.tsx](../../apps/desktop/src/renderer/Asks.tsx), contracts and SQLite migration. The current server returns answers without saving them; `Atom.keepAlive` only preserves renderer memory.

**Traps:** retain original placement, not today's same line number. Private answers remain separate from Drafts, Discussions, and Agent review Follow-ups. Never publish an answer silently. [ADR 0002](../adr/0002-activity-log-in-sqlite.md) supports SQLite and derived search when needed; this feature does not need a vector database.

### 6. Start an Agent from a To-do, then an issue

**Upstream:** [issue routes][issues] create/link workspaces, seed a brief and launch work; [task/issue documentation][issue-doc] also describes assignment, labels and automatic task completion on workspace archival.

**Port:** “Start Agent” on a To-do opens existing creation controls with a Mention in the initial message, plus a durable To-do→Agent source link. Next, support a GitHub issue URL with repository selection and title/body/link as context. This builds on current Mention expansion rather than replacing it.

**Start:** [ToDos.tsx](../../apps/desktop/src/renderer/ToDos.tsx), [NewAgent.tsx](../../apps/desktop/src/renderer/NewAgent.tsx), [Agents.ts](../../apps/server/src/Agents.ts), [ToDos.ts](../../apps/server/src/ToDos.ts), [prompt.ts](../../apps/server/src/prompt.ts).

**Traps:** keep completion user-controlled. Archival or a merged PR does not establish that a To-do is done. Treat issue bodies as source material; assignment and label mutations require deliberate product scope. JIRA/Azure dashboard parity is unnecessary.

### 7. Extend existing repository navigation

**Upstream:** [definitions.ts][definitions] searches Git objects with `git grep`, then ranks heuristic definitions/references by language and proximity, with byte/result/time limits. It does not run a language server or execute PR code.

**Port:** repository-wide literal content search at the pinned Revision, opening a result at its line in the existing Repository tab. Add symbol-reference lookup if needed; label heuristic candidates honestly. This is narrower than a new editor and more useful than duplicating whole-file viewing.

**Start:** [RepositoryBrowser.tsx](../../apps/desktop/src/renderer/RepositoryBrowser.tsx), [Checkouts.ts](../../apps/server/src/Checkouts.ts), [GitHubClient.ts](../../apps/server/src/github/GitHubClient.ts), repository/RPC contracts.

**Traps:** Checkouts currently validates the current PR head; it is not an arbitrary historic-Revision search API. Define behavior for moved heads, capped/truncated repositories, generated files and binary data. Avoid presenting regex matches as type-aware definitions.

### 8. Work recap, search, and next-work suggestions

**Upstream:** [workspace recap][recap] summarizes recent Claude transcripts on demand, cached by session/mtime. [Digest][digest] deterministically ranks dangling work and honors durable dismissals; [summary material][summary] gathers evidence and reports unavailable sources.

**Port:** extend the existing Dashboard with a deterministic combined list of waiting work, unfinished reviews, Agents and To-dos, with reasons and direct links. Add user-triggered recap of a chosen Agent/period, linked to its source Turns; then searchable past work.

**Start:** [Dashboard.tsx](../../apps/desktop/src/renderer/Dashboard.tsx), [ActivityLog.ts](../../apps/server/src/ActivityLog.ts), [Transcripts.ts](../../apps/server/src/Transcripts.ts), [ActivityLogPage.tsx](../../apps/desktop/src/renderer/ActivityLogPage.tsx).

**Traps:** use Glass's persisted Claude Code/pi transcripts rather than scraping `~/.claude`. Messages are not Activities. Summaries are derived interpretations, not completion evidence. Do not copy review-frequency nudges, Postgres/pgvector, or an ambient memory system without a demonstrated need.

## Later or skip

| Candidate | Assessment |
| --- | --- |
| Read-only stack context | Worth a later review feature: upstream [walks base/head relationships][stack] without a clone. Its linear walk chooses one branch at forks; show ambiguity and truncation rather than asserting a complete dependency graph. Keep merges/restacks outside the initial port. |
| Setup/run scripts and logs | A legitimate future Agent-placement capability; upstream [documents both][workspace-doc]. Start with explicit commands, logs, cancellation and clear trust boundaries. Avoid a terminal/IDE expansion; respect Glass's [Sandbox-provider seam](../adr/0010-sandboxes-come-from-provider-plugins.md). |
| Verification sections / must-read files | Upstream [implements a richer report surface][verification-doc]. Borrow evidence links and coverage gaps if useful; Glass already has Tours and prose Agent reviews. Do not import parallel section-agent machinery by default. |
| Mutation-testing sandbox | Defer. Upstream [testSandbox.ts][test-sandbox] depends on macOS `sandbox-exec` and explicitly leaves setup unsandboxed. No Windows portability or equivalent isolation was established. |
| Multi-repo workspaces | Upstream [supports them][workspace-doc]; Glass's Agent means one place/repository. Require a concrete cross-repository workflow before changing that model. |
| MCP | Upstream [serves and consumes MCP][mcp]. Consider a small read-only To-do/Activity/recap server when an external reader exists; a broad MCP client is separate scope. |
| Scheduled jobs / heads-down orchestration | [Present upstream][features], but add durable scheduling, authority, cancellation and recovery obligations. Defer until user-driven loops work well. |
| Voice, Calendar, Telegram, browser integration, clipboard, generated dashboards | [Documented upstream][features]; lower fit for the current review/Agent hub. Skip absent a concrete user requirement. |

The main correction to the initial shortlist is navigation: full-repository browsing already exists, so only content/symbol search is new. Stack context is separate and deferred. The first three ports remain the strongest; none requires importing Yarvis's broader personal-assistant architecture.

[commit]: https://github.com/bennettaur/yarvis/commit/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8
[since]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/reviewWorkspaces/sinceReview.ts#L1-L26
[marks]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/reviewWorkspaces/reviewMarks.ts#L70-L240
[rereview]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/reviewWorkspaces/rereview.ts#L348-L554
[comments]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/workspaces/reviewComments.ts#L93-L171
[format-comments]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/src/lib/workspaceReview.ts#L115-L174
[comments-ui]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/src/components/workspaces/WorkspaceReviewComments.tsx#L13-L63
[poller]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/workspaces/poller.ts#L1-L145
[attention]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/attention/service.ts#L28-L167
[attention-panel]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/src/components/attention/AttentionPanel.tsx#L62-L100
[attention-client]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/src/lib/attentionStore.ts#L110-L126
[notify]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/src/lib/notify.ts#L7-L19
[insights]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/pr/insights.ts#L6-L73
[insight-cards]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/src/components/pr/InsightCards.tsx#L24-L57
[issues]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/issues/routes.ts#L417-L493
[issue-doc]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/docs/features/issues-and-tasks.md#L54-L193
[definitions]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/reviewWorkspaces/definitions.ts#L420-L580
[recap]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/workspaces/activity.ts#L9-L143
[digest]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/digest/service.ts#L275-L344
[summary]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/digest/summary.ts#L48-L207
[stack]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/github/client.ts#L1792-L1865
[workspace-doc]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/docs/features/workspaces.md#L1-L118
[verification-doc]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/docs/features/review-workspaces.md#L178-L247
[test-sandbox]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/sidecar/src/reviewWorkspaces/testSandbox.ts#L1-L55
[mcp]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/docs/features/mcp.md#L1-L6
[features]: https://github.com/bennettaur/yarvis/blob/05da29dabb11fd2597f3ec0bc32db31d83f1c0a8/README.md#L97-L118
