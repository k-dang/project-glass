# Agent reviews read a checkout of the PR through Glass's own cached clones

Unlike Tours (ADR 0004), an Agent review gets a checkout of the Revision's head and read-only
file tools (read, search, list) with no shell or network, because a review that can only see the
diff misses callers, surrounding code, and untouched tests. Glass keeps one blobless partial clone
per repository under `~/.project-glass/repos/<owner>/<repo>`, fetches `pull/<n>/head` for each run,
and checks the head out into a temporary directory removed when the job ends. Git authenticates
with the Connection's token for that command only, so checkouts work exactly when the rest of Glass
does. The clones have no size limit yet.

Claude Code's restricted mode confines its read tools to the checkout. The pi CLI's read tools
aren't confined: a hostile PR could steer the agent to read a file
like `~/.ssh/config`, which would then reach the model provider and the user's screen. With no
shell or network the agent has no other way out, so Glass accepts this and its instructions keep
the agent inside the checkout rather than sandboxing the runner.

## Considered options

- **The user's own clones**: fastest, but Glass would add refs and worktrees to repositories the
  user works in, and every repository would need a configured path.
- **A commit tarball per run**: no git needed, but it downloads the whole repository each time,
  hundreds of megabytes for the largest repositories reviewed.
- **Running tests or linters**: needs a shell, so the agent could change things, and every
  repository needs its own setup.
