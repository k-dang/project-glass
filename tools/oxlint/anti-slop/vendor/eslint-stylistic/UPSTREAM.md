# Vendored padding-line-between-statements

Source: [ESLint Stylistic](https://github.com/eslint-stylistic/eslint-stylistic), commit `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`.

Copied files:

- `packages/eslint-plugin/rules/padding-line-between-statements/padding-line-between-statements.ts`
- `packages/eslint-plugin/rules/padding-line-between-statements/types.d.ts` → `padding-line-options.d.ts`
- Root `LICENSE`, retained verbatim. Both OpenJS Foundation and ESLint Stylistic notices apply.

The rule is MIT-licensed. Keep `LICENSE` with every redistributed copy, including skill assets. No Stylistic, ESLint, TypeScript-ESLint, or additional parser runtime dependency is required.

## Local adaptations

- Removed 31 redundant comment blocks from the rule and helper adapter. That cleanup left executable code, license material, upstream policy links, and retained API/JavaScript behavior notes unchanged.

- Replace upstream type aliases with Oxlint's ESTree, context, token/comment, and rule types. Upstream's token type includes comments; Oxlint exposes those separately.
- Replace `AST_NODE_TYPES` enum members with identical string literals.
- Guard indexed reads for consuming repositories with `noUncheckedIndexedAccess`. Impossible missing AST/configuration entries raise explicit invariant errors rather than introducing new non-null assertions.
- Replace the repository-specific `createRule` factory with `createPaddingLineRule(options)`. The anti-slop wrapper supplies typed options directly; it exposes no user configuration options.
- Implement the small required AST helper surface in `padding-line-ast.ts` using Oxlint's public source-code/token API. `isParenthesized` only needs the one-pair check used to exclude parenthesized directive strings, not the upstream general-purpose overloads.
- Retain the upstream statement matchers, scope tracking, comment-aware insertion/removal, selector support, and diagnostic text. Upstream naming and non-null assumptions remain localized here to keep future diffs reviewable; the file is not a model for new application code.
- Glass's local insertion fix selects the source file's first line ending (CRLF, LF, or CR; defaults to LF when none exists). Previously a CRLF file acquired mixed line endings on autofix. Existing bytes and comments remain intact; the spacing policy is unchanged. This fix is not mirrored into the installation skill assets.

The opinionated policy lives outside this directory in `../../rules/require-readable-spacing.ts`. It adds spacing without collapsing existing blank lines. Short local bindings, consecutive imports, and adjacent overload signatures/implementation remain grouped. Spacing is syntactic, not an inference of business-logic boundaries.

## Updating and verification

Fetch an explicit upstream revision, compare the original rule and types against the recorded revision, and port relevant fixes while retaining the adapters and local fix above. Update this record and preserve the license. The active Glass copy and installation templates have distinct roles, documented in [`../../UPSTREAM.md`](../../UPSTREAM.md).

Run `pnpm test:lint` for the local RuleTester and CLI fixtures, `pnpm check` for repository formatting/lint/type checks, and `pnpm test` for the normal CI test path (which includes `test:lint`). No `sync:skill-assets` command exists in Glass.

Actual local cases live in [`../../test/readable-spacing.test.ts`](../../test/readable-spacing.test.ts), with shared input/output fixtures in [`../../test/spacing-fixtures.ts`](../../test/spacing-fixtures.ts). They cover exact fixes, JSDoc/trailing and block comments, same-line statements, semicolon-free ASI guards, TypeScript exports/overloads, Effect-style generators, CRLF preservation, and already-spaced output. [`../../test/cli.test.ts`](../../test/cli.test.ts) loads the active exported plugins through the installed native Oxlint CLI on real temporary TS files and verifies rejection, exact autofix, and repeated-fix stability.

The complete upstream JS/TS suites and upstream blank-line removal behavior have not been ported. Glass's wrapper inserts spacing and deliberately does not collapse existing blank lines; the fixtures test that policy, not the entire configurable upstream rule. See [`../../test/README.md`](../../test/README.md) for coverage boundaries and verification evidence. The old references to tests under `../../rules/` were inherited upstream prose, not local coverage.
