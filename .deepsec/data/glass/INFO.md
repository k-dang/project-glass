# glass

## What this codebase does

Glass is a single-user Electron desktop app for reviewing GitHub pull requests and running coding
agents (Claude Code via the Claude Agent SDK, and pi). `apps/desktop` is Electron main, preload and
a React renderer; `apps/server` is an Effect 4 backend in a `utilityProcess` serving Effect RPC over
WebSocket on `127.0.0.1`, with SQLite at `~/.project-glass/glass.db`. Agents run in an agent host
(a small Node server) either as a local child process or inside a remote Sandbox from a provider
plugin. There is no multi-tenant server and no other users; the user's own GitHub token and
agent logins are the crown jewels.

## Auth shape

- `RendererAccess` (`access.ts`): every renderer HTTP/WS request must carry the per-launch secret in
  the `token` query param (`TOKEN_PARAM`) and an allowed `Origin`. Compared with `timingSafeSameSecret`.
- `McpCredentials` / `McpCaller`: the backend's MCP endpoint takes per-caller bearers from `mintBearer`.
  Callers are `GlobalChatCaller`, `ThreadCaller` or `OutsideAgentCaller`; tools read identity from
  `McpCaller.current`, never from arguments.
- Agent host (`agentHost/server.ts`): `RequireToken` guards its RPC; `HostGlassTools` relays MCP calls
  from its Threads, and the backend decides the calling Thread per connection, not from the host's word.
- `OutsideAgents`: agents Glass didn't launch get a user-approved bearer with a 30-day TTL, stored digested.
- Electron windows use `contextIsolation`, `sandbox`, no `nodeIntegration`, plus `setWindowOpenHandler`
  and `will-navigate` guards (`main/index.ts`, `main/browserPanes.ts`).

## Threat model

The highest-impact attacker is content Glass renders or hands to an agent: a hostile PR, web page,
or agent-written HTML trying to reach the backend secret, the user's GitHub token, or run commands
on this device. Next is a compromised or hostile Sandbox host trying to act as another Thread or
reach this device. Last is another local process trying to use the loopback ports without the secret.
Agent reviews intentionally get an unconfined shell (accepted risk), so don't report that by itself.

## Project-specific patterns to flag

- A loopback HTTP/WS route, MCP route, or CDP relay path that skips `RendererAccess`, `RequireToken`
  or bearer authentication, or that trusts a thread/session id from the request body.
- A Glass tool letting a Sandbox Thread act on a local Thread or the Global chat, or a
  device-only tool missing its `forThreadsOnThisDevice` gate (`mcp/toolAudience.ts`).
- Anything that could leak the per-launch token: logging URLs, unredacted spans, putting it in a
  Visualization or Browser pane page, or a webview reaching Glass's own window.
- Visualization pages (`glass-visualization://`) or Browser panes that can make requests to this
  device, escape the opaque-origin sandbox, or loosen their CSP.
- Building a shell command line from PR, branch, path or agent input (`processes.ts` runs `.cmd`
  files through `shell: true` on Windows with its own escaping); path traversal out of a Thread's
  folder in `threadFilesHttp`.

## Known false-positives

- `sql\`...${x}\`` from `effect/sql` is parameterised, including `sql.update`/`sql.in`; only
  `sql.unsafe` (migrations only) interpolates raw text.
- `insecure-crypto` "weak cipher" hits on `DESC` in SQL `ORDER BY` clauses.
- `missing-await` inside `Effect.gen`: effects are sequenced with `yield*`, not `await`.
- `examples/` (a fake Sandbox provider), `apps/server/test`, `*.test.ts`, recordings, and the
  `dev:fake` fake GitHub are fixtures, not shipped attack surface.
- The standalone backend's `GLASS_TOKEN=secret` in the README is a local dev example.
- Sandbox Threads may read local Threads' transcripts, To-dos, the Inbox and Activity through Glass
  tools. Only acting on local Threads (creating, messaging, starting work) is refused.
