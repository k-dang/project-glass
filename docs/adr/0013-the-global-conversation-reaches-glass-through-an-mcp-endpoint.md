# The Global conversation reaches Glass through the backend's own MCP endpoint

The Global conversation's tools read and act on state owned by backend services (ADR 0001), while
its Agent program runs in the agent host (ADR 0007). So the backend serves the tools itself, over an
MCP endpoint that Claude Code and pi both reach, with a credential of its own rather than the
renderer's.

## Considered options

- **Tools defined in the agent host**, as the Suggested draft tool is (ADR 0009): no new endpoint,
  but the host would need its own path to every backend service, and Claude Code's SDK tools and a
  pi extension would each need their own copy of the tools.
- **Exposing the tools over the renderer's Effect RPC**: one transport, but the Agent program would
  hold the renderer's secret and with it access to everything the renderer can do.
