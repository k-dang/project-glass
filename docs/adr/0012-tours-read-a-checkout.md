# Tours read a checkout of the PR

Tours used to see only the diff (ADR 0004). That left them unable to show a Before / after: what the
system did before a change usually sits outside its hunks, and a Tour that may not assume
surrounding code can only restate the diff. So a Tour now gets the same read-only checkout of the
Revision's head as an Agent review (ADR 0005), and every agent task carries one. Tours take longer
and each needs a fetch, which is worth it for a reader who wants to know what changed in the system
and not only in the files.

Glass accepts ADR 0005's risk for Tours too. pi's read tools aren't confined to the checkout, so a
hostile PR could steer the agent to read a local file, which would then reach the model provider.
Agent reviews for the Queue already run this way on PRs the user hasn't opened. What changes is that
Tours for the Queue moves from no file access to reading files, without the user turning it on
again. The instructions keep the agent inside the checkout, and Claude Code's restricted mode
confines it. Tours can't run on a Claude Code without that mode.

Links stay tied to the diff. The Tour's text may draw on the whole checkout, but every line a
reader can jump to must be in a hunk, because that's all the Tour view can show.

## Considered options

- **Stay diff-only**: faster and with no fetch, but unchanged context in a Before / after would be
  guesswork or missing.
- **Send the changed files' full contents in the prompt**: needs no tools, but it can't reach
  callers in other files, and that's most of the missing context.

## Revisit when

- pi can confine its read tools to a directory, which removes the risk accepted here.
- Tours on the Queue become too slow or too costly to leave on.
