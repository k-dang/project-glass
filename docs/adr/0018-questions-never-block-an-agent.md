# Questions never block an agent

An agent that asks the user something gets "asked" back at once and decides for itself whether to
keep working or end its Turn. The Question waits in the Inbox, not in the agent. This holds for
every agent: a Thread and the Global chat ask with Glass's `ask_user` tool rather than Claude
Code's own question tool or a pi dialog, and an Outside agent asks with the same tool. A blocked
agent held its Turn, its host, and an MCP call open until the user came back, and an Outside
agent's question vanished when that call timed out.

The answer reaches an agent Glass launched as a message: a Steer while a Turn runs, or a new Turn.
Glass cannot start a Turn in an Outside agent, so an Outside agent reads its answer by the
Question's id, from any of its sessions. Check-ins work the same way.

Permission requests still block: they gate a tool call already under way, and answering one later
would need the agent to retry the call and Glass to remember the approval.

## Considered options

- **Blocking with a timeout**, as before: simple for the agent, but a question asked while the
  user is away fails rather than waits.
- **Waking an Outside agent** with a plugin per host that polls Glass and starts a Turn when the
  session is idle, as Plannotator does for Claude Code, pi, and OpenCode. It needs code inside each
  agent's process, leases so two processes never take one answer, and still cannot reach a session
  that has quit. Reading by id is what such a wake would poll, so one can be added later without
  changing this decision.
