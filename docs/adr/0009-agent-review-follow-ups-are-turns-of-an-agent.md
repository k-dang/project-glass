# Agent review Follow-ups are Turns of one Agent seeded with the review

A first Agent review is rarely the last word: the user wants to question its points and turn the
ones that hold into comments for the PR's author. So the user can send Follow-ups about an Agent
review, beside it, and the agent can answer with Suggested drafts the user edits and adds as Drafts.

Following up is a conversation, so each Agent review gets one Agent (ADR 0007) and each Follow-up
is a Turn of it. The agent keeps what it read in earlier Turns instead of rereading the checkout
from a replayed transcript, and Follow-ups gain streamed answers, Steer, and Stop. Glass starts the
Agent on the first Follow-up, on the Agent review engine and its model, seeded with the PR material
and the review as data, never as instructions. The Agent works in a checkout of the review's
Revision written from Glass's cached clone (ADR 0005), kept as long as the Agent, rather than a
Local checkout worktree, with read, search, and list tools only, since it reads a Revision and
never commits. The Agent belongs to its Agent review: it is reached beside the review, not from the
Agents list, and its transcript is the record of the Follow-ups.

The agent proposes a Suggested draft by calling Glass's own tool with a path, side, line, and body.
Glass checks the line against the diff and rejects a call that misses it, so the agent can place it
again or put the text in its answer; a stray placement costs one call rather than the answer, which
is the failure ADR 0008 removed placement to avoid. This is the first tool Glass gives agents.

A Follow-up runs only while the review is current, so a Suggested draft's line is a line of the
diff the user is reading; an outdated review keeps its Agent's transcript to read and takes no new
Turns. Writing the review again removes its Agent, and the next Follow-up starts a new one. Nothing
reaches GitHub until the user adds a Suggested draft, which goes through the same path as a Draft
they wrote.

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
