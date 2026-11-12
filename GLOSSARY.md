# Glass

A desktop workspace for reviewing GitHub pull requests, responding to feedback on them, and working
with coding agents.

## Language

### Resuming work

**Saved place**:
The last piece of work the user was doing in an area of Glass, with their place in it, kept on this
device for them to continue. Each area keeps its own: the last PR in Reviews, the last Agent in
Agents. Visiting Settings or Activity leaves every Saved place unchanged.

**Needs you**:
The Agents, questions from an agent outside Glass, and queued PRs waiting on the user now. They live
in the Inbox, grouped by why they are waiting, with their count on the Inbox rail link in every area.
The Dashboard shows that count once Needs you has loaded, and links to the Inbox.
While it is loading or the stream has failed, the count stays off the Dashboard, the Inbox header, and the rail.

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
order added. When the user turns on Tours or Agent reviews for the Queue in Settings, Glass writes
a Tour or runs an Agent review for each open PR that joins it without one: Tours a few at a time,
Agent reviews one at a time. It leaves them outdated rather than redoing them after new commits;
turning either off cancels the ones still in progress. A PR leaves the Queue when the user removes
it or submits a Review on it, which cancels its Tour or Agent review still in progress. It sits
beside the PR lists in Reviews but is not one of them.
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
An agent-written reading order for one Revision of a PR: why the change exists, a Before / after
of the whole change when it has one, then Chapters ordered from the part that matters most to the
glue.
_Avoid_: Code tour, guided review, guide, walkthrough

**Before / after**:
A short plain-language outline of how something worked and how it works now, with removed and added
lines beside the unchanged ones that place them. A Tour may open with one for the whole PR, and a
Chapter may carry one for its own part.
_Avoid_: Call tree, show me, summary diagram

