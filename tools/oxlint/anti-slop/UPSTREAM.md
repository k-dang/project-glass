# Upstream

- Source: https://github.com/dmmulroy/anti-slop, `skills/install-anti-slop/assets/anti-slop/`
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (baseline before the local comment cleanup below, line endings normalized)
- Installed: 2026-10-11 via the `install-anti-slop` skill
- Plugins: `index.ts` (generic, `anti-slop`) and `effect/index.ts` (`anti-slop-effect`), registered in the root `vite.config.ts`
- Vendored third-party code: `vendor/` (eslint-stylistic, see `vendor/UPSTREAM.md` and `vendor/LICENSE`)
- Local deviations: removed four redundant comment blocks from the plugin entry points and private rule helpers, plus 31 from `vendor/eslint-stylistic/`. Applied the same comment deletions to the `.agents` and `.claude` skill assets. Executable code and license material are unchanged.
