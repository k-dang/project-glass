# Agent tasks share one agent-runner seam

Tours, Agent reviews, and Ask ask an agent the same thing: follow these instructions over this PR
material in this checkout, and return an answer matching this schema. So all three go through one
`AgentRunners` seam, with a strategy per program (Claude Code, the pi CLI), instead of a runner set
each. Runners know nothing of git, GitHub, or settings: the features prepare the checkout (ADR 0005)
and choose the engine and model, and translate the runners' shared failure into their own.

A strategy that can't honour a task's read-only access refuses to run it rather than run without
restrictions. So a Claude Code without restricted mode, which confines read tools to the checkout
and skips the user's settings and hooks, runs no task at all.

## Considered options

- **A separate runner set per feature**: no change to Tours, but two copies of each runner's
  login checks, flag probes, spawning, and output decoding drifting apart.
- **Running a runner diff-only when it can't restrict file access**: works, but quietly gives a
  weaker answer depending on the user's install.

## Revisit when

- A feature needs more from an agent than one answer to one prompt. Agent review Follow-ups are the
  first such case, and use an Agent instead of stretching this seam (ADR 0009).
