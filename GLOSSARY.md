# Glass

A desktop workspace for reviewing GitHub pull requests, responding to feedback on them, and working
with coding agents.

## Language

### Resuming work

**Saved place**:
The last piece of work the user was doing in Glass, with their place in it, kept on this device
for them to continue. Visiting Settings or Activity leaves the Saved place unchanged.

### Reviewing

**PR list**:
Pull requests from followed repositories in Reviews, listed together newest first or by repository,
from which the user opens a PR workspace.

**Followed repository**:
A repository the user selects as a source for Glass's PR lists.
_Avoid_: Watched repository

**Review request**:
A request on GitHub for a person or team to submit a Review on a PR. It is outstanding while GitHub
still marks that review as requested.

**Needs review**:
The PR list of open pull requests by other authors, not marked as draft, with an outstanding Review
request to the user or one of their teams.

**My PRs**:
The PR list of open pull requests authored by the user, including PRs marked as draft.

**Reviewing**:
The PR list for resuming open pull requests by other authors, not marked as draft, that the user
has opened or worked on in Glass, or where they have Drafts or a submitted Review on GitHub.
A PR can appear in both Reviewing and Needs review.

**Queue**:
The pull requests the user has added to review next, from any repository, kept on this device in the
order added. When the user turns on Tours for the Queue in Settings, Glass writes a Tour for each
open PR that joins it, a few at a time, and leaves that Tour outdated rather than rewriting it after new
commits; turning them off cancels the ones still being written. A PR leaves the Queue when the user
removes it or submits a Review on it, which cancels a Tour still being written. It sits beside the
PR lists in Reviews but is not one of them.
_Avoid_: Batch, backlog, review list

**PR workspace**:
One open pull request with its description, changed files, diffs, and discussions, pinned to a
Revision.
_Avoid_: PR view, session

**Revision**:
The base and head commit pair a PR workspace is pinned to.
_Avoid_: Version, snapshot, latest

**Reviewer**:
A person or team with an outstanding Review request on a PR, or whose latest Review approved or
requested changes.

**Approval**:
Whether a PR's Reviews meet its repository's rules: approved, changes requested, or review
required. A repository that requires no reviews gives no Approval.
_Avoid_: Review decision, review status

**Check**:
An automated run reporting on a PR's head commit, such as a CI job: passed, failed, running, or
skipped.

**Tour**:
An agent-written reading order for one Revision of a PR: why the change exists, then Chapters
ordered from the part that matters most to the glue.
_Avoid_: Code tour, guided review, guide, walkthrough

**Chapter**:
One step of a Tour: a group of changed files that belong together, with an explanation of what
they do and why.
_Avoid_: Section, stop, step

**Tour engine**:
The agent that writes every Tour, whether the user starts it from a PR or the Queue starts it:
Claude Code or pi, each with its own model. The user chooses it in Settings.
_Avoid_: Default engine, runner (in UI copy), generator, provider

**Agent review engine**:
The agent that runs every Agent review, chosen in Settings apart from the Tour engine and with its
own model for each engine. It starts as pi.
_Avoid_: Default engine, runner (in UI copy), reviewer

**Agent review**:
An agent-written critique of one Revision of a PR, kept on this device for the user alone: one
Markdown document that opens with the PR's main risk, read beside the diff. Glass keeps the latest
one for each PR and leaves it outdated after new commits. Unlike a Review, it is never published
and never suggests a Review decision.
_Avoid_: AI review, code review, critique

**Review prompt**:
The user's own description of how they review, set once in Settings and used by every Agent review
inside Glass's fixed instructions. It starts as a default the user can restore.
_Avoid_: System prompt, instructions

### Feedback

**Draft**:
An unpublished inline comment on the user's GitHub pending review, visible only to them until a
Review is submitted.
_Avoid_: Pending comment, unsent comment

**Flagged draft**:
A Draft that can't be placed in the current diff because its line is outdated, it is on a whole
file, or its file's diff isn't shown.
_Avoid_: Broken draft, orphaned comment

**Review**:
Published feedback on a PR, consisting of a Review decision, an optional summary, and any Drafts
submitted together.
_Avoid_: Submission, batch

**Review decision**:
One of comment, approve, or request changes.
_Avoid_: Verdict, status

**Discussion**:
A published thread of comments on a line or on the PR itself.
_Avoid_: Conversation, comment chain

**Reply**:
A comment added to an existing Discussion.
_Avoid_: Response, answer

**Feedback state**:
Where a piece of the user's feedback stands: draft, sending, confirmed by GitHub, or failed.
_Avoid_: Sync status

### Activity

**Activity**:
One meaningful thing the user did in Glass, with when it happened, what it was done to, and what
they wrote: opening a PR workspace, viewing a file in it, submitting a Review, sending a Reply,
adding a To-do, marking one done, or starting an Agent. Messages to an Agent are not Activities. Scrolling past a file is not viewing it; editing, reopening,
or deleting a To-do is not an Activity.
_Avoid_: Event, action, audit entry

**Activity log**:
Every Activity the user has done, kept on this device, listed newest first in Glass for the user
to look back over and for agents and later features to search.
_Avoid_: History, audit log, event log, telemetry

### Planning

**To-do**:
Something the user means to do, written down in Glass, open until they mark it done.
_Avoid_: Task, action item

### Agents

**Agent**:
One named conversation, started from Glass, with Claude Code or pi working in one place: a worktree on
this device or a Sandbox.
_Avoid_: Session, thread, bot, box

**Agent program**:
Claude Code or pi, the program an Agent runs. It decides which models and efforts the user can pick,
and leaving either to it runs its own default.
_Avoid_: Engine (in UI copy), harness, provider

**Effort**:
How hard an Agent's model works on each Turn, from the levels its Agent program offers for that model.
_Avoid_: Thinking level, reasoning budget

**Local checkout**:
A clone of a repository on this device that the user links in Glass, from which each local Agent gets
a worktree of its own.

**Sandbox**:
The remote machine a Sandbox provider creates for one Agent, kept until the user removes the Agent
or it expires.
_Avoid_: Box, computer, devbox, pod

**Sandbox provider**:
A kind of Sandbox the user can start Agents in, such as a company's own Sandboxes, added to Glass by a
Plugin.
_Avoid_: Backend, platform, adapter

**Plugin**:
Code the user installs in Glass's plugins folder to add to what Glass can do, such as a Sandbox
provider.
_Avoid_: Extension, add-on

**Turn**:
One message to an Agent and its whole response. It ends done, failed, stopped by the user, cut off
when Glass loses the Agent, or interrupted when Glass quits.
_Avoid_: Run, execution, exchange

**Queued message**:
A message sent while a Turn runs, waiting to start the next Turn; the user can cancel it before then.

**Steer**:
A message sent into the running Turn, for the Agent to take in before it finishes.
_Avoid_: Interrupt, inject

**Unsent message**:
What the user has written to an Agent and not sent yet, with any images, kept for each Agent on this
device until they send or clear it.
_Avoid_: Draft (a Draft is a GitHub comment)

**Permission mode**:
How much a local Claude Code Agent may do without asking: default, accept edits, auto, or bypass.
Agents in a Sandbox always bypass.

**Permission request**:
An Agent asking the user to allow one tool call, waiting in its transcript until they answer.
_Avoid_: Approval, prompt

**Question**:
An Agent asking the user to choose between options or answer in their own words, waiting in its
transcript until they answer.
An Agent with a Permission request or Question waiting is marked in the Agents list.

### Identity

**Connection**:
The GitHub identity Glass acts as, and where its token came from.
_Avoid_: Session, account, login
