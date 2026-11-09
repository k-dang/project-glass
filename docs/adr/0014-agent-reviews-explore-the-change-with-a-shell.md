# Agent reviews explore the change with a shell

An Agent review used to get the whole diff in its prompt. A large PR (hundreds of files, tens of
thousands of lines) overflowed the model's context window, the model stopped with "length", and
retrying could never help. Pasting the diff also decided for the agent what to read. Agent reviews
and their Follow-ups now get no diff: their checkout is a git repository of the PR, and the agent
gets a shell next to its file tools, so it finds the change itself, with `git diff <base>...HEAD`
or however it sees fit. The prompt names the base and head commits beside the title, description,
and published Discussions.

The checkout is still filled from Glass's cached clone (ADR 0005). Its own `.git` borrows the
clone's objects as alternates, HEAD is the Revision's head, and Glass fetches the base commit and
every blob the PR's diff reads before the agent starts. The agent's git then needs no token or
network for the diff. Older history is commits and trees only, so `git show` on an unrelated
commit can fail for a missing blob.

This drops ADR 0005's safety for these two tasks. With a shell, a hostile PR can steer the agent
to run any command as the user, with the user's credentials and network, including on PRs the
Queue reviews before the user opens them. Glass accepts this to let a review read a change of any
size the way a reviewer would. The instructions still ask the agent to stay inside the checkout
and leave it unchanged, but nothing enforces either. Claude Code can't be restricted with a shell,
so it skips the user's settings files by name instead.

Tours and Ask keep ADR 0005's read-only tools and inlined diffs. Ask sends one file, but a Tour still
inlines every diff, so a PR too large for an Agent review's old prompt is too large for its Tour.

## Considered options

- **A diff budget**: keep the inlined diff and drop the largest files' hunks past a limit. Safe,
  but Glass still decides what the agent reads, and the dropped files are the ones a large PR's
  review most needs.
- **Diff files in the checkout**: Glass writes each file's patch beside the code for the read
  tools to open. No shell, but still a fixed view of the change, without log, blame, or history.
- **A read-only git tool**: only `diff`, `log`, `show`, and `blame`, run by Glass with no shell.
  Keeps ADR 0005's safety, but every engine needs a custom tool, and the agent can't reach for
  anything else.
- **A sandboxed shell**: no network and no writes outside the checkout, through macOS
  `sandbox-exec`. Glass would own a sandbox profile per platform, and pi has no sandbox of its own.

## Revisit when

- A PR in the Queue steers a review into running something harmful.
- Tours fail on large PRs often enough to need the same exploring checkout.
- pi or Claude Code can confine a shell to a directory with no network, which would restore
  ADR 0005's safety at little cost.
