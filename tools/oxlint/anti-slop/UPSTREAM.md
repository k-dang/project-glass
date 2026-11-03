# Upstream

- Source: https://github.com/dmmulroy/anti-slop, `skills/install-anti-slop/assets/anti-slop/`
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (baseline before the local comment cleanup below, line endings normalized)
- Installed: 2026-10-11 via the `install-anti-slop` skill
- Plugins: `index.ts` (generic, `anti-slop`) and `effect/index.ts` (`anti-slop-effect`), registered in the root `vite.config.ts`
- Vendored third-party code: eslint-stylistic; see [`vendor/eslint-stylistic/UPSTREAM.md`](vendor/eslint-stylistic/UPSTREAM.md) and [`vendor/eslint-stylistic/LICENSE`](vendor/eslint-stylistic/LICENSE).
- Earlier local deviations: removed four redundant comment blocks from the plugin entry points and private rule helpers, plus 31 from `vendor/eslint-stylistic/`. The same cleanup was applied to the installation skill assets. That cleanup did not change executable code or license material.
- Local executable deviation: padding insertion now uses the source file's first line ending (LF, CRLF, or CR; LF for a one-line file), rather than always inserting LF. No lint policy or diagnostic changed.

## Authoritative copies and updates

`tools/oxlint/anti-slop/` is authoritative for Glass's active lint behavior, local fixes, and provenance. The root `vite.config.ts` loads these entry points directly.

`.agents/skills/install-anti-slop/assets/anti-slop/` is an installation template for the skill's copy operation, not a runtime dependency. `.claude/skills/install-anti-slop` links to that same skill directory. The local CRLF fix lives only in the active plugin copy.

For an update, stage an explicit incoming upstream revision and compare it with the recorded baseline and the active local tree. Port reviewed changes into the active tree, preserving local fixes; do not overwrite it from skill assets. Update this record and the nested Stylistic record when their source or adaptations change, and retain every license notice. Updating the installation template is a separate change with its own purpose. The recorded upstream revisions remain the baselines, not a claim that the locally adapted tree is pristine upstream code.
