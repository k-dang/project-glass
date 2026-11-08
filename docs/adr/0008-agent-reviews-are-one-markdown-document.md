# Agent reviews are one Markdown document read beside the diff

An Agent review is the agent's own Markdown, read beside the diff rather than placed on it. The
agent still answers through the shared runner seam (ADR 0006) as JSON, but the only field is the
Markdown, so the answer's schema stays a few dozen characters.

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
- **The review as the start of an Agent conversation**: follow-up questions help, but it needs an
  Agent and its checkout for every review. Instead, a review gets an Agent only when the user sends
  a Follow-up (ADR 0009).
