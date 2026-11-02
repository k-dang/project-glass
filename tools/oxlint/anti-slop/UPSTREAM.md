# Upstream

- Source: https://github.com/dmmulroy/anti-slop, `skills/install-anti-slop/assets/anti-slop/`
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (baseline before the local comment cleanup below, line endings normalized)
- Installed: 2026-10-11 via the `install-anti-slop` skill
- Plugins: `index.ts` (generic, `anti-slop`) and `effect/index.ts` (`anti-slop-effect`), registered in the root `vite.config.ts`
- Vendored third-party code: eslint-stylistic; see [`vendor/eslint-stylistic/UPSTREAM.md`](vendor/eslint-stylistic/UPSTREAM.md) and [`vendor/eslint-stylistic/LICENSE`](vendor/eslint-stylistic/LICENSE).
- Earlier local deviations: removed four redundant comment blocks from the plugin entry points and private rule helpers, plus 31 from `vendor/eslint-stylistic/`. The same cleanup was applied to the installation skill assets. That cleanup did not change executable code or license material.
- Local executable deviation: padding insertion now uses the source file's first line ending (LF, CRLF, or CR; LF for a one-line file), rather than always inserting LF. The CRLF regression has exact-output RuleTester and native CLI fixtures. No lint policy or diagnostic changed.
- Local verification: [`test/README.md`](test/README.md) describes the focused fixtures and commands. Tests and this verification documentation are Glass-owned additions, not claims about tests shipped in the upstream asset bundle.

## Authoritative copies and updates

`tools/oxlint/anti-slop/` is authoritative for Glass's active lint behavior, local fixes, tests, and provenance. The root `vite.config.ts` loads these entry points directly.

`.agents/skills/install-anti-slop/assets/anti-slop/` is an installation template for the skill's copy operation, not a runtime dependency or a second source of Glass rule coverage. `.claude/skills/install-anti-slop` links to that same skill directory. The template's inherited verification prose describes its source repository; it does not establish that those tests or commands exist in Glass. The local CRLF fix and tests deliberately live only in the active plugin copy. There is no `sync:skill-assets` script here.

For an update, stage an explicit incoming upstream revision and compare it with the recorded baseline and the active local tree. Port reviewed changes into the active tree, preserving local fixes and fixtures; do not overwrite it from skill assets. Update this record and the nested Stylistic record when their source or adaptations change, and retain every license notice. Updating the installation template is a separate change with its own purpose; it is not required to verify Glass. Run the commands in `test/README.md` after any rule or toolchain update. The recorded upstream revisions remain the baselines, not a claim that the locally adapted tree is pristine upstream code.
