# Glass

TBD

## Layout

| Path                 | What it is                                                                     |
| -------------------- | ------------------------------------------------------------------------------ |
| `apps/desktop`       | Electron app: main, preload, and React renderer, built separately.             |
| `apps/server`        | Effect backend: RPC over WebSocket on `127.0.0.1`, behind a per-launch secret. |
| `packages/contracts` | Effect Schema RPC definitions and errors shared by every app.                  |
| `packages/plugin`    | The types a Plugin implements to add a kind of Sandbox (ADR 0010).             |
| `examples`           | A fake Sandbox provider Plugin and a prompt for writing your own.              |
| `tools/oxlint`       | Lint rules `pnpm check` runs, including Glass's import and test-wait policies. |

## Requirements

Node 24.11+ and pnpm 11, pinned in [`mise.toml`](mise.toml): run `mise install`.

Tooling is [Vite+](https://viteplus.dev) (`vp`), configured in each package's `vite.config.ts`.

Glass signs in to GitHub with `GH_TOKEN`, `GITHUB_TOKEN`, or your GitHub CLI login (`gh auth login`).

Tours, Agent reviews, and Agents use either an authenticated Claude Code CLI or an installed pi CLI.
pi reuses the credentials and model configuration in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`);

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

The backend runs on its own: `GLASS_PORT=4000 GLASS_TOKEN=secret node apps/server/dist/bin.mjs`.

## Storage

The backend keeps the Activity log in `~/.project-glass/glass.db`.
