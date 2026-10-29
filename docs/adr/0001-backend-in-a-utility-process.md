# The backend is its own package, hosted in a utilityProcess

Glass will grow from PR review into a work hub with an AI agent UI, which needs local execution and
long-running work, so all credentials, GitHub access, and persistence live in a backend package
behind typed contracts rather than in the renderer or the Electron main process. v1 hosts it in an
Electron `utilityProcess` serving RPC over WebSocket on `127.0.0.1`, guarded by a per-launch secret
and an origin check: crash isolation from the windows without a full server lifecycle.

## Considered Options

- **No backend** (renderer calls GitHub, main injects the token): least code, but agents need Node,
  and script injected into the renderer could act with the full token.
- **Logic in the main process**: no isolation, and a custom IPC transport for Effect RPC.
- **Independent server or daemon now**: deferred. Because the backend never imports `electron`
  and takes its config from the environment, promoting it is a hosting change. Do it when agents
  must outlive the app, another client appears, or execution moves off-machine.

## Consequences

The windows outlive a backend crash: `main` restarts the backend on the same port and token, and
the renderer's RPC socket reconnects on its own while the app shows "Reconnecting". Only a backend
that keeps crashing gets "Glass's backend keeps stopping" with a Relaunch button. The backend's
output lands in `~/.glass/logs/backend.log` instead of the terminal. `main` now supervises a second
process, choosing a free port, minting the token, waiting for `/health`, and restarting it, and the
renderer holds one RPC socket that can die under it, so every call runs through a runtime that
retries.
