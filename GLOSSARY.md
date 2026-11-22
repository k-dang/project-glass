# Glass

A desktop workspace for reviewing GitHub pull requests, responding to feedback on them, and working
with coding agents.

## Language

### Getting around

**Area**:
One of the top-level parts of Glass the user moves between from the rail, such as Reviews or
Threads.
_Avoid_: Section, tab, page

**Command menu**:
The search box opened with ⌘K or Ctrl+K from anywhere in Glass, for running any action the current
view offers, jumping to a PR or Thread by name, and starting a Thread from what was typed.
_Avoid_: Command palette, quick open (a Command is something an Agent harness runs)

### Resuming work

**Saved place**:
The last piece of work the user was doing in an Area, with their place in it, kept on this device
for them to continue.

**Needs you**:
The Threads, questions, Check-ins, and PRs waiting on the user now, listed in the Inbox and
grouped by why they wait.

### Reviewing

**PR list**:
Pull requests from Followed repositories, listed in Reviews, from which the user opens a PR
workspace.

**Followed repository**:
A repository the user selects as a source for Glass's PR lists.
_Avoid_: Watched repository

**Needs review**:
The PR list of open, non-draft pull requests by other authors that request a review from the user
or one of their teams.

**My PRs**:
The PR list of open pull requests authored by the user, including drafts.

**Reviewing**:
The PR list of open, non-draft pull requests by other authors that the user has worked on in Glass
or on GitHub, for picking them back up.

**Queue**:
The pull requests the user has added to review next, from any repository, kept on this device in
the order added; Glass can write a Tour or run an Agent review for each. It sits beside the PR
lists but is not one of them.
_Avoid_: Batch, backlog, review list

**PR workspace**:
One open pull request with its description, changed files, diffs, and comments, pinned to a
Revision.
_Avoid_: PR view, session

**Revision**:
The base and head commit pair a PR workspace is pinned to.
_Avoid_: Version, snapshot, latest

**Tour**:
An agent-written reading order for one Revision of a PR: why the change exists, then Chapters
ordered from the part that matters most to the glue.
_Avoid_: Code tour, guided review, guide, walkthrough

