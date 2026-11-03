# Glass

TBD

## Layout

| Path                 | What it is                                                                     |
| -------------------- | ------------------------------------------------------------------------------ |
| `apps/desktop`       | Electron app: main, preload, and React renderer, built separately.             |
| `apps/server`        | Effect backend: RPC over WebSocket on `127.0.0.1`, behind a per-launch secret. |
| `packages/contracts` | Effect Schema RPC definitions and errors shared by every app.                  |
| `packages/plugin`    | The types a Plugin implements to add a kind of Sandbox (ADR 0008).             |
| `examples`           | A fake Sandbox provider Plugin and a prompt for writing your own.              |
| `tools/oxlint`       | Lint rules `pnpm check` runs, including Glass's import and test-wait policies. |

Inside `apps/desktop/src`, `main` owns windows and starts the backend in a `utilityProcess`,
`preload` exposes the desktop bridge, and `renderer` owns the React UI. The renderer talks to the
backend only through the RPC client. Node and renderer code have separate TypeScript configurations.

Tests live beside their source files; `*.integration.test.ts` files replay recordings of the real
Agent programs (ADR 0007). Shared test helpers live in `apps/desktop/test` and `apps/server/test`,
which holds the backend harness, the fake GitHub and model APIs, the scripted agent host, the
recorders, and their recordings. Desktop end-to-end tests live in `apps/desktop/e2e`.

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
pnpm test         # backend, renderer, and verification helper tests
pnpm test:e2e     # build, then drive the Electron app with Playwright
pnpm check        # format check, type-aware lint, and type check
pnpm fix          # apply format and lint fixes
```

Recording the Agent programs again after a change to what Glass sends them is covered in
[`AGENTS.md`](AGENTS.md#tests).

In `pnpm dev:fake`, open **Rate-limit the public API** → **Tour** → **Write Tour** →
**Start reading** to try diagrams, playback, call trees, and code callouts.
Use **Expand diagram** or **Expand call tree** for a wider view above the diff.
The curated Tour is synthetic and written without a model.

The backend runs on its own: `GLASS_PORT=4000 GLASS_TOKEN=secret node apps/server/dist/bin.mjs`.

## Storage

The backend keeps the Activity log in `~/.project-glass/glass.db`.
