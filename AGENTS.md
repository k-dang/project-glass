# Glass

Electron app for reviewing GitHub pull requests, growing into a work hub with an AI agent UI.

- **Domain words** come from [`GLOSSARY.md`](GLOSSARY.md); use them in code, UI copy, and specs.
- **Architecture decisions**: read the relevant ADRs in [`docs/adr/`](docs/adr/) before changing the architecture.

## Effect 4

The repo uses Effect 4, whose APIs differ from the Effect 3 most examples show (`effect/rpc`, `effect/http`, `effect/process` subpaths; `Context.Service`). Read the installed source and its
`AGENTS.md` and `ai-docs/` under `node_modules/.pnpm/effect@*/node_modules/effect/` as the truth.

- Expected failures are tagged errors in the error channel; services stay transport-agnostic and RPC handlers stay thin (`apps/server/src/handlers.ts`).

## Gotchas

- The per-launch secret travels in the `token` query parameter, so request logging stays off (`disableLogger` in `apps/server/src/server.ts`).
- Backend tests use `it.live`; the test clock in `it.effect` stalls WebSocket timers.

## Tests

- Wait on events, never on time: no elapsed-time assertions, no sleeps to order work, and product deadlines in success-path tests set far above the test timeout.
- Wait with `eventually` from each app's `test/eventually.ts`, not `vi.waitFor` (its default gives up after 1s). It waits up to 25s, inside each package's 30s `testTimeout`; don't add shorter `Effect.timeout` guards inside tests.
