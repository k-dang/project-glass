# Conversations reach Glass through an MCP endpoint on the backend

The Global conversation needs Glass tools, such as reading PR lists or starting an Agent review,
in both Claude Code and pi. Both programs speak MCP, so the backend serves one Streamable HTTP MCP
endpoint at `/mcp` on the listener the renderer's RPC already uses. It is built with Effect 4's
`McpServer.layerHttp`, which mounts on the backend's `HttpRouter`. Tools are typed `Toolkit`
handlers that stay thin over the same services as the RPC handlers. Programs reach the endpoint
from the agent host, which runs on this device.

The endpoint does not accept the renderer's per-launch secret. Each transport authenticates its own
routes: the renderer's routes check the launch secret and origin, and `/mcp` checks a bearer
credential. The backend issues a credential when a conversation runtime starts and binds it to that
conversation. It revokes the credential when the runtime ends and issues a fresh one on restart.
Every request resolves its caller from its credential, not from its MCP session id or tool
arguments, so a model cannot pick who it acts as. A session belongs to the credential that opened
it, and revoking a credential ends that credential's requests that are still in flight. Any request
with an `Origin` header is refused, which keeps browser pages off the endpoint. Credentials are held in memory, keyed by digest, and
never logged or persisted.

## Considered Options

- **The renderer's launch secret**: one credential to pass around, but a model holding it could
  call every renderer RPC, and revoking it would disconnect the windows.
- **A stdio MCP server per program**: no HTTP surface, but it would be a second process that still
  has to reach the backend, and a second transport to authenticate.
- **A hand-written JSON-RPC handler**: Effect 4.0.5's server mounts on the existing router with
  per-route middleware, so writing one was unnecessary.

## Consequences

A backend restart drops every credential, so a running conversation runtime must get a fresh one
before its next call. Effect's MCP server never expires sessions. A runtime that ends cleanly
deletes its own session, but a revoked credential's sessions stay in memory until the backend
restarts. The endpoint speaks MCP `2025-11-25`. In that version, invalid tool input comes back as
a tool error that the model can correct, not as a protocol error. Repository and
Sandbox Agents are not given credentials, and the endpoint has no remote ingress.
