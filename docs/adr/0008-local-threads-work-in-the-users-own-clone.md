# A local Thread works in a worktree of the user's own clone

A local Thread works in a worktree of a Local checkout, a clone the user links, on a new branch
from the base branch fetched through the user's own git config and credentials. A Thread's commits
belong in the user's repository, where they can push them and keep working. Agent tasks do the
opposite and use Glass's cached clones and its token (ADR 0005), as do Threads that only read a
Revision, such as an Agent review's Follow-ups (ADR 0010).

## Considered options

- **Worktrees of Glass's cached clones (ADR 0005)**: nothing to link, but the Thread's branch
  would live where the user doesn't work, and fetching would need Glass's token instead of the
  user's remotes.

## Revisit when

- Threads need to run without the user linking a clone.
