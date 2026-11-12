# Agent reviews are Markdown read beside the diff, with optionally placed Hotspots

An Agent review is the agent's own Markdown, read beside the diff rather than placed on it, plus up
to five ranked Hotspots: the places the reviewer should read most closely, each with a risk kind,
why it matters, the code it rests on, and what to check. A Hotspot may name the lines it is about,
and the Tour shows the Hotspots of an Agent review written for its Revision. The agent answers
through the shared runner seam (ADR 0006) as JSON, and the files that need little attention come
back with it.

Reviews used to return Findings: rated points, each placed on a diff line, a file, or the whole PR,
shown inline in the diff. The placement was the costliest part to keep working. Its schema passed
1,000 characters, and once it moved to stdin to stay clear of endpoint security tools that kill
long arguments, Claude Code stopped enforcing it, so a placement the agent got wrong failed the
whole review. Glass also had to check every path against the checkout and fall back when a line
wasn't in the diff.

Hotspots keep placement without that failure. Every part of the answer but the Markdown decodes
leniently, as Tour visuals do: a malformed Hotspot or list is logged and dropped, and a malformed or
missing place leaves its Hotspot unplaced. Glass checks each place against the diff the review read
and drops any range outside its hunks, so the Hotspot keeps its text and loses only its link. No
part of a Hotspot can fail the review, and only Hotspots are placed; every other point stays in the
Markdown.

## Considered options

- **Keep Findings with a flatter placement**: optional `path`, `line`, and `side` halved the
  schema, but kept the validation, the inline rendering, and the failures a stray path causes.
- **Plain text that Glass parses into Findings**: no schema at all, but Glass would own a parser
  that any heading in a body could break.
- **The review as the start of an Agent conversation**: follow-up questions help, but it needs an
  Agent and its checkout for every review. Instead, a review gets an Agent only when the user sends
  a Follow-up (ADR 0009).
- **Markdown only, with no Hotspots**: the simplest answer, but the reviewer can't jump to the risky
  lines, the diff can't collapse the plumbing, and the Tour can't say where to look first.
- **Hotspots written by the Tour**: the Tour already places code, but it guides a first reading
  and is told not to review, so the risks would come from the wrong agent. The two stay
  independent jobs, and the Tour shows Hotspots only when an Agent review exists for its Revision.