**Tour overview**:
The card that opens a Tour with a Before / after: why the change exists beside its Before / after,
above the first Chapter.
_Avoid_: Overview (the PR's Overview tab is a different place)

**Chapter**:
One step of a Tour: a group of changed files that belong together, with an explanation of what
they do and why. A Chapter may include one map, either a diagram (optionally with a flow the reader
can step through) or a Before / after, plus callouts linked to diff lines.
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

**Follow-up**:
A message the user sends about an Agent review, read beside it, and the agent's answer, which may
include Suggested drafts. Each one is a Turn of the Agent review's own Agent, which Glass starts on
the first Follow-up. An Agent review keeps its Follow-ups until it is written again, and takes new
ones only while it is current.
_Avoid_: Chat, thread

**Suggested draft**:
A comment for the PR's author that the agent proposes in a Follow-up, on a line of the diff. It
becomes a Draft only when the user adds it, after any edits.
_Avoid_: Proposed comment, AI comment

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

**Reaction**:
One of GitHub's eight emoji a person gives a published comment, which publishes right away.
_Avoid_: Emoji, like

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
this device, a Sandbox, or, for an Agent review's Follow-ups, a checkout of the review's Revision.
_Avoid_: Session, thread, bot, box

**Global conversation**:
The one conversation the user has with Glass itself, opened over any area without leaving it,
run by pi. It works in no repository and needs no Local checkout; it reads no files and
runs no commands, but reads the user's work in Glass through Glass's tools, starts Agent reviews,
creates Agents and messages them, and asks the user Questions. A message keeps the PR workspace
and Revision, or the Agent, in view when it was sent.
_Avoid_: Assistant, chat, copilot, global Agent

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
or it expires. While Glass runs, it extends a Sandbox that expires ahead of expiry, up to the
platform's cap.
_Avoid_: Box, computer, devbox, pod

**Sandbox provider**:
A kind of Sandbox the user can start Agents in, such as a company's own Sandboxes, added to Glass by a
Plugin.
_Avoid_: Backend, platform, adapter

**Plugin**:
Code the user installs in Glass's plugins folder to add to what Glass can do, such as a Sandbox
provider.
_Avoid_: Extension, add-on

**Skill pack**:
A named set of skills from one GitHub folder, pinned to a commit, that the user adds in Settings
and picks for an Agent when creating it. An Agent keeps the packs and commits it was created with.
_Avoid_: Skill set, registry, bundle, plugin

**Local skills**:
The skills in the user's skill folders on this device that the Agent program reads. Local Agents
always have them; a Sandbox Agent has them only if the user picks them when creating it.
_Avoid_: My skills, user skills

**Turn**:
One message to an Agent and its whole response. It ends done, failed, stopped by the user, cut off
when Glass loses the Agent, or interrupted when Glass quits; a Sandbox Agent's Turn carries on
while Glass is closed.
_Avoid_: Run, execution, exchange

**Queued message**:
A message sent while a Turn runs, waiting to start the next Turn; the user can cancel it before then.
Canceling one returns its Feedback notes to the Agent's unsent feedback.

**Mention**:
A To-do or file the user points at from a message to an Agent, by typing `@` and picking it. The
message shows a To-do by its title and a file by its name. The Agent reads a To-do's title and notes
as they are when the message reaches it, and a file's path. Files come from the Agent's folder, or,
for a New Agent's first message, from the branch it starts from: the Local checkout's copy of it on
this device, or GitHub's for a Sandbox.
_Avoid_: Reference, attachment, tag, chip

**Command**:
A skill, prompt template, or command the Agent program runs when a message starts with `/` and its
name, as the program lists them for the Agent's folder. Glass offers them after a leading `/`; a
Sandbox Agent has none until its Sandbox is up.
_Avoid_: Slash command (in UI copy), skill (for the whole list)

**Steer**:
A message sent into the running Turn, for the Agent to take in before it finishes.
_Avoid_: Interrupt, inject

**Unsent message**:
What the user has written to an Agent or the Global conversation and not sent yet, with any images
and, for an Agent, the Feedback notes added to it, kept for each on this device until they send or
clear it.
_Avoid_: Draft (a Draft is a GitHub comment)

**Feedback note**:
An instruction the user leaves on a line or range on either side of an Agent's Changes, kept with
the code they read there. The user adds the notes to the Agent's Unsent message and sends them
together as one message to that Agent, which then keeps them in its conversation; Glass never
publishes them.
_Avoid_: Draft, review comment

**Permission mode**:
How much a local Claude Code Agent may do without asking: default, accept edits, auto, or bypass.
Agents in a Sandbox always bypass.

**Permission request**:
An Agent asking the user to allow one tool call, waiting in its transcript until they answer.
_Avoid_: Approval, prompt

**Question**:
An Agent asking the user to choose between options or answer in their own words, waiting in its
transcript until they answer.
An Agent with a Permission request or Question waiting is marked in the Agents list and listed in
Needs you.
An agent outside Glass can ask through Glass's MCP endpoint after the user approves it. That
question waits in the Inbox, under Stopped on you, until the user answers or the wait ends.

**Outside agent**:
An agent Glass did not launch. The user approves it once, and it can then use Glass's MCP tools
on this computer, including asking a question. It is not a conversation Glass started.
_Avoid_: Session, client, login

### Identity

**Connection**:
The GitHub identity Glass acts as, and where its token came from.
_Avoid_: Session, account, login

### Storage

**Storage**:
The disk space Glass's database takes up on this device, shown in Settings.
_Avoid_: Disk usage

**Storage group**:
One part of Storage: Agents, Reviews, Activity, To-dos, Glass internals, or SQLite overhead. Each
holds the tables behind that part of Glass; SQLite overhead holds its write-ahead log and free
space.
_Avoid_: Area, which names a part of Glass the user visits

### Developing Glass

**Dogfood report**:
A note a Glass developer records the moment something in Glass is broken or could be better, kept
with what Glass was showing and the data behind it, so an agent can bring that moment back,
compare it with new code, and, for a Tour or Agent review, write it again. Dogfood reports never
leave the device.
_Avoid_: Feedback, bug report, snag
