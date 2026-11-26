# An Agent review is the first Turn of a Thread, and its Follow-ups are the next ones

A first Agent review is rarely the last word: the user wants to question its points and turn the
ones that hold into comments for the PR's author. Following up is a back-and-forth, so each Agent
review gets one Thread (ADR 0007), and each Follow-up is a Turn of it. The agent keeps what it read
in earlier Turns instead of rereading the checkout from a replayed transcript, and Follow-ups gain
streamed answers, Steer, and Stop.

Every Agent review, Queue reviews among them, runs as the first Turn of its own Thread on the agent
host rather than through the one-shot runner Tours and Ask use (ADR 0004). Follow-ups continue that
session, with the review's reading, reasoning, and answer, on the harness and model that wrote it.
One system prompt covers writing the review and answering about it, so following up reads as one
conversation rather than an agent handed a new role. The agent hands in the review by calling a Glass
tool whose parameters are the review's answer; the host checks the call and tells the agent what
doesn't fit, so it fixes the answer within its Turn rather than failing the review. Glass saves the
answer it accepted once the Turn ends, and a Turn that ends without one fails the review. Until
then the Thread belongs to the review in progress: stopping the review, its deadline passing, or
Glass quitting stops the Turn and removes the Thread, and at launch Glass removes every Review
Thread and checkout that no saved review keeps. Reviewing again replaces the review and removes its
Thread. The Follow-ups show without the review's own Turn, whose prompt carries the PR material
rather than the user's words.

The Thread's agent works in a checkout of the review's Revision from Glass's cached clone,
with a shell like the review's own (ADR 0006), not a Local checkout worktree (ADR 0008), since it
never commits. Most reviews get no Follow-up, so the checkout is dropped when the review's Turn
ends, and the Revision is checked out again at the same path before the Thread's next Turn: both
harnesses find a session by its folder. Each review then keeps only a hidden Thread and its
transcript. The PR material it read stays data, never instructions, because it comes from the PR's
author.

The agent proposes a Suggested draft by calling a Glass tool with a path, side, line, and body.
Glass checks the line against the diff and rejects a call that misses it, so the agent can place it
again or put the text in its answer: a stray placement costs one call rather than the whole answer,
which is the failure ADR 0009 guards against by making each Hotspot's place optional. For the
line to be one the user is reading, Follow-ups run only while the review is current; an outdated
review keeps its transcript to read and takes no new Turns. Nothing reaches GitHub until the user
adds a Suggested draft as a Draft.

## Considered options

- **One read-only run per Follow-up, as Tours run (ADR 0004)**: no new Thread kinds, but each run
  replays the review and every earlier Follow-up as text, forgets what it read, and returns one
  JSON answer at the end with no streaming, Steer, or Stop. Glass built this first.
- **Seeding a new Thread with the PR material and the review as data**: Glass built this next.
  The agent answered about a review it never wrote, without what the review's run had read, and
  Glass kept a second prompt carrying both.
- **Writing the review with the one-shot runner, then resuming its session in a Thread on the first
  Follow-up**: only a review someone follows up on gets a Thread, but the runner and the agent
  host's harness adapters must agree on the session's folder, format, and system prompt, and the
  runner seam gains session state that Tours and Ask don't need. Glass built this before running
  reviews as Turns.
- **Reading the review from the Turn's last message**: needs no tool, but by the time Glass reads
  it the Turn has ended, so a malformed answer can only fail the review.
- **Keeping a review in progress across a relaunch**: the Turn runs on while Glass is closed and
  shows as reviewing again after a relaunch, but Glass has to save each review in progress, resume
  it at launch, and count its deadline from a saved start. Glass built this first; a review is
  quick to start again.
- **Keeping the checkout until the review is replaced**: no second checkout on the first Follow-up,
  but every Queue review would keep a checkout of a Revision nobody may follow up on.
- **A separate Follow-up system prompt swapped in on resume**: Claude Code has to be told to drop
  the review's prompt, and the agent switches roles mid-conversation.
- **One drafting pass with no back-and-forth**: smaller, but it can't question the review's points,
  which is half of following up.
- **A Draft button on each point of the review**: needs every point placed on a line, while ADR 0009
  places only the Hotspots, and those only when their lines are in the diff.
