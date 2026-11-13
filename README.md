# Glass

TBD

## Layout

| Path                 | What it is                                                                         |
| -------------------- | ---------------------------------------------------------------------------------- |
| `apps/desktop`       | Electron app: main, preload, and React renderer, built separately.                 |
| `apps/server`        | Effect backend: RPC over WebSocket on `127.0.0.1`, behind a per-launch secret.     |
| `packages/contracts` | Effect Schema RPC definitions and errors shared by every app.                      |
| `packages/plugin`    | The types a Plugin implements to add a kind of Sandbox (ADR 0010).                 |
| `examples`           | Fake and Docker Cloud Sandbox provider Plugins, and a prompt for writing your own. |
| `tools/oxlint`       | Lint rules `pnpm check` runs, including Glass's import and test-wait policies.     |

## Requirements

Node 24.11+ and pnpm 11, pinned in [`mise.toml`](mise.toml): run `mise install`.

Tooling is [Vite+](https://viteplus.dev) (`vp`), configured in each package's `vite.config.ts`.

Glass signs in to GitHub with `GH_TOKEN`, `GITHUB_TOKEN`, or your GitHub CLI login (`gh auth login`).

Tours and Agent reviews use an authenticated Claude Code CLI or an installed pi CLI. Ordinary
Agents also support OpenCode 1.19.5. If Glass can't find a program on `PATH`, set `claudeCommand`,
`piCommand`, or `opencodeCommand` in `~/.project-glass/settings.json` to its full path and restart
Glass. pi and OpenCode use their native model configuration and logins.

The [Docker Cloud Plugin](examples/docker-cloud/README.md) runs OpenCode remotely without a local
OpenCode installation. Its README covers installation, credentials, costs, and verification.

OpenCode's adapter/session tests replay real native HTTP/SSE recordings. To refresh them, install
OpenCode 1.19.5 on PATH (or set `GLASS_OPENCODE_COMMAND`) and run
`pnpm --filter @glass/server record:sessions opencode`. The recording run uses an isolated local
model fixture and needs no model login.
OpenCode fixtures use NDJSON: a program/version header followed by one compact frame per line.

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

To profile the backend, set the standard `OTEL_*` variables before `pnpm dev` and it also sends
every span and log line over OTLP/HTTP, e.g. to the Aspire dashboard:

```sh
docker run --rm -p 18888:18888 -p 4318:18890 -e DOTNET_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=true \
  mcr.microsoft.com/dotnet/aspire-dashboard:9.5
export OTEL_TRACES_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pnpm dev   # traces and logs at http://localhost:18888
```

## Storage

The backend keeps the Activity log in `~/.project-glass/glass.db`.
