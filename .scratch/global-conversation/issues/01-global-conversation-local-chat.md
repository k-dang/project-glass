# 01: Global conversation — local chat with no tools

**What to build:** One persistent Glass-scoped conversation, startable on demand with no Local checkout or worktree, that the user can open and dismiss from every area without changing the current route or Saved place; it streams Claude Code or pi answers, supports stop, Queued messages, Steer, Questions, and Permission requests, and persists its transcript, Unsent message, and selected Agent program/model/Effort across a restart with an interrupted Turn represented accurately.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] User can open the Global conversation from every area and dismiss/reopen it without losing messages or moving from the current PR workspace or Agent
- [ ] The same conversation remains available across area changes; running with no Local checkout or worktree works with no git branch or worktree created
- [ ] Answers stream into the transcript with visible tool activity and failures; stop, Queued messages, Steer, Questions, and Permission requests behave as for existing Agent conversations
- [ ] Transcript, Unsent message, and selected Agent program/model/Effort survive restarting Glass; an interrupted Turn is represented accurately rather than finished
- [ ] Electron acceptance covers the distinct behaviors above using the real pinned Agent programs; reuse existing transcript and composer coverage
