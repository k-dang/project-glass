# 03: Bridge the conversation to Glass reads via MCP

**What to build:** The Global conversation calls read-only Glass tools over the real host-to-backend MCP connection for both Claude Code and pi, so the user can ask “What am I working on?” and get answers from their real PR lists, Queue, To-dos, recent Activity, Agents, and a specified PR's material at its exact Revision, with tool activity and failures explained in the transcript.

**Blocked by:** 01: Global conversation — local chat with no tools; 02: Backend MCP endpoint with dedicated credential

**Status:** ready-for-agent

- [ ] Both Agent programs discover and execute the same read-only Glass tool contract, which preserves tool failures and forwards cancellation through the bridge
- [ ] “This PR” fills in the captured context built in 01: it is resolved from the PR workspace and Revision captured when the message was sent, stays fixed if the user navigates elsewhere during the Turn, shows a readable label, and states clearly when context is missing rather than guessing from a Saved place
- [ ] Reads use the same domain services and tagged failures as the UI actions, never synthesize Activity, and never trigger a UI-opening side effect that records an opening or changes Queue state
- [ ] Electron acceptance sends a real Global conversation message through the real MCP bridge and asserts the visible result and resulting Glass state; recording tests for Claude Code and pi are refreshed and pass
- [ ] Recordings never contain the bearer, port, or host-specific URL; replay connects to whatever endpoint the test's backend provides
- [ ] The runtime gets a fresh credential from 02's seam each time it starts, and the credential is revoked when it ends
- [ ] Glass tools run without Permission requests; the conversation decides when to confirm with the user
