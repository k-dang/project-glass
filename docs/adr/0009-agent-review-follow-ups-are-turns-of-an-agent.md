# Agent review Follow-ups are Turns of one Agent seeded with the review

A first Agent review is rarely the last word: the user wants to question its points and turn the
ones that hold into comments for the PR's author. Following up is a conversation, so each Agent
review gets one Agent (ADR 0007), started on the first Follow-up, and each Follow-up is a Turn of
it. The agent keeps what it read in earlier Turns instead of rereading the checkout from a replayed
transcript, and Follow-ups gain streamed answers, Steer, and Stop.

The Agent works in a checkout of the review's Revision from Glass's cached clone, with a shell like
the review's own (ADR 0005), not a Local checkout worktree, since it never commits. It is seeded with
the PR material and the review as data, never as instructions, because both come from the PR's
author or an earlier agent.

The agent proposes a Suggested draft by calling a Glass tool with a path, side, line, and body.
Glass checks the line against the diff and rejects a call that misses it, so the agent can place it
again or put the text in its answer: a stray placement costs one call rather than the whole answer,
which is the failure ADR 0008 removed placement to avoid. For the line to be one the user is
reading, Follow-ups run only while the review is current; an outdated review keeps its transcript
to read and takes no new Turns. Nothing reaches GitHub until the user adds a Suggested draft as a
Draft.

## Considered options

- **One read-only run per Follow-up on the shared seam (ADR 0006)**: no new Agent kinds, but each
  run replays the review and every earlier Follow-up as text, forgets what it read, and returns one
  JSON answer at the end with no streaming, Steer, or Stop. Glass built this first.
- **Resuming the runner's own session for each Follow-up**: keeps what the agent read, but puts
  conversation state into a seam Tours and Agent reviews don't need, duplicating the agent host
  without its streaming, Steer, or Stop.
- **One drafting pass with no conversation**: smaller, but it can't question the review's points,
  which is half of following up.
- **A Draft button on each point of the review**: needs the review's points, their severities, and
  their places back as structure, which ADR 0008 removed.
