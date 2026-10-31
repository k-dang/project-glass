# Tours and Agent reviews share one agent-runner seam

Tours and Agent reviews ask an agent the same thing: follow these instructions over this PR
material and return an answer matching this schema. So both go through one `AgentRunners` seam
instead of a runner set each. A task carries the instructions, the prompt, the answer schema, and
its file access: none for Tours, or a read-only directory for Agent reviews. It also names what
the agent writes, so runner failures read "could not write the Tour" or "the Agent review". Each
strategy (Claude Code, the pi CLI) stays a plain function that owns invocation, parsing,
validation, interruption, and mapping its errors to a shared `AgentFailure`; the features
translate that into their own failures and add their own (a stale Revision, a failed checkout).
Runners know nothing of git or GitHub: a shared `CheckoutRuns` service prepares the checkout and
passes its path, for Agent reviews and for Ask, which answers a question about one line on the
Agent review engine.

Selecting a runner names the file access its tasks need, and a strategy that can't honour
read-only access refuses to be selected for it, so `CheckoutRuns` fails before checking out and no
strategy runs a file task without restrictions. The pi CLI
runs in the directory with only its read-only built-in tools (`--tools read,grep,find,ls`). Claude
Code runs in the directory with only its read, search, and list tools in restricted mode
(`--restricted --tools Read,Grep,Glob`), which confines those tools to the directory and skips the
user's settings files and their hooks; a Claude Code without restricted mode can't read files.
Agent reviews run on their own engine and models, chosen apart from the Tour engine, and Ask uses
the same engine. Runners don't read settings.

## Considered options

- **A separate runner set per feature**: no change to Tours, but two copies of each runner's
  login checks, flag probes, spawning, and output decoding drifting apart.
- **Running a runner diff-only for Agent reviews**: works today, but quietly gives a weaker review
  depending on a setting.
