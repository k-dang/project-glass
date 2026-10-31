# Glass

TBD

## Layout

| Path                 | What it is                                                                     |
| -------------------- | ------------------------------------------------------------------------------ |
| `apps/desktop`       | Electron app: main, preload, and React renderer, built separately.             |
| `apps/server`        | Effect backend: RPC over WebSocket on `127.0.0.1`, behind a per-launch secret. |
| `packages/contracts` | Effect Schema RPC definitions and errors shared by every app.                  |

Inside `apps/desktop/src`, `main` owns windows and starts the backend in a `utilityProcess`,
`preload` exposes the desktop bridge, and `renderer` owns the React UI. The renderer talks to the
backend only through the RPC client. Node and renderer code have separate TypeScript configurations.

Tests live beside their source files, including the backend's full-stack integration tests in
`apps/server/src`. Shared test helpers live in `apps/desktop/test` and `apps/server/test`, which
holds the backend harness and fake GitHub fixtures.

## Requirements

Node 24.11+ and pnpm 11, pinned in [`mise.toml`](mise.toml): run `mise install`.

Tooling is [Vite+](https://viteplus.dev) (`vp`), configured in each package's `vite.config.ts`.

Glass signs in to GitHub with `GH_TOKEN`, `GITHUB_TOKEN`, or your GitHub CLI login (`gh auth login`).

Tours, Agent reviews, and Agents use either an authenticated Claude Code CLI or an installed pi CLI.
pi reuses the credentials and model configuration in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`); use
pi's `/login` to sign in.

## Commands

```sh
mise install      # Node and pnpm at the pinned versions
pnpm install
pnpm dev          # Vite + watch builds + Electron, restarted on main/preload/backend changes
pnpm dev:fake     # pnpm dev on a fake GitHub with demo PRs and model-free Tours, in fresh data
pnpm start        # build everything and run the app as it ships
pnpm dist         # package an installer into apps/desktop/release
pnpm test         # backend integration tests, renderer tests, and verification helper tests
pnpm check        # format check, type-aware lint, and type check
pnpm fix          # apply format and lint fixes
```

The backend runs on its own: `GLASS_PORT=4000 GLASS_TOKEN=secret node apps/server/dist/bin.mjs`.

## Storage

The backend keeps the Activity log in `~/.project-glass/glass.db`.
