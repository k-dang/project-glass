# Agent tasks read a checkout of the PR through Glass's own cached clones

Agent reviews and their Follow-ups now run with a shell in a git repository of the PR (ADR 0014);
what follows holds for Tours and Ask.

Every agent task (Tours, Agent reviews, Ask) gets a checkout of the Revision's head and read-only
file tools (read, search, list) with no shell or network. A task that sees only the diff misses
callers, surrounding code, and untouched tests: a review can't check what a change breaks, and a
Tour can't show a Before / after, because what the system did before a change usually sits outside
its hunks. Tours and reviews take longer and each needs a fetch, which is worth it for a reader who
wants to know what changed in the system and not only in the files.

Glass keeps one blobless partial clone per repository of its own and checks each run's head out of
it. Git authenticates with the Connection's token, so checkouts work exactly when the rest of Glass
does, without the user's git config or credentials.

Claude Code's restricted mode confines its read tools to the checkout, so tasks can't run on a
Claude Code without that mode. The pi CLI's read tools aren't confined: a hostile PR could steer
the agent to read a file like `~/.ssh/config`, which would then reach the model provider and the
user's screen. With no shell or network the agent has no other way out, so Glass accepts this, and
its instructions keep the agent inside the checkout rather than sandboxing the runner. That holds
for Tours and Agent reviews the Queue runs on PRs the user hasn't opened.

A Tour's links stay tied to the diff. Its text may draw on the whole checkout, but every line a
reader can jump to must be in a hunk, because that's all the Tour view can show.

## Considered options

- **Diff-only Tours**: how Tours first ran. Faster and with no fetch, but unchanged context in a
  Before / after was guesswork or missing.
- **Sending the changed files' full contents in the prompt**: needs no tools, but it can't reach
  callers in other files, and that's most of the missing context.
- **The user's own clones**: fastest, but Glass would add refs and worktrees to repositories the
  user works in, and every repository would need a configured path.
- **A commit tarball per run**: no git needed, but it downloads the whole repository each time,
  hundreds of megabytes for the largest repositories reviewed.
- **Running tests or linters**: needs a shell, so the agent could change things, and every
  repository needs its own setup.

## Revisit when

- pi can confine its read tools to a directory, which removes the risk accepted here.
- Tours on the Queue become too slow or too costly to leave on.
- The clones grow large enough to need a limit, which they don't have.
