# Every Thread runs in an agent host, on this device or in a Sandbox

Threads run on this device and in Sandboxes, and Glass must render a structured transcript,
answer Permission requests, Steer, and survive dropped connections for both. So every Thread
runs inside an agent host: a small Node server built from Glass's own code that drives Claude Code
through the Claude Agent SDK (pointed at the user's installed `claude`) and pi through `pi --mode
rpc`, keeps a journal of numbered events, and serves Effect RPC over WebSocket. The backend starts a
host as a child process for local Threads; in a Sandbox, its provider starts the same host (ADR
0011). The backend persists every event in SQLite as the transcript of record and, after a dropped
connection, asks the host for the events after the last one it saved. Local and Sandbox Threads
differ only in where the host runs.

The backend stays in its `utilityProcess` (ADR 0001): Threads run off-machine, and outlive the app
(ADR 0016), through the host rather than by promoting the backend to a daemon.

Building Claude Code Threads confirmed the SDK over driving `claude` stream-json directly: the
SDK is the stream-json control protocol, already written and kept in step with the CLI. Glass pins
its version and asks for Claude Code's own system prompt and the user, project, and local settings
sources, since the SDK otherwise starts `claude` without them.

## Considered options

- **Threads inside the backend, with a separate remote path**: no second process locally, but
  two ways of driving a Thread, two sets of reconnect behaviour, and two fakes.
- **A hosted agents service's threads for Sandboxes**: no provisioning in Glass, but no Permission
  requests, images, or model changes, and its contract is private and changes often.
- **Streaming over a sandbox SDK's command runner with a FIFO**: no server to ship, but output
  produced while disconnected is lost and the shell plumbing is fragile.
- **Raw `claude -p` stream-json**: agent tasks use the CLI because they need one completion (ADR
  0004); Threads need permission callbacks, questions, interrupts, and model and Permission
  mode changes, which the SDK already wraps.

## Revisit when

- An Agent harness offers its own remote protocol that covers Permission requests, Steer, and
  reconnecting, which could replace the host for that harness.
- The SDK falls behind the CLI, or hides something Glass needs from the control protocol.
