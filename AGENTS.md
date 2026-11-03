# Glass

A desktop work hub for reviewing GitHub pull requests and working with coding Agents.

- **Domain words** come from [`GLOSSARY.md`](GLOSSARY.md); use them in code, UI copy, and specs.
- **Architecture decisions**: [`docs/adr/`](docs/adr/) records why past decisions were made under the conditions at the time. ADRs are context, not constraints: if a requirement challenges one, weigh the alternatives and propose replacing it.
- **Import boundaries and test waits**: `pnpm check` enforces the [executable policies](tools/oxlint/glass/README.md); consult their syntax and exceptions when changing imports or test synchronization.

## Effect 4

The repo uses Effect 4, whose APIs differ from the Effect 3 most examples show (`effect/rpc`, `effect/http`, `effect/process` subpaths; `Context.Service`). Read the installed source and its
`AGENTS.md` and `ai-docs/` under `node_modules/.pnpm/effect@*/node_modules/effect/` as the truth.

- Expected failures are tagged errors in the error channel; services stay transport-agnostic and RPC handlers stay thin (`apps/server/src/handlers.ts`).

## Gotchas

- The per-launch secret travels in the `token` query parameter, so request logging stays off (`disableLogger` in `apps/server/src/server.ts`).

## Tests

- Wait on events, never on time: no elapsed-time assertions, no sleeps to order work, and product deadlines in success-path tests set far above the test timeout.
- When what Glass sends Claude Code or pi changes, or a pinned SDK or bundled pi version moves, recording tests fail until you run `pnpm --filter @glass/server record:sessions [claude|pi]` or `pnpm --filter @glass/server record:runners --pi-model <provider/model>`, which use your own logins (ADR 0011).
- Wait with `eventually` from each app's `test/eventually.ts`, or Testing Library's `waitFor` in desktop tests with a DOM. Don't use `Effect.repeat` on a `Schedule`, which stalls under the `TestClock`, or add `Effect.timeout` guards inside tests.