**Tour overview**:
The card that opens a Tour: why the change exists beside one diagram or Before / after.
_Avoid_: Overview (the PR's Overview tab is a different place)

**Chapter**:
One step of a Tour: a group of changed files that belong together, with what they do and why.
_Avoid_: Section, stop, step

**Before / after**:
A short plain-language outline of how something worked and how it works now, for a whole PR or one
Chapter.
_Avoid_: Show me, summary diagram

**Tour engine**:
The Agent harness, with its model, that writes every Tour, chosen in Settings.
_Avoid_: Default engine, runner (in UI copy), generator, provider

**Agent review**:
An agent-written critique of one Revision of a PR, kept on this device for the user alone and
read beside the diff. Unlike a GitHub review, it is never published and never approves or
requests changes.
_Avoid_: AI review, code review, critique

**Agent review engine**:
The Agent harness, with its model, that runs every Agent review and answers every Ask, chosen in
Settings apart from the Tour engine.
_Avoid_: Default engine, runner (in UI copy), reviewer

**Hotspot**:
One of the few places in a PR an Agent review ranks for the closest read, with why it matters and
what to check.
_Avoid_: Finding, issue, risk area

**Low-attention file**:
A changed file an Agent review says needs little attention, such as generated code or a version
bump.
_Avoid_: Plumbing, noise, skippable file

**Follow-up**:
A message the user sends about an Agent review and the agent's answer, a Turn of the Agent
review's own Thread.
_Avoid_: Chat

**Suggested draft**:
A comment the agent proposes in a Follow-up on a line of the diff, which becomes a Draft only when
the user adds it.
_Avoid_: Proposed comment, AI comment

**Ask**:
A question the user asks the agent about one line of a PR's diff, answered privately beside it and
never sent to GitHub.
_Avoid_: Question (an agent asks those), comment

**Review prompt**:
The user's own description of how they review, set in Settings and given to every Agent review.
_Avoid_: System prompt, instructions

### Feedback

**Draft**:
An unpublished inline comment on the user's GitHub pending review, visible only to them until their
review is submitted.
_Avoid_: Pending comment, unsent comment

**Flagged draft**:
A Draft that can't be placed in the current diff, because its line is outdated, it is on a whole
file, or its file's diff isn't shown.
_Avoid_: Broken draft, orphaned comment

**Review thread**:
A published GitHub thread of comments on a line, range, or whole file of a PR, which the user can
reply to and resolve.
_Avoid_: Discussion, thread (a Thread is work with an agent), comment chain

**Feedback state**:
Where a piece of the user's feedback stands: draft, sending, confirmed by GitHub, or failed.
_Avoid_: Sync status

### Activity

**Activity**:
One meaningful thing the user did in Glass, such as opening a PR workspace, submitting a review,
or starting a Thread, with when it happened and what it was done to.
_Avoid_: Event, action, audit entry

**Activity log**:
Every Activity the user has done, kept on this device, for the user to look back over and for
agents to search.
_Avoid_: History, audit log, event log, telemetry

### Planning

**To-do**:
Something the user means to do, written down in Glass, open until they mark it done. A To-do
mentioned in a Thread's first message is marked done when that Thread's PR merges,
unless the user marked it done first.
_Avoid_: Task, action item

### Threads

**Thread**:
The named, lasting history of the user's work with one agent from Glass, run by an Agent harness
and a model and working in one place: a worktree on this device, a Sandbox, or a checkout of an
Agent review's Revision. The user starts one, or the Global chat or another
Thread's agent does for them. Any Thread can create and message other Threads through Glass's
tools, but never one that asks the user less than it does, and never itself; one in a Sandbox can
reach only Threads in a Sandbox. A Thread is not a Session, which is one stretch of the Global
chat.
_Avoid_: Conversation, chat, bot, box

**Thread's PR**:
The PR whose head is the branch the Thread's folder has checked out.
_Avoid_: Linked PR, agent PR

**Settled**:
A Thread whose PR merged after the user last wrote to it, with no Turn running or waiting on
the user. Glass lists it apart from the Threads still going, and it stops being Settled when
the user writes to it again or brings it back.
_Avoid_: Archived, done, finished, closed

**Global chat**:
The one chat the user has with Glass itself, opened over any Area, which works through
Glass's tools rather than in a repository. Its model and the work it started stay with it across
Sessions.
_Avoid_: Assistant, copilot, Global conversation

**Session**:
One stretch of the Global chat's transcript, run in one pi session and sharing its id. Start fresh
ends the current Session and begins the next; an ended Session stays readable but can't continue.
_Avoid_: Past chat, Past conversation, history, archived chat

**Started work update**:
A Turn Glass starts in the Global chat or a Thread to tell it that work it started
finished, failed, or needs the user's input.
_Avoid_: Global chat update, notification, event, wake-up

**Agent harness**:
Claude Code or pi, the harness that runs an agent and decides which models and Efforts it offers.
_Avoid_: Engine, provider

**Effort**:
How hard a Thread's model works on each Turn, from the levels its Agent harness offers.
_Avoid_: Thinking level, reasoning budget

**Local checkout**:
A clone of a repository on this device that the user links in Glass, from which each local
Thread gets a worktree of its own.

**Sandbox**:
The remote machine a Sandbox provider creates for one Thread.
_Avoid_: Box, computer, devbox, pod

**Sandbox provider**:
A kind of Sandbox the user can start Threads in, added to Glass by a plugin.
_Avoid_: Backend, platform, adapter

**Skill pack**:
A named set of skills from one GitHub folder, pinned to a commit, that the user picks for a
Thread when creating it.
_Avoid_: Skill set, registry, bundle, plugin

**Local skills**:
The skills in the user's skill folders on this device that the Agent harness reads.
_Avoid_: My skills, user skills

**Turn**:
One message to a Thread and its agent's whole response, or work the agent starts on its own
when background work reports back.
_Avoid_: Run, execution, exchange

**Agent status**:
A short line about what a Thread's agent has going besides its Turn, such as background
subagents or commands.
_Avoid_: Extension status, widget, banner

**Diagram**:
A named Mermaid picture a Thread's agent draws beside the Thread when the user asks for
one.
_Avoid_: Artifact, chart, whiteboard

**File pane**:
A file from a Thread's folder shown beside the Thread, opened from a path the agent
named. An HTML file opens in the Browser pane instead.
_Avoid_: Artifact, preview, viewer

**Browser pane**:
A web page shown beside a Thread, at an address the user or the Thread's agent opened. A Thread
has at most one. What the user signs in to in one Browser pane stays signed in for every Thread on
this device; Threads in a Sandbox share sign-ins only with each other, and their pages can't reach
this device.
_Avoid_: Preview, webview, browser tab

**Queued message**:
A message sent while a Turn runs, waiting to start the next Turn.

**Mention**:
A To-do or file the user points at from a message to a Thread by typing `@` and picking it.
_Avoid_: Reference, attachment, tag, chip

**Command**:
A skill, prompt template, or command the Agent harness runs when a message starts with `/` and its
name.
_Avoid_: Slash command (in UI copy), skill (for the whole list)

**Steer**:
A message sent into the running Turn, for the agent to take in before it finishes.
_Avoid_: Interrupt, inject

**Unsent message**:
What the user has written to a Thread or the Global chat and not sent yet, kept on
this device.
_Avoid_: Draft (a Draft is a GitHub comment)

**Feedback note**:
An instruction the user leaves on a line or range of a Thread's or Check-in's changes, or on
part of a page in a Browser pane, sent to the agent and never published.
_Avoid_: Draft, review comment

**Permission mode**:
How much the agent in a local Claude Code Thread may do without asking: default, accept
edits, auto, or bypass.

**Question**:
An agent asking the user to choose between options or answer in their own words, waiting until
they answer.

**Outside agent**:
An agent Glass did not launch that the user has approved to use Glass's MCP tools on this
computer.
_Avoid_: Session, client, login

**Check-in**:
An Outside agent asking the user to read the changes in a folder on this computer and approve them
or send Feedback notes back.
_Avoid_: Review, code review, Read request

### Identity

**Connection**:
The GitHub identity Glass acts as, and where its token came from.
_Avoid_: Session, account, login

### Storage

**Storage group**:
One part of the disk space Glass's database takes on this device, shown in Settings:
Threads, Reviews, Activity, To-dos, Glass internals, or SQLite overhead.
_Avoid_: Disk usage, Area

### Developing Glass

**Dogfood report**:
A note a Glass developer records the moment something in Glass is broken or could be better, kept
on this device with what Glass was showing and the data behind it, so an agent can bring that
moment back.
_Avoid_: Feedback, bug report, snag
