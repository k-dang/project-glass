# 02: Backend MCP endpoint with dedicated credential

**What to build:** An app-owned HTTP MCP endpoint alongside the renderer's Effect RPC transport, authenticated independently with a conversation-runtime bearer credential issued on runtime start, revoked on end, and refreshed on restart, resolving caller identity distinct from model-supplied operation targets without logging or persisting bearer values.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Backend exposes the MCP endpoint on the existing listener using Effect 4 MCP support with typed tool schemas, with routing that does not require the renderer's per-launch query token
- [ ] Missing, incorrect, and revoked credentials are rejected on every request; a fresh credential is issued after runtime restart
- [ ] Bearer values never appear in request logs, transcripts, database records, generated extensions, command arguments, or error messages
- [ ] Focused backend tests exercise real HTTP discovery and invocation against an isolated backend, covering credential rejection, caller identity distinct from operation targets, invalid inputs, and cancellation of an in-flight call using explicit event coordination
