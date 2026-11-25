# Agent review Follow-ups are Turns of one Thread that resumes the review's session

A first Agent review is rarely the last word: the user wants to question its points and turn the
ones that hold into comments for the PR's author. Following up is a back-and-forth, so each Agent
review gets one Thread (ADR 0007), started on the first Follow-up, and each Follow-up is a
Turn of it. The agent keeps what it read in earlier Turns instead of rereading the checkout from a
replayed transcript, and Follow-ups gain streamed answers, Steer, and Stop.

The Thread continues the agent that wrote the review rather than starting a new one. The review's
run saves its harness session under an id Glass picks, working in a checkout at a path named by that
id; the first Follow-up checks the Revision out at that path again and starts the Thread with that
id, so the harness resumes the session with the review's reading, reasoning, and answer, on the
harness and model that wrote it. Only a review someone follows up on gets a Thread. A review with
no saved session, such as one written before reviews saved theirs, takes no Follow-ups until it is
reviewed again, rather than a fresh agent that never saw it. Both harnesses keep a session by its
folder, which is why the path is fixed. The review and its Follow-ups share one system prompt,
which covers writing the review and answering about it, so following up reads as one conversation
rather than an agent handed a new role. Glass saves that prompt with the session: Claude Code keeps a
resumed session's first system prompt, and pi takes it again on resume. Every
review's run saves its session whether or not anyone follows up; the sessions are small, so Glass
leaves them to the harnesses, where Claude Code prunes old ones and pi keeps them.

The Thread's agent works in a checkout of the review's Revision from Glass's cached clone,
with a shell like the review's own (ADR 0006), not a Local checkout worktree (ADR 0008), since it
never commits. The PR material it read stays data, never instructions, because it comes from the
PR's author.

The agent proposes a Suggested draft by calling a Glass tool with a path, side, line, and body.
Glass checks the line against the diff and rejects a call that misses it, so the agent can place it
again or put the text in its answer: a stray placement costs one call rather than the whole answer,
which is the failure ADR 0009 guards against by making each Hotspot's place optional. For the
line to be one the user is reading, Follow-ups run only while the review is current; an outdated
review keeps its transcript to read and takes no new Turns. Nothing reaches GitHub until the user
adds a Suggested draft as a Draft.

## Considered options

- **One read-only run per Follow-up, as Agent reviews run (ADR 0004)**: no new Thread kinds, but
  each run replays the review and every earlier Follow-up as text, forgets what it read, and returns
  one JSON answer at the end with no streaming, Steer, or Stop. Glass built this first.
- **Seeding a new Thread with the PR material and the review as data**: Glass built this first.
  The agent answered about a review it never wrote, without what the review's run had read, and
  Glass kept a second prompt carrying both.
- **Running every Agent review as the first Turn of its Thread**: one session from the start, but
  every review, Queue reviews among them, would become a Thread and keep its checkout.
- **A separate Follow-up system prompt swapped in on resume**: Claude Code has to be told to drop
  the review's prompt, and the agent switches roles mid-conversation.
- **Resuming the runner's own session for each Follow-up**: keeps what the agent read, but puts
  session state into a seam Tours and Agent reviews don't need, duplicating the agent host
  without its streaming, Steer, or Stop. The runner only saves the session; the agent host resumes it.
- **One drafting pass with no back-and-forth**: smaller, but it can't question the review's points,
  which is half of following up.
- **A Draft button on each point of the review**: needs every point placed on a line, while ADR 0009
  places only the Hotspots, and those only when their lines are in the diff.
