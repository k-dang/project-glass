# The Global chat reaches Glass through the backend's own MCP endpoint

The Global chat's tools read and act on state owned by backend services (ADR 0001), while
its Agent harness runs in the agent host (ADR 0007). So the backend serves the tools itself, over an
MCP endpoint that Claude Code and pi both reach, with a credential of its own rather than the
renderer's.

Every other Conversation working on a branch reaches the same tools through its agent host, on this
device or in a Sandbox (ADR 0007); an Agent review's Conversation gets none. The host serves an MCP endpoint of its own on loopback, with a credential it
issues each Conversation when its agent starts and drops when the agent stops. It handles no tool
itself: it relays each call over the connection Glass already holds to it, and the backend answers
it with the same handlers, as that Conversation. Glass decides which Conversation a call comes from
per connection, never from the host's word alone: a Sandbox's host can call only as its own
Conversation, and a Conversation in a Sandbox can create and message only Conversations in a
Sandbox. A call is delivered at most once, so one that loses its connection midway says it may or
may not have happened rather than running twice.

## Considered options

- **Tools defined in the agent host**, as the Suggested draft tool is (ADR 0009): the host serves
  the endpoint for its Conversations, but defining the tools and their handlers there would need
  its own path to every backend service, and Claude Code's SDK tools and a pi extension would each
  need their own copy of the tools. So the backend offers its tools to each host it connects to,
  and answers the calls.
- **Exposing the tools over the renderer's Effect RPC**: one transport, but the Agent harness would
  hold the renderer's secret and with it access to everything the renderer can do.
