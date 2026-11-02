# Glass

Electron app for reviewing GitHub pull requests, growing into a work hub with an AI agent UI.

- **Domain words** come from [`GLOSSARY.md`](GLOSSARY.md); use them in code, UI copy, and specs.
- **Architecture decisions**: read the relevant ADRs in [`docs/adr/`](docs/adr/) before changing the architecture.
- **Import boundaries and test waits**: `pnpm check` enforces the [executable policies](tools/oxlint/glass/README.md); consult their syntax and exceptions when changing imports or test synchronization.

## Effect 4

The repo uses Effect 4, whose APIs differ from the Effect 3 most examples show (`effect/rpc`, `effect/http`, `effect/process` subpaths; `Context.Service`). Read the installed source and its
`AGENTS.md` and `ai-docs/` under `node_modules/.pnpm/effect@*/node_modules/effect/` as the truth.

- Expected failures are tagged errors in the error channel; services stay transport-agnostic and RPC handlers stay thin (`apps/server/src/handlers.ts`).

## Gotchas

- The per-launch secret travels in the `token` query parameter, so request logging stays off (`disableLogger` in `apps/server/src/server.ts`).

## Tests

- Wait on events, never on time: no elapsed-time assertions, no sleeps to order work, and product deadlines in success-path tests set far above the test timeout.
- Backend tests use `it.live`, except deadline tests: those use `it.effect`, wait until the work is stuck, then `TestClock.adjust` past the deadline. The server runs in the test process, so its deadlines follow the `TestClock`; timers in child processes stay real.
- Tests replay recordings of the real Agent programs (`apps/server/test/recordings/`, ADR 0007), so a change to what Glass sends Claude Code or pi fails until it is recorded again: run the adapter tests with `GLASS_RECORD_SESSIONS=1`, and the runners with `pnpm --filter @glass/server exec jiti test/recordRunnerReplays.ts --pi-model <provider/model>`.
- Wait with `eventually` from each app's `test/eventually.ts`, not `vi.waitFor` (its default gives up after 1s) or `Effect.repeat` on a `Schedule` (it stalls under the `TestClock`). It waits up to 25s, inside each package's 30s `testTimeout`; don't add shorter `Effect.timeout` guards inside tests.
