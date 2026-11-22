# Agent tasks work in a checkout of the PR from Glass's own cached clones

Every agent task (Tours, Agent reviews, Ask) gets a checkout of the Revision's head. A task that
sees only the diff misses callers, surrounding code, and untouched tests: a review can't check what
a change breaks, and a Tour can't show a Before / after, because what the system did before a change
usually sits outside its hunks. Each task takes longer and needs a fetch, which is worth it for a
reader who wants to know what changed in the system and not only in the files.

Glass keeps one blobless partial clone per repository of its own and checks each run's head out of
it. Git authenticates with the Connection's token, so checkouts work exactly when the rest of Glass
does, without the user's git config or credentials. Glass fetches the base commit and every blob
the PR's diff reads beforehand, so git in the checkout needs no token or network.

Tours and Ask get read-only file tools (read, search, list) and the diff in their prompt, since a
Tour places its links on hunks and Ask is about a single file. Agent reviews get a shell instead
(ADR 0006). Read-only tasks stay confined where the runner allows: Claude Code's restricted mode
confines its read tools to the checkout, and a Claude Code without that mode runs no task rather
than one with weaker limits. The pi CLI's read tools aren't confined: a hostile PR could steer a
Tour to read a file like `~/.ssh/config`, which would then reach the model provider and the user's
screen. With no shell or network the agent has no other way out, so Glass accepts this.

## Considered options

- **Diff-only Tours**: how Tours first ran. Faster and with no fetch, but unchanged context in a
  Before / after was guesswork or missing.
- **Sending the changed files' full contents in the prompt**: needs no tools, but it can't reach
  callers in other files, and that's most of the missing context.
- **The user's own clones**: fastest, but Glass would add refs and worktrees to repositories the
  user works in, and every repository would need a configured path.
- **A commit tarball per run**: no git needed, but it downloads the whole repository each time,
  hundreds of megabytes for the largest repositories reviewed.
- **Running diff-only when a runner can't confine its read tools**: works, but quietly gives a
  weaker answer depending on the user's install.

## Revisit when

- pi can confine its read tools to a directory.
- Tours on the Queue become too slow or too costly to leave on.
- The clones grow large enough to need a limit, which they don't have.
