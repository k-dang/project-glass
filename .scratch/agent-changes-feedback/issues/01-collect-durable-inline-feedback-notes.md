# 01: Collect durable inline Feedback notes

**What to build:** In Agent Changes, the user selects code or a gutter range, writes feedback at
that location, and keeps the resulting Feedback note beside the code. Notes can be edited or
removed, survive navigation and restart, and preserve exactly what the user read while the Agent
continues working. Follow the agreed Feedback on Agent Changes design and approved inline
annotation prototype.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] First separate the reusable diff rendering and selection behavior from GitHub-specific
  feedback stores. Existing PR workspace behavior remains unchanged; this feature belongs only
  to Agent Changes and never publishes feedback to GitHub.
- [ ] A user can annotate a single line or range on either side of displayed text changes using
  code selection, gutter actions, and keyboard ranges. The editor opens at the selected range;
  saved notes appear directly beneath their code, and editing happens in place.
- [ ] Saving a note keeps the Files sidebar in place. An optional Feedback overview can locate
  notes across files without becoming the primary writing surface.
- [ ] Each note preserves its original file location, diff side, range, selected code, and enough
  identity to distinguish the displayed code from later changes. Restoring a note does not
  require reading its current worktree or retaining access to a remote host.
- [ ] Agent work and external edits leave the displayed diff and saved note context stable until
  Show latest succeeds. Refresh failure keeps the previous view. After a successful refresh,
  older notes remain readable, editable, and removable with their original snippets and an
  older-version label; they are not attached to today's same line numbers by guesswork.
- [ ] Notes persist on this device across navigation and relaunch. Failed saves or edits retain
  the user's work and expose a retryable error. Binary or undisplayable patches keep their
  existing placeholders instead of offering invalid line targets.
- [ ] The same flow works for local and Sandbox Agents using either supported Agent program.
  Locally saved notes remain readable while their Agent is retained, including after Sandbox
  expiry. Normal Agent removal deletes its notes with its other records and keeps existing
  confirmation behavior.
- [ ] Focused persistence, selection, placement, and renderer tests prove original-code capture,
  both diff sides, refresh/restart retention, and ordinary cleanup. Run the affected repository
  checks and demonstrate creating, editing, and reopening notes in an isolated Glass instance.
