# 02: Backend MCP endpoint with dedicated credential

**What to build:** An app-owned HTTP MCP endpoint alongside the renderer's Effect RPC transport, authenticated independently with a conversation-runtime bearer credential issued on runtime start, revoked on end, and refreshed on restart, resolving caller identity distinct from model-supplied operation targets without logging or persisting bearer values.

**Blocked by:** None (can start immediately). Credentials are issued and revoked through a small backend seam that this slice's tests drive directly; 03 calls it when the Global conversation's runtime starts and ends.

**Status:** ready-for-agent

- [ ] First, confirm Effect 4.0.5's MCP server can mount on the existing HTTP router with a per-request authentication check; if not, write a thin JSON-RPC MCP handler over the same typed schemas instead of adding a second server or dependency
- [ ] Backend exposes the MCP endpoint on the existing listener using Effect 4 MCP support with typed tool schemas, with routing that does not require the renderer's per-launch query token
- [ ] Missing, incorrect, and revoked credentials are rejected on every request; a fresh credential is issued after runtime restart
- [ ] Bearer values never appear in request logs, transcripts, database records, generated extensions, command arguments, or error messages
- [ ] Focused backend tests exercise real HTTP discovery and invocation against an isolated backend, covering credential rejection, caller identity distinct from operation targets, invalid inputs, and cancellation of an in-flight call using explicit event coordination
