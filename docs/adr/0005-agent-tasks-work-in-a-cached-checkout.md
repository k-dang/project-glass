# Agent tasks work in a checkout of the PR from Glass's own cached clones

Every agent task (Tours, Agent reviews, Ask) gets a checkout of the Revision's head. A task that
sees only the diff misses callers, surrounding code, and untouched tests: a review can't check what
a change breaks, and a Tour can't show a Before / after, because what the system did before a change
usually sits outside its hunks. Tours and reviews take longer and each needs a fetch, which is worth
it for a reader who wants to know what changed in the system and not only in the files.

Glass keeps one blobless partial clone per repository of its own and checks each run's head out of
it. Git authenticates with the Connection's token, so checkouts work exactly when the rest of Glass
does, without the user's git config or credentials. Each checkout is a git repository of its own:
HEAD is the Revision's head, its objects come from the clone, and Glass fetches the base commit and
every blob the PR's diff reads beforehand, so `git diff <base>...HEAD` in it needs no token or
network. Older history is commits and trees only.

Agent reviews and their Follow-ups get a shell beside their file tools and no diff in their prompt,
only the base and head commits: the agent finds the change with git however it sees fit. Inlining
the diff overflowed the model's context on large PRs, hundreds of files and tens of thousands of
lines, so the model stopped part-way and retrying never helped; it also decided for the agent what
to read. Tours and Ask get read-only file tools (read, search, list) and the diff in their prompt.
A Tour needs every hunk to place its links, since every line a reader can jump to must be in one,
and Ask sends a single file.

The shell gives up confinement. A hostile PR can steer a review's agent to run any command as the
user, with the user's credentials and network, including on PRs the Queue reviews before the user
opens them. Glass accepts this to let a review read a change of any size the way a reviewer would.
Its instructions ask the agent to stay inside the checkout and leave it unchanged, but nothing
enforces either. Claude Code can't be restricted with a shell, so a review skips the user's settings
files by name instead.

Read-only tasks stay confined where the runner allows. Claude Code's restricted mode confines its
read tools to the checkout, so tasks can't run on a Claude Code without that mode. The pi CLI's read
tools aren't confined: a hostile PR could steer a Tour to read a file like `~/.ssh/config`, which
would then reach the model provider and the user's screen. With no shell or network the agent has no
other way out, so Glass accepts this.

## Considered options

- **Diff-only Tours**: how Tours first ran. Faster and with no fetch, but unchanged context in a
  Before / after was guesswork or missing.
- **Sending the changed files' full contents in the prompt**: needs no tools, but it can't reach
  callers in other files, and that's most of the missing context.
- **The user's own clones**: fastest, but Glass would add refs and worktrees to repositories the
  user works in, and every repository would need a configured path.
- **A commit tarball per run**: no git needed, but it downloads the whole repository each time,
  hundreds of megabytes for the largest repositories reviewed.
- **A diff budget for reviews**: keep the inlined diff and drop the largest files' hunks past a
  limit. Keeps reviews read-only, but Glass still decides what the agent reads, and the dropped
  files are the ones a large PR's review most needs.
- **A read-only git tool for reviews**: only `diff`, `log`, `show`, and `blame`, run by Glass with
  no shell. Keeps reviews confined, but every engine needs a custom tool, and the agent can't reach
  for anything else.
- **A sandboxed shell**: no network and no writes outside the checkout, through macOS
  `sandbox-exec`. Glass would own a sandbox profile per platform, and pi has no sandbox of its own.

## Revisit when

- A PR in the Queue steers a review into running something harmful.
- pi or Claude Code can confine a shell, or pi its read tools, to a directory.
- Tours fail on large PRs often enough to need the same exploring checkout.
- Tours on the Queue become too slow or too costly to leave on.
- The clones grow large enough to need a limit, which they don't have.
