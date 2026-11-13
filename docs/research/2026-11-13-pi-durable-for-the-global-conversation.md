# pi-durable for the Global conversation (2026-11-13)

Should the Global conversation run on [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable)
instead of the pi CLI in RPC mode? **Not yet.** Revisit when the triggers below change.

Read at pi commit `3e23dd9` (2026-11-13), pi-durable 1.5.2 on npm; Glass at `58765d9`.

## What pi-durable is

- An in-process agent harness built on `@earendil-works/pi-ai` and `@earendil-works/chord`, not a
  wrapper around the pi CLI. It has its own transcript, scheduler, tool/extension API and storage,
  and does not use pi's session files or RPC mode ([README](https://github.com/earendil-works/pi/tree/main/packages/durable#readme)).
- Every entry, task checkpoint and document change is committed before it is visible. After a
  crash, reopening the storage and calling `harness.resume()` continues interrupted work; a phase
  reruns from its top, a tool reruns only if declared `replay: "safe"`, and streamed text is
  persisted within `persistWithinMs` (default 1 s) (README; `docs/spec.md`).
- Storage: memory, IndexedDB, Node SQLite (one file, optional table prefix), its own JSONL format,
  Cloudflare Durable Objects, or a custom `Storage` (`src/types.ts`). One writer per storage, no
  cross-process locking.
- Busy conversations queue input in `pi.inbox`: follow-up, `whenBusy: "steer"`, reject, withdraw
  with `submission.abort()`. `conversation.abort()` stops the current work.
- No `ctx.ui.*`. Asking the person is a durable signal (`defineSignal`, `harness.signal(...)`;
  examples 39, 44), still under Unreleased in the CHANGELOG and not in 1.5.2.
- No MCP integration; MCP tools are a bridge the host writes (README).
- Consumers read committed state through `conversation.watch()`; a reconnecting client gets the
  current view plus pagination via `ConversationTranscript`, not a replay (examples 18, 20).
- Model is per-conversation `configure({ model, thinkingLevel })`, applied from the next request.
- Example 22 (subagent-background) is the closest shape to the Global conversation: one tool spawns
  and messages persistent child conversations and posts their answers back, surviving a restart.
- Coding-agent extensions can't run under the Harness ([#10386](https://github.com/earendil-works/pi/issues/10386)).

## Maturity

- README: "Experimental. The API changes without notice between releases."
- First commit 2026-09-18; 1.0.0 on 2026-10-01; 248 commits by 2026-11-13; breaking changes in
  nearly every minor (1.5.0 changed the `Storage` commit signature), and task-version bumps stop
  older harnesses from opening newer databases (CHANGELOG).
- About 110k lines including a 7,266-line normative spec; 106 test files.

## How Glass runs the Global conversation today

- pi CLI spawned as `pi --mode rpc --session-id <id>` in the agent host
  (`apps/server/src/agentHost/piRpc.ts`), using the user's own `pi` (`SettingsStore.ts`).
- Glass's tools reach pi through the backend MCP endpoint and a per-start credential (ADR 0013,
  `apps/server/src/agentHost/piGlassTools.ts`, `apps/server/src/mcp/McpCredentials.ts`).
- Global-specific code is about 700 lines; about 4,900 lines are shared with Agents
  (`ConversationTurns`, `Transcripts`, `HostAgents`, `piAdapter`/`piRpc`/`piTurn`).
- On quit or host crash the Turn ends Interrupted or CutOff, a waiting Question is lost, and
  queued messages wait for the user (`ConversationTurns.ts`, `conversationState.ts`).

## Why not now

- **Small gain.** Global Turns are short MCP calls into the backend; when the backend dies, so do
  the tools, so resuming mid-Turn mostly retries a tool call after relaunch.
- **A second stack.** Moving only the Global conversation forks it from the shared Agent path: a
  second transcript store or an adapter from durable's watch ops to `TranscriptUpdate`, plus an MCP
  bridge.
- **Immature API**, and the signals that `ask_user` needs are unreleased.
- **Model logins.** pi-durable calls `pi-ai` directly, so Glass would supply provider credentials
  that the user's `pi` handles today (ADR 0004). Not investigated.

## Revisit when

- pi-durable drops "Experimental" or goes a few minors without breaking changes, and signals ship.
- Agents should outlive the app (ADR 0007). The bigger fit is then the whole agent host for pi
  Agents, replacing `piRpc`, `turnLoop` and the in-memory journal; Claude Code Agents would still
  need their own runtime.
- Lost Turns or Questions on quit become a real complaint for the Global conversation.
