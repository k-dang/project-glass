# Glass Strategy

## Vision

<!-- vision: author-approved 2026-11-22 -->

`Glass` exists so that one developer can review pull requests and direct coding agents from one place, without losing track of what waits on them.
It serves Kevin, its only user, and it turns his PRs, issues, To-dos, and agent work into one list of what needs him and a place to act on each item.
It owns exactly one thing: the user's side of the loop, deciding, reviewing, steering, and fixing small things himself, while people and agents do the rest.

### Built for one person

Glass has one user and no releases, and it is never handed to anyone else.
A change serves how Kevin works today; it does not generalize for users Glass will not have.
Migrations carry his one database forward, with no compatibility shims and no tests for migrations that already ran.
What one person needs from a team tool, such as review requests from his teams, is welcome; team features for other people are not.

### Many inputs, one list

Work reaches Glass from more than GitHub: issues from a tracker such as Linear belong in the Inbox beside PRs, Check-ins, and To-dos.
Each new input lands in the existing Inbox and starts work the existing way, such as a Thread, rather than bringing its own screen.
Glass is an interface over other sources of truth, such as GitHub and Linear, never a replacement for them; it keeps only what no other source holds, such as To-dos, Agent reviews, and Threads.
State stays on the machine it was made on; Glass does not sync between machines.

### The user publishes, agents propose

Agent reviews, Asks, and Tours stay on this device, and no words reach GitHub under Kevin's name until he has read them.
A Suggested draft becomes a Draft only when he adds it, and an Agent review never approves or requests changes.
Publishing for him without a read waits until it carries a plain mark that his bot wrote it and a way to review what it sent; until then it is refused.
Inside Glass, automation is welcome when he switches it on and can stop it, such as Agent reviews for the Queue, auto-merge he queued, or a Global chat that starts Threads for ready To-dos, merges their PRs once checks pass, and reports what it did.
An agent never asks the user less than the agent that started it does, and the user can take back anything an agent drives, such as its Browser pane.
A small fix the user makes by hand, on a line in a Thread's Changes or a PR workspace, is welcome rather than routed through an agent Turn; Glass is not a code editor, and editing stops at small fixes where he reads.

### Borrow the agents, own the workspace

Glass drives Agent harnesses through their installed CLIs and reuses their logins; it keeps no API keys and owns no agent loop of its own.
Every agent task goes through one runner seam and every Thread through one agent host, the same on this device and in a Sandbox.
Adding a harness, such as Codex, is welcome through those seams; a feature that only one harness serves well, such as the Global chat on pi, runs on that one.
Sandbox platforms stay swappable: a provider is a plugin, Glass ships knowledge of none, not even the one Kevin uses, and real platforms live in `examples/` or outside the repo.

### Work outlives the window

A Thread keeps running when Glass quits, and Glass picks up its journal on the next launch.
A restart, a dropped connection, an upgrade, or a stalled host never loses a Turn, a Draft, or a Feedback note.
Finished work leaves on its own: a Thread is Settled when its PR merges, and its To-do is marked done.
Where the user was lives in the URL and the Saved place, so he returns to it.

### One word, one path

Every idea has one name, taken from GLOSSARY.md, and a rename replaces the old name everywhere, wire and database included, with no aliases.
There is one way to do each thing; a second path is merged into the first or deleted.
An experimental toggle, such as the Inset layout, may run beside the default while the design is unsettled; once Kevin picks one, the other is deleted.
Removed scope is deleted completely, code, docs, and schema alike.
Tests replay recordings of the real harnesses, wait on events rather than time, and are deleted when they protect nothing.

### Fast enough to stay in

Opening a PR, a Thread, or the next Queue item feels instant, because Glass loads it on hover or before it is needed.
A slow path is a bug: Glass measures its own memory and CPU and fixes regressions at the cause.

### Scope

Glass is not a GitHub client for teams, not a product for other users, and not something to install for anyone else.
It is not an Agent harness, a model gateway, a Sandbox platform, a code editor, or an issue tracker.
Glass is a desktop app today; reaching it from beyond the desktop may come later, for Kevin alone, and the backend stays a standalone program so that remains possible.
Personal material, logins, and company platforms stay out of the repository and live on the device or in user-installed plugins.

A change aligns when it shortens the path from something waiting on Kevin to his decision on it, reuses an existing seam, word, or harness, and survives a restart.
A change should be resisted when it adds a lasting second way to do something, publishes words under Kevin's name without his read, makes Glass the source of truth for something another tool owns, stores credentials Glass could borrow, bakes in one Sandbox platform, syncs state off the machine, or serves a user other than Kevin.
