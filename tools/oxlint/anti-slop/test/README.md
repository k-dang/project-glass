# Focused Glass rule verification

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test:lint
pnpm exec vp test run tools/oxlint/anti-slop/test/cli.test.ts
pnpm check
pnpm test
```

`pnpm test:lint` uses the root Vite+ test configuration's explicit `tools/oxlint/anti-slop/test/**/*.test.ts` include. `pnpm test` runs that suite before the existing recursive workspace tests; CI already runs `pnpm check` and `pnpm test`. The direct pinned `oxlint` dependency exposes `oxlint/plugins-dev`'s supported `RuleTester`, using the same Oxlint version as Vite+ and `@oxlint/plugins`. No additional test framework or parser is installed. `rule-tester.ts` connects RuleTester to `vite-plus/test` and selects TypeScript parsing.

Invalid source is data inside strings, not application TS modules. CLI tests write those strings into a unique OS temporary directory, load the active exported plugin files using an explicit isolated Oxlint JSON config, and remove the directory in `finally`. The config enables only the fixture rules and turns native correctness defaults off. No new application lint ignores or severity overrides are needed. The existing vendored-directory lint/format exclusion remains; `pnpm check` alone does not execute these fixtures.

## Covered guarantees

| Fixture | Guarantees exercised |
| --- | --- |
| `assertions.test.ts` | Non-const `as` and angle assertions require a preceding marker with a reason; statement, export, return, and field ownership; inline and block comments; marker boundaries, escaped custom markers and per-file option isolation; `as const`, angle `const`, and `satisfies` exceptions. Assertion chains report once, including parentheses, mixed syntax, and const/non-const chains; a safety comment does not permit a chain. Immutable local widening followed by a narrower assertion follows const value aliases and respects boundary inputs, mutable bindings, shadowed parameters, and function boundaries. Known-value widening resolves local/defaulted generic type aliases while accepting imported owner contracts and shadowing by type parameters. Non-fixable diagnostics have `output: null`. |
| `tagged-values.test.ts` | Broad Effect `catch`/`catchIf` tag and nested-reason comparisons and switches, including reversed comparisons, bracket members, function callbacks, root imports and namespace subpath imports. Dedicated handler diagnostics stay separate from general tag comparison diagnostics. Constructors, `catchTag(s)`, `catchReason`, `Match.tag`, `Predicate.isTagged`, and direct `Match.when`/`Match.not` patterns are accepted. Literal tag construction, including computed keys and object spreads, is rejected; constructing a value inside a Match callback remains rejected. |
| `readable-spacing.test.ts`, `spacing-fixtures.ts` | Exact comment-aware whitespace fixes, JSDoc attachment, semicolon-free code with an ASI guard, same-line statements, grouped imports/overloads, TS exports, generators, and CRLF line endings. Every expected fixed output is separately a valid fixture. Existing extra blank lines remain accepted. |
| `cli.test.ts` | Both plugin entry points load and register in a separate native CLI process; real TS files produce the expected error codes/severity and reason-handler guidance; `--fix` preserves non-fixable violations; all shared spacing cases fix exactly, pass a second fix byte-for-byte, and lint clean afterward. |

This bounded set targets type-evidence loss, tagged error handling, and the vendored autofixer. It does not establish every custom rule's behavior or full ESLint Stylistic conformance. The complete upstream suites, configurable padding removal, unrelated generic/Effect rules, and new import-direction/test-wait policies are outside this suite.

These are syntactic checks, not type proofs or whole-program data flow. A safety comment states an invariant; the linter cannot verify it. Imported owner types are not resolved across files. The widen-then-assert rule does not resolve arbitrary type aliases or cross-function flows. Effect handler and Match pattern recognition currently uses the literal namespace identifiers `Effect` and `Match`, without import resolution: aliases such as `Fx.catch` get the general comparison diagnostic instead of the dedicated Effect diagnostic; aliased Match patterns do not get the pattern exception. The general alias-branching rejection is covered, but arbitrary alias/shadowing correctness is not claimed. `catchAll` is retained in the existing helper for older Effect syntax; the Effect 4 compatibility cases use the installed `catch`, `catchIf`, `catchTag(s)`, and `catchReason` APIs. Accepted error-constructor fixtures follow the installed Effect 4 source and `ai-docs/src/01_effect/04_errors/` examples.

## Verification evidence

Verified locally on 2026-11-01 with pinned Node 24.21.0, pnpm 11.10.0, Oxlint 1.87.0, Effect 4.0.5, and Vite+ 1.1.0:

- `pnpm install --frozen-lockfile --offline`: passed after dependency setup; the lockfile change only exposes the already-pinned Oxlint as a root dev dependency.
- `pnpm test:lint`: 97 tests passed, including the two native CLI integration tests.
- `pnpm check`: passed formatting, lint, and type checks.
- `pnpm exec vp test run tools/oxlint/anti-slop/test/cli.test.ts`: both native CLI tests passed independently.
- `pnpm test`: passed the 97 lint tests, 254 desktop tests (36 files), and 291 server tests (44 files).
- Reversible diagnostic mutation: replaced the safety rule's `hasSafetyComment` guard with an unconditional return. `pnpm exec vp test run tools/oxlint/anti-slop/test/assertions.test.ts` exited 1: all nine missing-justification fixtures failed with zero diagnostics instead of one; 38 other cases passed.
- Reversible autofix mutation: replaced the new line-ending selection with hard-coded LF. `pnpm exec vp test run tools/oxlint/anti-slop/test/readable-spacing.test.ts tools/oxlint/anti-slop/test/cli.test.ts` exited 1: the CRLF unit fixture and CLI exact-output check failed; 14 other cases passed.

Both mutations were restored byte-for-byte in `finally` before rerunning checks. These experiments prove the fixtures detect suppressed diagnostics and a broken fix; they are not a claim of exhaustive mutation coverage. The upstream revisions, local deviation, and authoritative-copy/update convention are recorded in [`../UPSTREAM.md`](../UPSTREAM.md) and [`../vendor/eslint-stylistic/UPSTREAM.md`](../vendor/eslint-stylistic/UPSTREAM.md).

An additional exploratory strict type-check of the test entry points and their imported vendored sources remains limited by the pre-existing TS2322 at `shared/dictionary-types.ts:201` (`unsafeMembers[0]` can be `undefined` under `noUncheckedIndexedAccess`). No errors remain in the new harness. That helper is unchanged; the normal repository type-check excludes the vendored tree, and Vite+ executes these tests by transpilation. This check is separate from the passing required `pnpm check`:

```powershell
$testFiles = rg --files tools/oxlint/anti-slop/test -g '*.ts'
pnpm exec tsc --ignoreConfig --noEmit --target es2024 --module preserve --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --types node @testFiles
```
