# Backend access

The backend runs on its own with plain Node (`node apps/server/dist/bin.mjs`), configured only by environment variables. Every request must carry the launch secret in the `token` query parameter, and browser requests must come from an allowed origin; `/health` answers 204 when both hold.

## Sub-features

- `access-health` answers `GET /health?token=<secret>` with 204.
- `access-token` answers 401 "Unauthorized" with a missing or wrong token.
- `access-origin` answers 403 "Forbidden origin" when an `Origin` header isn't in `GLASS_ALLOWED_ORIGINS`; no `Origin` header needs only the token.
- `access-rpc` serves the RPC WebSocket at `/rpc` behind the same checks.

## How to get to it (user POV)

- `GLASS_PORT=<port> GLASS_TOKEN=<secret> [GLASS_ALLOWED_ORIGINS=glass://app] node apps/server/dist/bin.mjs` after `pnpm build`.

## Driving it with curl

Preconditions:

- `pnpm build` is current. Port 4917 is free (pick another if not).

- **Start.** `mkdir -p .verify/backend/evidence && (GLASS_PORT=4917 GLASS_TOKEN=verify-secret GLASS_ALLOWED_ORIGINS=glass://app node apps/server/dist/bin.mjs > .verify/backend/evidence/backend.log 2>&1 & echo $! > .verify/backend/pid)`. The log shows `Listening on http://127.0.0.1:4917`.
- **Token.** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4917/health` prints `401`; with `?token=wrong`, `401`; with `?token=verify-secret`, `204`.
- **Origin.** Add `-H 'Origin: https://evil.example'` to the good-token request: `403`. With `-H 'Origin: glass://app'`: `204`.
- **Stop.** `kill $(cat .verify/backend/pid)`; the same curl now prints `000`. Remove `.verify/backend/pid` and keep `.verify/backend/evidence/`.
- **Proof.** Save each command with its status code in `.verify/backend/evidence/access.txt`, next to `backend.log`.

## Gotchas

- Request logging is disabled on purpose because the secret is a query parameter; the log has only the `Listening on` line. A request line appearing in the log is a regression.
- `access-rpc` from a script needs an Effect RPC client; `apps/server/test/harness.ts` shows the shape. The desktop recipe in [GitHub connection](./github-connection.md) exercises it through the real renderer.
- Kill the PID you started, never `node` by name.
