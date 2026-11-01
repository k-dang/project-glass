# Every Agent runs in an agent host, on this device or in a Sandbox

> Sandbox providers now create Sandboxes and start the host in them (ADR 0008); Glass no longer
> provisions them itself.

Agents run on this device and in Sandboxes, and Glass must render a
structured transcript, answer Permission requests, Steer, and survive dropped connections for both. So
every Agent runs inside an agent host: a small Node server built from Glass's own code that drives
Claude Code through the Claude Agent SDK (pointed at the user's installed `claude`) and pi through
`pi --mode rpc`, keeps a journal of numbered events, and serves Effect RPC over WebSocket. The backend
starts a host as a child process for local Agents, and uploads and starts the same host in each
Sandbox, reaching it through the Sandbox's ingress with the user's credentials. The backend persists
every event in SQLite as the transcript of record and, after a dropped connection, asks the host for
the events after the last one it saved. Local and remote Agents differ only in where the host runs.

This answers ADR 0001's "execution moves off-machine" trigger without promoting the backend: the
backend stays in its `utilityProcess`, and letting local Agents outlive the app becomes not stopping
the local host on quit.

A local Agent works in a worktree of a Local checkout, a clone the user links, on a new branch from
the base branch fetched through the user's own git config and credentials. Agent reviews read
Glass's own cached clones instead (ADR 0005), because they only read a Revision; an Agent's commits
belong in the user's repository, where they can push them and keep working.

Building Claude Code Agents confirmed the SDK over driving `claude` stream-json directly: the SDK is
the stream-json control protocol, already written and kept in step with the CLI. Glass pins its
version, points it at the user's `claude`, and asks for Claude Code's own system prompt and the
user, project, and local settings sources, since the SDK otherwise starts `claude` without them.
Tests fake only interfaces Glass owns, because a fake of someone else's interface encodes Glass's
beliefs about it and passes when they are wrong. Business-service tests supply an `AgentAdapter`
and explicit domain events through the real host handlers and journal; a program that exits is a
session that closes. Each program's translation into Glass's events is a pure `step`, tested by
feeding it the program's messages. Wiring to a program (continuing a conversation, images, model
and effort changes, Permission requests and Questions) runs the real program, the pinned Claude
Code CLI or the bundled pi, against a fake model API, and desktop verification does the same. Real
processes stay only where the process is the subject: a host that dies or a dropped connection. A
fake SDK query stays only for failures the real CLI won't produce on demand, such as a handshake
that never answers or a refused model change. Agent tests use no scripted fake `claude`
executable.

## Considered Options

- **Worktrees of Glass's cached clones (ADR 0005)**: nothing to link, but the Agent's branch would
  live where the user doesn't work, and fetching would need Glass's token instead of the user's
  remotes.

- **Agents inside the backend, with a separate remote path**: no second process locally, but two ways
  of driving an Agent, two sets of reconnect behaviour, and two fakes.
- **A hosted agents service's threads for Sandboxes**: no provisioning in Glass, but no Permission
  requests, images, or model changes, and its contract is private and changes often.
- **Streaming over a sandbox SDK's command runner with a FIFO**: no server to ship, but output
  produced while disconnected is lost and the shell plumbing is fragile.
- **A provisioning CLI**: free credential setup, but it opens a browser, can exit 0 on failure, and
  gives no machine-readable result. Glass provisions Sandboxes itself instead, reading credentials
  from the user's existing logins as ADR 0004 does.
- **Raw `claude -p` stream-json**: Tours use the CLI because they need one completion; Agents need
  permission callbacks, questions, interrupts, and model and Permission mode changes, which the SDK
  already wraps.
