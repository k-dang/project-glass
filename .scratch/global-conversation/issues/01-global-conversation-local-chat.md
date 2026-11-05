# 01: Global conversation — local chat with no tools

**What to build:** One persistent Glass-scoped conversation, startable on demand with no Local checkout or worktree, that the user can open and dismiss from every area without changing the current route or Saved place; it streams Claude Code or pi answers, supports stop, Queued messages, Steer, and Questions, and persists its transcript, Unsent message, and selected Agent program/model/Effort across a restart with an interrupted Turn represented accurately. The Agent program runs with no file, shell, or user-configured tools: only the Question tool.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] User can open the Global conversation from every area and dismiss/reopen it without losing messages or moving from the current PR workspace or Agent
- [ ] The same conversation remains available across area changes; running with no Local checkout or worktree works with no git branch or worktree created
- [ ] Answers stream into the transcript; stop, Queued messages, Steer, and Questions behave as for existing Agent conversations
- [ ] Both programs reuse the Agent review lockdown (`settingSources: []` and `strictMcpConfig` for Claude Code; `--tools` with `piLoadsNothing` for pi), narrowed to the Question tool only; the user's own settings, plugins, and MCP servers are not loaded, and existing logins still work
- [ ] The runtime starts with the first message and lives until Glass quits or its process dies; stopping a Turn leaves it running
- [ ] A message can carry optional captured context (a PR and Revision, or an Agent) shown as a readable label; this slice stores and shows it, later slices fill it in
- [ ] Transcript, Unsent message, and selected Agent program/model/Effort survive restarting Glass; an interrupted Turn is represented accurately rather than finished
- [ ] Electron acceptance covers the distinct behaviors above using the real pinned Agent programs; reuse existing transcript and composer coverage
