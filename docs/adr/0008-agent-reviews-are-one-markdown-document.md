# Agent reviews are one Markdown document read beside the diff

An Agent review is the agent's own Markdown, opening with a paragraph whose bold first sentence
names the PR's main risk. Glass places nothing on the diff. Overview shows that opening paragraph,
and the whole review reads in an Agent review tab of the file panel, next to the code it talks
about. The agent still answers through the shared runner seam (ADR 0006) as JSON, but the only field
is the Markdown, as Ask's only field is its answer, so the answer's schema stays a few dozen
characters.

Reviews used to return Findings: rated points, each placed on a diff line, a file, or the whole PR,
shown inline in the diff. The placement was the costliest part to keep working. Its schema passed
1,000 characters, and once it moved to stdin to stay clear of endpoint security tools that kill
long arguments, Claude Code stopped enforcing it, so a placement the agent got wrong failed the
whole review. Glass also had to check every path against the checkout and fall back when a line
wasn't in the diff. A review read beside the diff gives up jumping to a line in exchange for a
format any model writes reliably.

## Considered options

- **Keep Findings with a flatter placement**: optional `path`, `line`, and `side` halved the
  schema, but kept the validation, the inline rendering, and the failures a stray path causes.
- **Plain text that Glass parses into Findings**: no schema at all, but Glass would own a parser
  that any heading in a body could break.
- **The review as the start of an Agent conversation**: follow-up questions would help, but it needs
  an Agent and its checkout for every review; Ask already answers questions about a line.
