# The Global conversation runs in the agent host without a repository

The user wants one point of contact with Glass itself, reached from any area, rather than an Agent
per piece of work. So Glass has one Global conversation, run by Claude Code or pi in the local agent
host (ADR 0007) like any Agent, with the same Turns, Steer, Stop, Queued messages, Questions, and
transcript of record. What differs is what it is for: it belongs to no repository, so it is not an
Agent and does not pretend to be one.

The host starts every conversation with a role: an Agent's work, an Agent review's Follow-ups
(ADR 0009), or the Global conversation. The role alone decides tools and instructions, so the
programs' adapters keep one way of running Turns. The Global conversation's role loads none of the
user's settings, plugins, extensions, or MCP servers, and gives the program no file or shell tools,
only its Question tool; pi has none of its own, so Glass's extension adds one. It works in a folder
of Glass's own data, which makes no branch or worktree and needs no Local checkout.

The backend delivers Turns, Steers, Stops, answers, and Unsent messages the same way for an Agent and
for the Global conversation, through one shared service, and keeps the Global conversation's
transcript in the same tables under its own stable identity. Its Agent program, model, and Effort
are its own, kept beside that identity. Each message can carry the context it was sent from: a PR
workspace and Revision, or an Agent. It is fixed when the message is sent, so later navigation
can't retarget it.

## Considered Options

- **An Agent with an optional repository**: reuses every Agent API, but every Agent rule, listing,
  and screen would have to handle an Agent with no repository, base branch, or worktree.
- **A separate process or runtime for the Global conversation**: free of the host's Agent model,
  but a second way of driving Claude Code and pi, with its own reconnects, Questions, and tests.

## Revisit when

- The Global conversation needs to outlive Glass or run somewhere other than this device.
- Users need more than one Global conversation.
