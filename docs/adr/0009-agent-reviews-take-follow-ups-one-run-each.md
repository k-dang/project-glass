# Agent reviews take Follow-ups, each one run on the shared seam

A first Agent review is rarely the last word: the user wants to question its points and turn the
ones that hold into comments for the PR's author. So the user can send Follow-ups about an Agent
review, beside it, and the agent can answer with Suggested drafts the user edits and adds as Drafts.

Each Follow-up is one read-only run on the Agent review engine over the cached checkout (ADRs 0005
and 0006), as Ask is. The run is given the PR material, the review, the earlier Follow-ups, and the
new message, and answers with Markdown and a list of Suggested drafts, each a path, side, line, and
body. Glass keeps the Suggested drafts that land on a line of the diff and adds the text of the rest
to the answer, so a stray placement costs one comment rather than the answer, which is the failure
ADR 0008 removed placement to avoid. Follow-ups share the Agent review's job for the PR: one runs at
a time, cancelling the review cancels it, and writing the review again starts without them. A
Follow-up runs only on the review's own Revision, so a Suggested draft's line is a line of the diff
the user is reading; an outdated review keeps its Follow-ups to read.

Nothing reaches GitHub until the user adds a Suggested draft, which goes through the same path as a
Draft they wrote.

## Considered options

- **A real Agent seeded with the review (ADR 0007)**: streamed answers, Steer, and Stop for free,
  but it needs Glass's first tool for agents to propose Drafts, a read-only Agent in the cached clone
  instead of a Local checkout worktree, and a link from an Agent to a PR. Worth it once agents act on
  Glass more widely, not for this alone.
- **One drafting pass with no conversation**: smaller, but it can't question the review's points,
  which is half of following up.
- **A Draft button on each point of the review**: needs the review's points, their severities, and
  their places back as structure, which ADR 0008 removed.
