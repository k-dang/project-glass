# Agent reviews explore the checkout with an unconfined shell

Agent reviews and their Follow-ups get a shell beside their file tools and no diff in their prompt,
only the base and head commits of their checkout (ADR 0005): the agent finds the change with git
however it sees fit. Inlining the diff overflowed the model's context on large PRs, hundreds of
files and tens of thousands of lines, so the model stopped part-way and retrying never helped; it
also decided for the agent what to read.

The shell gives up confinement. A hostile PR can steer a review's agent to run any command as the
user, with the user's credentials and network, including on PRs the Queue reviews before the user
opens them. Glass accepts this to let a review read a change of any size the way a reviewer would.
Its instructions ask the agent to stay inside the checkout and leave it unchanged, but nothing
enforces either. Claude Code can't be restricted with a shell, so a review skips the user's settings
files by name instead.

## Considered options

- **A diff budget**: keep the inlined diff and drop the largest files' hunks past a limit. Keeps
  reviews read-only, but Glass still decides what the agent reads, and the dropped files are the
  ones a large PR's review most needs.
- **A read-only git tool**: only `diff`, `log`, `show`, and `blame`, run by Glass with no shell.
  Keeps reviews confined, but every Agent harness needs a custom tool, and the agent can't reach for
  anything else.
- **A sandboxed shell**: no network and no writes outside the checkout, through macOS
  `sandbox-exec`. Glass would own a sandbox profile per platform, and pi has no sandbox of its own.

## Revisit when

- A PR in the Queue steers a review into running something harmful.
- pi or Claude Code can confine a shell to a directory.
- Tours fail on large PRs often enough to need a shell too.
