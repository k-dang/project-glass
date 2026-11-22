# @glass/plugin

The types a Plugin implements to add a kind of Sandbox to Glass (ADR 0010). The contract lives in
[`src/index.ts`](src/index.ts) and uses Promises and `AbortSignal`, so a Plugin needs no Effect.

![How Glass runs Threads locally and in Sandboxes made by provider Plugins](agent-host.svg)

Every Thread runs in an agent host: a small Node server, built from Glass's own code, that
drives Claude Code or pi, keeps a journal of numbered events, and serves RPC over WebSocket (ADR
0007). Local Threads start it as a child process. For a Sandbox Thread, the provider's
`create` makes the Sandbox, sets up logins, and clones the repository, and its `startHost` copies in
and starts the host bundle Glass hands it, with the token, port, and address in its environment.
Glass then reaches the host through `target` and keeps the transcript in SQLite, resuming from the
last saved event after a dropped connection. After a Glass upgrade that changes how Glass talks to
the host, Glass calls `startHost` again to replace the one the Sandbox still runs.

To write one, start from [`examples/fake-sandboxes`](../../examples/fake-sandboxes), see real
ones in [`examples/vercel-sandboxes`](../../examples/vercel-sandboxes) and
[`examples/upstash-boxes`](../../examples/upstash-boxes), or paste
[`examples/sandbox-provider-prompt.md`](../../examples/sandbox-provider-prompt.md) into your coding
agent.
