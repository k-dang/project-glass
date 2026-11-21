# Glass

A desktop work hub for reviewing GitHub pull requests and working with coding agents.

- **Single user**: Kevin is Glass's only user, with one install and no releases. A migration only has to carry his one database forward; backward-compatibility shims and tests for already-run migrations protect nobody.
- **Domain words** come from [`GLOSSARY.md`](GLOSSARY.md); use them in code, UI copy, and specs.

## Effect 4

The repo uses Effect 4, whose APIs differ from the Effect 3 most examples show (`effect/rpc`, `effect/http`, `effect/process` subpaths; `Context.Service`). Read the installed source and its `AGENTS.md` and `ai-docs/` under `node_modules/.pnpm/effect@*/node_modules/effect/` as the truth.

- Expected failures are tagged errors in the error channel; services stay transport-agnostic and RPC handlers stay thin (`apps/server/src/handlers.ts`).

## ui-sdk

Before using ui-sdk (`@ui-sdk/react`, `@ui-sdk/core` in `apps/desktop`), follow the `ui-sdk` skill if it's installed, and read `apps/desktop/node_modules/@ui-sdk/react/docs/llms.txt`. To build a new component, also search `docs/core.md` there by heading, and read `docs/rendering.md` next to it.

## Gotchas

- The per-launch secret travels in the `token` query parameter, so request logging stays off (`disableLogger` in `apps/server/src/server.ts`) and HTTP spans redact it (`UrlParams.CurrentRedactedNames` there).
- When a leftover process holds a folder (`EBUSY`, `EPERM`), run `node .agents/skills/verify-glass/scripts/glass-verify.ts ps` to see what holds it. Tear down a Glass home with `removeGlassHome` from `apps/server/test/glassHome.ts`.

## Tests

- Wait on events, never on time: no elapsed-time assertions, no sleeps to order work, and product deadlines in success-path tests set far above the test timeout.
- When what Glass sends Claude Code or pi changes, or a pinned SDK or bundled pi version moves, recording tests fail until you run `pnpm --filter @glass/server record:sessions [claude|pi] --pi-model <provider/model>` or `pnpm --filter @glass/server record:runners --pi-model <provider/model>`, which use your own logins.
- When a test turns out flaky (fails, then passes on a quick rerun with no code change), skip it so it stops blocking work, put a one-line `// Flaky: <what you saw>` comment above it, and log the sighting in [`docs/flaky-tests.md`](docs/flaky-tests.md).
- Wait with `eventually` from each app's `test/eventually.ts`, or Testing Library's `waitFor` in desktop tests with a DOM. Don't use `Effect.repeat` on a `Schedule`, which stalls under the `TestClock`, or add `Effect.timeout` guards inside tests.
