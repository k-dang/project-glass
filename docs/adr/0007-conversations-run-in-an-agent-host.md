# Every Conversation runs in an agent host, on this device or in a Sandbox

Conversations run on this device and in Sandboxes, and Glass must render a structured transcript,
answer Permission requests, Steer, and survive dropped connections for both. So every Conversation
runs inside an agent host: a small Node server built from Glass's own code that drives Claude Code
through the Claude Agent SDK (pointed at the user's installed `claude`) and pi through `pi --mode
rpc`, keeps a journal of numbered events, and serves Effect RPC over WebSocket. The backend starts a
host as a child process for local Conversations; in a Sandbox, its provider starts the same host
(ADR 0010). The backend persists every event in SQLite as the transcript of record and, after a
dropped connection, asks the host for the events after the last one it saved. Local and remote
Conversations differ only in where the host runs.

This answers ADR 0001's "execution moves off-machine" trigger without promoting the backend: the
backend stays in its `utilityProcess`, and local Conversations outlive the app because the backend
leaves the local host running on quit (ADR 0014).

A local Conversation works in a worktree of a Local checkout, a clone the user links, on a new
branch from the base branch fetched through the user's own git config and credentials. A
Conversation's commits belong in the user's repository, where they can push them and keep working.
Conversations that only read a Revision, such as an Agent review's Follow-ups (ADR 0009), use
Glass's cached clones instead (ADR 0005).

Building Claude Code Conversations confirmed the SDK over driving `claude` stream-json directly: the
SDK is the stream-json control protocol, already written and kept in step with the CLI. Glass pins
its version, points it at the user's `claude`, and asks for Claude Code's own system prompt and the
user, project, and local settings sources, since the SDK otherwise starts `claude` without them.

## Considered options

- **Worktrees of Glass's cached clones (ADR 0005)**: nothing to link, but the Conversation's branch
  would live where the user doesn't work, and fetching would need Glass's token instead of the
  user's remotes.
- **Conversations inside the backend, with a separate remote path**: no second process locally, but
  two ways of driving a Conversation, two sets of reconnect behaviour, and two fakes.
- **A hosted agents service's threads for Sandboxes**: no provisioning in Glass, but no Permission
  requests, images, or model changes, and its contract is private and changes often.
- **Streaming over a sandbox SDK's command runner with a FIFO**: no server to ship, but output
  produced while disconnected is lost and the shell plumbing is fragile.
- **Raw `claude -p` stream-json**: agent tasks use the CLI because they need one completion (ADR
  0004); Conversations need permission callbacks, questions, interrupts, and model and Permission
  mode changes, which the SDK already wraps.

## Revisit when

- An Agent harness offers its own remote protocol that covers Permission requests, Steer, and
  reconnecting, which could replace the host for that harness.
- The SDK falls behind the CLI, or hides something Glass needs from the control protocol.
- Conversations need to run without the user linking a clone.
