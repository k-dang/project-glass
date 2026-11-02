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

Run `pnpm check` for repository formatting/lint/type checks and `pnpm test` for the workspace application suites. These commands do not establish dedicated custom-rule coverage: the vendored directory is excluded from application lint/format checks, and Glass does not retain a dedicated RuleTester or CLI fixture suite.

The upstream JS/TS suites have not been ported. Earlier references to tests under `../../rules/` and `pnpm sync:skill-assets` were inherited upstream prose; those files and that command do not exist in Glass. Glass's wrapper inserts spacing and deliberately does not collapse existing blank lines; it does not use the entire configurable upstream policy.
